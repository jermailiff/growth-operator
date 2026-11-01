const $ = id => document.getElementById(id);
let revision;
let dirty = false;
let loading = false;
let configured = false;
let ownRun = false;
let prospectingConfigured = false;
let webProspectingConfigured = false;
let initialReviewNeeded = true;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
}
function setDirty(value) {
  dirty = value;
  $('saved-status').textContent = dirty ? 'Unsaved changes' : 'Saved locally';
  $('run').disabled = loading || !configured;
}
function setBusy(value) {
  loading = value;
  $('context-fields').disabled = value;
  document.querySelectorAll('.outcome-form button,.outcome-form textarea,.cohort-form button,.cohort-form input,.cohort-form textarea,.cohort-form select,.approve-cohort').forEach(el => { el.disabled = value; });
  document.querySelectorAll('.approve-cohort').forEach(el => { el.disabled = value || el.dataset.legacy === 'true' || !(el.dataset.provider === 'public_web' ? webProspectingConfigured : prospectingConfigured); });
  setDirty(dirty);
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify({ ...data, revision }) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function addInitiative(item = { description: '', origin: 'owner', status: 'proposed' }) {
  const row = node('div', undefined, 'initiative');
  const description = node('textarea');
  description.value = item.description;
  description.required = true;
  description.setAttribute('aria-label', 'Initiative description');
  description.dataset.field = 'description';
  const controls = node('div', undefined, 'initiative-controls');
  for (const [key, values] of Object.entries({ origin: ['owner', 'operator'], status: ['proposed', 'active', 'paused', 'stopped', 'completed'] })) {
    const label = node('label', key === 'origin' ? 'Origin' : 'Status');
    const select = node('select');
    select.dataset.field = key;
    for (const value of values) { const option = node('option', value); option.value = value; select.append(option); }
    select.value = item[key];
    label.append(select); controls.append(label);
  }
  const remove = node('button', 'Remove', 'secondary');
  remove.type = 'button';
  remove.addEventListener('click', () => { row.remove(); setDirty(true); });
  controls.append(remove); row.append(description, controls); $('initiatives').append(row);
}
function readState() {
  const state = Object.fromEntries(['businessContext', 'objective', 'state'].map(key => [key, $(key).value]));
  state.initiatives = [...document.querySelectorAll('.initiative')].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el.value])));
  return state;
}
const statusLabels = { sourced_fact: 'Sourced fact', provider_claim: 'Provider claim', inference: 'Inference', owner_provided: 'You supplied', owner_hypothesis: 'Your hypothesis', unknown: 'Unknown' };
function cleanText(text) {
  return text.replace(/^\[[A-Z_]+ [^\]]+\]\s*/, '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');
}
const visibleReport = run => run.research?.admission?.report || run.research?.report;
function evidenceDetails(run) {
  const details = node('details'); details.append(node('summary', 'Sources, evidence & uncertainty'));
  for (const item of visibleReport(run)?.evidence || []) {
    details.append(node('span', statusLabels[item.status] || 'Evidence', 'tag'), node('p', cleanText(item.statement)));
    for (const url of item.sourceUrls) {
      try {
        const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        const link = node('a', parsed.hostname + parsed.pathname); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link, node('br'));
      } catch { /* Do not render invalid links. */ }
    }
    if (item.support) details.append(node('p', item.support, 'hint'));
  }
  for (const source of run.ownerContextSources || []) {
    details.append(node('span', 'Owner context—unclassified', 'tag'), node('p', source.label), node('p', source.text, 'hint'));
  }
  for (const unknown of visibleReport(run)?.unresolvedUnknowns || []) details.append(node('p', 'Unknown: ' + unknown));
  return details;
}

function prospectApproval(run) {
  const box = node('div', undefined, 'owner-request');
  const offer = run.prospectOffer, p = offer.request;
  const publicWeb = p.provider === 'public_web';
  if (publicWeb) {
    box.append(node('h4', 'Approve public-web prospecting'), node('p', p.audienceHypothesis),
      node('p', 'Companies: ' + p.companies.join(', ') + '. Person locations: ' + p.locations.join(', ') + '. Roles: ' + (p.titles.join(', ') || 'Any')),
      node('p', p.scope?.sourceMode === 'public_professional' ? 'Source scope: public professional discovery; no fixed domain allowlist.' : 'Approved public source domains — ' + (p.scope ? 'exact hostnames only, no implicit subdomains: ' : 'legacy contract: ') + p.sourceDomains.join(', ')),
      node('p', 'Up to ' + p.cohortSize + ' review candidates, ' + p.maxCalls + ' total web calls, ' + p.deadlineSeconds + ' seconds and ' + (offer.executionPolicy?.maxOutputTokens?.toLocaleString('en-US') || 'unbound legacy') + ' output tokens. Fewer candidates or missing contacts are possible.'),
      node('p', 'Collect only public professional identity, employer, location, role and expressly published professional contact routes. No guessed contacts, private/authenticated sources, sending or purchases. Model/web API usage incurs configured OpenAI charges. Candidate data is processed by that model and saved locally.'));
    if (p.scope) {
      box.append(node('p', 'Permitted page types: ' + p.scope.pageTypes.join(', ')));
      for (const [key, value] of Object.entries(p.scope)) if (!['sourceMode', 'pageTypes'].includes(key)) box.append(node('p', value));
    }
    if (!p.scope || !offer.executionPolicy) box.append(node('p', 'Legacy scope remains audit-only. A new complete scope proposal and approval are required for future execution.'));
  } else {
    box.append(node('h4', 'Approve a small prospect cohort'), node('p', p.audienceHypothesis),
      node('p', 'Provider: Apollo. Companies: ' + p.companies.join(', ') + '. Person locations: ' + p.locations.join(', ') +
        '. Titles: ' + (p.titles.join(', ') || 'No title restriction') + '.'),
      node('p', 'Discover up to ' + p.poolSize + ' candidates; select up to ' + p.cohortSize +
        ' for review; enrich only selected records needing requested information, at most ' + p.maxEnrichments + '.'),
      node('p', 'Requested data: ' + p.fields.map(f => f.field + ' — ' + f.purpose).join('; ')),
      node('p', 'Maximum ' + p.maxCalls + ' provider calls, ' + p.deadlineSeconds + ' seconds and ' + p.maxCredits +
        ' Apollo credits. Configured worst-case charge: ' + offer.creditCeiling + ' credits. Account pricing must match these ceilings.'),
      node('p', 'No phone/personal-email lookup, waterfall enrichment, scraping or email sending. Acquired professional data is sent to the model for assessment.'),
      node('p', p.segmentHypothesis ? 'Hypothesis to test: ' + p.segmentHypothesis : 'No segment hypothesis proposed.'));
  }
  if (run.cohortExecutionId) box.append(node('p', 'This approval has already been used. The acquisition result is saved as a separate run.'));
  else {
    const button = node('button', 'Approve & build cohort', 'approve-cohort'); button.type = 'button';
    button.dataset.provider = p.provider;
    button.dataset.legacy = String(publicWeb && (!p.scope || !offer.executionPolicy));
    button.disabled = (publicWeb && (!p.scope || !offer.executionPolicy)) || !(publicWeb ? webProspectingConfigured : prospectingConfigured);
    if (!(publicWeb ? webProspectingConfigured : prospectingConfigured)) box.append(node('p', publicWeb ? 'Public-web prospecting is not configured.' : 'Apollo is not connected. Add the server-side API key before acquisition.'));
    button.addEventListener('click', async () => {
      if (dirty || hasOtherOutcomeDrafts()) { notice('Save or record your current edits before approving acquisition.', true); return; }
      ownRun = true; setBusy(true); notice(publicWeb ? 'Finding supported candidates within the approved public-web scope…' : 'Discovering the approved candidate pool, selecting the review cohort, then enriching only where needed…');
      try { await api('/api/decisions/' + run.id + '/cohort', 'POST', { approve: true, hash: offer.hash }); await refresh(false); notice('Acquisition stopped. Review the saved cohort, limitations and result below.'); }
      catch (error) { await refresh(false); notice(error.message + ' No automatic retry was made.', true); }
      finally { ownRun = false; setBusy(false); }
    });
    box.append(button);
  }
  return box;
}
function cohortReview(run) {
  const cohort = run.cohort;
  const box = node('section', undefined, 'cohort');
  box.append(node('h3', 'Prospect cohort · ' + cohort.prospects.length + ' people'),
    node('p', cohort.status === 'completed' ? 'Acquisition finished. Review whether you would actually contact each person.' : 'Acquisition stopped with incomplete work. Review the limitations before using any record.'),
    node('p', 'Provider-reported attributes and email statuses are not independent verification, buying intent or permission to contact. Approve means “I would contact this person”; it does not authorize sending.'),
    node('p', 'Calls: ' + cohort.usage.calls + '. Reported credits: ' + cohort.usage.reportedCredits +
      (cohort.usage.actualCreditsKnown ? '.' : ' (actual total not fully reported).')));
  if (cohort.yieldCounts) {
    const c = cohort.yieldCounts;
    box.append(node('p', 'Returned: ' + c.returned + '; admitted: ' + c.admitted + '; supported employer + location matches: ' + c.supportedMatches + '; provisional: ' + c.provisional + '; published contact routes: ' + c.contactRoutes + '; routes among supported matches: ' + c.contactRoutesAmongSupported + '. Source support is not independent verification.'));
  } else if (cohort.returnedCandidateCount !== undefined) box.append(node('p', 'Provider returned ' + cohort.returnedCandidateCount + ' candidates; admission stopped. Match and contact counts were not established.'));
  if (cohort.scopeCheck) {
    const audit = node('details'); audit.append(node('summary', 'Scope observations and reported incidents'),
      node('p', 'Provider-observed actions: ' + JSON.stringify(cohort.scopeCheck.providerObserved)),
      node('p', 'Model-reported incidents (not independent transport observations): ' + JSON.stringify(cohort.scopeCheck.modelReported)),
      node('p', 'Stops: ' + cohort.scopeCheck.failures.join('; '))); box.append(audit);
  }
  if (run.cohortReview) {
    const accepted = run.cohortReview.reviews.filter(r => r.choice === 'approve').length;
    box.append(node('p', 'Your review: ' + accepted + ' of ' + cohort.prospects.length + ' worth contacting; ' +
      (cohort.prospects.length - accepted) + ' rejected.'));
    const metrics = run.cohortReview.metrics;
    if (metrics) box.append(node('p', 'Owner-reported: ' + metrics.reviewMinutes + ' minutes reviewing. Additional research: ' +
      metrics.additionalResearch + '. Rough normal prospecting estimate: ' + metrics.normalMinutes + ' minutes. This is not measured time saved.'));
  }
  if (cohort.error) box.append(node('p', cohort.error, 'error'));
  for (const exclusion of cohort.exclusions || []) box.append(node('p', 'Excluded candidate ' + (exclusion.candidateIndex + 1) + ': ' + exclusion.reason, 'hint'));
  for (const warning of cohort.warnings) box.append(node('p', warning, 'hint'));
  if (!cohort.prospects.length) return box;
  const form = node('form', undefined, 'cohort-form');
  const rows = [];
  for (const person of cohort.prospects) {
    const card = node('fieldset', undefined, 'prospect');
    card.append(node('legend', person.attributes.name || person.displayName),
      node('p', person.fit.explanation),
      node('p', 'Audience criteria for review: ' + person.fit.criteria.companies.join(', ') + '; ' +
        person.fit.criteria.locations.join(', ') + (person.fit.criteria.titles.length ? '; ' + person.fit.criteria.titles.join(', ') : '')));
    for (const [key, value] of Object.entries(person.attributes)) {
      if (key === 'name') continue;
      card.append(node('p', key + ': ' + (value === null ? 'Unknown / unavailable' : typeof value === 'string' ? value : JSON.stringify(value))));
    }
    card.append(node('p', (cohort.provider === 'public_web' ? 'Published contact route is not verified. Email status: ' : 'Apollo email status: ') + (person.emailStatus || 'Not supplied') +
      '. Match confidence: ' + (person.matchConfidence ?? 'Not supplied')));
    if (person.hypothesis) card.append(node('p', 'Hypothesis, not fact: ' + person.hypothesis.text));
    for (const unknown of person.unknowns) card.append(node('p', 'Unknown: ' + unknown, 'hint'));
    const provenance = node('details');
    provenance.append(node('summary', 'Source details'), node('p', cohort.provider + ' · ' + person.providerPersonId),
      node('p', 'Retrieved: ' + cohort.createdAt + '. Source: ' + person.sourceRef),
      node('p', 'Field sources: ' + JSON.stringify(person.attributeSources || {})));
    if (cohort.provider === 'public_web') {
      card.append(node('p', person.contactRoute ? 'Published contact route: ' + person.contactRoute.value + ' — not sending permission.' : 'No supported contact route found.'));
      for (const [field, source] of Object.entries(person.sources || {})) {
        const link = node('a', field + ': ' + source.sourceUrl);
        if (/^https?:\/\//.test(source.sourceUrl)) { link.href = source.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        provenance.append(link, node('p', source.support), node('p', 'Source claim; not independently verified.'));
      }
    }
    card.append(provenance);
    const previous = run.cohortReview?.reviews.find(r => r.prospectId === person.id);
    if (previous) {
      card.append(node('p', 'Your review: ' + previous.choice), node('p', 'Reason: ' + previous.reason), node('p', 'Correction: ' + previous.correction));
    } else {
      const label = node('label', 'Would you contact this person?');
      const choice = node('select'); choice.required = true; choice.setAttribute('aria-label', 'Review ' + person.id);
      for (const [value, title] of [['', 'Choose…'], ['approve', 'Approve — I would contact'], ['reject', 'Reject']]) {
        const option = node('option', title); option.value = value; choice.append(option);
      }
      label.append(choice); card.append(label);
      const reasonLabel = node('label', 'Reason (optional)'), reason = node('textarea');
      reason.rows = 2; reason.setAttribute('aria-label', 'Reason ' + person.id); reasonLabel.append(reason); card.append(reasonLabel);
      const correctionLabel = node('label', 'Correction (optional)'), correction = node('textarea');
      correction.rows = 2; correction.setAttribute('aria-label', 'Correction ' + person.id); correctionLabel.append(correction); card.append(correctionLabel);
      rows.push({ person, choice, reason, correction });
    }
    form.append(card);
  }
  if (!run.cohortReview) {
    let metrics = null;
    if (initialReviewNeeded) {
      const group = node('fieldset'); group.append(node('legend', 'First cohort: was this useful?'));
      metrics = {};
      for (const [key, labelText] of [['reviewMinutes', 'Minutes spent reviewing this cohort'], ['additionalResearch', 'Did you need additional manual research? Describe briefly, or say no.'], ['normalMinutes', 'Roughly how many minutes would equivalent prospecting normally take you?']]) {
        const label = node('label', labelText), field = node(key === 'additionalResearch' ? 'textarea' : 'input');
        if (key !== 'additionalResearch') { field.type = 'number'; field.min = '0'; field.step = 'any'; }
        field.required = true; field.setAttribute('aria-label', labelText); metrics[key] = field; label.append(field); group.append(label);
      }
      form.append(group);
    }
    const button = node('button', 'Save cohort review'); button.type = 'submit'; form.append(button);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (dirty || hasOtherOutcomeDrafts(form)) { notice('Save other edits before recording this review.', true); return; }
      const reviews = rows.map(({ person, choice, reason, correction }) => ({ prospectId: person.id, choice: choice.value, reason: reason.value, correction: correction.value }));
      const values = metrics ? { reviewMinutes: Number(metrics.reviewMinutes.value), additionalResearch: metrics.additionalResearch.value, normalMinutes: Number(metrics.normalMinutes.value) } : null;
      setBusy(true);
      try { await api('/api/decisions/' + run.id + '/prospect-review', 'POST', { reviews, metrics: values }); await refresh(false); notice('Review recorded. The next deliberate run will use your feedback; no new cohort or email was sent.'); }
      catch (error) { notice(error.message, true); }
      finally { setBusy(false); }
    });
  }
  box.append(form);
  return box;
}
function renderHistory(history) {
  initialReviewNeeded = !history.some(r => r.cohortReview?.metrics);
  $('count').textContent = `${history.length} run${history.length === 1 ? '' : 's'}`;
  $('decisions').replaceChildren();
  if (!history.length) $('decisions').append(node('p', 'No decisions yet. Update the context, save it, and run the operator.', 'empty'));
  for (const run of [...history].reverse()) {
    const article = node('article', undefined, 'decision');
    article.append(node('div', `${new Date(run.createdAt).toLocaleString()} · ${run.model}`, 'meta'));
    if (run.status === 'pending') {
      article.append(node('h3', 'Working…'), node('p', run.stage === 'prospecting' ? 'Building the approved prospect cohort…' : run.stage === 'research' ? 'Checking what public information can establish…' : run.stage === 'decision' ? 'Bringing the findings together into a decision…' : 'Reviewing your objective, ideas and previous responses…'));
      $('decisions').append(article); continue;
    }
    if (run.status === 'awaiting_approval') {
      article.append(node('h3', run.cohortExecutionId ? 'Your prospect request — approval recorded' : 'Your prospect request — awaiting approval'), node('p', 'Staged directly from your specified request, not a model-generated recommendation.'));
    } else if (run.status !== 'completed') {
      article.append(node('h3', run.status === 'needs_input' ? 'A clarification is needed' : 'This run could not finish'));
      article.append(node('p', run.status === 'needs_input' ? run.clarification : 'No final decision was completed. Any research completed below has been saved. Nothing was retried or executed externally.'));
      if (run.status === 'failed') {
        const errorDetails = node('details'); errorDetails.append(node('summary', 'Technical details'), node('p', run.error)); article.append(errorDetails);
      }
      if (run.research) article.append(node('h4', run.status === 'needs_input' ? 'What prevented further work' : 'Work completed before stopping'), node('p', cleanText(visibleReport(run).explanation)), evidenceDetails(run));
    } else {
      const decision = run.decision;
      article.append(node('h3', decision.recommendedNextStep), node('p', decision.assessment));
      if (run.research) {
        const researched = run.research.report.disposition === 'researched';
        if (run.research.admission) article.append(node('h4', 'Partial research — support gaps remain'));
        article.append(node('h4', researched ? 'Work completed' : 'What this run established'), node('p', cleanText(visibleReport(run).explanation)));
        if (!researched) article.append(node('p', run.research.report.disposition === 'research_unnecessary' ? 'Existing evidence was sufficient; no web research was performed.' : 'Public information could not resolve every necessary question.', 'hint'));
        article.append(evidenceDetails(run));
      }
      article.append(node('h4', 'Proposed next action'), node('p', decision.proposedAction));
      if (decision.ownerInputRequired || decision.ownerApprovalRequired) {
        const ask = node('div', undefined, 'owner-request');
        ask.append(node('h4', decision.ownerInputRequired ? 'Your input is needed' : 'Your approval is needed'), node('p', decision.ownerRequirementDetails));
        if (decision.ownerApprovalRequired) ask.append(node('p', 'Approval records your permission. External execution will be handled separately.', 'hint'));
        article.append(ask);
      }
      const details = node('details');
      details.append(node('summary', 'Why this decision & what remains unknown'), node('p', decision.reasoningSummary));
      for (const [key, title] of Object.entries({ evidenceUsed: 'Evidence used', assumptions: 'Assumptions', importantUnknowns: 'Important unknowns', learnings: 'Learnings' })) {
        details.append(node('h4', title));
        const list = node('ul'); decision[key].forEach(text => list.append(node('li', cleanText(text)))); details.append(list);
      }
      details.append(node('h4', 'Intended outcome'), node('p', decision.intendedOutcomeOrEvidence)); article.append(details);
    }
    if (run.prospectOffer) article.append(prospectApproval(run));
    if (run.cohort) article.append(cohortReview(run));
    for (const outcome of run.outcomes) {
      const block = node('div', undefined, 'outcome');
      block.append(node('div', `Recorded ${new Date(outcome.recordedAt).toLocaleString()}`, 'meta'), node('p', outcome.text)); article.append(block);
    }
    const form = node('form', undefined, 'outcome-form');
    const label = node('label', 'Record outcome / owner response');
    const textarea = node('textarea');
    textarea.id = `outcome-${run.id}`; label.htmlFor = textarea.id;
    textarea.rows = 3; textarea.required = true;
    const hint = node('p', 'Record what actually happened, an answer, or a correction. Each entry is preserved for the next run.', 'hint');
    const button = node('button', 'Record outcome', 'secondary'); button.type = 'submit';
    form.append(label, hint, textarea, button);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (hasOtherOutcomeDrafts(textarea)) { notice('Record the other outcome drafts first, or copy and clear them before saving this one.', true); return; }
      setBusy(true); notice('Saving outcome…');
      try { await api(`/api/decisions/${run.id}/outcome`, 'POST', { text: textarea.value }); await refresh(false); notice('Outcome recorded. The next run will include it.'); }
      catch (error) { notice(error.message, true); }
      finally { setBusy(false); }
    });
    article.append(form); $('decisions').append(article);
  }
}
function hasOtherOutcomeDrafts(except) {
  return [...document.querySelectorAll('.outcome-form textarea,.cohort-form textarea,.cohort-form select,.cohort-form input')].some(el => el !== except && !except?.contains(el) && el.value.trim());
}
async function refresh(replaceContext = true) {
  const data = await api('/api/state');
  revision = data.revision; configured = data.configured; prospectingConfigured = data.prospectingConfigured; webProspectingConfigured = data.webProspectingConfigured;
  $('connection').textContent = configured ? 'Your context and history are saved locally. Running sends them to OpenAI and may examine public sources.' : 'Setup is needed before running. You can edit and save your context now; ask your setup contact to connect the model.';
  if (replaceContext) {
    for (const key of ['businessContext', 'objective', 'state']) $(key).value = data.state[key];
    $('initiatives').replaceChildren(); data.state.initiatives.forEach(addInitiative); setDirty(false);
  }
  renderHistory(data.history);
  if (loading) document.querySelectorAll('.outcome-form button,.outcome-form textarea,.cohort-form button,.cohort-form input,.cohort-form textarea,.cohort-form select,.approve-cohort').forEach(el => { el.disabled = true; });
  if (data.busy) { setBusy(true); notice('The operator is working. This page will update when it finishes.'); }
  else if (loading && !ownRun) { setBusy(false); notice('Ready. Review the latest result below.'); }
}
$('context-form').addEventListener('input', () => setDirty(true));
$('add-initiative').addEventListener('click', () => { addInitiative(); setDirty(true); });
$('context-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (hasOtherOutcomeDrafts()) { notice('Record or copy and clear the outcome draft before saving context.', true); return; }
  setBusy(true); notice('Saving context…');
  try { await api('/api/state', 'PUT', { state: readState() }); await refresh(); notice('Context saved.'); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
$('run').addEventListener('click', async () => {
  if (hasOtherOutcomeDrafts()) { notice('Record the outcome draft before running again so it is included in the decision.', true); return; }
  if (!$('context-form').reportValidity()) return;
  ownRun = true; setBusy(true); notice('Working on your objective. Public research may take a few minutes…');
  const poll = setInterval(() => { refresh(false).catch(() => {}); }, 2000);
  let message = 'Decision saved. Record your response or outcome below.';
  let failed = false;
  try {
    if (dirty) { await api('/api/state', 'PUT', { state: readState() }); await refresh(false); setDirty(false); }
    await api('/api/run', 'POST', {});
    message = 'Run finished. Review the result and record your response below.';
  }
  catch (error) { message = 'The run could not finish. Review any saved work and technical details below. If the connection was interrupted, reload to check its status before starting another run.'; failed = true; }
  try { await refresh(false); } catch (error) { message += ` ${error.message}`; failed = true; }
  finally { clearInterval(poll); ownRun = false; setBusy(false); notice(message, failed); }
});
window.addEventListener('beforeunload', event => {
  if (dirty || hasOtherOutcomeDrafts()) { event.preventDefault(); event.returnValue = ''; }
});
setBusy(true);
refresh().catch(error => notice(error.message, true));
setInterval(() => { if (loading && !ownRun) refresh(false).catch(() => {}); }, 2000);
