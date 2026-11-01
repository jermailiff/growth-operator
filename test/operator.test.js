import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createModel } from '../src/model.js';
import { INSTRUCTIONS, DECISION_SCHEMA, runOperator, validateDecision } from '../src/operator.js';
import { state, decision } from './helpers.js';

test('adapter sends complete runtime state and outcomes using a configurable model and no tools', async () => {
  let captured;
  const context = { ...state, decisionHistory: [{ id: 'earlier', decision, outcomes: [{ text: 'Unknown, cannot retrieve.' }] }] };
  const model = createModel({ apiKey: 'unit-test-key', model: 'configured-model', fetchImpl: async (url, request) => {
    captured = JSON.parse(request.body);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return Response.json({ status: 'completed', model: 'resolved-model', output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] });
  } });
  const result = await runOperator(model, context);
  assert.deepEqual(JSON.parse(captured.input), context);
  assert.equal(captured.model, 'configured-model');
  assert.equal(captured.instructions, INSTRUCTIONS);
  assert.deepEqual(captured.text.format.schema, DECISION_SCHEMA);
  assert.equal(captured.store, false);
  assert.equal(captured.tools, undefined);
  assert.equal(result.model, 'resolved-model');
});

test('invalid structured output is rejected, including wrong types and extra fields', () => {
  for (const invalid of [null, {}, { ...decision, extra: true }, { ...decision, ownerInputRequired: 'yes' }, { ...decision, evidenceUsed: 'invented' }, { ...decision, proposedAction: '' }]) {
    assert.throws(() => validateDecision(invalid));
  }
});

test('missing credentials never make a request', async () => {
  const model = createModel({ model: 'test', fetchImpl: () => { throw new Error('Must not call'); } });
  await assert.rejects(model.decide(state), /OPENAI_API_KEY/);
});

test('provider errors, refusals, incomplete and malformed responses are explicit; no retries', async () => {
  for (const [response, expected] of [
    [new Response('', { status: 429 }), /billing/],
    [Response.json({ status: 'incomplete', output: [] }), /did not complete/],
    [Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }), /declined/],
    [Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] }), /fields/]
  ]) {
    let calls = 0;
    const model = createModel({ apiKey: 'test', model: 'test', fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(runOperator(model, state), expected);
    assert.equal(calls, 1);
  }
});

test('production code and UI contain no original-business names or legacy imports', async () => {
  async function inspect(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
      if (entry.isDirectory()) { await inspect(path); continue; }
      const source = await readFile(path, 'utf8');
      // Apollo is now an approved generic adapter; business-specific strategies remain forbidden.
      assert.doesNotMatch(source, /perry|anthropic|presidio|real.estat|PERRY_BUSINESS_CONTEXT/i, entry.name);
      assert.doesNotMatch(source, /from\s+['"]\.\.\/\.\.\//, entry.name);
    }
  }
  for (const directory of ['src', 'public']) await inspect(new URL('../' + directory + '/', import.meta.url));
});

test('mandate distinguishes experimentation capacity from quotas, owner workload and automatic initiative preference', () => {
  assert.match(INSTRUCTIONS, /discover and develop effective acquisition channels through disciplined experimentation/);
  assert.match(INSTRUCTIONS, /product hypothesis, not a promised improvement or a mandatory experiment quota/);
  assert.match(INSTRUCTIONS, /Operator work is not costless, but it is not automatically owner work/);
  assert.match(INSTRUCTIONS, /waiting for results does not automatically block/);
  assert.match(INSTRUCTIONS, /not ideas to reject merely for lacking evidence/);
  assert.match(INSTRUCTIONS, /do not prefer new acquisition work merely because it is new/);
  assert.match(INSTRUCTIONS, /provide the actual draft or brief in the existing response fields/);
  assert.match(INSTRUCTIONS, /Missing results are not zero results/);
});

test('mandate acknowledges browser research without granting decision calls tools or external execution', () => {
  assert.doesNotMatch(INSTRUCTIONS, /This milestone only reasons and proposes|No research, retrieval/);
  assert.match(INSTRUCTIONS, /bounded public-document research capability/);
  assert.match(INSTRUCTIONS, /This individual decision call has no research tools/);
  assert.match(INSTRUCTIONS, /final decision must use the supplied research artifact and context without pretending to conduct additional research/);
  assert.match(INSTRUCTIONS, /Without an explicitly supplied and owner-approved acquisition capability, the system cannot collect prospect records or spend money/);
  assert.match(INSTRUCTIONS, /Consequential external actions require explicit owner approval/);
  assert.match(INSTRUCTIONS, /Never propose prohibited profile scraping or guessed contact patterns/);
  assert.match(INSTRUCTIONS, /Do not invent execution, customer responses, conversions, learning or success/);
});
