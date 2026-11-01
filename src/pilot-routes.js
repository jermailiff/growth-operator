import { counts } from './pilot.js';
// Local, supervised pilot routes. No model calls and no sends from GET/OAuth/preview.
export async function pilotReadRoute(pilot, url, send) {
  if(!pilot)return false;
  if(url.pathname==='/api/pilot') {const p=await pilot.read();return send(200,{...p,mailbox:await pilot.gmail.status(),batches:p.batches.map(b=>({...b,counts:counts(b),replies:b.replies}))}),true;}
  if(url.pathname==='/api/pilot/oauth/callback'){
    try{await pilot.gmail.callback(url.searchParams.get('code'),url.searchParams.get('state'));send(200,'Mailbox connected. No email sent. Return to /pilot.html to preview and review.','text/plain; charset=utf-8');}
    catch{send(400,'Mailbox connection failed or wrong account selected. No email sent. Return to /pilot.html.','text/plain; charset=utf-8');}return true;
  }
  return false;
}
export async function pilotWriteRoute(pilot,path,input,send){
  if(!pilot || !path.startsWith('/api/pilot/'))return false;
  const {revision,id,hash}=input;
  if(path==='/api/pilot/connect'){
    const p=await pilot.read();if(p.revision!==revision)throw new Error('Pilot changed; reload before connecting.');
    if(!p.input?.sender?.email)throw new Error('Set the owner’s sender identity first.');
    send(200,{url:pilot.gmail.connect(p.input.sender.email,input.ownerAuthorized===true)});
  }else if(path==='/api/pilot/freeze')send(201,await pilot.freeze(revision,input.ids,input.readiness));
  else if(path==='/api/pilot/approve'){await pilot.approve(revision,id,hash,input.approve);send(200,{saved:true});}
  else if(path==='/api/pilot/send-next')send(200,await pilot.sendNext(revision,id,hash));
  else if(path==='/api/pilot/pause'){await pilot.pause(revision,id,input.paused);send(200,{saved:true});}
  else if(path==='/api/pilot/refresh'){await pilot.refresh(revision,id);send(200,{saved:true});}
  else if(path==='/api/pilot/observe'){await pilot.observe(revision,id,input.observation);send(200,{saved:true});}
  else throw new Error('Unknown pilot action.');
  return true;
}
