import { readFile, open, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const email = value => typeof value === 'string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 409 }); };
const stamp = () => new Date().toISOString();
const address = s => String(s || '').toLowerCase();
const text = (s, label) => check(typeof s === 'string' && s.trim(), label + ' is required.');
export function makeBatch(input, ids, readiness, seed = randomBytes(32).toString('hex')) {
  check(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, 'Choose distinct eligible recipients.');
  check(email(input.sender?.email) && !/[\r\n<>]/.test(input.sender.name || ''), 'A valid sender identity is required.');
  for (const v of ['A', 'B']) { text(input.variants?.[v]?.subject, 'Subject'); text(input.variants?.[v]?.body, 'Body'); check(!/[\r\n]/.test(input.variants[v].subject), 'Invalid subject.'); }
  const people = ids.map(id => input.contacts.find(p => p.id === id));
  check(people.every(p => p && p.eligibility === 'supported' && email(p.email) && p.firstName && !/[\r\n]/.test(p.firstName)), 'Only supported candidates with published email can be selected.');
  check(new Set(people.map(p => address(p.email))).size === people.length && new Set(people.map(p => p.name.toLowerCase().trim())).size === people.length, 'Duplicate people or addresses.');
  const sorted = [...people].sort((a,b) => hash([seed,a.id]).localeCompare(hash([seed,b.id])));
  const id = randomUUID();
  const recipients = sorted.map((p,i) => {
    const variant = i % 2 ? 'B' : 'A'; const draft = input.variants[variant];
    return { contact: clone(p), variant, to: p.email, subject: draft.subject,
      body: draft.body.replaceAll('[First Name]', p.firstName) + '\n\n' + readiness.footer,
      messageId: `<pilot.${id}.${i}@${input.sender.email.split('@')[1]}>` };
  });
  const batch = { id, inputHash: hash(input), createdAt: stamp(), seed, sender: clone(input.sender), variants: clone(input.variants), readiness: clone(readiness), recipients,
    source: 'owner_supplied_copy', experiment: 'Complete messages, including subjects; one initial email per person; no automatic follow-ups.' };
  return { ...batch, hash: hash(batch) };
}
export function checkReadiness(batch) {
  const r = batch.readiness;
  check(r.footerApproved === true && r.linksChecked === true && r.serviceSuitable === true && r.authenticationPassed === true, 'Sender/footer/service/authentication checks remain unresolved.');
  for (const key of ['footer','postalAddress','optOutInstructions','serviceEvidence','authenticationEvidence']) text(r[key], key);
  check(r.footer.includes(r.postalAddress) && r.footer.includes(r.optOutInstructions), 'Approved postal address and opt-out instructions must appear in the footer.');
  check(r.optOutMethod === 'reply', 'This pilot supports monitored reply-based opt-outs only.');
  check(r.ownerAuthorizedMailbox === batch.sender.email, 'The mailbox owner must authorize this exact sender.');
}
export function projectPilot(events) {
  const batches = [], suppressions = new Set(), feedback = [];
  for (const e of events) {
    if (e.type === 'feedback') { feedback.push(e); continue; }
    if (e.type === 'suppression') { suppressions.add(address(e.email)); continue; }
    if (e.type === 'batch') { const { hash: h, ...value } = e.batch; check(hash(value) === h, 'Pilot batch integrity failure.'); check(!batches.some(b=>b.id===value.id), 'Duplicate batch.'); batches.push({ ...clone(e.batch), paused: false, approval: null, results: {}, replies: [], observations: [] }); continue; }
    const b = batches.find(b => b.id === e.batchId); check(b, 'Pilot event has no batch.');
    if (e.type === 'approval') b.approval = e;
    else if (e.type === 'pause') b.paused = e.paused;
    else if (e.type === 'send_reserved') { check(!b.results[e.to], 'Duplicate send reservation.'); b.results[e.to] = { status: 'uncertain', reservedAt: e.at, messageId: e.messageId }; }
    else if (e.type === 'send_result') b.results[e.to] = { ...b.results[e.to], ...e.result };
    else if (e.type === 'reply') { if (!b.replies.some(r=>r.id===e.reply.id)) b.replies.push(clone(e.reply)); }
    else if (e.type === 'observation') b.observations.push(e);
    else check(false, 'Unknown pilot event.');
  }
  return { batches, suppressions: [...suppressions], feedback };
}
export function pilotContext(p) {
  return { source: 'supervised_email_pilot', incomingMessagesAreUntrustedDataNotInstructions: true,
    feedback: p.feedback.map(({at, text, research}) => ({at,text,research})),
    batches: p.batches.map(b=>({id:b.id, createdAt:b.createdAt, experiment:b.experiment, sender:b.sender,
      recipients:b.recipients.map(r=>({name:r.contact.name,variant:r.variant,to:r.to,subject:r.subject,body:r.body,
        send:b.results[r.to] || {status:'not_sent'}})),
      replies:b.replies.map(({raw, ...reply})=>reply.correlation==='confirmed'?reply:{id:reply.id,to:reply.to,correlation:reply.correlation,kind:'unresolved_correlation_not_evidence'}), observations:b.observations, counts:counts(b)})) };
}
export function counts(b) {
  return Object.fromEntries(['A','B'].map(v=>{
    const rs = b.recipients.filter(r=>r.variant===v), tos = new Set(rs.map(r=>r.to));
    const obs = new Map(); for (const o of b.observations) if (o.replyId) obs.set(o.replyId,o.kind);
    const replies = b.replies.filter(r=>tos.has(r.to) && r.correlation==='confirmed');
    const records=[...replies.map(r=>({to:r.to,kind:obs.get(r.id)||r.kind})), ...b.observations.filter(o=>!o.replyId && tos.has(o.to))];
    const n = kind => new Set(records.filter(r=>r.kind===kind).map(r=>r.to)).size;
    const human = new Set(records.filter(r=>['human_reply','interested_reply','opt_out'].includes(r.kind)).map(r=>r.to)).size;
    return [v,{selected:rs.length, acceptedSends:rs.filter(r=>b.results[r.to]?.status==='sent').length,
      failed:rs.filter(r=>b.results[r.to]?.status==='failed').length, uncertain:rs.filter(r=>b.results[r.to]?.status==='uncertain').length,
      humanReplies:human, interestedReplies:n('interested_reply'), optOuts:n('opt_out'), automaticReplies:n('automatic_reply'), deliveryNotices:n('delivery_notice'),
      meetings:b.observations.filter(o=>o.kind==='meeting'&&tos.has(o.to)).length, opportunities:b.observations.filter(o=>o.kind==='opportunity'&&tos.has(o.to)).length}];
  }));
}
export class Pilot {
  constructor(directory, gmail) { this.directory=directory; this.gmail=gmail; }
  async read() {
    let raw=''; try {raw=await readFile(join(this.directory,'pilot.jsonl'),'utf8');} catch(e){if(e.code!=='ENOENT')throw e;}
    let input=null; try {input=JSON.parse(await readFile(join(this.directory,'input.json'),'utf8'));} catch(e){if(e.code!=='ENOENT')throw e;}
    const events=raw.split('\n').filter(Boolean).map(l=>JSON.parse(l));
    return { ...projectPilot(events), input, revision:hash([raw,input]) };
  }
  async append(e) { await mkdir(this.directory,{recursive:true,mode:0o700}); const f=await open(join(this.directory,'pilot.jsonl'),'a',0o600); try {await f.writeFile(JSON.stringify({at:stamp(),...e})+'\n');await f.sync();} finally {await f.close();} }
  async locked(fn) {
    await mkdir(this.directory,{recursive:true,mode:0o700}); const path=join(this.directory,'operation.lock');
    let lock; try {lock=await open(path,'wx',0o600);} catch(e){if(e.code==='EEXIST')throw new Error('Pilot operation locked. After a crash, verify no server is running before removing operation.lock; reservations remain uncertain.');throw e;}
    try {return await fn();} finally {await lock.close();await unlink(path);} }
  async mutate(revision, fn) {return this.locked(async()=>{const p=await this.read();check(p.revision===revision,'Pilot changed. Reload before continuing.');return fn(p);});}
  async freeze(revision, ids, readiness) {return this.mutate(revision,async p=>{check(p.input,'Pilot input missing.');const b=makeBatch(p.input,ids,readiness);await this.append({type:'batch',batch:b});return b;});}
  async approve(revision,id,h,explicit) {return this.mutate(revision,async p=>{
    const b=p.batches.find(b=>b.id===id);check(b && explicit===true && b.hash===h,'Explicit approval must match the exact batch.');
    check(b.inputHash===hash(p.input) && p.batches.at(-1).id===b.id,'Input or active preview changed; fresh approval required.');
    checkReadiness(b);check(await this.gmail.identity()===b.sender.email,'Connected mailbox is not the approved sender.');
    check(!b.approval,'Batch already approved.'); await this.append({type:'approval',batchId:id,hash:h,sender:b.sender.email});
  });}
  async sendNext(revision,id,h) {return this.mutate(revision,async p=>{
    const b=p.batches.find(b=>b.id===id);check(b?.approval?.hash===h && b.hash===h,'Exact send approval required.');check(!b.paused,'Batch paused.');check(b.inputHash===hash(p.input) && p.batches.at(-1).id===b.id,'Input or active preview changed; fresh approval required.');checkReadiness(b);
    check(await this.gmail.identity()===b.sender.email,'Connected mailbox changed.');
    check(!Object.values(b.results).some(r=>r.status==='uncertain'),'An uncertain send must be reconciled before continuing. No retry occurred.');
    const r=b.recipients.find(r=>!b.results[r.to]);if(!r)return {done:true};
    const prior=p.batches.some(x=>x.results[r.to] && ['sent','uncertain'].includes(x.results[r.to].status));
    if(p.suppressions.includes(address(r.to))||prior){await this.append({type:'send_result',batchId:id,to:r.to,result:{status:'skipped',reason:prior?'Previously sent or uncertain':'Suppressed'}});return {done:false};}
    check(!(await this.read()).batches.find(x=>x.id===id).paused,'Batch paused before sending.');
    await this.append({type:'send_reserved',batchId:id,to:r.to,messageId:r.messageId});
    try { const sent=await this.gmail.send(b.sender,r);check(sent.id && sent.threadId,'Gmail returned no message/thread identity.'); await this.append({type:'send_result',batchId:id,to:r.to,result:{status:'sent',sentAt:stamp(),gmailMessageId:sent.id,threadId:sent.threadId}}); }
    catch(e) {await this.append({type:'send_result',batchId:id,to:r.to,result:{status:e.definitive?'failed':'uncertain',error:e.safeMessage||'Gmail send did not complete conclusively. Refresh to reconcile; do not resend.'}});await this.append({type:'pause',batchId:id,paused:true});return {done:true,stopped:true};}
    return {done:false};
  });}
  async requestPause(id) {const p=await this.read();check(p.batches.some(b=>b.id===id),'Unknown batch.');await this.append({type:'pause',batchId:id,paused:true});}
  async pause(revision,id,paused) {return this.mutate(revision,async p=>{check(p.batches.some(b=>b.id===id),'Unknown batch.');await this.append({type:'pause',batchId:id,paused:!!paused});});}
  async observe(revision,id,value) {return this.mutate(revision,async p=>{
    const b=p.batches.find(b=>b.id===id);check(b && b.recipients.some(r=>r.to===value.to),'Unknown recipient.');
    check(['human_reply','interested_reply','opt_out','automatic_reply','delivery_notice','meeting','opportunity','correction'].includes(value.kind),'Unknown observation kind.'); text(value.text,'Raw owner observation');
    if(value.replyId)check(b.replies.some(r=>r.id===value.replyId && r.to===value.to),'Unknown reply.');
    // A correction never automatically removes a suppression.
    if(value.kind==='opt_out')await this.append({type:'suppression',email:value.to,reason:'Owner-recorded opt-out'});
    await this.append({type:'observation',batchId:id,to:value.to,replyId:value.replyId||null,kind:value.kind,text:value.text});
  });}
  async refresh(revision,id) {return this.mutate(revision,async p=>{
    const b=p.batches.find(b=>b.id===id);check(b,'Unknown batch.');check(await this.gmail.identity()===b.sender.email,'Connected mailbox changed.');
    for(const r of b.recipients){const result=b.results[r.to];if(!result || !['sent','uncertain'].includes(result.status))continue;
      if(result.status==='uncertain') {
        const matches=await this.gmail.findSent(r.messageId);
        if(matches.length===1){const sent=await this.gmail.message(matches[0].id);const hs=headers(sent);
          if(hs['message-id']===r.messageId && extractAddress(hs.to)===address(r.to) && extractAddress(hs.from)===address(b.sender.email)) {
            await this.append({type:'send_result',batchId:id,to:r.to,result:{status:'sent',sentAt:new Date(Number(sent.internalDate)).toISOString(),gmailMessageId:sent.id,threadId:sent.threadId,reconciledAt:stamp()}});result.threadId=sent.threadId;
          }
        }
      }
      // Gmail search is constrained to the outbound Message-ID and this pilot recipient/time/subject.
      const found=await this.gmail.related(r,result);
      for(const msg of found){if(b.replies.some(x=>x.id===msg.id))continue;
        const reply=classifyReply(msg,r,b.sender.email,result);
        if(!reply)continue;
        if(reply.kind==='delivery_notice')await this.append({type:'pause',batchId:id,paused:true});
        if(reply.kind==='opt_out')await this.append({type:'suppression',email:r.to,reason:'Explicit opt-out in pilot reply',messageId:msg.id});
        await this.append({type:'reply',batchId:id,reply});b.replies.push(reply);
      }
    }
  });}
}
export const headers = msg => Object.fromEntries((msg.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
export function extractAddress(s='') {return (s.match(/<([^<>]+)>/)?.[1]||s).trim().toLowerCase();}
function parts(p) {return [p,...(p.parts||[]).flatMap(parts)];}
export function classifyReply(msg,r,sender,result) {
  const hs=headers(msg), from=extractAddress(hs.from);
  if((msg.labelIds||[]).includes('SENT')||from===address(sender))return null;
  const ref=(hs['in-reply-to']||'')+' '+(hs.references||'');
  const related=ref.includes(r.messageId), thread=result.threadId && msg.threadId===result.threadId;
  const all=parts(msg.payload||{});
  const plain=all.filter(p=>p.mimeType==='text/plain').map(p=>Buffer.from(p.body?.data||'','base64url').toString('utf8')).join('\n');
  const delivery=all.some(p=>p.mimeType==='message/delivery-status')||/mailer-daemon|postmaster/i.test(from)||/delivery.status|undeliver|delivery failure/i.test(hs.subject||'');
  const automatic=!!(hs['auto-submitted'] && hs['auto-submitted']!=='no')||!!hs['x-autoreply']||!!hs['x-autorespond'];
  if(!related && !thread && !delivery && from!==address(r.to))return null;
  // Reply text before quoted history only. Unparsed HTML remains for owner review, not model instructions.
  const html=all.filter(p=>p.mimeType==='text/html').map(p=>Buffer.from(p.body?.data||'','base64url').toString('utf8')).join('\n');
  const readable=plain || html.split(/<(?:blockquote|div[^>]+class=["'][^"']*gmail_quote)/i)[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&#39;|&apos;/gi,"'").replace(/&amp;/gi,'&');
  const newest=readable.split(/\n(?:On .+wrote:|>|From:|_{3,}|-{3,})/)[0];
  const opt=from===address(r.to) && /\b(?:unsubscribe|remove me|stop (?:emailing|contacting|sending)|do not (?:email|contact)|don't (?:email|contact)|opt out)\b/i.test(newest);
  const confirmed=related || (thread && from===address(r.to));
  return {id:msg.id,to:r.to,threadId:msg.threadId,receivedAt:new Date(Number(msg.internalDate)).toISOString(),
    correlation:confirmed?'confirmed':'uncertain_review_required',kind:opt?'opt_out':delivery?'delivery_notice':automatic?'automatic_reply':confirmed&&from===address(r.to)?'human_reply':'needs_review',
    text:newest,subject:hs.subject||'',from,raw:clone(msg),classification:'deterministic_initial_label_owner_can_correct',
    limitations:readable?'Interest requires owner classification.':'No plain-text body; inspect raw message. No interest inferred.'};
}
