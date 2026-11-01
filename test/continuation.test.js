import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE, executeContinuation, loadOrigin, verifyArtifact, hash } from '../src/continuation.js';
import { createResearch } from '../src/research.js';
import { createModel } from '../src/model.js';
import { INSTRUCTIONS, DECISION_SCHEMA } from '../src/operator.js';
import { state, decision, temporaryStore } from './helpers.js';

async function fixture(t, business = state, originatingDecision = { ...decision, proposedAction: 'Examine public eligibility documentation without collecting records or contacting anyone.' }) {
  const directory = await mkdtemp(join(tmpdir(), 'm2-isolated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { ...business, decisionHistory: [{ id: 'run-1', decision, outcomes: [{ text: 'Compare alternatives using evidence.' }] }] };
  const result = { decision: originatingDecision, model: 'mock-m1' };
  const files = {
    'context.json': context, 'result.json': result,
    'request.json': { instructions: INSTRUCTIONS, input: JSON.stringify(context), text: { format: { schema: DECISION_SCHEMA } } },
    'response.raw.json': { status: 'completed', model: result.model, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result.decision) }] }] },
    'transport.json': { receivedAt: '2026-09-22T01:00:00.000Z' },
    'verification.json': { commit: BASELINE, completed: true, stateUnchanged: true, historyUnchanged: true }
  };
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(directory, name), JSON.stringify(value))));
  return { directory, context, result, protectedDirectory: (await temporaryStore(t)).directory };
}

function research(value = 'The provider excludes this use.', disposition = 'researched', malformedOwner = false, capturedRaw = []) {
  const url = 'https://vendor.example/eligibility';
  const report = { disposition, explanation: 'Examined eligibility; demand remains unknown.', scopeCompliant: true,
    unresolvedUnknowns: ['Demand.'], evidence: disposition === 'researched' ? [
      { id: 'E1', status: 'provider_claim', statement: value, sourceUrls: [url], contextRefs: [], basisIds: [], support: `Source-attributed paraphrase: ${value}` },
      { id: 'E2', status: 'unknown', statement: 'Demand is unknown.', sourceUrls: [], contextRefs: [], basisIds: [], support: '' },
      { id: 'O1', status: 'owner_provided', statement: 'The owner asks to compare alternatives using evidence.', sourceUrls: [],
        contextRefs: ['/context/decisionHistory/0/outcomes/0/text'], basisIds: [],
        support: malformedOwner ? 'Exact supplied substring: "Compare alternatives using evidence."' : 'Compare alternatives using evidence.' }
    ] : [] };
  return createResearch({ apiKey: 'test', model: 'mock', fetchImpl: async () => {
    const raw = JSON.stringify({ status: 'completed', model: 'mock-research', output: [
    ...(disposition === 'researched' ? [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url }] } }] : []),
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [{ type: 'url_citation', url }] }] }
    ] });
    capturedRaw.push(raw);
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
  } });
}

function makeDecision(captured = []) {
  return schema => createModel({ apiKey: 'test', model: 'mock', decisionSchema: schema, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body), context = JSON.parse(body.input);
    captured.push({ body, context });
    // A wiring double, not proof of real-model judgment or sensitivity.
    const next = context.researchEvidence.report.evidence[0]?.statement.includes('excludes') ? 'Do not proceed: documented blocker.' : 'Propose a bounded test subject to the remaining unknowns.';
    return Response.json({ status: 'completed', model: 'mock-decision', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision: { ...decision, recommendedNextStep: next, evidenceUsed: context.evidenceUsedOptions }, researchInferencesNotReliedUpon: [] }) }] }] });
  } });
}

test('one isolated continuation supplies complete original context and unfiltered raw research to unchanged strategic prompt', async t => {
  const f = await fixture(t), captured = [];
  const originBefore = await readFile(join(f.directory, 'context.json'));
  const result = await executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(), makeDecision: makeDecision(captured) });
  assert.equal(captured.length, 1);
  const { context, body } = captured[0];
  assert.equal(body.instructions, INSTRUCTIONS); assert.equal(body.tools, undefined);
  assert.deepEqual(context.decisionHistory.slice(0, -1), f.context.decisionHistory);
  assert.deepEqual(context.decisionHistory.at(-1).decision, f.result.decision);
  assert.deepEqual(context.researchEvidence, JSON.parse(result.artifact.researchText));
  assert.match(context.researchEvidence.rawResponse, /Demand is unknown/);
  assert.equal(result.artifact.selectedEvidence.find(item => item.id === 'O1').support, 'Compare alternatives using evidence.');
  assert.ok(JSON.parse(result.artifact.resultText).decision.evidenceUsed.some(item => item.startsWith('[OWNER_PROVIDED O1;')));
  assert.deepEqual(await readFile(join(f.directory, 'context.json')), originBefore);
  assert.equal(hash(await readFile(join(result.directory, 'artifact.json'))), result.artifactSha256);
  assert.equal(verifyArtifact(result.artifact).valid, true);
  assert.equal(JSON.parse(await readFile(join(result.directory, 'review.json'))).choice, null);
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: () => assert.fail('No repeat'), makeDecision: makeDecision() }), /EEXIST/);
});

test('complete contrary evidence and a second business flow through the same domain-independent path', async t => {
  const inputs = [];
  for (const [value, expected] of [['The provider excludes this use.', /Do not proceed/], ['The provider permits this use.', /bounded test/]]) {
    const f = await fixture(t, { businessContext: 'A repair shop considering a municipal vendor channel.', objective: 'Win two service contracts.', initiatives: [], state: 'Eligibility and demand are unverified.' });
    const result = await executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(value), makeDecision: makeDecision(inputs) });
    assert.match(JSON.parse(result.artifact.resultText).decision.recommendedNextStep, expected);
    assert.equal(inputs.at(-1).context.businessContext, 'A repair shop considering a municipal vendor channel.');
  }
  assert.notDeepEqual(inputs[0].context.researchEvidence.report, inputs[1].context.researchEvidence.report);
});

test('insufficient task stops before strategic decision; unnecessary/publicly unresolvable research requires no web action', async t => {
  for (const disposition of ['insufficient_task_definition', 'research_unnecessary', 'public_research_cannot_resolve']) {
    const f = await fixture(t), captured = [];
    const pending = executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research('', disposition), makeDecision: makeDecision(captured) });
    if (disposition === 'insufficient_task_definition') {
      await assert.rejects(pending); assert.equal(captured.length, 0);
    } else {
      const result = await pending;
      assert.equal(verifyArtifact(result.artifact).calls, 0); assert.equal(captured.length, 1);
    }
  }
});

test('one explicit infrastructure retry before research exists, never automatic and never a third attempt', async t => {
  const f = await fixture(t);
  let calls = 0;
  const failing = createResearch({ apiKey: 'test', model: 'mock', fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: failing, makeDecision: makeDecision() }));
  assert.equal(calls, 1);
  const result = await executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(), makeDecision: makeDecision(), manualRetry: true });
  assert.equal(result.artifact.attempt, 2);
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: () => assert.fail('No third attempt'), makeDecision: makeDecision(), manualRetry: true }), /EEXIST/);
});

test('a strategic failure after valid research cannot trigger a manual research or model retry', async t => {
  const f = await fixture(t);
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(), makeDecision: () => ({ decide: async () => { throw new Error('Decision connection failed.'); } }) }), /Decision connection/);
  const failure = JSON.parse(await readFile(join(f.directory, 'm2-continuation/attempt-1/failure.json')));
  assert.equal(failure.manualRetryEligible, false);
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: () => assert.fail('No research'), makeDecision: makeDecision(), manualRetry: true }), /not eligible/);
});

test('recursion and artifact edits fail validation', async t => {
  const f = await fixture(t);
  const result = await executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(), makeDecision: makeDecision() });
  const tampered = structuredClone(result.artifact);
  tampered.decisionContextText = JSON.stringify({ missing: 'research' });
  assert.throws(() => verifyArtifact(tampered), /Complete research/);
  const context = { ...f.context, researchEvidence: {} };
  await writeFile(join(f.directory, 'context.json'), JSON.stringify(context));
  await assert.rejects(loadOrigin(f.directory), /unchanged M1/);
});

test('changed protected files prevent a completed/promotable artifact without attempting restoration', async t => {
  const f = await fixture(t);
  await assert.rejects(executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory, research: research(),
    makeDecision: () => ({ decide: async context => {
      await writeFile(join(f.protectedDirectory, 'state.json'), JSON.stringify({ ...state, state: 'Concurrent external edit in a temporary fixture.' }));
      return { model: 'mock', decision: { decision: { ...decision, evidenceUsed: context.evidenceUsedOptions }, researchInferencesNotReliedUpon: [] } };
    } })
  }), /Live files changed/);
  await assert.rejects(readFile(join(f.directory, 'm2-continuation/artifact.json')), /ENOENT/);
  const failure = JSON.parse(await readFile(join(f.directory, 'm2-continuation/attempt-1/failure.json')));
  assert.equal(failure.manualRetryEligible, false);
});

test('malformed owner evidence preserves raw response, blocks strategy and remains non-retryable', async t => {
  const f = await fixture(t), captured = [], raw = [];
  const run = { originDirectory: f.directory, protectedDirectory: f.protectedDirectory,
    research: research('The provider excludes this use.', 'researched', true, raw), makeDecision: makeDecision(captured) };
  await assert.rejects(executeContinuation(run), /Evidence O1 .*Owner support does not match context/);
  assert.equal(raw.length, 1); assert.equal(captured.length, 0);
  const directory = join(f.directory, 'm2-continuation');
  const failureText = await readFile(join(directory, 'attempt-1/failure.json'), 'utf8');
  const failure = JSON.parse(failureText);
  assert.equal(failure.audit.rawResponse, raw[0]);
  assert.equal(failure.stage, 'research'); assert.equal(failure.manualRetryEligible, false);
  for (const file of ['attempt-1/research.json', 'attempt-1/decision-context.json', 'attempt-1/result.json', 'artifact.json']) {
    await assert.rejects(readFile(join(directory, file)), /ENOENT/);
  }
  const manifest = await readFile(join(directory, 'manifest.json'));
  const events = await readFile(join(directory, 'events.jsonl'));
  await assert.rejects(executeContinuation({ ...run, manualRetry: true }), /not eligible/);
  await assert.rejects(executeContinuation(run), /EEXIST/);
  assert.equal(raw.length, 1); assert.equal(captured.length, 0);
  assert.equal(await readFile(join(directory, 'attempt-1/failure.json'), 'utf8'), failureText);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifest);
  assert.deepEqual(await readFile(join(directory, 'events.jsonl')), events);
});

// Predetermined synthetic responses verify contract delivery and continuation handling,
// not that a real model selects these dispositions. No model/API evaluation occurs here.
const historicalRestriction = 'This version cannot inspect external documents. Prepare an eligibility-assessment outline only; the operator would examine the published requirements later.';
const eligibilityQuestion = 'Does the published municipal maintenance program require an accreditation the business lacks?';
const boundaryCases = [
  {
    name: 'investigation describable but eligibility unresolved', restriction: historicalRestriction,
    state: 'Synthetic scenario: examine the published eligibility page, identify accreditation requirements, and compare them with our qualifications. These steps are fully specified, but no requirements have been retrieved. The business lacks accreditation X.',
    questions: [eligibilityQuestion], disposition: 'researched', calls: 1,
    explanation: 'An outline is possible, but supplied evidence does not establish the eligibility requirement. Public documentation can narrow that uncertainty.',
    remaining: []
  },
  {
    name: 'matched restraint: supplied evidence already resolves eligibility', restriction: historicalRestriction,
    state: 'Synthetic supplied current public program requirement: accreditation X is mandatory, with no exceptions. Owner-provided qualification: the business lacks accreditation X. These facts establish the immediate eligibility blocker; no other eligibility uncertainty remains.',
    questions: [eligibilityQuestion], disposition: 'research_unnecessary', calls: 0,
    explanation: 'The supplied requirement and owner qualification establish the blocker. Additional research is unnecessary for this eligibility decision.',
    remaining: []
  },
  {
    name: 'public research cannot materially help with the remaining private uncertainty', restriction: historicalRestriction,
    state: 'Synthetic scenario: public eligibility is already established. Only the owner knows whether they privately intend to accept the required weekend schedule; that intention has not been supplied.',
    questions: ['Does the owner privately intend to accept the weekend schedule?'], disposition: 'public_research_cannot_resolve', calls: 0,
    explanation: 'Public documents cannot materially narrow an unreported private owner intention.',
    remaining: ['Owner intention remains unknown.']
  },
  {
    name: 'mixed public eligibility and observational performance uncertainty', restriction: historicalRestriction,
    state: 'Synthetic scenario: published accreditation requirements have not been examined. Actual repair turnaround under this contract has never been observed.',
    questions: [eligibilityQuestion, 'What turnaround will the business actually achieve?'], disposition: 'researched', calls: 1,
    explanation: 'Investigate published eligibility even though actual turnaround requires observations and remains unknown.',
    remaining: ['Actual repair turnaround remains unobserved.']
  },
  {
    name: 'binding owner prohibition remains binding', restriction: 'The owner expressly prohibits external research for this project, even if a research capability becomes available.',
    state: 'Synthetic scenario: the owner prohibition remains in force and published eligibility is unknown.',
    questions: [eligibilityQuestion], disposition: 'insufficient_task_definition', calls: 0,
    explanation: 'The binding owner prohibition conflicts with research execution. Clarification is needed; it is not a historical capability limitation.',
    remaining: [eligibilityQuestion]
  },
  {
    name: 'ambiguous restriction stops for clarification', restriction: 'Do not research now; prepare an outline only. The reason for this restriction is not recorded.',
    state: 'Synthetic scenario: eligibility is unknown and the record does not establish whether the restriction reflects owner intent or missing capability.',
    questions: [eligibilityQuestion], disposition: 'insufficient_task_definition', calls: 0,
    explanation: 'It is materially ambiguous whether the restriction is substantive or capability-related; do not override it.',
    remaining: [eligibilityQuestion]
  }
];

for (const scenario of boundaryCases) test(`municipal repair contract fixture: ${scenario.name}`, async t => {
  const origin = { ...decision, assessment: 'Determine whether a small repair business should pursue a municipal maintenance contract.',
    recommendedNextStep: 'Assess published eligibility for the municipal maintenance contract.',
    importantUnknowns: scenario.questions, proposedAction: scenario.restriction + ' No applications, contacting officials, data acquisition or spending.',
    intendedOutcomeOrEvidence: 'Evidence resolving the eligibility prerequisite, with remaining uncertainties identified.' };
  const f = await fixture(t, { businessContext: 'A small repair business considering a municipal maintenance contract.',
    objective: 'Determine whether to pursue one municipal service contract.', initiatives: [], state: scenario.state }, origin);
  const originBytes = await readFile(join(f.directory, 'result.json'));
  const captured = [];
  let requests = 0;
  const source = 'https://municipality.example/maintenance/eligibility';
  const report = { disposition: scenario.disposition, explanation: scenario.explanation, scopeCompliant: true,
    unresolvedUnknowns: scenario.remaining, evidence: scenario.calls ? [{ id: 'S1', status: 'sourced_fact',
      statement: 'The synthetic published requirement makes accreditation X mandatory.', sourceUrls: [source], contextRefs: [], basisIds: [],
      support: 'Synthetic fixture excerpt: accreditation X is mandatory.' }] : [] };
  const researchModel = createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async (_, request) => {
    requests++;
    const body = JSON.parse(request.body);
    assert.deepEqual(JSON.parse(body.input), { context: f.context, originatingDecision: origin });
    assert.equal(body.tool_choice, 'auto'); assert.equal(body.max_tool_calls, 5);
    assert.ok(body.instructions.includes('Having enough context to describe, scope or document an investigation is not sufficient.'));
    return Response.json({ status: 'completed', model: 'mock', output: [
      ...(scenario.calls ? [{ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'municipal maintenance accreditation requirement', sources: [{ url: source }] } }] : []),
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report),
        annotations: scenario.calls ? [{ type: 'url_citation', url: source }] : [] }] }
    ] });
  } });
  const pending = executeContinuation({ originDirectory: f.directory, protectedDirectory: f.protectedDirectory,
    research: researchModel, makeDecision: makeDecision(captured) });
  if (scenario.disposition === 'insufficient_task_definition') {
    await assert.rejects(pending, error => error.message === scenario.explanation);
    assert.equal(captured.length, 0);
  } else {
    const result = await pending;
    assert.equal(verifyArtifact(result.artifact).calls, scenario.calls);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].context.researchEvidence.report, report);
    assert.equal(captured[0].body.instructions, INSTRUCTIONS);
  }
  const savedResearch = JSON.parse(await readFile(join(f.directory, 'm2-continuation/attempt-1/research.json'), 'utf8'));
  assert.deepEqual(savedResearch.report, report);
  assert.equal(JSON.parse(savedResearch.rawResponse).output.filter(item => item.type === 'web_search_call').length, scenario.calls);
  assert.equal(requests, 1);
  assert.deepEqual(await readFile(join(f.directory, 'result.json')), originBytes);
});
