import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promote } from '../scripts/promote-research.mjs';
import { BASELINE, executeContinuation, hash } from '../src/continuation.js';
import { createResearch } from '../src/research.js';
import { runOperator, INSTRUCTIONS, DECISION_SCHEMA } from '../src/operator.js';
import { state, decision, temporaryStore } from './helpers.js';

async function fixture(t) {
  const originDirectory = await mkdtemp(join(tmpdir(), 'm2-promotion-'));
  t.after(() => rm(originDirectory, { recursive: true, force: true }));
  const files = {
    'context.json': { ...state, decisionHistory: [] }, 'result.json': { decision, model: 'mock-m1' },
    'request.json': { instructions: INSTRUCTIONS, input: JSON.stringify({ ...state, decisionHistory: [] }), text: { format: { schema: DECISION_SCHEMA } } },
    'response.raw.json': { status: 'completed', model: 'mock-m1', output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] },
    'transport.json': { receivedAt: '2026-09-22T01:00:00.000Z' },
    'verification.json': { commit: BASELINE, completed: true, stateUnchanged: true, historyUnchanged: true }
  };
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(originDirectory, name), JSON.stringify(value))));
  const url = 'https://vendor.example/terms';
  const report = { disposition: 'public_research_cannot_resolve', explanation: 'Documentation states terms but does not establish coverage; no justified launch yet.', scopeCompliant: true,
    unresolvedUnknowns: ['Coverage cannot be established publicly.'], evidence: [
      { id: 'E1', status: 'provider_claim', statement: 'Provider states conditions.', sourceUrls: [url], contextRefs: [], basisIds: [], support: 'Source-attributed paraphrase: the provider states conditions.' },
      { id: 'E2', status: 'unknown', statement: 'Coverage is unknown.', sourceUrls: [], contextRefs: [], basisIds: [], support: '' }
    ] };
  const store = await temporaryStore(t);
  const run = await executeContinuation({ originDirectory, protectedDirectory: store.directory,
    research: createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async () => Response.json({ status: 'completed', model: 'mock-research', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [{ type: 'url_citation', url }] }] }
    ] }) }),
    makeDecision: () => ({ decide: async context => ({ model: 'mock-decision', decision: { decision: { ...decision, recommendedNextStep: 'Do not launch: public evidence cannot establish required coverage.', evidenceUsed: context.evidenceUsedOptions }, researchInferencesNotReliedUpon: [] } }) })
  });
  await store.append({ type: 'run_started', id: 'original', at: '2026-09-21T00:00:00.000Z', model: 'mock-m1' });
  await store.append({ type: 'run_completed', decisionId: 'original', at: '2026-09-21T00:01:00.000Z', model: 'mock-m1', decision });
  const stateBefore = await readFile(join(store.directory, 'state.json'));
  const historyBefore = await readFile(join(store.directory, 'decisions.jsonl'));
  const review = JSON.parse(await readFile(join(run.directory, 'review.json')));
  const approve = async () => {
    review.choice = 'Promote'; review.reviewedBy = 'Synthetic test reviewer'; review.reviewedAt = new Date().toISOString();
    review.criteria.forEach(item => { item.passed = true; item.notes = 'Synthetic fixture satisfies this criterion; not a live quality assessment.'; });
    await writeFile(join(run.directory, 'review.json'), JSON.stringify(review));
  };
  return { ...run, store, stateBefore, historyBefore, approve, review };
}

test('reviewed eligible unresolved result → explicit promotion → zero calls → exact evidence in next context once → state unchanged', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.read()).history.length, 1); // Unpromoted artifact is invisible.
  await f.approve();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Promotion must never call a provider or web tool.');
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await promote({ directory: f.directory, store: f.store, approvedHash: f.artifactSha256, serverStopped: true });
  assert.equal(result.promoted, true);
  assert.deepEqual(await readFile(join(f.store.directory, 'state.json')), f.stateBefore);
  assert.ok((await readFile(join(f.store.directory, 'decisions.jsonl'))).subarray(0, f.historyBefore.length).equals(f.historyBefore));
  const saved = await f.store.read(), event = saved.events.at(-1), record = saved.history.at(-1);
  assert.equal(event.artifactText, await readFile(join(f.directory, 'artifact.json'), 'utf8'));
  const embedded = JSON.parse(event.artifactText);
  assert.equal(embedded.researchText, f.artifact.researchText); assert.equal(embedded.resultText, f.artifact.resultText);
  assert.deepEqual(record.decision, JSON.parse(f.artifact.resultText).decision);
  assert.deepEqual(record.research, JSON.parse(f.artifact.researchText));
  assert.equal(record.createdAt, f.artifact.decisionCompletedAt);
  assert.equal(record.isolatedProvenance.promotedAt, event.at);
  await f.store.append({ type: 'outcome_recorded', decisionId: record.id, at: new Date().toISOString(), text: 'Hold until coverage is established.' });
  const snapshot = await f.store.read();
  let captured;
  await runOperator({ decide: async context => { captured = context; return { decision, model: 'mock' }; } }, { ...snapshot.state, decisionHistory: snapshot.history });
  assert.equal(captured.decisionHistory.filter(item => item.id === record.id).length, 1);
  assert.deepEqual(captured.decisionHistory.at(-1).research, record.research);
  assert.equal(captured.decisionHistory.at(-1).outcomes[0].text, 'Hold until coverage is established.');
  await assert.rejects(promote({ directory: f.directory, store: f.store, approvedHash: f.artifactSha256, serverStopped: true }), /already promoted/);
});

test('no approval, Do not promote, tampered artifact/hash, ineligible review and active-server acknowledgement fail without mutation', async t => {
  const f = await fixture(t);
  const options = { directory: f.directory, store: f.store, approvedHash: f.artifactSha256, serverStopped: true };
  await assert.rejects(promote(options), /approval/);
  f.review.choice = 'Do not promote'; await writeFile(join(f.directory, 'review.json'), JSON.stringify(f.review));
  assert.deepEqual(await promote(options), { promoted: false });
  await f.approve();
  await assert.rejects(promote({ ...options, approvedHash: 'wrong' }), /hash/);
  await assert.rejects(promote({ ...options, serverStopped: false }), /Stop the local server/);
  f.review.criteria[6].passed = false; await writeFile(join(f.directory, 'review.json'), JSON.stringify(f.review));
  await assert.rejects(promote(options), /ineligible/);
  await f.approve();
  const original = await readFile(join(f.directory, 'artifact.json'), 'utf8');
  const failedText = JSON.stringify({ ...JSON.parse(original), status: 'failed' });
  await writeFile(join(f.directory, 'artifact.json'), failedText);
  f.review.artifactSha256 = hash(failedText);
  await writeFile(join(f.directory, 'review.json'), JSON.stringify(f.review));
  await assert.rejects(promote({ ...options, approvedHash: hash(failedText) }), /Incomplete artifact/);
  f.review.artifactSha256 = f.artifactSha256;
  await f.approve();
  await writeFile(join(f.directory, 'artifact.json'), original);
  await writeFile(join(f.directory, 'artifact.json'), (await readFile(join(f.directory, 'artifact.json'), 'utf8')) + ' ');
  await assert.rejects(promote(options), /hash/);
  assert.deepEqual(await readFile(join(f.store.directory, 'state.json')), f.stateBefore);
  assert.deepEqual(await readFile(join(f.store.directory, 'decisions.jsonl')), f.historyBefore);
});
