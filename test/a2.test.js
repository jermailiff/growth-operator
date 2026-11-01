import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE, executeContinuation, verifyArtifact } from '../src/continuation.js';
import { createResearch } from '../src/research.js';
import { createModel } from '../src/model.js';
import { INSTRUCTIONS, DECISION_SCHEMA } from '../src/operator.js';
import { temporaryStore } from './helpers.js';

const input = JSON.parse(await readFile(new URL('./fixtures/a2-sam-input.json', import.meta.url)));
const expectation = JSON.parse(await readFile(new URL('./fixtures/a2-sam-expectation.json', import.meta.url)));

test('A2 sends only the exact proposed input and carries complete mocked evidence through unchanged strategy', async t => {
  // Synthetic transport envelopes and responses: no M1 generation, web or model calls.
  // This checks wiring, not whether the live model meets the reviewer expectations.
  const directory = await mkdtemp(join(tmpdir(), 'm2-a2-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const protectedDirectory = (await temporaryStore(t)).directory;
  const stateBefore = await readFile(join(protectedDirectory, 'state.json'));
  const result = { decision: input.originatingDecision, model: 'synthetic-m1-fixture' };
  const files = {
    'context.json': input.context,
    'result.json': result,
    'request.json': { instructions: INSTRUCTIONS, input: JSON.stringify(input.context), text: { format: { schema: DECISION_SCHEMA } } },
    'response.raw.json': { status: 'completed', model: result.model, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result.decision) }] }] },
    'transport.json': { receivedAt: '2026-09-22T01:00:00.000Z' },
    'verification.json': { commit: BASELINE, completed: true, stateUnchanged: true, historyUnchanged: true }
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value));
  const url = 'https://sam.gov/entity-registration';
  const report = {
    disposition: 'researched', explanation: 'Synthetic response: external-document access is now authorized; the published prerequisite narrows the unresolved question.',
    scopeCompliant: true, unresolvedUnknowns: ['Overall contracting eligibility is outside this investigation.'],
    evidence: [
      { id: 'S1', status: 'sourced_fact', statement: 'Completed registration is required for the scoped prime contracting route.', sourceUrls: [url], contextRefs: [], basisIds: [], support: 'Synthetic source-attributed paraphrase: registration is required.' },
      { id: 'O1', status: 'owner_provided', statement: 'The business has a UEI but no completed active registration.', sourceUrls: [], contextRefs: ['/context/businessContext'], basisIds: [], support: 'The owner reports that the business has obtained a Unique Entity ID through SAM.gov but has not completed entity registration and has no active SAM.gov registration.' },
      { id: 'I1', status: 'inference', statement: 'The supplied business facts do not satisfy the registration prerequisite.', sourceUrls: [], contextRefs: [], basisIds: ['S1', 'O1'], support: 'Apply the published prerequisite to the supplied business facts.' }
    ]
  };
  let researchRequests = 0, strategicRequests = 0;
  const research = createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async (_, request) => {
    researchRequests++;
    const body = JSON.parse(request.body);
    assert.deepEqual(JSON.parse(body.input), input);
    assert.equal(body.input.includes(expectation.reviewerExpectedAnswer), false);
    assert.equal(body.input.includes(expectation.interpretation), false);
    assert.ok(body.input.includes(url));
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.max_tool_calls, expectation.maximumWebToolCalls);
    assert.equal(body.max_output_tokens, expectation.maximumResearchOutputTokens);
    return Response.json({ status: 'completed', model: 'mock-research', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url, sources: [{ url }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [{ type: 'url_citation', url }] }] }
    ] });
  } });
  let strategicContext;
  const makeDecision = schema => createModel({ apiKey: 'fake', model: 'mock', decisionSchema: schema, fetchImpl: async (_, request) => {
    strategicRequests++;
    const body = JSON.parse(request.body);
    strategicContext = JSON.parse(body.input);
    assert.equal(body.instructions, INSTRUCTIONS);
    assert.equal(body.tools, undefined);
    assert.equal(body.input.includes(expectation.reviewerExpectedAnswer), false);
    assert.equal(body.input.includes(expectation.interpretation), false);
    assert.deepEqual(strategicContext.researchEvidence.report, report);
    return Response.json({ status: 'completed', model: 'mock-strategy', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      decision: { ...input.originatingDecision, recommendedNextStep: 'The registration prerequisite is unmet; seek owner approval before registration work.', evidenceUsed: strategicContext.evidenceUsedOptions }, researchInferencesNotReliedUpon: []
    }) }] }] });
  } });
  const completed = await executeContinuation({ originDirectory: directory, protectedDirectory, research, makeDecision });
  const verified = verifyArtifact(completed.artifact);
  assert.equal(verified.valid, true);
  assert.equal(verified.research.report.disposition, expectation.expectedDisposition);
  assert.ok(verified.calls >= expectation.minimumWebToolCalls && verified.calls <= expectation.maximumWebToolCalls);
  assert.deepEqual(strategicContext.researchEvidence, JSON.parse(completed.artifact.researchText));
  assert.deepEqual(completed.artifact.selectedEvidence.map(item => item.status), ['sourced_fact', 'owner_provided', 'inference']);
  assert.equal(researchRequests, 1); assert.equal(strategicRequests, 1);
  assert.deepEqual(await readFile(join(protectedDirectory, 'state.json')), stateBefore);
  await assert.rejects(readFile(join(protectedDirectory, 'decisions.jsonl')), /ENOENT/);
  for (const [name, value] of Object.entries(files)) assert.equal(await readFile(join(directory, name), 'utf8'), JSON.stringify(value));
});
