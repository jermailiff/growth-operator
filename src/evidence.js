import { DECISION_SCHEMA, validateDecision } from './operator.js';

export const STATUSES = ['sourced_fact', 'provider_claim', 'inference', 'owner_provided', 'owner_hypothesis', 'unknown'];
const text = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: text };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const RESEARCH_SCHEMA = object({
  disposition: { type: 'string', enum: ['researched', 'research_unnecessary', 'public_research_cannot_resolve', 'insufficient_task_definition'] },
  explanation: text,
  evidence: { type: 'array', items: object({
    id: text, status: { type: 'string', enum: STATUSES }, statement: text,
    sourceUrls: { ...strings, description: 'Every URL must exactly match a returned url_citation annotation; a search-source URL alone is insufficient. Owner evidence must use an empty array.' },
    contextRefs: { ...strings, maxItems: 1, description: 'Exactly one JSON pointer for owner_provided or owner_hypothesis; empty for other statuses. Allowed owner text: /context/businessContext, /context/objective, /context/state, /context/initiatives/N/description where origin is owner, or /context/decisionHistory/N/outcomes/N/text. Model decisions, originatingDecision and history metadata are not owner provenance.' },
    basisIds: { ...strings, description: 'Nonempty supporting evidence IDs for inference only. All other statuses, including unknown, must use an empty array.' },
    support: { type: 'string', description: 'For owner evidence: one bare, contiguous, verbatim substring of the single referenced owner text. No explanatory prefix, labels, added quotation delimiters, joined excerpts or normalization. Put multiple passages in separate evidence records. For sourced evidence: captured support or an explicitly labelled source-attributed paraphrase.' }
  }) },
  unresolvedUnknowns: strings,
  scopeCompliant: { type: 'boolean' }
});

// Validate locally as well as requesting strict structured output from the provider.
function shape(value, schema) {
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== schema.required.slice().sort().join()) throw new Error('Invalid research fields.');
    for (const [key, sub] of Object.entries(schema.properties)) shape(value[key], sub);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error('Invalid research list.');
    value.forEach(item => shape(item, schema.items));
  } else if (typeof value !== schema.type || (schema.minLength && !value.trim()) || (schema.enum && !schema.enum.includes(value))) {
    throw new Error('Invalid research value.');
  }
}

export function publicUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) ||
      /\[|\]|(?:^|\.)local$/.test(url.hostname)) throw new Error('Non-public source URL.');
  return value;
}

function pointer(root, path) {
  if (!path.startsWith('/')) throw new Error('Context references must be JSON pointers.');
  return path.slice(1).split('/').reduce((value, key) => {
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || !Object.hasOwn(value, key)) throw new Error('Unknown context reference.');
    return value[key];
  }, root);
}

// Never serialize a parsed URL: all components except one literal query entry
// must retain their original bytes. This is a provider-corroborated alias only.
function withoutProviderTracking(url) {
  const fragmentAt = url.indexOf('#');
  const head = fragmentAt < 0 ? url : url.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : url.slice(fragmentAt);
  const queryAt = head.indexOf('?');
  if (queryAt < 0) return null;
  const entries = head.slice(queryAt + 1).split('&');
  // Encoded parameter names and alternative separators are ambiguous here.
  if (entries.some(entry => !entry || /[%+;]/.test(entry.split('=')[0])) || entries.some(entry => entry.includes(';'))) return null;
  const tracking = entries.filter(entry => entry.split('=')[0] === 'utm_source');
  if (tracking.length !== 1 || tracking[0] !== 'utm_source=openai') return null;
  const remaining = entries.filter(entry => entry !== 'utm_source=openai');
  return head.slice(0, queryAt) + (remaining.length ? '?' + remaining.join('&') : '') + fragment;
}

export function citationMatcher(payload) {
  const annotations = (payload.output || []).flatMap(item => item.content || []).flatMap(item => item.annotations || []);
  const cited = new Set(annotations.filter(item => item.type === 'url_citation').map(item => publicUrl(item.url)));
  const returnedSources = new Set((payload.output || []).filter(item => item.type === 'web_search_call')
    .flatMap(item => item.action?.sources || []).map(item => item.url).filter(url => typeof url === 'string'));
  return evidenceUrl => {
    publicUrl(evidenceUrl);
    if (cited.has(evidenceUrl)) return { method: 'exact', evidenceUrl, citationUrl: evidenceUrl };
    if (returnedSources.has(evidenceUrl)) {
      for (const citationUrl of cited) {
        if (withoutProviderTracking(citationUrl) === evidenceUrl) return {
          method: 'provider_corroborated_utm_source_openai_alias', evidenceUrl, citationUrl, sourceUrl: evidenceUrl
        };
      }
    }
    throw Object.assign(new Error('Evidence cites a source absent from returned citations.'), { code: 'SOURCE_CITATION_MISSING' });
  };
}

export function validateEvidence(report, payload, input, provenanceMatches = [], sourceFailures = null) {
  shape(report, RESEARCH_SCHEMA);
  if (!report.scopeCompliant) throw new Error('Research reported a scope violation.');
  const matchCitation = citationMatcher(payload);
  const ids = new Set();
  for (const item of report.evidence) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate evidence ID.');
    ids.add(item.id);
    for (const url of item.sourceUrls) {
      try { provenanceMatches.push({ evidenceId: item.id, ...matchCitation(url) }); }
      catch (error) {
        if (!sourceFailures || error.code !== 'SOURCE_CITATION_MISSING') throw error;
        sourceFailures.push({ evidenceId: item.id, url, reason: 'source_absent_from_returned_citations' });
      }
    }
    if (['sourced_fact', 'provider_claim'].includes(item.status) && (!item.sourceUrls.length || !item.support.trim())) throw new Error('Sourced evidence needs citations and captured support.');
    if (['owner_provided', 'owner_hypothesis'].includes(item.status)) {
      const fail = message => new Error(`Evidence ${item.id} (${item.contextRefs.join(', ') || 'no context reference'}): ${message}`);
      if (item.contextRefs.length !== 1 || item.sourceUrls.length || !item.support.trim()) throw fail('Owner evidence requires exactly one owner-context reference, bare support and no source URLs.');
      const ref = item.contextRefs[0];
      const initiative = ref.match(/^\/context\/initiatives\/(0|[1-9]\d*)\/description$/);
      const allowed = /^\/context\/(businessContext|objective|state)$/.test(ref) ||
        /^\/context\/decisionHistory\/(0|[1-9]\d*)\/outcomes\/(0|[1-9]\d*)\/text$/.test(ref) ||
        (initiative && input.context?.initiatives?.[Number(initiative[1])]?.origin === 'owner');
      if (!allowed) throw fail('Reference is not owner-provided provenance; model decisions and history metadata are excluded.');
      let original;
      try { original = pointer(input, ref); }
      catch (error) { throw fail(error.message); }
      if (typeof original !== 'string' || !original.includes(item.support)) {
        throw fail('Owner support does not match context; expected one bare verbatim substring.');
      }
    } else if (item.contextRefs.length) throw new Error('Only owner evidence may use owner context references.');
    if (item.status === 'inference' && !item.basisIds.length) throw new Error('Inference needs evidence references.');
    if (item.status !== 'inference' && item.basisIds.length) throw new Error('Only inference may have basis references.');
  }
  const visit = (id, path = new Set()) => {
    if (!ids.has(id) || path.has(id)) throw new Error('Missing or cyclic evidence reference.');
    report.evidence.find(item => item.id === id).basisIds.forEach(next => visit(next, new Set([...path, id])));
  };
  ids.forEach(id => visit(id));
  return report;
}

export function evidenceChoices(report) {
  return report.evidence.map(item => `[${item.status.toUpperCase()} ${item.id}; ${[...item.sourceUrls, ...item.contextRefs, ...item.basisIds].join(', ') || 'not established'}] ${item.statement}`);
}

// Source blocks preserve owner prose as supplied, without classifying its claims.
export function ownerContextSources(context) {
  const sources = [];
  const add = (contextRef, label, text) => {
    if (typeof text === 'string' && text.trim()) sources.push({
      kind: 'owner_context_source', contextRef, label,
      epistemicStatus: 'unclassified_owner_text', text
    });
  };
  for (const [field, label] of [['objective', 'Objective'], ['businessContext', 'Business context'], ['state', 'Current state']]) {
    add(`/context/${field}`, label, context[field]);
  }
  context.initiatives.forEach((initiative, index) => {
    if (initiative.origin === 'owner') add(`/context/initiatives/${index}/description`, `Owner initiative ${index + 1}`, initiative.description);
  });
  context.decisionHistory.forEach((record, index) => {
    record.outcomes.forEach((outcome, outcomeIndex) => {
      add(`/context/decisionHistory/${index}/outcomes/${outcomeIndex}/text`, `Owner outcome ${index + 1}.${outcomeIndex + 1}`, outcome.text);
    });
  });
  return sources;
}

export function ownerContextChoices(sources) {
  return sources.map(source => `[OWNER_CONTEXT ${source.contextRef}] Owner context—unclassified`);
}

export function selectableEvidenceChoices(report, sources = []) {
  return [...evidenceChoices(report), ...ownerContextChoices(sources)];
}

export function evidenceSchema(report, sources = []) {
  const schema = structuredClone(DECISION_SCHEMA);
  const choices = selectableEvidenceChoices(report, sources);
  schema.properties.evidenceUsed = choices.length
    ? { type: 'array', items: { type: 'string', enum: choices } }
    : { type: 'array', items: { type: 'string' }, maxItems: 0 };
  return schema;
}

export function validateDecisionEvidence(decision, report, sources = []) {
  validateDecision(decision);
  const choices = selectableEvidenceChoices(report, sources);
  if (decision.evidenceUsed.some(item => !choices.includes(item))) throw new Error('Decision altered evidence status, statement or provenance.');
  const records = [...report.evidence, ...sources];
  return decision.evidenceUsed.map(item => records[choices.indexOf(item)]);
}

const NON_RELIANCE_REASONS = ['irrelevant_to_selected_action', 'not_accepted'];

export function decisionEnvelopeSchema(report, sources = []) {
  const decision = evidenceSchema(report, sources);
  decision.properties.evidenceUsed.description = 'Select the canonical record whenever a strategic conclusion is already represented by a research inference. Re-deriving it from underlying facts does not remove attribution. Select all transitive inference dependencies, but underlying sourced/owner facts need not be separately selected. Genuinely different strategic reasoning remains expressible in reasoningSummary or assumptions.';
  if (sources.length) decision.properties.evidenceUsed.description += ' Owner-context citations are complete verbatim owner-supplied source blocks, not classified atomic facts. unclassified_owner_text may contain observations, hypotheses, preferences and unknowns; selection does not establish their contents as fact. Preserve those distinctions in reasoning and assumptions. Select only exact supplied evidence options.';
  const ids = report.evidence.filter(item => item.status === 'inference').map(item => item.id);
  return object({
    decision,
    researchInferencesNotReliedUpon: {
      type: 'array', ...(ids.length ? {} : { maxItems: 0 }),
      description: 'Account for every research inference exactly once: either select it in decision.evidenceUsed or explicitly decline it here. Irrelevant means unrelated to the selected action; not_accepted means its conclusion is not adopted. Neither permits adopting or re-deriving the same conclusion without attribution. Explain each non-reliance; explanations are audit records, not proof of semantic non-reliance.',
      items: object({ inferenceId: ids.length ? { ...text, enum: ids } : text,
        reason: { type: 'string', enum: NON_RELIANCE_REASONS }, explanation: text })
    }
  });
}

export function validateDecisionEnvelope(envelope, report, sources = []) {
  if (!envelope || Array.isArray(envelope) || Object.keys(envelope).sort().join() !== 'decision,researchInferencesNotReliedUpon') throw new Error('Invalid M2 decision envelope.');
  const selected = validateDecisionEvidence(envelope.decision, report, sources);
  const inferences = new Map(report.evidence.filter(item => item.status === 'inference').map(item => [item.id, item]));
  const selectedIds = selected.filter(item => item.status === 'inference').map(item => item.id);
  const relied = new Set(selectedIds), declined = new Set();
  if (relied.size !== selectedIds.length) throw new Error('Duplicate selected research inference.');
  if (!Array.isArray(envelope.researchInferencesNotReliedUpon)) throw new Error('Invalid research inference non-reliance list.');
  for (const item of envelope.researchInferencesNotReliedUpon) {
    if (!item || Array.isArray(item) || Object.keys(item).sort().join() !== 'explanation,inferenceId,reason' ||
        !NON_RELIANCE_REASONS.includes(item.reason) || typeof item.explanation !== 'string' || !item.explanation.trim()) throw new Error('Invalid research inference non-reliance record.');
    if (!inferences.has(item.inferenceId)) throw new Error('Non-reliance ID must identify a canonical research inference.');
    if (declined.has(item.inferenceId)) throw new Error('Duplicate non-reliance inference ID.');
    if (relied.has(item.inferenceId)) throw new Error(`Research inference ${item.inferenceId} is both selected and declined.`);
    declined.add(item.inferenceId);
  }
  for (const id of inferences.keys()) {
    if (!relied.has(id) && !declined.has(id)) throw new Error(`Research inference ${id} is neither selected in evidenceUsed nor explicitly accounted for as not relied upon.`);
  }
  const visited = new Set();
  const dependencies = id => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const basisId of inferences.get(id).basisIds) {
      if (!inferences.has(basisId)) continue;
      if (!relied.has(basisId)) throw new Error(`Selected research inference ${id} requires inference dependency ${basisId} to be selected, not declined.`);
      dependencies(basisId);
    }
  };
  relied.forEach(dependencies);
  return selected;
}

// Admission filters whole records only. All structural and safety validation runs first.
export function researchAdmission(report, failures) {
  const excluded = new Map();
  for (const failure of failures) {
    if (!excluded.has(failure.evidenceId)) excluded.set(failure.evidenceId, {
      evidenceId: failure.evidenceId, reason: 'source_provenance_failure',
      availability: 'unavailable_not_accepted', failures: []
    });
    excluded.get(failure.evidenceId).failures.push(failure);
  }
  let changed;
  do {
    changed = false;
    for (const item of report.evidence) {
      if (!excluded.has(item.id) && item.basisIds.some(id => excluded.has(id))) {
        excluded.set(item.id, { evidenceId: item.id, reason: 'excluded_dependency',
          availability: 'unavailable_not_accepted', dependencyIds: item.basisIds.filter(id => excluded.has(id)) });
        changed = true;
      }
    }
  } while (changed);
  // Capture all unavailable immediate dependencies, regardless of iteration order.
  for (const item of report.evidence) if (excluded.get(item.id)?.reason === 'excluded_dependency') {
    excluded.get(item.id).dependencyIds = item.basisIds.filter(id => excluded.has(id));
  }
  const evidence = report.evidence.filter(item => !excluded.has(item.id));
  return { status: 'partial', exclusions: [...excluded.values()],
    report: { disposition: report.disposition, scopeCompliant: report.scopeCompliant,
      explanation: evidence.length
        ? 'Partial research: some records and dependent conclusions lack required source provenance and are unavailable. Remaining records passed admission checks, not semantic verification.'
        : 'Partial research: no decision-eligible research evidence remains. No evidence-backed research recommendation can be established.',
      evidence, unresolvedUnknowns: [...excluded.values()].map(item =>
        'Unavailable evidence ' + item.evidenceId + ': ' + item.reason + '. Its claims and dependent prerequisites remain unestablished.') } };
}
export const eligibleReport = research => research.admission?.report || research.report;
