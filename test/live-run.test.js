import { substantiveResearch } from '../src/model-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { createResearch } from '../src/research.js';
import { ownerContextSources } from '../src/evidence.js';
import { decision, temporaryStore } from './helpers.js';

async function setup(t, scenario) {
  const store = await temporaryStore(t), inputs = [], strategicInputs = [], researchInputs = [];
  let initialCalls = 0, researchCalls = 0, strategicCalls = 0;
  const stateBefore = await readFile(join(store.directory, 'state.json'));
  const report = { disposition: scenario === 'input' ? 'insufficient_task_definition' : ['no-research', 'owner-input'].includes(scenario) ? 'research_unnecessary' : scenario === 'unresolved' ? 'public_research_cannot_resolve' : 'researched',
    explanation: scenario === 'input' ? 'Which service area should the public eligibility check cover?' : scenario === 'no-research' ? 'The supplied capacity figures already resolve the question.' : 'Reviewed the public eligibility rules; actual customer demand remains unknown.',
    evidence: [], unresolvedUnknowns: scenario === 'no-research' ? [] : ['Actual customer demand.'], scopeCompliant: true };
  const hasTools = ['research', 'strategy-failure', 'research-failure', 'unresolved'].includes(scenario);
  const url = 'https://program.example/eligibility';
  if (hasTools) report.evidence.push({ id: 'S1', status: 'sourced_fact', statement: 'The published rule requires current registration.', sourceUrls: [url], contextRefs: [], basisIds: [], support: 'Synthetic source-attributed paraphrase: registration is required.' });
  const research = createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async (_, request) => {
    researchInputs.push(JSON.parse(JSON.parse(request.body).input));
    researchCalls++;
    if (scenario === 'research-failure') return Response.json({ status: 'completed', model: 'mock', output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid structured response' }] }] });
    return Response.json({ status: 'completed', model: 'mock', output: [
      ...(hasTools ? [{ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url } }] : []),
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: hasTools ? [{ type: 'url_citation', url }] : [] }] }
    ] });
  } });
  const server = createAppServer({ store, model: { name: 'mock', decide: async context => {
    inputs.push(context); initialCalls++;
    return { model: 'mock', decision: { ...decision, recommendedNextStep: 'INTERNAL: prepare an assessment outline.' } };
  } }, research, makeDecision: () => ({ decide: async context => {
    strategicCalls++; strategicInputs.push(context);
    assert.deepEqual(context.researchEvidence.report, report);
    if (scenario === 'strategy-failure') throw new Error('Synthetic strategic connection failure');
    return { model: 'mock', decision: { decision: { ...decision, recommendedNextStep: 'Defer launch until registration is established.',
      assessment: 'The eligibility question is resolved by the supplied evidence.', ownerInputRequired: scenario === 'owner-input', ownerRequirementDetails: scenario === 'owner-input' ? 'Which service area should I assess?' : decision.ownerRequirementDetails,
      evidenceUsed: context.evidenceUsedOptions }, researchInferencesNotReliedUpon: [] } };
  } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await server.initialize();
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const urlBase = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(urlBase + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  return { store, request, inputs, strategicInputs, researchInputs, stateBefore, counters: () => ({ initialCalls, researchCalls, strategicCalls }) };
}

for (const scenario of ['no-research', 'research', 'input', 'owner-input', 'unresolved', 'research-failure', 'strategy-failure']) {
  test(`one browser operation: ${scenario}; preserves work and never retries`, async t => {
    const f = await setup(t, scenario);
    const before = (await f.request('/api/state')).data;
    const result = await f.request('/api/run', 'POST', { revision: before.revision });
    const snapshot = await f.store.read(), run = snapshot.history[0];
    assert.equal(snapshot.history.length, 1);
    assert.deepEqual(await readFile(join(f.store.directory, 'state.json')), f.stateBefore);
    assert.equal(f.counters().initialCalls, 1); assert.equal(f.counters().researchCalls, 1);
    if (scenario.endsWith('failure')) {
      assert.equal(result.status, 502); assert.equal(run.status, 'failed'); assert.equal(run.decision, null);
      assert.ok(run.originatingDecision);
      if (scenario === 'strategy-failure') assert.ok(run.research.report.evidence.length);
      else assert.ok(snapshot.events.some(e => e.work?.failedResearchAudit?.rawResponse));
    } else if (scenario === 'input') {
      assert.equal(run.status, 'needs_input'); assert.equal(run.decision, null);
      assert.equal(run.clarification, 'Which service area should the public eligibility check cover?');
    } else {
      assert.equal(result.status, 201); assert.equal(run.status, 'completed');
      assert.equal(run.decision.recommendedNextStep, 'Defer launch until registration is established.');
      if (scenario === 'owner-input') { assert.equal(run.decision.ownerInputRequired, true); assert.equal(run.decision.ownerRequirementDetails, 'Which service area should I assess?'); }
      assert.ok(run.research); assert.deepEqual(run.researchInferencesNotReliedUpon, []);
      assert.deepEqual(f.strategicInputs[0].decisionHistory, []);
      assert.deepEqual(f.strategicInputs[0].internalCandidate.decision, run.originatingDecision);
      assert.deepEqual(f.strategicInputs[0].researchEvidence, substantiveResearch(run.research));
      assert.deepEqual(f.strategicInputs[0].researchEvidence.report, run.research.report);
      assert.deepEqual(f.researchInputs[0].context, f.inputs[0]);
      assert.deepEqual(f.researchInputs[0].originatingDecision, run.originatingDecision);
      assert.deepEqual(run.ownerContextSources, ownerContextSources(f.inputs[0]));
      assert.equal(snapshot.events.filter(e => e.type === 'run_completed').length, 1);
      const calls = JSON.parse(run.research.rawResponse).output.filter(x => x.type === 'web_search_call');
      assert.equal(calls.length, ['no-research', 'owner-input'].includes(scenario) ? 0 : 1);
    }
    assert.equal(f.counters().strategicCalls, ['input', 'research-failure'].includes(scenario) ? 0 : 1);
    const saved = (await f.request('/api/state')).data;
    assert.equal((await f.request(`/api/decisions/${run.id}/outcome`, 'POST', { revision: saved.revision, text: 'Owner response: use the north service area.' })).status, 201);
    const next = (await f.request('/api/state')).data;
    await f.request('/api/run', 'POST', { revision: next.revision });
    assert.equal(f.inputs[1].decisionHistory[0].outcomes[0].text, 'Owner response: use the north service area.');
    assert.equal(f.inputs[1].decisionHistory.length, 1);
    assert.deepEqual(f.inputs[1].decisionHistory[0].decision, run.decision);
    if (f.strategicInputs.length) {
      assert.deepEqual(f.strategicInputs[1].decisionHistory, f.inputs[1].decisionHistory);
      assert.deepEqual(f.inputs[1].decisionHistory[0].ownerContextSources, run.ownerContextSources);
      assert.equal(f.strategicInputs[1].ownerContextSources.at(-1).text, 'Owner response: use the north service area.');
    }
  });
}
