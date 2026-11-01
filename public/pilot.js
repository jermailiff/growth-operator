const $=id=>document.getElementById(id);let current,stop=false,sending=false;
const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
function notice(s){$('notice').textContent=s;}
async function api(path,data){const r=await fetch('/api/pilot'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify({revision:current.revision,...data}):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
const button=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;notice("Working…");try{await fn();await load();}catch(e){notice(e.message);}finally{b.disabled=false;}};return b;};
function link(url){const a=node('a',url);try{if(!['https:','http:'].includes(new URL(url).protocol))return node('span',url);}catch{return node('span',url);}a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function render(){
 $('mailbox').textContent=`Intended sender: ${current.input?.sender?.name||'Not set'} <${current.input?.sender?.email||'not set'}>. Connected: ${current.mailbox.mailbox||'none'}. OAuth ${current.mailbox.configured?'configured':'not configured'}.`;
 $('connect').disabled=!current.mailbox.configured;
 $('feedback').replaceChildren(...current.feedback.map(f=>node('p',f.text)));
 $('contacts').replaceChildren();for(const p of current.input?.contacts||[]){const row=node('article');const label=node('label');const box=node('input');box.type='checkbox';box.value=p.id;box.className='recipient';box.disabled=p.eligibility!=='supported'||!p.email;label.append(box,document.createTextNode(`${p.name} — ${p.role} — ${p.eligibility} — ${p.email||'no published email'}`));row.append(label,node('p',(p.gaps||[]).join(' ')));const details=node('details');details.append(node('summary','Evidence & freshness'),node('pre',JSON.stringify(p,null,2)));for(const u of p.sources||[])details.append(link(u),node('br'));row.append(details);$('contacts').append(row);}
 $('drafts').replaceChildren();for(const [v,d] of Object.entries(current.input?.variants||{})){$('drafts').append(node('h3',`${v}: ${d.subject}`),node('pre',d.body));}
 if(!$('footer').value)$('footer').value=current.input?.footerPreview||'';
 $('batches').replaceChildren();for(const b of [...current.batches].reverse()){
 const card=node('article');card.append(node('h3',`${b.createdAt} — ${b.recipients.length} recipients`),node('p',`A: ${b.recipients.filter(r=>r.variant==='A').length}; B: ${b.recipients.filter(r=>r.variant==='B').length}. ${b.approval?'Approved exact snapshot':'Not approved to send'}. ${b.paused?'Paused':''}`));
 const details=node('details');details.open=true;details.append(node('summary','Exact sender, recipients and messages'));details.append(node('p',`From: ${b.sender.name} <${b.sender.email}>`));
 for(const r of b.recipients){details.append(node('h4',`${r.contact.name} <${r.to}> · ${r.variant} · ${b.results[r.to]?.status||'not sent'}`),node('strong',r.subject),node('pre',r.body));}
 card.append(details,node('p','Approval binds all messages, assignments, sender and readiness checks. Accepted sends do not establish inbox delivery.'));
 if(!b.approval)card.append(button('Approve this exact send batch',async()=>{if(!confirm('Approve sending these exact messages to these exact recipients from the shown mailbox?'))return;await api('/approve',{id:b.id,hash:b.hash,approve:true});}));
 else {card.append(button('Send approved unsent messages',async()=>{
 if(sending)return;stop=false;sending=true;
 try{while(!stop){const r=await api('/send-next',{id:b.id,hash:b.hash});await load();if(r.done)break;}notice(stop?'Paused before the next message.':'Send operation stopped. Inspect each result.');}finally{sending=false;}
 }));card.append(button(b.paused?'Resume eligibility (does not send)':'Pause unsent messages',async()=>{stop=true;await api('/pause',{id:b.id,paused:!b.paused});}));}
 card.append(button('Refresh results',async()=>{await api('/refresh',{id:b.id});notice('Results refreshed. No follow-up sent.');}));
 const tally={};for(const v of ['A','B']){const rs=b.recipients.filter(r=>r.variant===v);tally[v]={selected:rs.length,sent:rs.filter(r=>b.results[r.to]?.status==='sent').length,failed:rs.filter(r=>b.results[r.to]?.status==='failed').length,uncertain:rs.filter(r=>b.results[r.to]?.status==='uncertain').length};}
 card.append(node('pre',JSON.stringify(b.counts||tally,null,2)),node('p','Reply counts are unique recipients per category / selected recipients; inspect accepted-send counts separately. Small-sample observations, not a proven winner.'));
 for(const reply of b.replies){card.append(node('h4',`${reply.to}: ${reply.kind} (${reply.correlation})`),node('p',reply.id),node('pre',reply.text),node('p',reply.limitations));const audit=node('details');audit.append(node('summary','Raw Gmail response'),node('pre',JSON.stringify(reply.raw,null,2)));card.append(audit);}
 const form=node('form'),recipient=node('select'),kind=node('select'),raw=node('textarea'),replyId=node('input');
 for(const r of b.recipients){const o=node('option',r.contact.name);o.value=r.to;recipient.append(o);}for(const k of ['human_reply','interested_reply','opt_out','automatic_reply','delivery_notice','meeting','opportunity','correction']){const o=node('option',k);kind.append(o);}raw.required=true;
 for(const [label,field] of [['Recipient',recipient],['Observation type',kind],['Optional reply ID to correct',replyId],['Raw owner observation / correction',raw]]){const l=node('label',label);field.setAttribute('aria-label',label);l.append(field);form.append(l);}const save=node('button','Record observation');save.type='submit';form.append(save);form.onsubmit=async e=>{e.preventDefault();try{await api('/observe',{id:b.id,observation:{to:recipient.value,kind:kind.value,text:raw.value,replyId:replyId.value||null}});await load();notice('Observation recorded verbatim.');}catch(e){notice(e.message);}};card.append(form);
 for(const o of b.observations)card.append(node('p',`${o.kind} · ${o.to}: ${o.text}`));$('batches').append(card);}
}
async function load(){current=await api('');render();}
$('connect').onclick=async()=>{try{const r=await api('/connect',{ownerAuthorized:$('owner-authorized').checked});location.href=r.url;}catch(e){notice(e.message);}};
$('prepare').onsubmit=async e=>{e.preventDefault();try{const readiness={optOutMethod:'reply'};for(const id of ['footer','postalAddress','optOutInstructions','ownerAuthorizedMailbox','serviceEvidence','authenticationEvidence'])readiness[id]=$(id).value;for(const id of ['footerApproved','linksChecked','serviceSuitable','authenticationPassed'])readiness[id]=$(id).checked;
 await api('/freeze',{ids:[...document.querySelectorAll('.recipient:checked')].map(n=>n.value),readiness});await load();notice('Assignment frozen. No email sent.');}catch(e){notice(e.message);}};
load().catch(e=>notice(e.message));
