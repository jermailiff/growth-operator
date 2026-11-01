import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireCohort, quoteProspects, validateProspectRequest, validateReview, cohortSourceBlocks, pricingFromEnv, unwrapProspectResponse } from '../src/prospecting.js';
import { ApolloProvider } from '../src/providers/apollo.js';
import { createModel } from '../src/model.js';
import { decideFromCohort } from '../src/continuation.js';
import { plan, person, fakeApollo, responses } from './prospecting-fixtures.js';
import { state, decision } from './helpers.js';

async function build(p = plan, queue = responses(), priorIds = []) {
  const calls = [], audit = [];
  const cohort = await acquireCohort({ offer: quoteProspects(p, { organization:1, enrichment:1 }),
    provider: new ApolloProvider({ apiKey:'fake',fetchImpl:fakeApollo(queue,calls) }), priorIds, record: async e => audit.push(structuredClone(e)) });
  return { cohort,calls,audit };
}
test('discovery pool -> frozen cohort -> selective enrichment; raw status, provenance and credits retained', async () => {
  const { cohort,calls,audit } = await build();
  assert.equal(cohort.status,'completed'); assert.equal(cohort.prospects.length,2);
  assert.equal(calls[1].body.per_page,4);
  assert.deepEqual(calls[2].body.details,[{id:'p1'},{id:'p2'}]);
  assert.equal(calls[1].body.organization_locations,undefined);
  assert.deepEqual(calls[1].body.person_locations,['Oakland']);
  for(const key of ['reveal_phone_number','reveal_personal_emails','run_waterfall_email','run_waterfall_phone']) assert.equal(new URL(calls[2].url).searchParams.get(key),'false');
  assert.equal(cohort.prospects[0].emailStatus,'verified');
  assert.equal(cohort.prospects[0].hypothesis.status,'inference');
  assert.equal(cohort.prospects[0].sourceStatus,'provider_claim');
  assert.equal(cohort.usage.reportedCredits,3);
  assert.ok(audit.some(x => x.rawResponse && x.headers['x-request-id']==='synthetic'));
  assert.ok(audit.findIndex(x=>x.phase==='cohort_selected') < audit.findIndex(x=>x.endpoint==='/people/bulk_match'));
  assert.ok(!JSON.stringify(cohortSourceBlocks(cohort)).includes('preventive maintenance'));
});
test('does not enrich where selected search records already contain the requested fields; never fills allowance', async () => {
  const p={...plan,fields:plan.fields.filter(f=>f.field!=='businessEmail')};
  const { calls,cohort }=await build(p,responses().slice(0,2));
  assert.equal(calls.length,2); assert.equal(cohort.prospects.length,2);
});
test('paid selection cannot depend on absent enrichment fields or arbitrary scoring criteria', () => {
  assert.throws(()=>validateProspectRequest({...plan,buyerScore:90}));
  assert.throws(()=>validateProspectRequest({...plan,tenureMinimum:2}));
  assert.throws(()=>validateProspectRequest({...plan,fields:[{field:'wealth',purpose:'Score'}]}));
  assert.throws(()=>validateProspectRequest({...plan,maxEnrichments:3}));
  assert.throws(()=>quoteProspects({...plan,maxCredits:1},{organization:1,enrichment:1}));
});
test('deduplicates provider identities and prior cohorts; employer, title and known location mismatches excluded before enrichment', async () => {
  const p={...plan,poolSize:8,cohortSize:1,maxEnrichments:1};
  const q=[responses()[0], {people:[person('prior'),person('prior'),person('wrongOrg',{organization:{id:'other'}}),
    person('wrongTitle',{title:'Accountant'}),person('wrongCity',{city:'Boston'}),person('okay')]},
    {matches:[person('okay',{email:'okay@example.test'})],credits_consumed:1}];
  const {cohort,calls}=await build(p,q,['apollo:prior']);
  assert.deepEqual(calls[2].body.details,[{id:'okay'}]);
  assert.equal(cohort.selection.filter(s=>s.selected).length,1);
});
test('missing search location is filter-based unknown, not an invented reported location', async () => {
  const q=responses();q[1].people=q[1].people.map(p=>({...p,city:null,state:null}));
  const {audit}=await build(plan,q);
  const selected=audit.find(e=>e.phase==='cohort_selected').cohort;
  assert.equal(selected.prospects[0].attributes.location,null);
  assert.match(selected.prospects[0].fit.explanation,/filter-based/);
});
test('enrichment identity mismatch never merges wrong data or retries', async () => {
  const q=responses();q[2].matches.reverse();
  const {cohort,calls}=await build(plan,q);
  assert.equal(cohort.status,'partial_or_failed');
  assert.match(cohort.error,/identity mismatch/);
  assert.ok(cohort.prospects.every(p=>p.attributes.businessEmail===null));assert.equal(calls.length,3);
});
test('enrichment conflicts withheld; selected cohort is not refilled or reranked', async () => {
  const q=responses();q[2].matches[0].organization={id:'wrong'};
  const {cohort,calls}=await build(plan,q);
  assert.deepEqual(cohort.prospects.map(p=>p.providerPersonId),['p1','p2']);
  assert.equal(cohort.prospects[0].attributes.businessEmail,null);
  assert.match(cohort.prospects[0].unknowns.join(),/conflicts/);assert.equal(calls.length,3);
});
test('rate, permission, transport and malformed responses stop with audit and no retry', async () => {
  for(const first of [{httpStatus:403,payload:{error:'Restricted'}},{httpStatus:429,payload:{error:'Rate'}},new Error('network'),{organizations:'bad'}]){
    const {cohort,calls,audit}=await build(plan,[first]);
    assert.equal(cohort.status,'partial_or_failed');assert.equal(calls.length,1);assert.ok(audit.length);
  }
});
test('call cap, credit deviation, bad approval hash and deadline stop execution', async () => {
  const {cohort,calls}=await build({...plan,maxCalls:2},responses().slice(0,2));
  assert.equal(calls.length,2);assert.match(cohort.error,/bound/);
  const q=responses();q[0].credits_consumed=2;
  assert.match((await build(plan,q)).cohort.error,/ceiling/);
  await assert.rejects(acquireCohort({offer:{...quoteProspects(plan,{organization:1,enrichment:1}),hash:'tampered'}}),/hash/);
  let time=0;
  const expired=await acquireCohort({offer:quoteProspects(plan,{organization:1,enrichment:1}),
    provider:{organizations:async()=>{time=60001;return responses()[0];}},record:async()=>{},clock:()=>time});
  assert.match(expired.error,/deadline/);
  assert.throws(()=>pricingFromEnv({APOLLO_ENRICHMENT_CREDIT_CEILING:'bad'}));
});
test('unknown usage is unknown; no guessed email status upgrading; null enrichment preserves discovered record', async () => {
  const q=responses();delete q[0].credits_consumed;q[2]={matches:[null,person('p2',{email:'p2@example.test',email_status:'guessed'})]};
  const {cohort}=await build(plan,q);
  assert.equal(cohort.usage.actualCreditsKnown,false);
  assert.equal(cohort.prospects[0].attributes.businessEmail,null);
  assert.equal(cohort.prospects[1].emailStatus,'guessed');
  assert.match(cohort.prospects[1].contactRoute.verification,/no deliverability/);
});
test('review preserves free text and requires a single explicit choice per actual prospect', async () => {
  const {cohort}=await build();
  const input={reviews:cohort.prospects.map(p=>({prospectId:p.id,choice:'reject',reason:'  Raw\nreason  ',correction:'actually remote\n'})),metrics:{reviewMinutes:8,additionalResearch:'None',normalMinutes:45}};
  assert.equal(validateReview(input,cohort),input);assert.equal(input.reviews[0].reason,'  Raw\nreason  ');
  assert.throws(()=>validateReview({...input,reviews:[input.reviews[0],input.reviews[0]]},cohort));
  assert.throws(()=>validateReview({...input,reviews:input.reviews.map(r=>({...r,choice:'pending'}))},cohort));
  assert.throws(()=>validateReview({...input,metrics:{}},cohort));
});
test('capability envelope uses existing decision call, supports restraint, enforces approval flags', async () => {
  let sent;
  const approved={...decision,ownerInputRequired:false,ownerApprovalRequired:true};
  const model=createModel({apiKey:'fake',model:'mock',prospecting:true,fetchImpl:async(_url,options)=>{
    sent=JSON.parse(options.body);return Response.json({status:'completed',model:'mock',output:[{content:[{type:'output_text',text:JSON.stringify({decision:approved,prospectRequest:plan})}]}]});
  }});
  const r=await model.decide({...state,decisionHistory:[]});
  assert.deepEqual(r.prospectRequest,plan);
  assert.ok(sent.text.format.schema.properties.prospectRequest);
  assert.match(sent.instructions,/Do not add a generic compliance investigation/);
  assert.throws(()=>unwrapProspectResponse({decision,prospectRequest:plan},false),/approval/);
  assert.equal(unwrapProspectResponse({decision,prospectRequest:null},false).prospectRequest,null);
});
test('provider evidence is exact selectable snapshots; no web-source bypass or arbitrary selection', async () => {
  const {cohort}=await build();
  const context={...state,decisionHistory:[]};
  let received;
  const result=await decideFromCohort(context,cohort,schema=>({decide:async c=>{
    received=c;assert.deepEqual(schema.properties.evidenceUsed.items.enum,c.evidenceUsedOptions);
    return {model:'mock',decision:{...decision,evidenceUsed:[c.evidenceUsedOptions.at(-1)]}};
  }}));
  assert.equal(result.selectedEvidence[0].epistemicStatus,'provider_claim');
  assert.ok(!JSON.stringify(received).includes('rawResponse'));
  await assert.rejects(decideFromCohort(context,cohort,()=>({decide:async()=>({decision:{...decision,evidenceUsed:['invented']},model:'mock'})})),/changed captured/);
});

test('25-person review cohort comes from a 40-person search pool and only those 25 are enriched in ten-person batches', async () => {
  const p={...plan,cohortSize:25,poolSize:40,maxEnrichments:25,maxCalls:5,maxCredits:26};
  const people=Array.from({length:40},(_,i)=>person('p'+i));
  const q=[responses()[0],{people}];
  for(let i=0;i<25;i+=10) q.push({matches:people.slice(i,Math.min(i+10,25)).map(p=>({...p,email:p.id+'@example.test'})),credits_consumed:Math.min(10,25-i)});
  const {cohort,calls}=await build(p,q);
  assert.equal(cohort.status,'completed');assert.equal(cohort.prospects.length,25);
  assert.equal(calls[1].body.per_page,40);
  assert.deepEqual(calls.slice(2).map(c=>c.body.details.length),[10,10,5]);
  assert.equal(new Set(calls.slice(2).flatMap(c=>c.body.details.map(d=>d.id))).size,25);
  assert.ok(!calls.slice(2).some(c=>c.body.details.some(d=>d.id==='p25')));
});

test('only selected records with missing requested information are enriched, not the whole selected cohort', async () => {
  const q=responses();q[1].people[0].email='already@example.test';q[1].people[0].email_status='unverified';
  q[2]={matches:[person('p2',{email:'p2@example.test'})],credits_consumed:1};
  const {cohort,calls}=await build(plan,q);
  assert.deepEqual(calls[2].body.details,[{id:'p2'}]);
  assert.equal(cohort.prospects[0].emailStatus,'unverified');
  assert.equal(cohort.usage.reservedCredits,2);
});

test('nested strategic envelope retains research inference accounting while carrying a new acquisition proposal', async () => {
  const { decisionEnvelopeSchema, validateDecisionEnvelope } = await import('../src/evidence.js');
  const report={evidence:[{id:'I',status:'inference',statement:'A test may clarify demand.',sourceUrls:[],contextRefs:[],basisIds:['O'],support:'Derived'},
    {id:'O',status:'owner_provided',statement:'Some capacity is available.',sourceUrls:[],contextRefs:['/context/state'],basisIds:[],support:'Source'}]};
  const envelope={decision:{...decision,ownerApprovalRequired:true,ownerInputRequired:false,evidenceUsed:[]},
    researchInferencesNotReliedUpon:[{inferenceId:'I',reason:'irrelevant_to_selected_action',explanation:'Different action.'}]};
  const schema=decisionEnvelopeSchema(report);
  const model=createModel({apiKey:'fake',model:'mock',prospecting:true,decisionSchema:schema,fetchImpl:async()=>Response.json({
    status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...envelope,prospectRequest:plan})}]}]})});
  const result=await model.decide({...state,decisionHistory:[]});
  assert.deepEqual(result.prospectRequest,plan);
  // The capability wrapper neither consumes nor discards the existing accounting envelope.
  assert.deepEqual(result.decision,envelope);
  validateDecisionEnvelope(result.decision,report);
});

test('search preview with exact employer name and redacted surname is selected without inventing identity; only selected IDs enriched', async () => {
  const q=responses();
  q[1].people=q[1].people.map(p=>({id:p.id,first_name:p.first_name,last_name_obfuscated:'S***',title:p.title,has_email:true,organization:{name:'Example Manufacturing'}}));
  const {cohort,calls,audit}=await build(plan,q);
  const before=audit.find(e=>e.phase==='cohort_selected').cohort.prospects;
  assert.equal(before[0].attributes.name,null);
  assert.equal(before[0].attributes.location,null);
  assert.equal(before[0].attributes.businessEmail,null);
  assert.deepEqual(calls[2].body.details,[{id:'p1'},{id:'p2'}]);
  assert.equal(cohort.prospects[0].attributes.name,'Synthetic p1');
});
