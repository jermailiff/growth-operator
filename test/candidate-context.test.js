import { substantiveResearch } from '../src/model-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decision, temporaryStore } from './helpers.js';
import { INSTRUCTIONS } from '../src/operator.js';
import { createModel } from '../src/model.js';
import { liveDecisionContext, researchDecisionContext, decideFromResearch } from '../src/continuation.js';
import { ownerContextSources, ownerContextChoices, evidenceChoices, selectableEvidenceChoices, decisionEnvelopeSchema, validateDecisionEnvelope, validateDecisionEvidence } from '../src/evidence.js';
import { projectHistory } from '../src/store.js';

const context = {
  objective: 'Keep the repair workshop operating reliably.',
  businessContext: '  Two workbenches are available.\n\nOwner hypothesis: a new service could attract demand.  ',
  state: 'An existing customer needs a repaired machine tomorrow. Demand for the proposed service is unknown.',
  initiatives: [
    { origin: 'owner', status: 'proposed', description: 'Consider the municipal repair program. This is an unvalidated idea.' },
    { origin: 'operator', status: 'proposed', description: 'A prior model suggestion, not owner evidence.' }
  ], decisionHistory: []
};
const candidate = { ...decision, recommendedNextStep: 'Assess the municipal repair program prerequisite.' };
const report = {
  disposition: 'researched', explanation: 'Synthetic published requirement checked.', scopeCompliant: true, unresolvedUnknowns: [],
  evidence: [
    { id: 'S1', status: 'sourced_fact', statement: 'The program requires four workbenches.', sourceUrls: ['https://program.example/rules'], contextRefs: [], basisIds: [], support: 'Synthetic source-attributed paraphrase: four workbenches required.' },
    { id: 'O1', status: 'owner_provided', statement: 'Two workbenches are available.', sourceUrls: [], contextRefs: ['/context/businessContext'], basisIds: [], support: 'Two workbenches are available.' },
    { id: 'I1', status: 'inference', statement: 'The workshop does not meet the program prerequisite.', sourceUrls: [], contextRefs: [], basisIds: ['S1', 'O1'], support: '' }
  ]
};
const research = { report, request: { input: JSON.stringify({ context, originatingDecision: candidate }) }, rawResponse: ' { "synthetic": true }\n', provenanceMatches: [{ evidenceId: 'S1', match: 'exact' }] };
const decline = { inferenceId: 'I1', reason: 'irrelevant_to_selected_action', explanation: 'Program eligibility is unrelated to the selected existing-customer repair.' };
const envelope = (choices, declined = []) => ({ decision: { ...decision, evidenceUsed: choices }, researchInferencesNotReliedUpon: declined });

for (const history of [[], [{ id: 'earlier', status: 'completed', decision, outcomes: [{ text: 'The owner approved servicing the existing customer first.' }] }]]) {
  test(`same-run candidate remains separate with ${history.length} pre-run decisions`, () => {
    const input = { ...context, decisionHistory: history }, before = JSON.stringify(input);
    const final = liveDecisionContext(input, candidate, research);
    assert.deepEqual(final.decisionHistory, history);
    assert.equal(final.decisionHistory.some(item => item.decision === candidate), false);
    assert.deepEqual(final.internalCandidate, { decision: candidate, role: 'provisional same-run investigation direction', ownerExposure: 'not presented to owner', ownerAccepted: false });
    assert.equal(Object.hasOwn(final.internalCandidate, 'status'), false);
    assert.deepEqual(final.researchEvidence, substantiveResearch(research));
    assert.deepEqual(final.researchEvidence.report, research.report);
    assert.equal(Object.hasOwn(final.researchEvidence, 'rawResponse'), false);
    assert.equal(JSON.stringify(input), before);
  });
}

test('owner sources contain complete verbatim mixed prose, owner initiatives and outcomes only', () => {
  const input = structuredClone(context);
  input.decisionHistory = [{ decision: { assessment: 'Model text must not become owner evidence.' }, outcomes: [{ text: '  Owner hypothesis: the delay may cost a customer.\nNo loss is observed. ' }] }];
  const sources = ownerContextSources(input);
  assert.deepEqual(sources.map(x => x.contextRef), ['/context/objective', '/context/businessContext', '/context/state', '/context/initiatives/0/description', '/context/decisionHistory/0/outcomes/0/text']);
  assert.deepEqual(sources.map(x => x.text), [input.objective, input.businessContext, input.state, input.initiatives[0].description, input.decisionHistory[0].outcomes[0].text]);
  for (const source of sources) {
    assert.equal(source.kind, 'owner_context_source'); assert.equal(source.epistemicStatus, 'unclassified_owner_text');
    assert.equal(Object.hasOwn(source, 'status'), false);
  }
  assert.equal(ownerContextSources({ ...context, state: ' \n ' }).some(x => x.contextRef === '/context/state'), false);
  assert.equal(ownerContextSources({ ...context, initiatives: [] }).length, 3);
});

for (const action of ['affirm', 'replace']) test(`final strategic request can ${action} the provisional candidate`, async () => {
  const final = liveDecisionContext(context, candidate, research);
  const choices = action === 'affirm' ? evidenceChoices(report) : [ownerContextChoices(final.ownerContextSources)[2]];
  const value = envelope(choices, action === 'replace' ? [decline] : []);
  value.decision.recommendedNextStep = action === 'affirm' ? candidate.recommendedNextStep : 'Prepare the existing customer repair for tomorrow.';
  value.decision.reasoningSummary = action === 'affirm' ? 'The published rule and available workbenches support the candidate direction.' : 'The owner supplied an immediate customer deadline; the program question is unrelated to that repair.';
  let requests = 0;
  const result = await decideFromResearch(final, research, schema => createModel({ apiKey: 'synthetic', model: 'mock', decisionSchema: schema, fetchImpl: async (_, request) => {
    requests++;
    const body = JSON.parse(request.body), supplied = JSON.parse(body.input);
    assert.equal(body.instructions, INSTRUCTIONS);
    assert.deepEqual(supplied.decisionHistory, []);
    assert.deepEqual(supplied.internalCandidate.decision, candidate);
    assert.deepEqual(supplied.researchEvidence, substantiveResearch(research));
    assert.deepEqual(supplied.researchEvidence.report, research.report);
    assert.deepEqual(supplied.ownerContextSources, ownerContextSources(context));
    assert.match(body.text.format.schema.description, /affirm, refine, or replace/);
    assert.match(body.text.format.schema.description, /not a previous owner-visible decision/);
    assert.deepEqual(body.text.format.schema.properties.decision.properties.evidenceUsed.items.enum, selectableEvidenceChoices(report, final.ownerContextSources));
    return Response.json({ status: 'completed', model: 'mock', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  } }));
  assert.equal(requests, 1); assert.deepEqual(result.decision, value.decision);
  if (action === 'replace') assert.equal(report.evidence.some(x => x.statement.includes('tomorrow')), false);
});

for (const [name, mutate] of [
  ['forged reference', x => x.replace('/context/state', '/context/nonexistent')],
  ['altered reference', x => x.replace('/context/state', '/context/State')],
  ['shortened reference', x => x.replace('/context/state', '/context/stat')],
  ['fact relabelling', x => x.replace('Owner context—unclassified', 'Owner fact')]
]) test(`context citations reject ${name}`, () => {
  const sources = ownerContextSources(context), choice = ownerContextChoices(sources)[2];
  assert.throws(() => validateDecisionEvidence({ ...decision, evidenceUsed: [mutate(choice)] }, report, sources), /altered evidence status, statement or provenance/);
});

test('original context selection cannot bypass canonical inference accounting or dependencies', () => {
  const sources = ownerContextSources(context), value = envelope(ownerContextChoices(sources));
  assert.throws(() => validateDecisionEnvelope(value, report, sources), /Research inference I1 is neither selected/);
  value.researchInferencesNotReliedUpon = [decline];
  assert.deepEqual(validateDecisionEnvelope(value, report, sources), sources);
  const dependent = structuredClone(report);
  dependent.evidence.push({ ...report.evidence[2], id: 'I2', basisIds: ['I1'] });
  value.decision.evidenceUsed.push(evidenceChoices(dependent)[3]);
  assert.throws(() => validateDecisionEnvelope(value, dependent, sources), /requires inference dependency I1/);
  value.decision.evidenceUsed = ownerContextChoices(sources);
  value.researchInferencesNotReliedUpon = [{ ...decline, inferenceId: '/context/state' }];
  assert.throws(() => validateDecisionEnvelope(value, report, sources), /canonical research inference/);
});

test('legacy context, response envelope and history remain readable without migration', () => {
  const record = { id: 'legacy-origin', status: 'completed', decision: candidate, outcomes: [] };
  const legacy = researchDecisionContext(context, record, research);
  assert.deepEqual(legacy.decisionHistory, [record]);
  assert.equal(Object.hasOwn(legacy, 'internalCandidate'), false);
  assert.equal(Object.hasOwn(legacy, 'ownerContextSources'), false);
  assert.deepEqual(legacy.evidenceUsedOptions, evidenceChoices(report));
  assert.deepEqual(Object.keys(decisionEnvelopeSchema(report).properties), ['decision', 'researchInferencesNotReliedUpon']);
  const events = [
    { type: 'run_started', id: 'old', at: '2026-01-01T00:00:00Z', model: 'mock' },
    { type: 'run_progress', decisionId: 'old', work: { originatingDecision: candidate, research } },
    { type: 'run_completed', decisionId: 'old', decision, model: 'mock' },
    { type: 'outcome_recorded', decisionId: 'old', at: '2026-01-02T00:00:00Z', text: 'Original response.' }
  ];
  const bytes = JSON.stringify(events), projected = projectHistory(events);
  assert.equal(projected.length, 1); assert.deepEqual(projected[0].decision, decision);
  assert.deepEqual(projected[0].originatingDecision, candidate);
  assert.equal(projected[0].outcomes[0].text, 'Original response.');
  assert.equal(Object.hasOwn(projected[0], 'ownerContextSources'), false);
  assert.equal(JSON.stringify(events), bytes);
});

const multilineOwnerText = '  Two workbenches are available.\n\nOwner hypothesis: demand may rise.\r\nNo results yet.\t"quoted" \\n is literal.  ';
const citationControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const compactCitation = source => `[OWNER_CONTEXT ${source.contextRef}] Owner context—unclassified`;

test('synthetic long multiline owner source stays verbatim outside compact selectable citations', () => {
  const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') +
    Array.from({ length: 33 }, (_, i) => String.fromCharCode(127 + i)).join('') + '\u2028\u2029';
  const original = multilineOwnerText.repeat(1000) + controls;
  const input = { ...context, businessContext: original };
  const sources = ownerContextSources(input), source = sources.find(x => x.contextRef === '/context/businessContext');
  const before = JSON.stringify(sources), citation = ownerContextChoices([source])[0];
  assert.deepEqual(Buffer.from(source.text), Buffer.from(original));
  assert.equal(source.epistemicStatus, 'unclassified_owner_text');
  assert.match(citation, /Owner context—unclassified/);
  assert.equal(citationControls.test(citation), false);
  assert.equal(citation, compactCitation(source));
  assert.ok(citation.length < 100);
  assert.equal(citation.includes('Two workbenches'), false);
  assert.deepEqual(validateDecisionEvidence({ ...decision, evidenceUsed: [citation] }, report, sources), [source]);
  const literals = JSON.parse(JSON.stringify(decisionEnvelopeSchema(report, sources))).properties.decision.properties.evidenceUsed.items.enum;
  assert.ok(literals.includes(citation));
  assert.ok(literals.every(x => !x.includes(original)));
  assert.equal(JSON.stringify(sources), before);
  assert.equal(input.businessContext, original);
});

test('parsed actual strategic request enums are control-safe and selected citation persists its verbatim source', async () => {
  const longText = multilineOwnerText.repeat(1000);
  const input = { ...context, businessContext: longText };
  const final = liveDecisionContext(input, candidate, research);
  const source = final.ownerContextSources.find(x => x.contextRef === '/context/businessContext');
  const citation = ownerContextChoices([source])[0];
  const value = envelope([citation], [decline]);
  let calls = 0;
  const result = await decideFromResearch(final, research, schema => createModel({ apiKey: 'synthetic', model: 'mock', decisionSchema: schema,
    fetchImpl: async (_, request) => {
      calls++;
      // Check the decoded wire request, not only a pre-serialization helper value.
      const body = JSON.parse(request.body), supplied = JSON.parse(body.input);
      const literals = body.text.format.schema.properties.decision.properties.evidenceUsed.items.enum;
      assert.ok(literals.includes(citation));
      assert.ok(literals.every(x => !citationControls.test(x)));
      assert.deepEqual(literals, supplied.evidenceUsedOptions);
      assert.equal(supplied.ownerContextSources.find(x => x.contextRef === source.contextRef).text, longText);
      assert.deepEqual(supplied.decisionHistory, []);
      assert.deepEqual(supplied.internalCandidate.decision, candidate);
      assert.deepEqual(supplied.researchEvidence, substantiveResearch(research));
      assert.deepEqual(supplied.researchEvidence.report, research.report);
      assert.equal(body.instructions, INSTRUCTIONS);
      return Response.json({ status: 'completed', model: 'mock', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
    }
  }));
  assert.equal(calls, 1);
  const selected = validateDecisionEnvelope({ decision: result.decision, researchInferencesNotReliedUpon: result.researchInferencesNotReliedUpon }, report, final.ownerContextSources);
  assert.deepEqual(selected, [source]);
  const events = [
    { type: 'run_started', id: 'escaped', at: '2026-01-01T00:00:00Z', model: 'mock' },
    { type: 'run_progress', decisionId: 'escaped', work: { selectedEvidence: selected, ownerContextSources: selected } },
    { type: 'run_completed', decisionId: 'escaped', decision: result.decision, model: 'mock' }
  ];
  const persisted = projectHistory(JSON.parse(JSON.stringify(events)))[0];
  assert.equal(persisted.decision.evidenceUsed[0], citation);
  assert.deepEqual(persisted.selectedEvidence, [source]);
  assert.deepEqual(Buffer.from(persisted.ownerContextSources[0].text), Buffer.from(longText));
  assert.throws(() => validateDecisionEnvelope({ ...value, researchInferencesNotReliedUpon: [] }, report, final.ownerContextSources), /Research inference I1 is neither selected/);
});

for (const [name, mutate] of [
  ['unknown reference', x => x.replace('/context/businessContext', '/context/missing')],
  ['shortened reference', x => x.replace('businessContext', 'businessCon')],
  ['altered reference', x => x.replace('businessContext', 'BusinessContext')],
  ['incorrect classification', x => x.replace('Owner context—unclassified', 'Owner fact')],
  ['appended text', x => x + ': Two workbenches are available.'],
  ['trailing whitespace', x => x + ' ']
]) test(`compact owner citations reject ${name}`, () => {
  const sources = ownerContextSources({ ...context, businessContext: multilineOwnerText });
  const source = sources.find(x => x.contextRef === '/context/businessContext');
  const citation = ownerContextChoices([source])[0], altered = mutate(citation);
  assert.notEqual(altered, citation);
  assert.throws(() => validateDecisionEvidence({ ...decision, evidenceUsed: [altered] }, report, sources), /altered evidence status, statement or provenance/);
});

test('single-line and multiline source snapshots use exact references without conflating their text', () => {
  const source = ownerContextSources(context).find(x => x.contextRef === '/context/objective');
  const citation = ownerContextChoices([source])[0];
  assert.equal(citation, compactCitation(source));
  assert.deepEqual(validateDecisionEvidence({ ...decision, evidenceUsed: [citation] }, report, [source]), [source]);
  for (const text of ['First\\nSecond', 'First\nSecond']) {
    const snapshot = { ...source, text };
    assert.equal(ownerContextChoices([snapshot])[0], citation);
    assert.equal(validateDecisionEvidence({ ...decision, evidenceUsed: [citation] }, report, [snapshot])[0].text, text);
  }
});

test('selected source snapshots survive later business edits and reach subsequent history', async t => {
  const store = await temporaryStore(t);
  const { decisionHistory, ...initialState } = { ...context, businessContext: multilineOwnerText };
  await store.saveState(initialState);
  const final = liveDecisionContext({ ...initialState, decisionHistory }, candidate, research);
  const source = final.ownerContextSources.find(x => x.contextRef === '/context/businessContext');
  const citation = ownerContextChoices([source])[0];
  const value = envelope([citation], [decline]);
  const selected = validateDecisionEnvelope(value, report, final.ownerContextSources);
  await store.append({ type: 'run_started', id: 'snapshot', at: '2026-01-01T00:00:00Z', model: 'mock' });
  await store.append({ type: 'run_progress', decisionId: 'snapshot', work: { research, originatingDecision: candidate, selectedEvidence: selected, ownerContextSources: selected, researchInferencesNotReliedUpon: [decline] } });
  await store.append({ type: 'run_completed', decisionId: 'snapshot', decision: value.decision, model: 'mock' });
  await store.append({ type: 'outcome_recorded', decisionId: 'snapshot', text: 'Actual owner response.', at: '2026-01-02T00:00:00Z' });
  const prior = (await store.read()).history;
  await store.saveState({ ...initialState, businessContext: 'Changed after this decision.' });
  const snapshot = await store.read();
  assert.deepEqual(snapshot.history, prior);
  const next = liveDecisionContext({ ...snapshot.state, decisionHistory: snapshot.history }, candidate, research);
  assert.equal(next.businessContext, 'Changed after this decision.');
  assert.equal(next.ownerContextSources.find(x => x.contextRef === source.contextRef).text, 'Changed after this decision.');
  assert.equal(next.decisionHistory.length, 1);
  assert.deepEqual(next.decisionHistory[0].decision, value.decision);
  assert.deepEqual(next.decisionHistory[0].selectedEvidence, [source]);
  assert.equal(next.decisionHistory[0].ownerContextSources[0].text, multilineOwnerText);
  assert.equal(next.decisionHistory[0].outcomes[0].text, 'Actual owner response.');
});

test('legacy full-text citations and failed raw responses remain readable without revalidation', async t => {
  const store = await temporaryStore(t);
  const source = ownerContextSources(context)[1];
  const oldCitation = `[OWNER_CONTEXT ${source.contextRef}] Owner context—unclassified, ${source.label}: ${JSON.stringify(source.text).slice(1, -1)}`;
  const oldDecision = { ...decision, evidenceUsed: [oldCitation] };
  await store.append({ type: 'run_started', id: 'legacy', at: '2026-01-01T00:00:00Z', model: 'mock' });
  await store.append({ type: 'run_progress', decisionId: 'legacy', work: { ownerContextSources: [source], selectedEvidence: [source] } });
  await store.append({ type: 'run_completed', decisionId: 'legacy', decision: oldDecision, model: 'mock' });
  await store.append({ type: 'run_started', id: 'failed', at: '2026-01-02T00:00:00Z', model: 'mock' });
  const rejectedRaw = JSON.stringify({ decision: { ...decision, evidenceUsed: [oldCitation.slice(0, 110)] } });
  await store.append({ type: 'run_progress', decisionId: 'failed', work: { strategicRawResponse: rejectedRaw } });
  await store.append({ type: 'run_failed', decisionId: 'failed', error: 'Decision altered evidence status, statement or provenance.' });
  const before = await store.read(), after = await store.read();
  assert.equal(before.revision, after.revision);
  assert.deepEqual(after.history[0].decision, oldDecision);
  assert.deepEqual(after.history[0].ownerContextSources, [source]);
  assert.equal(after.history[1].status, 'failed');
  assert.equal(after.history[1].decision, null);
  assert.equal(after.events.find(e => e.work?.strategicRawResponse).work.strategicRawResponse, rejectedRaw);
  assert.throws(() => validateDecisionEvidence(oldDecision, report, [source]), /altered evidence/);
});
