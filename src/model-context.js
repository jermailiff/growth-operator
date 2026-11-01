// Model inputs contain substantive work; immutable local audit records retain transport detail.
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

function referencedOwnerSources(report, requestInput) {
  const input = parse(requestInput), refs = new Set();
  for (const evidence of Array.isArray(report?.evidence) ? report.evidence : []) {
    for (const ref of Array.isArray(evidence?.contextRefs) ? evidence.contextRefs : []) refs.add(ref);
  }
  return [...refs].map(contextRef => {
    // Resolve only text leaves, never replay a context/history object from an audit snapshot.
    const text = typeof contextRef === 'string' && contextRef.startsWith('/')
      ? contextRef.slice(1).split('/').reduce((value, key) => {
        key = key.replace(/~1/g, '/').replace(/~0/g, '~');
        return value && Object.hasOwn(value, key) ? value[key] : undefined;
      }, input) : undefined;
    return typeof text === 'string'
      ? { contextRef, text, kind: 'owner_context_source', epistemicStatus: 'unclassified_owner_text' }
      : { contextRef, resolution: 'unavailable_in_saved_request' };
  });
}

export function substantiveResearch(audit, validated = true) {
  const payload = parse(audit.rawResponse);
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const content = output.flatMap(item => Array.isArray(item.content) ? item.content : []);
  const outputText = content.filter(item => item.type === 'output_text').map(item => item.text).join('');
  const report = validated ? (audit.admission?.report || audit.report) : parse(outputText);
  const projected = {
    validationStatus: validated ? (audit.admission ? 'partial_source_admission_not_semantic_verification' : 'validated') : 'unvalidated_not_evidence',
    ...(validated && audit.admission ? { exclusions: audit.admission.exclusions } : {}),
    ...pick(audit, ['model', 'startedAt', 'completedAt']),
    ...(report ? { report } : {}),
    webActions: output.filter(item => item.type === 'web_search_call').map(item => pick(item, validated && audit.admission ? ['id', 'type', 'status'] : ['id', 'type', 'status', 'action'])),
    citations: content.flatMap(item => item.annotations || []).filter(citation => !validated || !audit.admission ||
      (audit.provenanceMatches || []).some(match => match.citationUrl === citation.url && report.evidence.some(item => item.id === match.evidenceId))),
    provenanceMatches: (audit.provenanceMatches || []).filter(match => !audit.admission || report.evidence.some(item => item.id === match.evidenceId)),
    // References retain their original per-run scope even if mutable context later changes.
    ownerSourceSnapshots: referencedOwnerSources(report, audit.request?.input)
  };
  if (!validated && outputText && !report) projected.unvalidatedOutputText = outputText;
  if (!validated && payload?.error) projected.providerError = payload.error;
  return structuredClone(projected);
}

export function modelHistory(history, events = []) {
  // A failed execution contributes only accepted substantive work or owner feedback.
  // Full failures, transport records and provisional work remain in the local audit/UI.
  return history.filter(record => record.status !== 'failed' || record.research ||
    record.outcomes?.length || record.cohort?.prospects?.length).map(record => {
    const entry = {
      ...pick(record, ['id', 'createdAt', 'status', 'model', 'outcomes', 'clarification', 'proposalOrigin']),
      decision: record.status === 'completed' ? record.decision : null,
      decisionValidationStatus: record.status === 'completed' ? 'accepted' : 'no_accepted_final_decision'
    };
    if (record.status !== 'failed' && record.originatingDecision) entry.internalCandidate = {
      decision: record.originatingDecision,
      validationStatus: 'provisional_not_final', ownerExposure: 'not presented to owner', ownerAccepted: false
    };
    // Stored research progress is appended only after local validation, even if strategy later fails.
    if (record.research) entry.research = substantiveResearch(record.research);
    for (const key of ['selectedEvidence', 'ownerContextSources', 'researchInferencesNotReliedUpon', 'cohort', 'prospectOffer', 'cohortApproval']) {
      if (Object.hasOwn(record, key)) entry[key] = record[key];
    }
    if (record.isolatedProvenance) entry.isolatedProvenance = {
      ...pick(record.isolatedProvenance, ['attempt', 'artifactSha256', 'promotedAt']),
      originId: record.isolatedProvenance.origin?.id
    };
    return structuredClone(entry);
  });
}

export function browserModelContext(snapshot) {
  return { ...structuredClone(snapshot.state), decisionHistory: modelHistory(snapshot.history, snapshot.events) };
}
