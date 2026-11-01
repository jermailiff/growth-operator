import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceChoices, decisionEnvelopeSchema, validateDecisionEnvelope, validateDecisionEvidence, validateEvidence } from '../src/evidence.js';
import { validateDecision, runOperator, INSTRUCTIONS, DECISION_SCHEMA } from '../src/operator.js';
import { BASELINE, executeContinuation, verifyArtifact } from '../src/continuation.js';
import { createResearch } from '../src/research.js';
import { createModel } from '../src/model.js';
import { promote } from '../scripts/promote-research.mjs';
import { temporaryStore } from './helpers.js';

const decision = {
  assessment: 'The workshop needs to decide how to allocate its machine capacity.',
  recommendedNextStep: 'Assess the published program prerequisite before allocating capacity.',
  reasoningSummary: 'Compare the published prerequisite with supplied machine capacity.',
  evidenceUsed: [], assumptions: ['The supplied workshop facts are accurate.'],
  importantUnknowns: [], proposedAction: 'Present the capacity assessment; take no external action.',
  ownerApprovalRequired: false, ownerInputRequired: false,
  ownerRequirementDetails: 'Assessment is authorized; operational changes require separate approval.',
  intendedOutcomeOrEvidence: 'A capacity-allocation decision supported by the supplied evidence.', learnings: []
};

const url = 'https://program.example/requirements';
const context = { businessContext: 'A synthetic equipment workshop.', objective: 'Allocate workshop capacity.', initiatives: [],
  state: 'The workshop has two available machines. Three confirmed simultaneous internal jobs each require one machine.', decisionHistory: [] };
const record = (id, status, statement, rest = {}) => ({ id, status, statement, sourceUrls: [], contextRefs: [], basisIds: [], support: '', ...rest });
const report = { disposition: 'researched', explanation: 'Synthetic public requirement examined.', scopeCompliant: true, unresolvedUnknowns: [], evidence: [
  record('S1', 'sourced_fact', 'The program requires at least four available machines.', { sourceUrls: [url], support: 'Synthetic source-attributed paraphrase: at least four available machines are required.' }),
  record('O1', 'owner_provided', 'The workshop has two available machines.', { contextRefs: ['/context/state'], support: 'The workshop has two available machines.' }),
  record('I1', 'inference', 'The workshop does not meet the program’s machine-count prerequisite.', { basisIds: ['S1', 'O1'] }),
  record('O2', 'owner_provided', 'Three confirmed simultaneous internal jobs each require one machine.', { contextRefs: ['/context/state'], support: 'Three confirmed simultaneous internal jobs each require one machine.' })
] };
const payload = { status: 'completed', model: 'mock-research', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url } },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [{ type: 'url_citation', url }] }] }
] };
const decline = (inferenceId = 'I1') => ({ inferenceId, reason: 'irrelevant_to_selected_action', explanation: 'Program eligibility is unrelated to the selected internal scheduling action.' });
function envelope(ids, declined = [], research = report) {
  return { decision: { ...decision, evidenceUsed: evidenceChoices(research).filter((_, i) => ids.includes(research.evidence[i].id)) }, researchInferencesNotReliedUpon: declined };
}
function scheduling() {
  const value = envelope(['O1', 'O2'], [decline()]);
  value.decision.assessment = 'Three simultaneous jobs cannot fit on two machines.';
  value.decision.recommendedNextStep = 'Propose staggering one internal job.';
  value.decision.proposedAction = 'Present a proposal to stagger one job; do not change the schedule without owner approval.';
  value.decision.reasoningSummary = 'From O1 and O2, simultaneous demand exceeds machine capacity by one job. This scheduling conclusion is different from program eligibility.';
  value.decision.assumptions = ['Each confirmed job uses one machine during the shared time slot.'];
  return value;
}

test('workshop missing attribution fails specifically for unaccounted canonical inference; selecting it passes', () => {
  validateEvidence(report, payload, { context });
  const value = envelope(['S1', 'O1']);
  value.decision.assessment = 'The workshop does not meet the program’s machine-count prerequisite.';
  value.decision.reasoningSummary = 'Two available machines are fewer than the four required.';
  validateDecision(value.decision);
  validateDecisionEvidence(value.decision, report);
  assert.throws(() => validateDecisionEnvelope(value, report), { message: 'Research inference I1 is neither selected in evidenceUsed nor explicitly accounted for as not relied upon.' });
  value.decision.evidenceUsed.push(evidenceChoices(report)[2]);
  assert.doesNotThrow(() => validateDecisionEnvelope(value, report));
});

test('workshop new scheduling reasoning passes while unrelated eligibility inference is explicitly irrelevant', () => {
  const value = scheduling();
  assert.deepEqual(validateDecisionEnvelope(value, report).map(x => x.id), ['O1', 'O2']);
  assert.equal(value.researchInferencesNotReliedUpon[0].reason, 'irrelevant_to_selected_action');
  assert.equal(report.evidence.some(x => x.statement === value.decision.reasoningSummary), false);
});

for (const [name, mutate, error] of [
  ['invalid ID', v => { v.researchInferencesNotReliedUpon[0].inferenceId = 'I999'; }, /canonical research inference/],
  ['sourced non-inference ID', v => { v.researchInferencesNotReliedUpon[0].inferenceId = 'S1'; }, /canonical research inference/],
  ['owner non-inference ID', v => { v.researchInferencesNotReliedUpon[0].inferenceId = 'O1'; }, /canonical research inference/],
  ['duplicate non-reliance', v => { v.researchInferencesNotReliedUpon.push(decline()); }, /Duplicate non-reliance/],
  ['selected and declined', v => { v.decision.evidenceUsed.push(evidenceChoices(report)[2]); }, /both selected and declined/],
  ['duplicate selected inference', v => { v.researchInferencesNotReliedUpon = []; v.decision.evidenceUsed.push(evidenceChoices(report)[2], evidenceChoices(report)[2]); }, /Duplicate selected/],
  ['removed reason', v => { v.researchInferencesNotReliedUpon[0].reason = 'new_reasoning_from_underlying_evidence'; }, /Invalid research inference non-reliance record/],
  ['unsupported reason', v => { v.researchInferencesNotReliedUpon[0].reason = 'other'; }, /Invalid research inference non-reliance record/],
  ['blank explanation', v => { v.researchInferencesNotReliedUpon[0].explanation = ' '; }, /Invalid research inference non-reliance record/]
]) test(`inference accounting rejects ${name}`, () => {
  const value = scheduling(); mutate(value);
  assert.throws(() => validateDecisionEnvelope(value, report), error);
});

test('not_accepted is supported and envelope descriptions preserve attribution and new reasoning freedom', () => {
  const value = scheduling(); value.researchInferencesNotReliedUpon[0] = { inferenceId: 'I1', reason: 'not_accepted', explanation: 'The program conclusion is not adopted for this decision.' };
  validateDecisionEnvelope(value, report);
  const schema = decisionEnvelopeSchema(report);
  assert.deepEqual(schema.properties.researchInferencesNotReliedUpon.items.properties.reason.enum, ['irrelevant_to_selected_action', 'not_accepted']);
  assert.match(schema.properties.decision.properties.evidenceUsed.description, /Re-deriving.*does not remove attribution/);
  assert.match(schema.properties.decision.properties.evidenceUsed.description, /Genuinely different strategic reasoning/);
});

test('inference dependencies must be selected transitively; underlying facts need not be separately selected', () => {
  const research = structuredClone(report);
  research.evidence.push(record('I2', 'inference', 'Program pursuit faces an eligibility blocker.', { basisIds: ['I1'] }), record('I3', 'inference', 'Eligibility must change before this program can be pursued.', { basisIds: ['I2'] }));
  validateEvidence(research, payload, { context });
  assert.throws(() => validateDecisionEnvelope(envelope(['I2', 'I3'], [decline()], research), research), /requires inference dependency I1/);
  assert.throws(() => validateDecisionEnvelope(envelope(['I3'], [decline(), decline('I2')], research), research), /requires inference dependency I2/);
  assert.deepEqual(validateDecisionEnvelope(envelope(['I1', 'I2', 'I3'], [], research), research).map(x => x.id), ['I1', 'I2', 'I3']);
  assert.deepEqual(validateDecisionEnvelope(envelope(['I1']), report).map(x => x.id), ['I1']);
});

test('M2 envelope persists non-reliance through promotion into subsequent unchanged M1 context; v1 retains its contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'm2-workshop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await temporaryStore(t);
  const files = {
    'context.json': context, 'result.json': { decision, model: 'mock-m1' },
    'request.json': { instructions: INSTRUCTIONS, input: JSON.stringify(context), text: { format: { schema: DECISION_SCHEMA } } },
    'response.raw.json': { status: 'completed', model: 'mock-m1', output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] },
    'transport.json': { receivedAt: '2026-09-22T01:00:00.000Z' },
    'verification.json': { commit: BASELINE, completed: true, stateUnchanged: true, historyUnchanged: true }
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value));
  const value = scheduling(); let calls = 0;
  const run = await executeContinuation({ originDirectory: directory, protectedDirectory: store.directory,
    research: createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async () => Response.json(payload) }),
    makeDecision: schema => createModel({ apiKey: 'fake', model: 'mock', decisionSchema: schema, fetchImpl: async (_, request) => {
      calls++; const body = JSON.parse(request.body);
      assert.equal(body.instructions, INSTRUCTIONS);
      assert.deepEqual(body.text.format.schema, decisionEnvelopeSchema(report));
      assert.deepEqual(JSON.parse(body.input).researchEvidence.report, report);
      return Response.json({ status: 'completed', model: 'mock-strategy', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
    } }) });
  assert.equal(calls, 1);
  assert.equal(run.artifact.format, 'isolated-m2-continuation-v2');
  assert.deepEqual(JSON.parse(run.artifact.resultText).researchInferencesNotReliedUpon, value.researchInferencesNotReliedUpon);
  const tampered = structuredClone(run.artifact), result = JSON.parse(tampered.resultText);
  delete result.researchInferencesNotReliedUpon; tampered.resultText = JSON.stringify(result);
  assert.throws(() => verifyArtifact(tampered), /non-reliance list/);
  tampered.format = 'isolated-m2-continuation-v1';
  assert.equal(verifyArtifact(tampered).valid, true); // Legacy artifacts never required accounting.
  const review = JSON.parse(await readFile(join(run.directory, 'review.json')));
  Object.assign(review, { choice: 'Promote', reviewedBy: 'Synthetic reviewer', reviewedAt: new Date().toISOString() });
  review.criteria.forEach(x => Object.assign(x, { passed: true, notes: 'Synthetic persistence test only.' }));
  await writeFile(join(run.directory, 'review.json'), JSON.stringify(review));
  await promote({ directory: run.directory, store, approvedHash: run.artifactSha256, serverStopped: true });
  const snapshot = await store.read(); let captured;
  await runOperator({ decide: async input => { captured = input; return { decision, model: 'mock' }; } }, { ...snapshot.state, decisionHistory: snapshot.history });
  assert.deepEqual(captured.decisionHistory[0].researchInferencesNotReliedUpon, value.researchInferencesNotReliedUpon);
  assert.deepEqual(captured.decisionHistory[0].decision, value.decision);
  assert.deepEqual(captured.decisionHistory[0].selectedEvidence.map(x => x.id), ['O1', 'O2']);
});
