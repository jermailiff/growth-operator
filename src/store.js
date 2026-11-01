import { readFile, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { quoteProspects, digest } from './prospecting.js';

export function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'businessContext,initiatives,objective,state') {
    throw Object.assign(new Error('State must contain exactly businessContext, objective, initiatives, and state.'), { status: 422 });
  }
  for (const key of ['businessContext', 'objective', 'state']) {
    if (typeof value[key] !== 'string' || (key !== 'state' && !value[key].trim())) {
      throw Object.assign(new Error(`${key} must be text${key === 'state' ? '' : ' and cannot be empty'}.`), { status: 422 });
    }
  }
  if (!Array.isArray(value.initiatives) || value.initiatives.some(item =>
    !item || Object.keys(item).sort().join(',') !== 'description,origin,status' ||
    typeof item.description !== 'string' || !item.description.trim() ||
    !['owner', 'operator'].includes(item.origin) ||
    !['proposed', 'active', 'paused', 'stopped', 'completed'].includes(item.status))) {
    throw Object.assign(new Error('Each initiative needs a description, origin (owner/operator), and valid status.'), { status: 422 });
  }
  return value;
}

export function projectHistory(events) {
  const history = [];
  for (const event of events) {
    if (event.type === 'research_continuation_promoted') {
      if (createHash('sha256').update(event.artifactText).digest('hex') !== event.artifactSha256 || history.some(item => item.id === event.id)) throw new Error('Promoted continuation integrity failure.');
      const artifact = JSON.parse(event.artifactText);
      const result = JSON.parse(artifact.resultText);
      if (artifact.id !== event.id || artifact.status !== 'completed') throw new Error('Invalid promoted continuation.');
      history.push({ id: event.id, createdAt: artifact.decisionCompletedAt, status: 'completed', model: result.model,
        decision: result.decision, outcomes: [], error: null,
        research: JSON.parse(artifact.researchText), selectedEvidence: artifact.selectedEvidence,
        ...(artifact.format === 'isolated-m2-continuation-v2' ? { researchInferencesNotReliedUpon: result.researchInferencesNotReliedUpon } : {}),
        isolatedProvenance: { origin: artifact.origin, attempt: artifact.attempt, artifactSha256: event.artifactSha256, promotedAt: event.at } });
      continue;
    }
    if (event.type === 'prospect_proposal_staged') {
      const { hash, ...bound } = event.offer;
      if (digest(bound) !== hash || JSON.stringify(event.request) !== JSON.stringify(event.offer.request) || event.origin !== 'owner_specified' || history.some(r => r.id === event.id)) throw new Error('Staged proposal integrity failure.');
      history.push({ id: event.id, createdAt: event.at, status: 'awaiting_approval', model: 'Owner-specified request', proposalOrigin: 'owner_specified', prospectOffer: event.offer, decision: null, outcomes: [], error: null });
      continue;
    }
    if (event.type === 'run_started') {
      history.push({ id: event.id, createdAt: event.at, status: 'pending', model: event.model, decision: null, outcomes: [], error: null });
      continue;
    }
    const record = history.find(item => item.id === event.decisionId);
    if (!record) throw new Error('Decision log contains an update without a matching run. Restore from a backup.');
    if (event.type === 'run_completed') Object.assign(record, { status: 'completed', decision: event.decision, model: event.model });
    else if (event.type === 'run_progress') {
      for (const key of ['stage', 'originatingDecision', 'originatingModel', 'research', 'selectedEvidence', 'ownerContextSources', 'researchInferencesNotReliedUpon', 'prospectOffer', 'cohort']) {
        if (Object.hasOwn(event.work, key)) record[key] = event.work[key];
      }
    }
    else if (event.type === 'run_needs_input') Object.assign(record, { status: 'needs_input', clarification: event.clarification });
    else if (event.type === 'run_failed') Object.assign(record, { status: 'failed', error: event.error });
    else if (event.type === 'cohort_approved') {
      if (record.cohortExecutionId) throw new Error('Duplicate cohort execution reservation.');
      record.cohortExecutionId = event.executionId;
      record.cohortApproval = { hash: event.hash, at: event.at };
    }
    else if (event.type === 'prospect_review_recorded') {
      if (!record.cohort || record.cohort.id !== event.cohortId || record.cohortReview) throw new Error('Invalid or duplicate cohort review.');
      record.cohortReview = { recordedAt: event.at, cohortId: event.cohortId, reviews: event.reviews, metrics: event.metrics };
      record.outcomes.push({ recordedAt: event.at, text: event.text, cohortReview: record.cohortReview });
    }
    else if (event.type === 'prospect_audit') { /* Transport records stay audit-only. */ }
    else if (event.type === 'outcome_recorded') record.outcomes.push({ recordedAt: event.at, text: event.text });
    else throw new Error('Decision log contains an unknown event.');
  }
  return history;
}

export class Store {
  constructor(directory) { this.directory = directory; }
  async read() {
    const stateText = await readFile(join(this.directory, 'state.json'), 'utf8');
    let logText = '';
    try { logText = await readFile(join(this.directory, 'decisions.jsonl'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = validateState(JSON.parse(stateText));
    let events;
    try { events = logText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error('Decision log is damaged. Restore from a backup; it has not been overwritten.'); }
    return {
      state, events, history: projectHistory(events),
      revision: createHash('sha256').update(stateText).update('\0').update(logText).digest('hex')
    };
  }
  async saveState(state) {
    validateState(state);
    const temporary = join(this.directory, 'state.json.tmp');
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, join(this.directory, 'state.json'));
  }
  async stageProspectRequest(request) {
    if (request?.provider !== 'public_web') throw new Error('Direct staging supports public-web requests only.');
    const offer = quoteProspects(request, {});
    const snapshot = await this.read();
    if (snapshot.history.some(r => r.status === 'pending')) throw new Error('An operation is in progress.');
    const event = { type: 'prospect_proposal_staged', id: randomUUID(), at: new Date().toISOString(), origin: 'owner_specified', request: structuredClone(request), offer };
    projectHistory([...snapshot.events, event]);
    await this.append(event);
    return event;
  }
  async append(event) {
    const file = await open(join(this.directory, 'decisions.jsonl'), 'a', 0o600);
    try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  // CLI-only: stop the server first, just as for other manual data maintenance.
  async appendPromotion(event) {
    const snapshot = await this.read();
    if (snapshot.history.some(item => item.id === event.id)) throw new Error('Continuation already promoted.');
    projectHistory([...snapshot.events, event]);
    let log = '';
    try { log = await readFile(join(this.directory, 'decisions.jsonl'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (log && !log.endsWith('\n')) throw new Error('History lacks its final newline; promotion stopped without modifying it.');
    await this.append(event);
  }
  async recoverInterruptedRuns() {
    const snapshot = await this.read();
    for (const run of snapshot.history.filter(item => item.status === 'pending')) {
      await this.append({ type: 'run_failed', decisionId: run.id, at: new Date().toISOString(), error: 'The server stopped before this run finished. The provider may have processed it. No automatic retry was made.' });
    }
  }
}
