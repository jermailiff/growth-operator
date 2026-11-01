import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceChoices, evidenceSchema, validateDecisionEvidence, validateEvidence } from '../src/evidence.js';
import { DECISION_SCHEMA } from '../src/operator.js';
import { decision } from './helpers.js';

const url = 'https://vendor.example/policies';
const record = (id, status, rest = {}) => ({ id, status, statement: 'A limited claim.', support: '', sourceUrls: [], contextRefs: [], basisIds: [], ...rest });
const input = { context: { objective: 'Two bookings.', state: 'Partnerships may help.' } };
const payload = { output: [{ content: [{ annotations: [{ type: 'url_citation', url, title: 'Policy' }] }] }] };
function report() {
  return { disposition: 'researched', explanation: 'Documentation examined.', scopeCompliant: true, unresolvedUnknowns: ['Actual demand.'], evidence: [
    record('E1', 'sourced_fact', { sourceUrls: [url], support: 'Source-attributed paraphrase: the published policy has eligibility conditions.' }),
    record('E2', 'provider_claim', { sourceUrls: [url], support: 'Source-attributed paraphrase: the provider claims coverage.' }),
    record('E3', 'owner_provided', { contextRefs: ['/context/objective'], support: 'Two bookings.' }),
    record('E4', 'owner_hypothesis', { contextRefs: ['/context/state'], support: 'Partnerships may help.' }),
    record('E5', 'inference', { basisIds: ['E1', 'E2'] }), record('E6', 'unknown')
  ] };
}

test('all six statuses survive as exact decision strings and structured selected records without changing M1 schema', () => {
  const original = JSON.stringify(DECISION_SCHEMA), research = report();
  validateEvidence(research, payload, input);
  const choices = evidenceChoices(research);
  assert.deepEqual(evidenceSchema(research).properties.evidenceUsed.items.enum, choices);
  assert.deepEqual(validateDecisionEvidence({ ...decision, evidenceUsed: choices }, research), research.evidence);
  assert.equal(JSON.stringify(DECISION_SCHEMA), original);
  assert.match(choices[1], /PROVIDER_CLAIM E2/);
  assert.throws(() => validateDecisionEvidence({ ...decision, evidenceUsed: [choices[1].replace('PROVIDER_CLAIM', 'SOURCED_FACT')] }, research), /altered/);
  assert.throws(() => validateDecisionEvidence({ ...decision, evidenceUsed: ['Unattributed web conclusion.'] }, research), /altered/);
});

test('invented citations, absent support, fabricated owner quotes, missing/cyclic inference references and invalid statuses fail', () => {
  for (const mutate of [
    r => { r.evidence[0].sourceUrls = ['https://invented.example/']; },
    r => { r.evidence[0].support = ''; },
    r => { r.evidence[2].support = 'Owner approved everything.'; },
    r => { r.evidence[3].contextRefs = ['/context/missing']; },
    r => { r.evidence[4].basisIds = ['missing']; },
    r => { r.evidence[4].basisIds = ['E5']; },
    r => { r.evidence[0].status = 'verified'; },
    r => { r.evidence[1].id = 'E1'; },
    r => { r.scopeCompliant = false; }
  ]) { const value = report(); mutate(value); assert.throws(() => validateEvidence(value, payload, input)); }
});

test('search visibility alone cannot supply evidence provenance; empty evidence permits no free-text evidenceUsed', () => {
  const research = report();
  assert.throws(() => validateEvidence(research, { output: [{ action: { sources: [{ url }] } }] }, input), /citations/);
  research.evidence = [];
  assert.equal(evidenceSchema(research).properties.evidenceUsed.maxItems, 0);
  assert.deepEqual(validateDecisionEvidence({ ...decision, evidenceUsed: [] }, research), []);
});

test('owner wrappers, added quotation delimiters, joined excerpts and paraphrases fail exact matching with ID and reference', () => {
  const ownerInput = { context: { objective: 'Book two jobs. Capacity is limited. Referrals are untested.' } };
  for (const support of [
    'Exact supplied substring: "Book two jobs."',
    '"Book two jobs."',
    'Book two jobs.; Referrals are untested.',
    'Book two jobs. Referrals are untested.',
    'book two jobs.',
    'Book  two jobs.'
  ]) {
    const value = { ...report(), evidence: [record('O1', 'owner_provided', { contextRefs: ['/context/objective'], support })] };
    assert.throws(() => validateEvidence(value, payload, ownerInput), error => {
      assert.match(error.message, /Evidence O1/);
      assert.match(error.message, /\/context\/objective/);
      assert.match(error.message, /bare verbatim substring/);
      return true;
    });
  }
  const valid = { ...report(), evidence: [record('O1', 'owner_provided', { contextRefs: ['/context/objective'], support: 'Book two jobs.' })] };
  assert.equal(validateEvidence(valid, payload, ownerInput), valid);
});

test('multiple owner passages require separate records, not mixed or duplicate references', () => {
  const ownerInput = { context: { objective: 'Same words.', state: 'Same words.' } };
  for (const refs of [[], ['/context/objective', '/context/state'], ['/context/objective', '/context/objective']]) {
    const value = { ...report(), evidence: [record('O2', 'owner_hypothesis', { contextRefs: refs, support: 'Same words.' })] };
    assert.throws(() => validateEvidence(value, payload, ownerInput), /Evidence O2 .*exactly one owner-context reference/);
  }
  const valid = { ...report(), evidence: [
    record('O1', 'owner_provided', { contextRefs: ['/context/objective'], support: 'Same words.' }),
    record('O2', 'owner_hypothesis', { contextRefs: ['/context/state'], support: 'Same words.' })
  ] };
  validateEvidence(valid, payload, ownerInput);
});

test('owner provenance permits owner text and outcomes but rejects model decisions, metadata and operator initiatives', () => {
  const ownerInput = { context: {
    businessContext: 'Supplied text.', objective: 'Supplied text.', state: 'Supplied text.',
    initiatives: [{ origin: 'owner', description: 'Supplied text.' }, { origin: 'operator', description: 'Supplied text.' }],
    decisionHistory: [{ model: 'Supplied text.', decision: { assessment: 'Supplied text.' }, outcomes: [{ text: 'Supplied text.' }] }]
  }, originatingDecision: { assessment: 'Supplied text.' } };
  for (const status of ['owner_provided', 'owner_hypothesis']) {
    for (const ref of ['/originatingDecision/assessment', '/context/decisionHistory/0/decision/assessment',
      '/context/decisionHistory/0/model', '/context/decisionHistory/0', '/context/initiatives/1/description', '/context/initiatives/0/origin']) {
      const value = { ...report(), evidence: [record('O3', status, { contextRefs: [ref], support: 'Supplied text.' })] };
      assert.throws(() => validateEvidence(value, payload, ownerInput), error => {
        assert.ok(error.message.includes(ref)); assert.match(error.message, /Evidence O3 .*not owner-provided provenance/); return true;
      });
    }
    for (const ref of ['/context/businessContext', '/context/objective', '/context/state', '/context/initiatives/0/description', '/context/decisionHistory/0/outcomes/0/text']) {
      validateEvidence({ ...report(), evidence: [record('O3', status, { contextRefs: [ref], support: 'Supplied text.' })] }, payload, ownerInput);
    }
  }
  const missing = { ...report(), evidence: [record('O4', 'owner_provided', { contextRefs: ['/context/decisionHistory/1/outcomes/0/text'], support: 'Supplied text.' })] };
  assert.throws(() => validateEvidence(missing, payload, ownerInput), /Evidence O4 .*\/context\/decisionHistory\/1\/outcomes\/0\/text.*Unknown context reference/);
});

test('citation URLs must match annotations exactly; search presence and URL cleanup do not substitute', () => {
  const annotated = url + '?lang=en';
  const sources = { output: [{ action: { sources: [{ url }] }, content: [{ annotations: [{ type: 'url_citation', url: annotated }] }] }] };
  const value = { ...report(), evidence: [record('S1', 'provider_claim', { sourceUrls: [url], support: 'Source-attributed paraphrase: a claim.' })] };
  assert.throws(() => validateEvidence(value, sources, input), /absent from returned citations/);
  value.evidence[0].sourceUrls = [annotated];
  validateEvidence(value, sources, input);
});

test('unknown and other non-inference statuses reject basisIds; inference requires existing acyclic evidence', () => {
  for (const index of [0, 1, 2, 3, 5]) {
    const value = report(); value.evidence[index].basisIds = ['E1'];
    assert.throws(() => validateEvidence(value, payload, input), /Only inference may have basis references/);
  }
  for (const basisIds of [[], ['absent'], ['E5']]) {
    const value = report(); value.evidence[4].basisIds = basisIds;
    assert.throws(() => validateEvidence(value, payload, input), /Inference needs|Missing or cyclic/);
  }
});
