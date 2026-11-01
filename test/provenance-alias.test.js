import test from 'node:test';
import assert from 'node:assert/strict';
import { citationMatcher, validateEvidence } from '../src/evidence.js';
import { createResearch, validateResearch } from '../src/research.js';
import { state, decision } from './helpers.js';

const base = 'https://agency.example/guidance';
const tracked = base + '?utm_source=openai';
function payload(citations, sources = []) {
  return { output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: sources.map(url => ({ type: 'url', url })) } },
    { type: 'message', content: [{ type: 'output_text', annotations: citations.map(url => ({ type: 'url_citation', url })) }] }
  ] };
}

test('exact citation equality remains primary, needs no source-list membership and preserves existing matches', () => {
  for (const url of [base, tracked, base + '?utm_source=other', base + '#section']) {
    assert.deepEqual(citationMatcher(payload([url]))(url), { method: 'exact', evidenceUrl: url, citationUrl: url });
  }
  assert.equal(citationMatcher(payload([tracked, base], [base]))(base).method, 'exact');
});

test('provider-corroborated literal tracking alias passes and preserves every other query component and fragment', () => {
  for (const [evidence, citation] of [
    [base, tracked],
    [base + '?article=42&lang=en#section', base + '?article=42&utm_source=openai&lang=en#section'],
    [base + '?article=42&lang=en', base + '?utm_source=openai&article=42&lang=en'],
    [base + '?article=42&lang=en', base + '?article=42&lang=en&utm_source=openai']
  ]) assert.deepEqual(citationMatcher(payload([citation], [evidence]))(evidence), {
    method: 'provider_corroborated_utm_source_openai_alias', evidenceUrl: evidence, citationUrl: citation, sourceUrl: evidence
  });
});

for (const [name, evidence, citations, sources] of [
  ['bare URL absent from source metadata', base, [tracked], []],
  ['different path', base + '/invented', [tracked], [base + '/invented']],
  ['different host', 'https://other.example/guidance', [tracked], ['https://other.example/guidance']],
  ['different subdomain', 'https://sub.agency.example/guidance', [tracked], ['https://sub.agency.example/guidance']],
  ['significant query difference', base + '?sysparm_article=KB2', [base + '?sysparm_article=KB1&utm_source=openai'], [base + '?sysparm_article=KB2']],
  ['fragment-only difference', base + '#one', [base + '#two'], [base + '#one']],
  ['fragment difference with tracking', base + '#one', [tracked + '#two'], [base + '#one']],
  ['source-list-only URL', base, [], [base]],
  ['other tracking parameter', base, [base + '?utm_medium=openai'], [base]],
  ['other tracking value', base, [base + '?utm_source=other'], [base]],
  ['duplicate tracking parameter', base, [tracked + '&utm_source=openai'], [base]],
  ['duplicate conflicting tracking parameter', base, [tracked + '&utm_source=other'], [base]],
  ['encoded parameter-name lookalike', base, [base + '?utm%5Fsource=openai'], [base]],
  ['encoded value lookalike', base, [base + '?utm_source=%6fpenai'], [base]],
  ['encoded duplicate alongside literal entry', base + '?utm%5Fsource=openai', [tracked + '&utm%5Fsource=openai'], [base + '?utm%5Fsource=openai']],
  ['ambiguous separators', base + '?x=1', [tracked + ';x=1'], [base + '?x=1']],
  ['ambiguous empty query entry', base + '?', [tracked + '&'], [base + '?']],
  ['trailing slash difference', base + '/', [tracked], [base + '/']],
  ['query reordering', base + '?a=1&b=2', [base + '?b=2&utm_source=openai&a=1'], [base + '?a=1&b=2']],
  ['percent-encoding normalization', base + '?article=A', [base + '?article=%41&utm_source=openai'], [base + '?article=A']],
  ['scheme difference', base.replace('https:', 'http:'), [tracked], [base.replace('https:', 'http:')]],
  ['invented evidence-side tracking', tracked, [base], [base]],
  ['non-public URLs', 'https://127.0.0.1/guidance', ['https://127.0.0.1/guidance?utm_source=openai'], ['https://127.0.0.1/guidance']]
]) test(`provenance alias rejects ${name}`, () => {
  assert.throws(() => citationMatcher(payload(citations, sources))(evidence), /absent from returned citations|Non-public source URL/);
});

test('multiple returned citations associate only the one valid provider-corroborated alias', () => {
  const raw = payload([base + '/different?utm_source=openai', base + '?article=42&utm_source=openai', tracked], [base]);
  const before = JSON.stringify(raw);
  assert.equal(citationMatcher(raw)(base).citationUrl, tracked);
  assert.equal(JSON.stringify(raw), before);
});

test('source metadata must come from an actual web_search_call, not model-declared equivalence', () => {
  const raw = payload([tracked]);
  raw.output.push({ type: 'message', action: { sources: [{ url: base }] }, equivalentUrls: [base, tracked] });
  assert.throws(() => citationMatcher(raw)(base), /absent from returned citations/);
});

test('synthetic FTC-shaped response passes specifically via alias and preserves raw bytes, URLs and evidence', async () => {
  // Independently authored synthetic fixture. Never imports an experimental artifact.
  const ftc = 'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business';
  const citation = ftc + '?utm_source=openai';
  const report = { disposition: 'researched', explanation: 'Synthetic public-document result.', scopeCompliant: true, unresolvedUnknowns: [], evidence: [
    { id: 'S6', status: 'sourced_fact', statement: `Synthetic source-attributed statement. (${citation})`, sourceUrls: [ftc], contextRefs: [], basisIds: [], support: 'Synthetic support for transport/provenance testing only.' }
  ] };
  const rawPayload = payload([citation], [ftc]);
  Object.assign(rawPayload, { status: 'completed', model: 'mock-research', usage: { output_tokens: 100 } });
  rawPayload.output[1].content[0].text = JSON.stringify(report);
  const rawBytes = JSON.stringify(rawPayload, null, 2) + '\n';
  const beforeReport = JSON.stringify(report);
  const metadata = [];
  validateEvidence(report, rawPayload, {}, metadata);
  assert.deepEqual(metadata, [{ evidenceId: 'S6', method: 'provider_corroborated_utm_source_openai_alias', evidenceUrl: ftc, citationUrl: citation, sourceUrl: ftc }]);
  let requests = 0;
  const input = { context: state, originatingDecision: decision };
  const run = createResearch({ apiKey: 'fake', model: 'mock', fetchImpl: async () => { requests++; return new Response(rawBytes); } });
  const result = await run(input);
  assert.equal(requests, 1);
  assert.equal(result.rawResponse, rawBytes);
  assert.equal(JSON.stringify(result.report), beforeReport);
  assert.deepEqual(result.provenanceMatches, metadata);
  assert.equal(JSON.stringify(rawPayload, null, 2) + '\n', rawBytes);
  assert.equal(result.report.evidence[0].sourceUrls[0], ftc);
  assert.equal(JSON.parse(result.rawResponse).output[1].content[0].annotations[0].url, citation);
  const tampered = structuredClone(result); tampered.provenanceMatches[0].method = 'exact';
  assert.throws(() => validateResearch(tampered, input), /provenance match metadata/);
  const invented = { ...report, evidence: [{ ...report.evidence[0], sourceUrls: [ftc + '-invented'] }] };
  assert.throws(() => validateEvidence(invented, rawPayload, {}), /absent from returned citations/);
});
