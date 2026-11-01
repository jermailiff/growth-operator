import { cohortSourceBlocks, cohortChoices } from './prospecting.js';
import { readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runOperator, validateDecision, INSTRUCTIONS, DECISION_SCHEMA } from './operator.js';
import { validateState } from './store.js';
import { LIMITS, validateResearch } from './research.js';
import { substantiveResearch } from './model-context.js';
import { eligibleReport, ownerContextSources, selectableEvidenceChoices, evidenceChoices, decisionEnvelopeSchema, validateDecisionEnvelope, validateDecisionEvidence } from './evidence.js';

export const BASELINE = 'dfbacbdccf96465b2e6527b9431c3a6a43ddc3e7';
export const CHECKLIST = Object.freeze({
  version: 'm2-acceptance-v1',
  criteria: [
    'Investigation performed by the operator, not delegated to the owner.',
    'Research stayed within deterministic bounds.',
    'Real supporting sources and provenance captured and support checked.',
    'Sourced facts, provider claims, inference, owner facts/hypotheses and unknowns remain distinct, including in the decision.',
    'Public documents only; no prospect records, employee lists, contact discovery or prohibited actions.',
    'Complete research artifact reached the strategic decision without strategic filtering.',
    'Decision materially advances beyond preparing a feasibility brief; supported inability to establish a necessary condition is valid.',
    'No integrity or validation failure.'
  ]
});
export const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const now = () => new Date().toISOString();

export async function writeNew(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(typeof value === 'string' ? value : json(value)); await file.sync(); }
  finally { await file.close(); }
}

export async function loadOrigin(directory) {
  const names = ['context.json', 'request.json', 'result.json', 'response.raw.json', 'transport.json', 'verification.json'];
  const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(directory, name), 'utf8')])));
  return validateOrigin({ id: hash(JSON.stringify(sources)), sources });
}

export function validateOrigin(origin) {
  if (origin.id !== hash(JSON.stringify(origin.sources))) throw new Error('Origin hash mismatch.');
  const context = JSON.parse(origin.sources['context.json']);
  const request = JSON.parse(origin.sources['request.json']);
  if (request.instructions !== INSTRUCTIONS || request.tools ||
      JSON.stringify(request.text?.format?.schema) !== JSON.stringify(DECISION_SCHEMA) ||
      JSON.stringify(JSON.parse(request.input)) !== JSON.stringify(context)) throw new Error('Origin does not match its unchanged M1 request.');
  if (Object.keys(context).sort().join() !== 'businessContext,decisionHistory,initiatives,objective,state') throw new Error('Origin must be a plain M1 evaluation context, not a continuation.');
  const { decisionHistory, ...state } = context;
  validateState(state);
  if (!Array.isArray(decisionHistory) || decisionHistory.some(item => item.research || item.isolatedProvenance || item.continuationId)) throw new Error('Recursive research is forbidden.');
  const result = JSON.parse(origin.sources['result.json']);
  if (Object.keys(result).sort().join() !== 'decision,model') throw new Error('Origin is not an M1 result.');
  validateDecision(result.decision);
  const response = JSON.parse(origin.sources['response.raw.json']);
  const rawDecision = (response.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
  if (response.status !== 'completed' || response.model !== result.model || JSON.stringify(JSON.parse(rawDecision)) !== JSON.stringify(result.decision)) throw new Error('Origin result differs from provider output.');
  const verification = JSON.parse(origin.sources['verification.json']);
  if (verification.commit !== BASELINE || !verification.completed || !verification.stateUnchanged || !verification.historyUnchanged) throw new Error('Origin is not the verified isolated M1 baseline evaluation.');
  const transport = JSON.parse(origin.sources['transport.json']);
  if (!Number.isFinite(Date.parse(transport.receivedAt))) throw new Error('Origin execution timestamp missing.');
  return origin;
}

export function researchInput(origin) {
  return { context: JSON.parse(origin.sources['context.json']), originatingDecision: JSON.parse(origin.sources['result.json']).decision };
}

export function decisionContext(origin, research) {
  const input = researchInput(origin);
  return researchDecisionContext(input.context, {
    id: `isolated-m1-${origin.id}`, createdAt: JSON.parse(origin.sources['transport.json']).receivedAt,
    status: 'completed', model: JSON.parse(origin.sources['result.json']).model,
    decision: input.originatingDecision, outcomes: [], error: null
  }, research);
}

export function researchDecisionContext(context, originatingRecord, research) {
  return {
    ...context,
    decisionHistory: [...context.decisionHistory, originatingRecord],
    // Entire request, raw provider output, sources, contrary findings and unknowns: no summary/filter.
    researchEvidence: research,
    evidenceUsedOptions: evidenceChoices(research.report)
  };
}

// Browser candidates are internal working state, unlike preserved isolated origins.
export function liveDecisionContext(context, candidate, research) {
  const sources = ownerContextSources(context);
  return {
    ...context,
    internalCandidate: {
      decision: candidate, role: 'provisional same-run investigation direction',
      ownerExposure: 'not presented to owner', ownerAccepted: false
    },
    researchEvidence: substantiveResearch(research),
    ownerContextSources: sources,
    evidenceUsedOptions: selectableEvidenceChoices(eligibleReport(research), sources)
  };
}

export async function decideFromResearch(context, research, makeDecision) {
  const sources = context.internalCandidate ? ownerContextSources(context) : [];
  const schema = decisionEnvelopeSchema(eligibleReport(research), sources);
  if (context.internalCandidate) schema.description = 'The internalCandidate is provisional work generated during this invocation, not a previous owner-visible decision, an owner commitment, or an action awaiting an outcome. Evaluate the entire business context and evidence; affirm, refine, or replace the candidate. decisionHistory is the unchanged pre-run history. No further investigation is performed by this strategic call.';
  if (research.admission) schema.description += ' Research is partial. Only eligible records may support conclusions; admission does not establish semantic truth. Excluded records and dependent inferences are unavailable, not accepted, and cannot support a recommendation. Identify the remaining support gaps and useful preparation possible without them. Keep launch conditional or blocked where prerequisites lack support. Missing support for one route does not establish another route is superior. Do not claim the investigation is complete; if no eligible research evidence remains, say so.';
  const model = makeDecision(schema);
  let nonReliance, prospectRequest;
  const result = await runOperator({ decide: async input => {
    const response = await model.decide(input);
    validateDecisionEnvelope(response.decision, eligibleReport(research), sources);
    nonReliance = response.decision.researchInferencesNotReliedUpon;
    prospectRequest = response.prospectRequest;
    return { model: response.model, decision: response.decision.decision };
  } }, context);
  return { ...result, researchInferencesNotReliedUpon: nonReliance, ...(prospectRequest ? { prospectRequest } : {}) };
}

export function verifyArtifact(artifact) {
  if (!['isolated-m2-continuation-v1', 'isolated-m2-continuation-v2'].includes(artifact.format) || artifact.status !== 'completed' ||
      JSON.stringify(artifact.checklist) !== JSON.stringify(CHECKLIST)) throw new Error('Incomplete artifact or checklist mismatch.');
  validateOrigin(artifact.origin);
  if (artifact.id !== `m2-${artifact.origin.id}`) throw new Error('Continuation identity mismatch.');
  const research = JSON.parse(artifact.researchText);
  const { calls, report } = validateResearch(research, researchInput(artifact.origin));
  if (report.disposition === 'insufficient_task_definition') throw new Error('Insufficient task definition.');
  if (![1, 2].includes(artifact.attempt) || !Number.isFinite(artifact.previousResearchMs) || artifact.previousResearchMs < 0 ||
      research.elapsedMs + artifact.previousResearchMs >= LIMITS.deadlineMs) throw new Error('Continuation research deadline exceeded.');
  if (!artifact.liveIntegrity || ['state', 'history'].some(key =>
    !/^[a-f0-9]{64}$/.test(artifact.liveIntegrity[key]?.before) || artifact.liveIntegrity[key].before !== artifact.liveIntegrity[key].after)) throw new Error('Live file integrity failed.');
  const context = decisionContext(artifact.origin, research);
  if (artifact.decisionContextText !== json(context)) throw new Error('Complete research did not reach decision context.');
  const result = JSON.parse(artifact.resultText);
  if (!result.model || !Number.isFinite(Date.parse(artifact.decisionCompletedAt))) throw new Error('Decision provenance missing.');
  const evidence = artifact.format === 'isolated-m2-continuation-v2'
    ? validateDecisionEnvelope({ decision: result.decision, researchInferencesNotReliedUpon: result.researchInferencesNotReliedUpon }, report)
    : validateDecisionEvidence(result.decision, report);
  if (JSON.stringify(evidence) !== JSON.stringify(artifact.selectedEvidence)) throw new Error('Decision evidence projection mismatch.');
  return { valid: true, calls: calls.length, hasSupportingSources: report.evidence.some(item => ['sourced_fact', 'provider_claim'].includes(item.status)),
    researchElapsedMs: research.elapsedMs + artifact.previousResearchMs, research, result };
}

export async function executeContinuation({ originDirectory, protectedDirectory, research, makeDecision, manualRetry = false }) {
  const fingerprint = async () => Object.fromEntries(await Promise.all(['state', 'history'].map(async key => {
    const path = join(protectedDirectory, key === 'state' ? 'state.json' : 'decisions.jsonl');
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) { if (key !== 'history' || error.code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
    return [key, hash(bytes)];
  })));
  const before = await fingerprint();
  const origin = await loadOrigin(originDirectory);
  const directory = join(originDirectory, 'm2-continuation');
  let attempt = 1, previousResearchMs = 0;
  if (!manualRetry) {
    await mkdir(directory, { mode: 0o700 }); // Existing directory is a durable one-shot reservation.
    await writeNew(join(directory, 'manifest.json'), { id: `m2-${origin.id}`, origin, checklist: CHECKLIST, limits: LIMITS, reservedAt: now() });
  } else {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const failure = JSON.parse(await readFile(join(directory, 'attempt-1', 'failure.json'), 'utf8'));
    if (manifest.origin.id !== origin.id || failure.stage !== 'research' || !failure.manualRetryEligible) throw new Error('Manual retry is not eligible.');
    previousResearchMs = failure.researchElapsedMs;
    if (!Number.isFinite(previousResearchMs) || previousResearchMs < 0 || previousResearchMs >= LIMITS.deadlineMs) throw new Error('No research deadline budget remains.');
    attempt = 2;
  }
  const attemptDirectory = join(directory, `attempt-${attempt}`);
  await mkdir(attemptDirectory, { mode: 0o700 }); // A second manual retry cannot overwrite this attempt.
  const events = await open(join(directory, 'events.jsonl'), 'a', 0o600);
  const append = async event => { await events.writeFile(JSON.stringify({ ...event, attempt, at: now() }) + '\n'); await events.sync(); };
  let stage = 'research', researchResult;
  try {
    await append({ type: 'research_started', originId: origin.id });
    researchResult = await research(researchInput(origin), LIMITS.deadlineMs - previousResearchMs);
    validateResearch(researchResult, researchInput(origin));
    if (researchResult.elapsedMs + previousResearchMs >= LIMITS.deadlineMs) throw new Error('Continuation research deadline exceeded.');
    const researchText = json(researchResult);
    await writeNew(join(attemptDirectory, 'research.json'), researchText);
    stage = 'research_validated';
    await append({ type: 'research_captured', sha256: hash(researchText) });
    if (researchResult.report.disposition === 'insufficient_task_definition') throw new Error(researchResult.report.explanation);
    stage = 'decision';
    const context = decisionContext(origin, researchResult);
    const decisionContextText = json(context);
    await writeNew(join(attemptDirectory, 'decision-context.json'), decisionContextText);
    const result = await decideFromResearch(context, researchResult, schema => makeDecision(schema, attemptDirectory));
    const selectedEvidence = validateDecisionEvidence(result.decision, researchResult.report);
    const resultText = json(result);
    await writeNew(join(attemptDirectory, 'result.json'), resultText);
    stage = 'isolation';
    const after = await fingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Live files changed during isolated execution.');
    const liveIntegrity = Object.fromEntries(Object.keys(before).map(key => [key, { before: before[key], after: after[key] }]));
    const artifact = { format: 'isolated-m2-continuation-v2', status: 'completed', id: `m2-${origin.id}`,
      origin, checklist: CHECKLIST, attempt, previousResearchMs, researchText, decisionContextText, resultText,
      selectedEvidence, decisionCompletedAt: now(), liveIntegrity };
    const verification = verifyArtifact(artifact);
    const artifactText = json(artifact), artifactSha256 = hash(artifactText);
    await writeNew(join(directory, 'artifact.json'), artifactText);
    await writeNew(join(directory, 'review.json'), {
      artifactSha256, choice: null, reviewedBy: '', reviewedAt: '',
      criteria: CHECKLIST.criteria.map(criterion => ({ criterion, passed: null, notes: '' }))
    });
    await writeNew(join(directory, 'verification.json'), {
      valid: verification.valid, calls: verification.calls, hasSupportingSources: verification.hasSupportingSources,
      researchElapsedMs: verification.researchElapsedMs, artifactSha256, requiresHumanReview: true
    });
    await append({ type: 'continuation_completed', artifactSha256 });
    return { directory, artifact, artifactSha256 };
  } catch (error) {
    const failure = { stage, error: error.message, manualRetryEligible: attempt === 1 && stage === 'research' && !researchResult && error.retryable === true,
      researchElapsedMs: previousResearchMs + (researchResult?.elapsedMs || error.audit?.elapsedMs || 0), audit: error.audit || null };
    await writeNew(join(attemptDirectory, 'failure.json'), failure);
    await append({ type: 'continuation_failed', stage, error: error.message });
    throw error;
  } finally { await events.close(); }
}

// Cohorts use captured provider records, not invented public-web citation annotations.
export async function decideFromCohort(context, cohort, makeDecision) {
  const sources = ownerContextSources(context);
  const providerSources = cohortSourceBlocks(cohort);
  const choices = [...selectableEvidenceChoices({ evidence: [] }, sources), ...cohortChoices(cohort)];
  const schema = structuredClone(DECISION_SCHEMA);
  schema.properties.evidenceUsed = { type: 'array', items: { type: 'string', enum: choices } };
  schema.description = 'This approved cohort acquisition is complete or explicitly partial. Provider records are provider claims, not verified facts, buying intent or permission to contact. Return useful completed preparation and limitations. No sending or further acquisition is possible in this call. Keep proposed angles as hypotheses. Do not score people. Selection is already frozen. Owner review is the next experiment outcome.';
  const input = { ...context, cohort, ownerContextSources: sources, providerSources, evidenceUsedOptions: choices };
  const result = await runOperator(makeDecision(schema), input);
  if (result.decision.evidenceUsed.some(item => !choices.includes(item))) throw new Error('Decision changed captured provider/owner evidence selection.');
  return { ...result, selectedEvidence: result.decision.evidenceUsed.map(item => [...sources, ...providerSources][choices.indexOf(item)]) };
}
