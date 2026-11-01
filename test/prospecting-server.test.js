import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { ApolloProvider } from '../src/providers/apollo.js';
import { browserModelContext } from '../src/model-context.js';
import { temporaryStore, decision } from './helpers.js';
import { plan, responses, fakeApollo, person } from './prospecting-fixtures.js';

async function setup(t, overrides={}) {
  const store=await temporaryStore(t), providerCalls=[], modelInputs=[], strategicInputs=[];
  const queue=[...responses(), ...responses().map((r,index)=>index===1 ? {people:['p5','p6','p7','p8'].map(id=>person(id))}
    : index===2 ? {matches:['p5','p6'].map(id=>person(id,{email:id+'@example.test'})),credits_consumed:2}:r)];
  const server=createAppServer({store,model:{name:'mock',decide:async c=>{
    modelInputs.push(c);
    return {model:'mock',decision:{...decision,ownerInputRequired:false,ownerApprovalRequired:true},prospectRequest:c.decisionHistory.some(r=>r.outcomes.some(o=>o.cohortReview))
      ? {...plan,segmentHypothesis:'Tentative refinement from owner review: test fit of current facilities responsibilities; do not turn two observations into a permanent rule.'}
      :plan};
  }}, research:async()=>{throw Error('No generic research needed for a ready acquisition request.');},
    prospectProvider:new ApolloProvider({apiKey:'fake',fetchImpl:fakeApollo(queue,providerCalls)}),
    makeDecision:()=>({decide:async c=>{strategicInputs.push(c);return {model:'mock',decision:{...decision,
      recommendedNextStep:'Review these facilities contacts.',evidenceUsed:c.evidenceUsedOptions,ownerInputRequired:false}};}}),...overrides});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));await server.initialize();
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const get=async()=> (await fetch(base+'/api/state')).json();
  const post=async(path,data={})=>{
    const {revision}=await get();
    const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,...data})});
    return {status:res.status,body:await res.json()};
  };
  return {store,get,post,providerCalls,modelInputs,strategicInputs};
}
test('approval -> discovery -> review -> next cohort: append-only, raw feedback, first-use time capture, no sending',async t=>{
  const s=await setup(t);
  const before=await readFile(join(s.store.directory,'state.json'));
  const first=await s.post('/api/run');assert.equal(first.status,201);
  let snapshot=await s.get(),offer=snapshot.history[0].prospectOffer;
  assert.equal(s.providerCalls.length,0);
  const path='/api/decisions/'+first.body.id+'/cohort';
  assert.equal((await s.post(path,{hash:offer.hash})).status,409);
  assert.equal((await s.post(path,{hash:'wrong',approve:true})).status,409);
  assert.equal(s.providerCalls.length,0);
  const acquisition=await s.post(path,{hash:offer.hash,approve:true});assert.equal(acquisition.status,201);
  assert.equal(s.providerCalls.length,3);
  assert.equal((await s.post(path,{hash:offer.hash,approve:true})).status,409);
  snapshot=await s.get();const run=snapshot.history[1];
  assert.equal(run.status,'completed');assert.equal(run.cohort.prospects.length,2);
  assert.equal(s.strategicInputs[0].decisionHistory.length,1);
  assert.ok(!JSON.stringify(s.strategicInputs[0]).includes('rawResponse'));
  const reviews=run.cohort.prospects.map((p,i)=>({prospectId:p.id,choice:i?'reject':'approve',reason:'  Free text\nreason  ',correction:i?'Role changed':'  '}));
  const reviewPath='/api/decisions/'+acquisition.body.id+'/prospect-review';
  assert.equal((await s.post(reviewPath,{reviews,metrics:null})).status,422);
  const metrics={reviewMinutes:9,additionalResearch:'No extra research.',normalMinutes:45};
  assert.equal((await s.post(reviewPath,{reviews,metrics})).status,201);
  assert.equal((await s.post(reviewPath,{reviews,metrics})).status,409);
  const next=await s.post('/api/run');assert.equal(next.status,201);
  const prior=s.modelInputs[1].decisionHistory[1];
  assert.deepEqual(prior.outcomes[0].cohortReview.reviews,reviews);
  assert.deepEqual(prior.outcomes[0].cohortReview.metrics,metrics);
  assert.equal(prior.cohort.prospects[0].attributes.businessEmail,'p1@example.test');
  snapshot=await s.get();offer=snapshot.history.at(-1).prospectOffer;
  assert.match(offer.request.segmentHypothesis,/Tentative refinement/);
  assert.notEqual(offer.hash,snapshot.history[0].prospectOffer.hash);
  const second=await s.post('/api/decisions/'+next.body.id+'/cohort',{hash:offer.hash,approve:true});
  snapshot=await s.get();const secondRun=snapshot.history.at(-1);
  assert.deepEqual(secondRun.cohort.prospects.map(p=>p.id),['apollo:p5','apollo:p6']);
  assert.equal((await s.post('/api/decisions/'+second.body.id+'/prospect-review',{reviews:secondRun.cohort.prospects.map(p=>({prospectId:p.id,choice:'approve',reason:'',correction:''})),metrics:null})).status,201);
  assert.deepEqual(await readFile(join(s.store.directory,'state.json')),before);
  const full=await s.store.read();
  assert.ok(full.events.some(e=>e.type==='prospect_audit' && e.audit.rawResponse));
  assert.ok(!JSON.stringify(browserModelContext(full)).includes('rawResponse'));
});
test('provider permission failure stops, persists original response and consumes approval once',async t=>{
  const calls=[];
  const s=await setup(t,{prospectProvider:new ApolloProvider({apiKey:'fake',fetchImpl:fakeApollo([{httpStatus:403,payload:{error:'Concrete provider restriction'}}],calls)})});
  const first=await s.post('/api/run');const saved=await s.get();const offer=saved.history[0].prospectOffer;
  const path='/api/decisions/'+first.body.id+'/cohort';
  const executed=await s.post(path,{approve:true,hash:offer.hash});
  assert.equal(executed.status,201);assert.equal(calls.length,1);assert.equal(s.strategicInputs.length,0);
  const snap=await s.store.read();
  assert.equal(snap.history.at(-1).status,'failed');
  assert.match(snap.events.find(e=>e.audit?.rawResponse)?.audit.rawResponse,/Concrete provider restriction/);
  assert.equal((await s.post(path,{approve:true,hash:offer.hash})).status,409);assert.equal(calls.length,1);
});
test('strategic failure retains acquired cohort for owner review without reacquisition',async t=>{
  const s=await setup(t,{makeDecision:()=>({decide:async()=>{throw Error('Synthetic strategic failure');}})});
  const first=await s.post('/api/run');const saved=await s.get(),offer=saved.history[0].prospectOffer;
  assert.equal((await s.post('/api/decisions/'+first.body.id+'/cohort',{approve:true,hash:offer.hash})).status,502);
  const snap=await s.get();assert.equal(snap.history[1].status,'failed');assert.equal(snap.history[1].cohort.prospects.length,2);
  assert.equal(s.providerCalls.length,3);
});
test('changed pricing invalidates a saved offer; missing provider never acquires',async t=>{
  const s=await setup(t,{prospectProvider:null});
  const first=await s.post('/api/run');const saved=await s.get();
  assert.equal((await s.post('/api/decisions/'+first.body.id+'/cohort',{approve:true,hash:saved.history[0].prospectOffer.hash})).status,503);
  assert.equal(s.providerCalls.length,0);
});
