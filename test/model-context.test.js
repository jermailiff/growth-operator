import test from 'node:test';
import assert from 'node:assert/strict';
import { browserModelContext, modelHistory, substantiveResearch } from '../src/model-context.js';
import { liveDecisionContext } from '../src/continuation.js';
import { validateResearch, createResearch } from '../src/research.js';
import { validateDecisionEnvelope, evidenceChoices, citationMatcher } from '../src/evidence.js';
import { projectHistory } from '../src/store.js';
import { state, decision } from './helpers.js';

const url = 'https://program.example/requirements';
const report = {
  disposition: 'researched', explanation: 'Published requirements conflict with the supplied capacity. No demand results are established.',
  evidence: [
    { id: 'S1', status: 'sourced_fact', statement: 'Three machines are required.', sourceUrls: [url], contextRefs: [], basisIds: [], support: 'A minimum of three machines is required.' },
    { id: 'O1', status: 'owner_provided', statement: 'Two machines are available.', sourceUrls: [], contextRefs: ['/context/state'], basisIds: [], support: 'Two machines are available.' },
    { id: 'I1', status: 'inference', statement: 'Current capacity does not meet the requirement.', sourceUrls: [], contextRefs: [], basisIds: ['S1', 'O1'], support: '' },
    { id: 'U1', status: 'unknown', statement: 'Actual demand is unknown.', sourceUrls: [], contextRefs: [], basisIds: [], support: 'No observed results.' }
  ],
  unresolvedUnknowns: ['Actual demand.', 'Cost of increasing capacity.'], scopeCompliant: true
};
const input = { context: { ...state, state: 'Two machines are available.\nDo not invent results.', decisionHistory: [] }, originatingDecision: decision };
const annotation = { type: 'url_citation', url, title: 'Requirements', start_index: 0, end_index: 25 };
const payload = { status: 'completed', model: 'mock', output: [
  { id: 'call-1', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url, sources: [{ url, title: 'Requirements' }] } },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [annotation] }] }
] };
async function researchAudit() {
  return createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async () => Response.json(payload) })(input);
}
function assertNoAudit(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['request', 'rawResponse', 'strategicRequest', 'strategicRawResponse', 'instructions', 'schema'].includes(key), `Audit field leaked: ${key}`);
    assert.notEqual(key, 'decisionHistory', 'Nested history leaked');
    assertNoAudit(child);
  }
}

test('complete substantive report and exact supporting provenance survive without transport envelopes', async () => {
  const audit = await researchAudit(), before = JSON.stringify(audit);
  const projected = substantiveResearch(audit);
  assert.deepEqual(projected.report, report);
  assert.deepEqual(projected.webActions, [payload.output[0]]);
  assert.deepEqual(projected.citations, [annotation]);
  assert.deepEqual(projected.provenanceMatches, audit.provenanceMatches);
  assert.equal(projected.validationStatus, 'validated');
  assert.deepEqual(projected.ownerSourceSnapshots, [{ contextRef: '/context/state', text: input.context.state, kind: 'owner_context_source', epistemicStatus: 'unclassified_owner_text' }]);
  assertNoAudit(projected);
  assert.equal(JSON.stringify(audit), before);
  validateResearch(audit, input); // Local validation continues using the complete untouched audit.
  const minimalPayload = { output: [...projected.webActions, { content: [{ annotations: projected.citations }] }] };
  for (const item of projected.report.evidence) {
    item.sourceUrls.forEach(source => assert.equal(citationMatcher(minimalPayload)(source).method, 'exact'));
    item.contextRefs.forEach(ref => assert.ok(projected.ownerSourceSnapshots.find(source => source.contextRef === ref).text.includes(item.support)));
    item.basisIds.forEach(id => assert.ok(projected.report.evidence.some(evidence => evidence.id === id)));
  }
  assert.throws(() => validateDecisionEnvelope({ decision: { ...decision, evidenceUsed: [] }, researchInferencesNotReliedUpon: [] }, projected.report), /I1 is neither selected/);
  validateDecisionEnvelope({ decision: { ...decision, evidenceUsed: [evidenceChoices(report)[2]] }, researchInferencesNotReliedUpon: [] }, projected.report);
});

test('each authoritative run appears once, with exact outcomes and snapshots scoped to its execution', async () => {
  const audit = await researchAudit();
  const outcome = { recordedAt: '2026-01-01T01:00:00Z', text: 'Compare direct acquisition with the alternative.\nPrepare a conditional readiness plan.' };
  const source = { kind: 'owner_context_source', contextRef: '/context/state', epistemicStatus: 'unclassified_owner_text', label: 'Current state', text: input.context.state };
  const history = [
    { id: 'a', status: 'failed', decision: null, outcomes: [], error: 'Strategy validation failed.', originatingDecision: decision, research: audit },
    { id: 'b', status: 'completed', decision, outcomes: [outcome], error: null, research: audit, selectedEvidence: [report.evidence[2], source], ownerContextSources: [source], researchInferencesNotReliedUpon: [] }
  ];
  // Historical audit requests really do embed older history; projection must not traverse it as history.
  history[1].research = { ...audit, request: { ...audit.request, input: JSON.stringify({ ...input, context: { ...input.context, decisionHistory: [history[0]] } }) } };
  const before = JSON.stringify(history);
  const context = browserModelContext({ state: { ...state, state: 'Capacity changed later.' }, history, events: [] });
  assert.deepEqual(context.decisionHistory.map(x => x.id), ['a', 'b']);
  assert.deepEqual(context.decisionHistory.map(x => x.status), ['failed', 'completed']);
  assert.equal(context.decisionHistory[0].decision, null);
  assert.equal(context.decisionHistory[0].internalCandidate, undefined);
  assert.equal(context.decisionHistory[0].error, undefined);
  assert.deepEqual(context.decisionHistory[0].research.report, report);
  assert.deepEqual(context.decisionHistory[1].decision, decision);
  assert.deepEqual(context.decisionHistory[1].outcomes, [outcome]);
  assert.deepEqual(context.decisionHistory[1].ownerContextSources, [source]);
  assert.deepEqual(context.decisionHistory[1].selectedEvidence, history[1].selectedEvidence);
  assert.deepEqual(context.decisionHistory[1].researchInferencesNotReliedUpon, []);
  assert.equal(context.decisionHistory[1].research.ownerSourceSnapshots[0].text, input.context.state);
  context.decisionHistory.forEach(assertNoAudit);
  assert.equal(JSON.stringify(history), before);
  const final = liveDecisionContext(context, decision, audit);
  assert.deepEqual(final.decisionHistory, context.decisionHistory);
  assert.deepEqual(final.researchEvidence.report, report);
  assert.deepEqual(final.internalCandidate.decision, decision);
  assertNoAudit(final.researchEvidence);
});

test('failed research and malformed partial work stay unvalidated; rejected decisions are never promoted', () => {
  const failed = { request: { input: JSON.stringify(input) }, rawResponse: JSON.stringify(payload), httpStatus: 200 };
  const events = [
    { type: 'run_started', id: 'bad', at: '2026-01-01T00:00:00Z', model: 'mock' },
    { type: 'run_progress', decisionId: 'bad', work: { originatingDecision: decision, failedResearchAudit: failed, strategicRawResponse: JSON.stringify({ decision }) } },
    { type: 'run_failed', decisionId: 'bad', error: 'Evidence validation failed.' }
  ];
  const before = JSON.stringify(events);
  assert.deepEqual(modelHistory(projectHistory(events), events), []);
  assert.equal(projectHistory(events)[0].status, 'failed');
  assert.equal(JSON.stringify(events), before);
  const malformed = { ...failed, rawResponse: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'partial invalid JSON' }] }] }) };
  assert.equal(substantiveResearch(malformed, false).unvalidatedOutputText, 'partial invalid JSON');
  const invalidShape = { ...failed, rawResponse: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{"evidence":{}}' }] }] }) };
  assert.deepEqual(substantiveResearch(invalidShape, false).report, { evidence: {} });
  const rejected = substantiveResearch({ rawResponse: JSON.stringify({ error: { type: 'tokens', code: 'rate_limit_exceeded', message: 'Limit reached.' } }) }, false);
  assert.equal(rejected.report, undefined);
  assert.equal(rejected.providerError.code, 'rate_limit_exceeded');
});

test('successive synthetic audit cycles grow model-facing history linearly rather than replaying request history', () => {
  const history = [], sizes = [];
  for (let i = 0; i < 7; i++) {
    const requestInput = { ...input, context: { ...input.context, decisionHistory: structuredClone(history) } };
    const audit = { report, rawResponse: JSON.stringify({ ...payload, instructions: 'AUDIT_ONLY_PROMPT', text: { schema: 'AUDIT_ONLY_SCHEMA' } }), request: { input: JSON.stringify(requestInput) } };
    history.push({ id: `run-${i}`, status: 'completed', decision, outcomes: [], research: audit });
    const projected = modelHistory(history);
    assert.equal(projected.length, i + 1);
    assert.equal(new Set(projected.map(x => x.id)).size, i + 1);
    projected.forEach(assertNoAudit);
    assert.ok(!JSON.stringify(projected).includes('AUDIT_ONLY'));
    sizes.push(Buffer.byteLength(JSON.stringify(projected)));
  }
  for (const size of sizes) assert.equal(size, 1 + (sizes[0] - 1) * (sizes.indexOf(size) + 1));
  assert.ok(Buffer.byteLength(JSON.stringify(history)) > sizes.at(-1) * 5);
});

test('promoted history keeps substantive evidence and provenance identifiers but not embedded origin requests', async () => {
  const audit = await researchAudit();
  const entry = { id: 'promoted', status: 'completed', decision, outcomes: [], research: audit,
    isolatedProvenance: { origin: { id: 'origin-id', sources: { 'request.json': 'AUDIT_ONLY' } }, attempt: 1, artifactSha256: 'hash', promotedAt: '2026-01-01T00:00:00Z' } };
  const projected = modelHistory([entry])[0];
  assert.deepEqual(projected.isolatedProvenance, { attempt: 1, artifactSha256: 'hash', promotedAt: '2026-01-01T00:00:00Z', originId: 'origin-id' });
  assert.deepEqual(projected.research.report, report);
  assert.ok(!JSON.stringify(projected).includes('AUDIT_ONLY'));
});

test('repeated provider failures add no model context while audit/UI and exact owner feedback survive', () => {
  const feedback = 'Find a permitted alternative.\nDo not assign the investigation to the owner.';
  const events = [
    { type: 'run_started', id: 'accepted', at: '2026-01-01', model: 'mock' },
    { type: 'run_completed', decisionId: 'accepted', decision, model: 'mock' },
    { type: 'outcome_recorded', decisionId: 'accepted', at: '2026-01-02', text: feedback }
  ];
  const baseline = JSON.stringify(browserModelContext({ state, history: projectHistory(events), events }));
  for (let i = 0; i < 5; i++) {
    const id = `failure-${i}`;
    events.push({ type: 'run_started', id, at: '2026-01-03', model: 'mock' },
      { type: 'run_progress', decisionId: id, work: { originatingDecision: decision, failedResearchAudit: {
        httpStatus: 429, requestId: id, rawResponse: JSON.stringify({ error: { code: 'rate_limit_exceeded' } })
      } } }, { type: 'run_failed', decisionId: id, error: 'HTTP 429' });
    const before = JSON.stringify(events), history = projectHistory(events);
    const context = browserModelContext({ state, history, events });
    assert.equal(JSON.stringify(context), baseline);
    assert.equal(context.decisionHistory.flatMap(r => r.outcomes).filter(o => o.text === feedback).length, 1);
    assert.equal(history.filter(r => r.status === 'failed').length, i + 1);
    assert.equal(JSON.stringify(events), before);
  }
});

test('feedback and reviewable cohorts on failed runs survive without failed candidates or transport', () => {
  const outcomes = [{ text: 'Keep this exact owner correction.\nSecond line.' }];
  const cohort = { prospects: [{ id: 'p1', name: 'Synthetic owner-review record' }] };
  const history = [
    { id: 'feedback', status: 'failed', outcomes, originatingDecision: decision, error: 'Transport error' },
    { id: 'cohort', status: 'failed', outcomes: [], cohort, originatingDecision: decision }
  ];
  const projected = modelHistory(history);
  assert.deepEqual(projected[0].outcomes, outcomes);
  assert.deepEqual(projected[1].cohort, cohort);
  for (const entry of projected) {
    assert.equal(entry.internalCandidate, undefined);
    assert.equal(entry.error, undefined);
    assert.equal(entry.decision, null);
  }
});

test('incomplete output stays audit-only even when it contains parseable research', async () => {
  for (const text of [JSON.stringify(report), '{"evidence":[']) {
    const audit = { rawResponse: JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ type: 'output_text', text }] }] }) };
    const history = [{ id: 'incomplete', status: 'failed', outcomes: [], originatingDecision: decision }];
    const events = [{ decisionId: 'incomplete', work: { failedResearchAudit: audit } }];
    const before = JSON.stringify(events);
    assert.deepEqual(modelHistory(history, events), []);
    assert.equal(JSON.stringify(events), before);
  }
  const audit = await researchAudit();
  const partial = { ...audit, admission: { report, exclusions: [{ id: 'excluded', reason: 'Uncited source' }] } };
  const entry = modelHistory([{ id: 'partial', status: 'failed', outcomes: [], research: partial }])[0];
  assert.deepEqual(entry.research.report, report);
  assert.deepEqual(entry.research.exclusions, partial.admission.exclusions);
  assert.equal(entry.research.validationStatus, 'partial_source_admission_not_semantic_verification');
  assert.equal(entry.research.httpStatus, undefined);
  assert.equal(entry.research.requestId, undefined);
});
