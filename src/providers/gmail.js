import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
export const SCOPES=['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'];
const safe = (message, definitive=false) => Object.assign(new Error(message),{safeMessage:message,definitive});
export class Gmail {
  constructor({directory,clientId,clientSecret,redirectUri,fetchImpl=fetch}) {Object.assign(this,{directory,clientId,clientSecret,redirectUri,fetchImpl});this.pending=null;}
  get configured(){return !!(this.clientId&&this.clientSecret&&this.redirectUri);}
  async tokens(){try{return JSON.parse(await readFile(join(this.directory,'gmail-token.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw safe('Cannot read local Gmail authorization.');}}
  async save(value){await mkdir(this.directory,{recursive:true,mode:0o700});const p=join(this.directory,'gmail-token.json');await writeFile(p+'.tmp',JSON.stringify(value),{mode:0o600});await rename(p+'.tmp',p);}
  async status(){const t=await this.tokens();return {configured:this.configured,connected:!!t,mailbox:t?.mailbox||null};}
  connect(expected,ownerAuthorized){if(!this.configured||!ownerAuthorized)throw safe('Mailbox-owner authorization and OAuth configuration are required.');
    const state=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('base64url');
    this.pending={state,verifier,expected,expires:Date.now()+600000};
    const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',login_hint:expected});return u.href;
  }
  async tokenRequest(fields){let response;try{response=await this.fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,...fields}),signal:AbortSignal.timeout(30000)});}catch{throw safe('Gmail authorization request failed. No email was sent.');}
    if(!response.ok)throw safe('Google authorization failed; reconnect the intended mailbox.');return response.json();}
  async callback(code,state){const p=this.pending;this.pending=null;if(!p||state!==p.state||p.expires<Date.now()||!code)throw safe('Expired or invalid Gmail authorization.');
    const t=await this.tokenRequest({grant_type:'authorization_code',code,redirect_uri:this.redirectUri,code_verifier:p.verifier});
    if(!t.refresh_token || !SCOPES.every(s=>(t.scope||'').split(' ').includes(s)))throw safe('Google did not grant the required pilot permissions.');
    const profile=await this.request('profile',{accessToken:t.access_token});
    if(profile.emailAddress!==p.expected)throw safe('Wrong mailbox. No authorization saved. Connect the approved sender’s own Google mailbox.');
    await this.save({...t,mailbox:p.expected,expiresAt:Date.now()+t.expires_in*1000});return p.expected;
  }
  async access(){const t=await this.tokens();if(!t)throw safe('Connect the mailbox first.');if(t.expiresAt>Date.now()+60000)return t.access_token;
    const next=await this.tokenRequest({grant_type:'refresh_token',refresh_token:t.refresh_token});await this.save({...t,...next,refresh_token:next.refresh_token||t.refresh_token,expiresAt:Date.now()+next.expires_in*1000});return next.access_token;}
  async request(path,{method='GET',body,accessToken}={}){
    const token=accessToken||await this.access();let response;
    try{response=await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});}catch{throw safe('Gmail request timed out or disconnected. Its outcome may be uncertain.');}
    if(!response.ok)throw safe('Gmail rejected the request (HTTP '+response.status+').',response.status>=400&&response.status<500);
    try{return await response.json();}catch{throw safe('Gmail returned an unreadable response; outcome is uncertain.');}
  }
  async identity(){return (await this.request('profile')).emailAddress;}
  async send(sender,r){
    const subject='=?UTF-8?B?'+Buffer.from(r.subject).toString('base64')+'?=';
    const name='=?UTF-8?B?'+Buffer.from(sender.name).toString('base64')+'?=';
    const body=Buffer.from(r.body.replace(/\r?\n/g,'\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
    const mime=[`From: ${name} <${sender.email}>`,`To: ${r.to}`,`Reply-To: ${sender.email}`,`Subject: ${subject}`,`Message-ID: ${r.messageId}`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+body].join('\r\n');
    return this.request('messages/send',{method:'POST',body:{raw:Buffer.from(mime).toString('base64url')}});
  }
  async list(q){const messages=[];let page;do{const result=await this.request('messages?'+new URLSearchParams({q,maxResults:'100',...(page?{pageToken:page}:{})}));messages.push(...result.messages||[]);page=result.nextPageToken;}while(page);return messages;}
  findSent(messageId){return this.list('in:sent rfc822msgid:'+messageId.replace(/[<>]/g,''));}
  message(id,format='full'){return this.request('messages/'+encodeURIComponent(id)+'?format='+format);}
  async related(r,result){
    const after=Math.floor(Date.parse(result.reservedAt||result.sentAt)/1000)-60;
    const escaped=r.subject.replace(/["\\]/g,'');
    const queries=[`in:anywhere -in:sent after:${after} rfc822msgid:${r.messageId.replace(/[<>]/g,'')}`,
      `in:anywhere -in:sent after:${after} from:${r.to} subject:"${escaped}"`,
      `in:anywhere -in:sent after:${after} {from:mailer-daemon from:postmaster} "${r.to}"`];
    const ids=new Set();for(const q of queries)for(const m of await this.list(q))ids.add(m.id);
    // Thread lookup is first metadata only; fetch bodies only for direct pilot references/participants.
    if(result.threadId){const t=await this.request('threads/'+encodeURIComponent(result.threadId)+'?format=metadata');
      for(const m of t.messages||[]){const h=Object.fromEntries((m.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));
        if(!(m.labelIds||[]).includes('SENT') && ((h.references||'').includes(r.messageId)||(h['in-reply-to']||'').includes(r.messageId)||(h.from||'').toLowerCase().includes(r.to.toLowerCase())))ids.add(m.id);}}
    const messages=[];
    for(const id of ids){
      const metadata=await this.message(id,'metadata');
      const h=Object.fromEntries((metadata.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));
      const from=((h.from||'').match(/<([^<>]+)>/)?.[1]||h.from||'').trim().toLowerCase();
      const reference=(h.references||'').includes(r.messageId)||(h['in-reply-to']||'').includes(r.messageId);
      const participant=metadata.threadId===result.threadId && from===r.to.toLowerCase();
      const notice=/mailer-daemon|postmaster/i.test(from);
      // A same-subject search hit alone is not permission to read an unrelated body.
      // Delivery notices found by the recipient/time query remain uncertain unless references match.
      if(!(metadata.labelIds||[]).includes('SENT') && (reference||participant||notice))messages.push(await this.message(id));
    }
    return messages;
  }
}
