import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearch, validateResearch } from '../src/research.js';
import { eligibleReport, evidenceChoices, validateDecisionEvidence } from '../src/evidence.js';
import { liveDecisionContext, decideFromResearch } from '../src/continuation.js';
import { substantiveResearch, browserModelContext } from '../src/model-context.js';
import { projectHistory } from '../src/store.js';
import { state, decision } from './helpers.js';

const context = { ...state, decisionHistory: [] };
const input = { context, originatingDecision: decision };
const url = 'https://workshop.example/rules', absent = 'https://workshop.example/uncited';
const evidence = (id, status, basisIds = [], sourceUrls = []) => ({ id, status, statement: 'Claim ' + id,
  support: 'Source-attributed paraphrase for ' + id, sourceUrls, contextRefs: [], basisIds });
const report = () => ({ disposition: 'researched', explanation: 'EXCLUDED NARRATIVE: launch immediately.',
  unresolvedUnknowns: ['EXCLUDED SUMMARY: rival route inferior.'], scopeCompliant: true, evidence: [
    evidence('compound', 'sourced_fact', [], [url, absent]),
    evidence('direct', 'inference', ['compound']),
    evidence('transitive', 'inference', ['direct']),
    evidence('independent', 'sourced_fact', [], [url]),
    evidence('eligibleInference', 'inference', ['independent'])
  ] });
const payload = value => ({ status: 'completed', model: 'mock', usage: { output_tokens: 100 }, output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url }, { url: absent }] } },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [{ type: 'url_citation', url }] }] }
] });
async function run(value = report(), mutate = p => p, allowPartial = true) {
  const raw = JSON.stringify(mutate(payload(value)));
  const result = await createResearch({ apiKey: 'fake', model: 'mock', allowPartial,
    fetchImpl: async () => new Response(raw) })(input);
  return { result, raw };
}
test('partial excludes whole compound and transitive dependents; keeps independent records and audit verbatim', async () => {
  const original = report(), { result, raw } = await run(original);
  assert.equal(result.rawResponse, raw); assert.deepEqual(result.report, original);
  assert.deepEqual(eligibleReport(result).evidence, original.evidence.slice(3));
  assert.deepEqual(result.admission.exclusions.map(x => x.evidenceId), ['compound', 'direct', 'transitive']);
  assert.deepEqual(result.admission.exclusions[0].failures, [{ evidenceId: 'compound', url: absent, reason: 'source_absent_from_returned_citations' }]);
  assert.deepEqual(result.admission.exclusions[2].dependencyIds, ['direct']);
  assert.ok(result.admission.exclusions.every(x => x.availability === 'unavailable_not_accepted'));
  validateResearch(result, input, { allowPartial: true });
});
test('partial strategy omits excluded narrative; cannot select excluded evidence; eligible inference accounting still enforced', async () => {
  const { result } = await run();
  const c = liveDecisionContext(context, decision, result);
  assert.deepEqual(c.decisionHistory, []);
  assert.ok(!JSON.stringify(c).includes('EXCLUDED'));
  assert.ok(!JSON.stringify(c.researchEvidence).includes('"rawResponse"'));
  assert.ok(!JSON.stringify(c.researchEvidence.report).includes('Claim compound'));
  assert.throws(() => validateDecisionEvidence({ ...decision, evidenceUsed: [evidenceChoices(result.report)[0]] }, eligibleReport(result)), /altered evidence/);
  await assert.rejects(decideFromResearch(c, result, () => ({ decide: async () => ({ model: 'mock',
    decision: { decision: { ...decision, evidenceUsed: [] }, researchInferencesNotReliedUpon: [] } }) })), /neither selected in evidenceUsed nor explicitly accounted/);
  const accepted = await decideFromResearch(c, result, schema => {
    assert.ok(schema.description.includes('Keep launch conditional or blocked'));
    return { decide: async () => ({ model: 'mock', decision: {
      decision: { ...decision, evidenceUsed: evidenceChoices(eligibleReport(result)) }, researchInferencesNotReliedUpon: []
    } }) };
  });
  assert.equal(accepted.model, 'mock');
});
test('partial admission and exclusions persist and reach subsequent context without original narrative', async () => {
  const { result } = await run();
  const events = [{ type: 'run_started', id: 'run', at: 'now', model: 'mock' },
    { type: 'run_progress', decisionId: 'run', work: { research: result } },
    { type: 'run_completed', decisionId: 'run', model: 'mock', decision },
    { type: 'outcome_recorded', decisionId: 'run', at: 'later', text: 'Compare both routes; do not launch.' }];
  const history = projectHistory(JSON.parse(JSON.stringify(events)));
  assert.equal(history[0].research.rawResponse, result.rawResponse);
  const c = browserModelContext({ state, events, history });
  assert.deepEqual(c.decisionHistory[0].research.exclusions, result.admission.exclusions);
  assert.ok(!JSON.stringify(c).includes('EXCLUDED'));
  assert.equal(c.decisionHistory[0].outcomes[0].text, events[3].text);
});
test('no eligible evidence clearly reported; fully valid path unchanged; isolated default remains strict', async () => {
  const allBad = report(); allBad.evidence = allBad.evidence.slice(0, 3);
  const { result } = await run(allBad);
  assert.equal(eligibleReport(result).evidence.length, 0);
  assert.match(eligibleReport(result).explanation, /no decision-eligible research evidence remains/);
  const valid = report(); valid.evidence = valid.evidence.slice(3);
  const good = (await run(valid)).result;
  assert.equal(good.admission, undefined);
  assert.deepEqual(substantiveResearch(good).report, valid);
  await assert.rejects(run(report(), p => p, false), /absent from returned citations/);
});
test('partial never recovers malformed identity, dependency, safety, bounds, or public URL failures', async () => {
  for (const mutate of [
    r => r.evidence.push(r.evidence[0]),
    r => r.evidence[1].basisIds.push('missing'),
    r => r.evidence[1].basisIds.push('transitive'),
    r => r.scopeCompliant = false,
    r => r.evidence[0].sourceUrls.push('http://localhost/secret'),
    r => r.evidence[0].support = '',
  ]) {
    const r = report(); mutate(r);
    await assert.rejects(run(r));
  }
  await assert.rejects(run(report(), p => ({ ...p, output: [...Array(6).fill(p.output[0]), p.output[1]] })), /tool-call bound/);
  await assert.rejects(run(report(), p => ({ ...p, output: [{ ...p.output[0], action: { type: 'search', query: 'list of employees' } }, p.output[1]] })), /Prohibited/);
  await assert.rejects(run(report(), p => ({ ...p, status: 'incomplete' })), /incomplete/);
  const { result } = await run(); result.admission.report.evidence.push(result.report.evidence[0]);
  assert.throws(() => validateResearch(result, input, { allowPartial: true }), /admission integrity/);
});
