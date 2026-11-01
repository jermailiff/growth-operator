import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWebProspecting, webCandidates } from '../src/providers/public-web.js';
import { quoteProspects, validateProspectRequest, cohortSourceBlocks } from '../src/prospecting.js';
import { createAppServer } from '../src/server.js';
import { temporaryStore, decision } from './helpers.js';
import { webPlan, candidate, webPayload, sourceUrl } from './public-web-fixtures.js';
const offer = () => quoteProspects(webPlan, { organization: 1, enrichment: 1 });
async function execute(payload = webPayload(), options = {}) {
  const audits = [], requests = [];
  const acquire = createWebProspecting({ apiKey: 'fake', model: 'mock', fetchImpl: async (_, request) => {
    requests.push(JSON.parse(request.body)); return Response.json(payload);
  } });
  const cohort = await acquire({ offer: offer(), record: async a => audits.push(structuredClone(a)), ...options });
  return { cohort, audits, requests };
}
test('public-web scope is separately approved and enforces finite limits', () => {
  assert.equal(offer().creditCeiling, 0);
  assert.equal(offer().hash, offer().hash);
  for (const patch of [{ maxCalls: 6 }, { deadlineSeconds: 181 }, { cohortSize: 26 }, { sourceDomains: ['linkedin.com'] }, { sourceDomains: ['workshop.example/path'] }]) {
    assert.throws(() => validateProspectRequest({ ...webPlan, ...patch }));
  }
});
test('one hosted invocation returns cited candidates with contact routes and complete audit', async () => {
  const { cohort, audits, requests } = await execute();
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tool_calls, 5); assert.equal(requests[0].max_output_tokens, 6000);
  assert.equal(requests[0].tool_choice, 'auto'); assert.equal(requests[0].background, false);
  assert.deepEqual(requests[0].tools[0].filters.allowed_domains, webPlan.sourceDomains);
  assert.equal(cohort.prospects.length, 1); assert.equal(cohort.prospects[0].contactRoute.value, candidate().contact.value);
  assert.equal(cohort.prospects[0].sources.name.citation.method, 'exact');
  assert.deepEqual(JSON.parse(audits.find(a => a.rawResponse).rawResponse), webPayload());
  assert.ok(cohort.warnings.some(w => w.includes('Fewer')));
  assert.ok(cohortSourceBlocks(cohort)[0].text.includes(sourceUrl));
});
test('missing contact/location are explicit gaps and prior candidate is not reacquired', async () => {
  const c = candidate(); c.contact = null; c.location = null;
  const first = await execute(webPayload([c]));
  assert.equal(first.cohort.prospects[0].contactRoute, null);
  assert.match(first.cohort.prospects[0].unknowns.join(' '), /location is not established/);
  const second = await execute(webPayload([c]), { priorIds: [first.cohort.prospects[0].id] });
  assert.equal(second.cohort.prospects.length, 0); assert.equal(second.cohort.exclusions.length, 1);
});
test('invented source, guessed contact and wrong employer exclude complete records', async () => {
  for (const mutate of [c => c.name.sourceUrl += '/invented', c => c.contact.support = 'A guessed address', c => c.company.value = 'Other firm']) {
    const c = candidate(); mutate(c);
    const { cohort } = await execute(webPayload([c]));
    assert.equal(cohort.prospects.length, 0); assert.equal(cohort.exclusions.length, 1);
  }
});
test('one unsupported candidate does not remove independent supported candidates or leak their claim', async () => {
  const bad = candidate(); bad.name.value = 'Unsupported person'; bad.name.sourceUrl += '/invented';
  const { cohort } = await execute(webPayload([bad, candidate()]));
  assert.equal(cohort.prospects.length, 1); assert.equal(cohort.status, 'partial_or_failed');
  assert.equal(JSON.stringify(cohort).includes('Unsupported person'), false);
});
test('contact page is itself cited and distinct from assumed messaging availability', async () => {
  const c = candidate(); c.contact = { type: 'professional_contact_page', value: sourceUrl, sourceUrl, support: 'Professional contact form for Taylor.' };
  const result = await execute(webPayload([c]));
  assert.equal(result.cohort.prospects[0].contactRoute.value, sourceUrl);
  c.contact.value += '/guessed-form';
  assert.equal((await execute(webPayload([c]))).cohort.prospects.length, 0);
});
test('incomplete, out-of-scope, excessive calls and malformed reports remain hard failures', async () => {
  for (const mutate of [p => p.status = 'incomplete', p => p.output.push(...Array(5).fill(p.output[0])),
    p => p.output[0].action = { type: 'open_page', url: 'https://outside.example/team' },
    p => p.output.at(-1).content[0].text = '{',
    p => { const r = JSON.parse(p.output.at(-1).content[0].text); r.scopeCompliant = false; p.output.at(-1).content[0].text = JSON.stringify(r); }]) {
    const p = webPayload(); mutate(p);
    const { cohort, requests, audits } = await execute(p);
    assert.equal(cohort.prospects.length, 0); assert.ok(cohort.error); assert.equal(requests.length, 1); assert.ok(audits.some(a => a.rawResponse));
  }
});
test('approval hash tampering prevents all web dispatch', async () => {
  let calls = 0;
  const acquire = createWebProspecting({ apiKey: 'fake', model: 'mock', fetchImpl: async () => { calls++; } });
  await assert.rejects(acquire({ offer: { ...offer(), hash: 'bad' }, record: async () => {} }), /hash mismatch/);
  assert.equal(calls, 0);
});
test('browser server requires one-time approval and owner review reaches the next run', async t => {
  const store = await temporaryStore(t), before = await readFile(join(store.directory, 'state.json'));
  let calls = 0; const contexts = [];
  const server = createAppServer({ store, model: { name: 'mock', decide: async context => {
    contexts.push(context); return { model: 'mock', decision: { ...decision, ownerInputRequired: false, ownerApprovalRequired: true }, prospectRequest: webPlan };
  } }, webProspecting: createWebProspecting({ apiKey: 'fake', model: 'mock', fetchImpl: async () => { calls++; return Response.json(webPayload()); } }),
    makeDecision: () => ({ decide: async c => ({ model: 'mock', decision: { ...decision, evidenceUsed: c.evidenceUsedOptions } }) }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await server.initialize();
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async () => (await fetch(base + '/api/state')).json();
  const post = async (path, data = {}) => { const { revision } = await get(); const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...data }) }); return { status: r.status, body: await r.json() }; };
  const first = await post('/api/run'); let s = await get(); const path = '/api/decisions/' + first.body.id + '/cohort', hash = s.history[0].prospectOffer.hash;
  assert.equal(calls, 0); assert.equal((await post(path, { hash })).status, 409);
  assert.equal((await post(path, { hash: 'wrong', approve: true })).status, 409);
  await post(path, { hash, approve: true }); s = await get();
  assert.equal(calls, 1); const run = s.history[1]; assert.equal(run.status, 'completed');
  assert.equal((await post(path, { hash, approve: true })).status, 409);
  const reviews = run.cohort.prospects.map(p => ({ prospectId: p.id, choice: 'reject', reason: '  Wrong location\nKeep this raw. ', correction: 'Moved.' }));
  assert.equal((await post('/api/decisions/' + run.id + '/prospect-review', { reviews, metrics: { reviewMinutes: 2, normalMinutes: 20, additionalResearch: 'Checked location.' } })).status, 201);
  await post('/api/run');
  assert.deepEqual(contexts[1].decisionHistory[1].outcomes[0].cohortReview.reviews, reviews);
  assert.deepEqual(await readFile(join(store.directory, 'state.json')), before);
});

test('HTTP rejection and network failure make only one attempt and retain honest failures', async () => {
  for (const failure of ['http', 'network']) {
    let calls = 0; const audits = [];
    const acquire = createWebProspecting({ apiKey: 'fake', model: 'mock', fetchImpl: async (_, request) => {
      assert.ok(request.signal instanceof AbortSignal); calls++;
      if (failure === 'network') throw new Error('Synthetic network failure');
      return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 });
    } });
    const result = await acquire({ offer: offer(), record: async a => audits.push(a) });
    assert.equal(calls, 1); assert.equal(result.status, 'partial_or_failed'); assert.equal(result.prospects.length, 0);
    assert.match(result.error, failure === 'http' ? /HTTP 429/ : /network failure/);
    assert.equal(audits.at(-1).phase, 'cohort_finished');
  }
});

test('public-web fields preserve the narrow provider-corroborated tracking alias without rewriting URLs', async () => {
  const p = webPayload(); p.output.at(-1).content[0].annotations[0].url = sourceUrl + '?utm_source=openai';
  const before = JSON.stringify(p), result = await execute(p);
  assert.equal(result.cohort.prospects[0].sources.name.citation.method, 'provider_corroborated_utm_source_openai_alias');
  assert.equal(result.cohort.prospects[0].sourceRef, sourceUrl); assert.equal(JSON.stringify(p), before);
});

test('scope is hash-bound and passed unchanged; changed rules and legacy approvals cannot execute', async () => {
  const { requests } = await execute();
  assert.deepEqual(JSON.parse(requests[0].input).approvedRequest, webPlan);
  assert.match(requests[0].instructions, /approvedRequest.scope is authoritative/);
  const changed = structuredClone(webPlan); changed.scope.contactRule = 'Any contact';
  assert.throws(() => quoteProspects(changed, {}));
  const legacy = structuredClone(webPlan); delete legacy.scope;
  assert.throws(() => quoteProspects(legacy, {}), /Legacy/);
  const broader = structuredClone(webPlan); broader.scope.sourceMode = 'public_professional'; broader.sourceDomains = [];
  const broaderOffer = quoteProspects(broader, {}); assert.notEqual(broaderOffer.hash, offer().hash);
  const { requests: next } = await execute(webPayload(), { offer: broaderOffer });
  assert.deepEqual(next[0].tools, [{ type: 'web_search' }]);
  assert.deepEqual(JSON.parse(next[0].input).approvedRequest, broader);
});

test('exact-host semantics reject child hosts, bare equivalents, deliberate site targeting and off-scope evidence', async () => {
  const wwwOnly = structuredClone(webPlan); wwwOnly.sourceDomains = ['www.workshop.example'];
  assert.match((await execute(webPayload(), { offer: quoteProspects(wwwOnly, {}) })).cohort.error, /scope stop/);
  for (const host of ['child.workshop.example', 'outside.example']) {
    for (const type of ['search', 'open', 'evidence']) {
      const p = webPayload();
      if (type === 'search') p.output[0].action = { type: 'search', queries: ['site:' + host + ' staff'] };
      if (type === 'open') p.output[0].action = { type: 'open_page', url: 'https://' + host + '/team' };
      if (type === 'evidence') { const r = JSON.parse(p.output.at(-1).content[0].text); r.candidates[0].name.sourceUrl = 'https://' + host + '/team'; p.output.at(-1).content[0].text = JSON.stringify(r); }
      const { cohort } = await execute(p); assert.equal(cohort.prospects.length, 0); assert.match(cohort.error, /scope stop/);
      assert.ok(cohort.scopeCheck.failures.length);
    }
  }
});

test('incidental results do not imply visits and excluded redirects remain model-reported, not provider-confirmed', async () => {
  const p = webPayload(); const off = 'https://outside.example/';
  p.output[0].action.sources.push({ url: off });
  p.output.unshift({ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: sourceUrl } });
  const r = JSON.parse(p.output.at(-1).content[0].text);
  r.incidents = [
    { kind: 'incidental_result', requestedUrl: '', observedUrl: off, excludedFromEvidence: true, explanation: 'Incidental search result excluded.' },
    { kind: 'automatic_redirect', requestedUrl: sourceUrl, observedUrl: off, excludedFromEvidence: true, explanation: 'Reported automatic redirect; not used or followed.' }
  ];
  p.output.at(-1).content[0].text = JSON.stringify(r);
  const { cohort } = await execute(p);
  assert.equal(cohort.prospects.length, 1); assert.deepEqual(cohort.scopeCheck.modelReported, r.incidents);
  assert.equal(cohort.scopeCheck.providerObserved.filter(o => o.action.url === off).length, 0);
  for (const patch of [{ scopeCompliant: false }, { incidents: [{ ...r.incidents[1], kind: 'uncertain' }] }, { incidents: [{ ...r.incidents[1], excludedFromEvidence: false }] }, { incidents: [{ ...r.incidents[1], kind: 'deliberate_prohibited_activity' }] }]) {
    const bad = structuredClone(p); bad.output.at(-1).content[0].text = JSON.stringify({ ...r, ...patch });
    assert.match((await execute(bad)).cohort.error, /scope stop/);
  }
  const targeted = structuredClone(p); targeted.output[0].action = { type: 'search', query: 'site:outside.example people' };
  assert.match((await execute(targeted)).cohort.error, /scope stop/);
});

test('yield counts distinguish source-supported matches, provisional records and contact coverage', async () => {
  const first = candidate(), second = candidate(), third = candidate();
  second.name.value = 'Second Person'; second.location = null;
  third.name.value = 'Third Person'; third.employmentStatus = 'historical_or_unknown'; third.contact = null;
  const { cohort } = await execute(webPayload([first, second, third]));
  assert.deepEqual(cohort.yieldCounts, { returned: 3, admitted: 3, supportedMatches: 1, provisional: 2, contactRoutes: 2, contactRoutesAmongSupported: 1 });
  assert.match(cohort.prospects[1].unknowns.join(' '), /location is not established/);
  assert.match(cohort.prospects[2].unknowns.join(' '), /historical affiliation/);
});

test('page types and explicitly linked first-party contact provenance are checked', async () => {
  const restricted = structuredClone(webPlan); restricted.scope.pageTypes = ['event_speaker_biography'];
  assert.match((await execute(webPayload(), { offer: quoteProspects(restricted, {}) })).cohort.error, /Off-scope candidate page type/);
  const p = webPayload(); const r = JSON.parse(p.output.at(-1).content[0].text);
  const contactUrl = 'https://workshop.example/contact'; r.candidates[0].contact = { type: 'professional_contact_page', value: contactUrl, sourceUrl: contactUrl, support: 'Professional contact page.' };
  r.sourceDetails.push({ url: contactUrl, pageType: 'linked_first_party_professional_contact', publishedDate: 'not stated', linkedFrom: sourceUrl, linkSupport: 'Biography links to ' + contactUrl });
  p.output.at(-1).content[0].annotations.push({ type: 'url_citation', url: contactUrl });
  p.output.at(-1).content[0].text = JSON.stringify(r);
  assert.equal((await execute(p)).cohort.prospects.length, 1);
  r.sourceDetails[1].linkSupport = 'Unspecified link'; p.output.at(-1).content[0].text = JSON.stringify(r);
  assert.match((await execute(p)).cohort.exclusions[0].reason, /link provenance/);
});

test('direct owner staging appends one unapproved proposal without model/provider calls or state edits', async t => {
  const store = await temporaryStore(t), stateBefore = await readFile(join(store.directory, 'state.json'));
  let calls = 0;
  const forbidden = async () => { calls++; throw new Error('Must not call'); };
  const server = createAppServer({ store, model: { name: 'mock', decide: forbidden }, webProspecting: forbidden });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await server.initialize();
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body) => {
    const snapshot = await (await fetch(base + '/api/state')).json();
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: snapshot.revision, ...body }) });
  };
  const plan = structuredClone(webPlan); plan.scope.sourceMode = 'public_professional'; plan.sourceDomains = [];
  const response = await post('/api/prospect-proposals', { request: plan }); assert.equal(response.status, 201);
  const { id, hash } = await response.json();
  let snapshot = await store.read();
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].type, 'prospect_proposal_staged');
  const staged = snapshot.history[0]; assert.equal(staged.status, 'awaiting_approval'); assert.equal(staged.proposalOrigin, 'owner_specified');
  assert.equal(staged.decision, null); assert.equal(staged.cohortApproval, undefined);
  assert.deepEqual(staged.prospectOffer.request, plan); assert.equal(staged.prospectOffer.executionPolicy.maxOutputTokens, 6000);
  for (const body of [{ hash }, { hash: 'wrong', approve: true }]) assert.equal((await post('/api/decisions/' + id + '/cohort', body)).status, 409);
  const invalid = structuredClone(plan); invalid.maxCalls = 6;
  assert.equal((await post('/api/prospect-proposals', { request: invalid })).status, 422);
  assert.equal((await store.read()).events.length, 1); assert.equal(calls, 0);
  assert.deepEqual(await readFile(join(store.directory, 'state.json')), stateBefore);
});

test('execution policy and every effective request limit are hash-bound before dispatch', async () => {
  const original = offer();
  for (const [key, value] of [['cohortSize', 2], ['maxCalls', 4], ['deadlineSeconds', 120], ['sourceDomains', ['other.example']]]) {
    const changed = structuredClone(original); changed.request[key] = value;
    assert.notEqual(quoteProspects(changed.request, {}).hash, original.hash);
    await assert.rejects(execute(webPayload(), { offer: changed }), /hash mismatch/);
  }
  const changed = structuredClone(original); changed.executionPolicy.maxOutputTokens = 5999;
  await assert.rejects(execute(webPayload(), { offer: changed }), /hash mismatch/);
  const { hash, ...bound } = changed;
  const { digest } = await import('../src/prospecting.js'); changed.hash = digest(bound);
  await assert.rejects(execute(webPayload(), { offer: changed }), /hash mismatch/);
  const { requests } = await execute(); assert.equal(requests[0].max_output_tokens, original.executionPolicy.maxOutputTokens);
});
