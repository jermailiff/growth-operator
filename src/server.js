import { Pilot, pilotContext } from './pilot.js';
import { Gmail } from './providers/gmail.js';
import { pilotReadRoute, pilotWriteRoute } from './pilot-routes.js';
import { createWebProspecting } from './providers/public-web.js';
import { ApolloProvider } from './providers/apollo.js';
import { quoteProspects, digest, pricingFromEnv, acquireCohort, validateReview } from './prospecting.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, validateState } from './store.js';
import { createModel } from './model.js';
import { runOperator } from './operator.js';
import { createResearch, validateResearch } from './research.js';
import { liveDecisionContext, decideFromResearch, decideFromCohort } from './continuation.js';
import { eligibleReport, validateDecisionEvidence } from './evidence.js';
import { browserModelContext } from './model-context.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Use application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw fail(413, 'This prototype accepts up to 1 MiB per edit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Request must contain valid JSON.'); }
}

export function createAppServer({ store, model, research, makeDecision, prospectProvider, webProspecting, prospectPricing = { organization: 1, enrichment: 1 }, configured = true, pilot = null }) {
  let busy = false;
  let ready = false;
  const server = createServer(async (request, response) => {
    const send = (status, value, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': contentType, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      });
      response.end(contentType.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    let locked = false;
    try {
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(request.headers.host)) throw fail(403, 'Localhost access only.');
      if (!ready) throw fail(503, 'Starting up. Reload shortly.');
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const { state, history, revision } = await store.read();
        return send(200, { state, history, revision, busy, configured, prospectingConfigured: Boolean(prospectProvider), webProspectingConfigured: Boolean(webProspecting), model: model.name || 'Custom adapter' });
      }
      if (request.method === 'GET' && await pilotReadRoute(pilot, url, send)) return;
      const staticFiles = { '/pilot.html': ['pilot.html', 'text/html'], '/pilot.js': ['pilot.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        return send(200, await readFile(join(root, 'public', file)), `${type}; charset=utf-8`);
      }
      if (!['POST', 'PUT'].includes(request.method)) throw fail(404, 'Not found.');
      const origin = request.headers.origin;
      if (origin && !allowedHosts.map(host => `http://${host}`).includes(origin)) throw fail(403, 'Cross-origin edits are not allowed.');
      if (pilot && url.pathname === '/api/pilot/pause') {
        const pauseInput = await body(request);
        if (pauseInput.paused !== true) { if (busy) throw fail(409, 'Wait for the current operation before resuming.'); await pilot.pause(pauseInput.revision, pauseInput.id, false); }
        else await pilot.requestPause(pauseInput.id);
        return send(200, { saved: true });
      }
      if (busy) throw fail(409, 'An operation is already in progress. Wait and reload before trying again.');
      busy = true;
      locked = true;
      const input = await body(request);
      if (await pilotWriteRoute(pilot, url.pathname, input, send)) return;
      const snapshot = await store.read();
      const operatorContext = async () => ({ ...browserModelContext(snapshot), ...(pilot ? { emailPilot: pilotContext(await pilot.read()) } : {}) });
      if (input.revision !== snapshot.revision) throw fail(409, 'Saved data changed in another window. Copy any unsaved edits, then reload.');

      if (request.method === 'POST' && url.pathname === '/api/prospect-proposals') {
        let staged;
        try { staged = await store.stageProspectRequest(input.request); }
        catch (error) { throw fail(422, error.message); }
        return send(201, { id: staged.id, hash: staged.offer.hash });
      }
      if (request.method === 'PUT' && url.pathname === '/api/state') {
        await store.saveState(validateState(input.state));
        return send(200, { saved: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        const id = randomUUID();
        await store.append({ type: 'run_started', id, at: now(), model: model.name || 'Custom adapter', stateSnapshot: snapshot.state, priorDecisionIds: snapshot.history.map(item => item.id) });
        try {
          const context = await operatorContext();
          const progress = async work => store.append({ type: 'run_progress', decisionId: id, at: now(), work });
          let result = await runOperator(model, context);
          if (research && !result.prospectRequest) {
            await progress({ stage: 'research', originatingDecision: result.decision, originatingModel: result.model });
            const input = { context, originatingDecision: result.decision };
            const findings = await research(input);
            const { admission } = validateResearch(findings, input, { allowPartial: true });
            if (admission) findings.admission = admission;
            await progress({ stage: 'decision', research: findings });
            if (findings.report.disposition === 'insufficient_task_definition') {
              await store.append({ type: 'run_needs_input', decisionId: id, at: now(), clarification: findings.report.explanation });
              return send(201, { id });
            }
            const nextContext = liveDecisionContext(context, result.decision, findings);
            await progress({ strategicContext: nextContext });
            result = await decideFromResearch(nextContext, findings, schema => makeDecision(schema, progress));
            const selectedEvidence = validateDecisionEvidence(result.decision, eligibleReport(findings), nextContext.ownerContextSources);
            await progress({ selectedEvidence,
              ownerContextSources: selectedEvidence.filter(item => item.kind === 'owner_context_source'),
              researchInferencesNotReliedUpon: result.researchInferencesNotReliedUpon, stage: 'completed' });
          }
          if (result.prospectRequest) {
            if (!result.decision.ownerApprovalRequired || result.decision.ownerInputRequired) throw new Error('Prospecting requires explicit approval and a fully defined request.');
            await progress({ prospectOffer: quoteProspects(result.prospectRequest, prospectPricing) });
          }
          await store.append({ type: 'run_completed', decisionId: id, at: now(), model: result.model || model.name || 'Custom adapter', decision: result.decision });
          return send(201, { id });
        } catch (error) {
          if (error.audit) await store.append({ type: 'run_progress', decisionId: id, at: now(), work: { failedResearchAudit: error.audit } });
          await store.append({ type: 'run_failed', decisionId: id, at: now(), error: error.message });
          return send(502, { error: error.message });
        }
      }
      const cohortAction = url.pathname.match(/^\/api\/decisions\/([^/]+)\/cohort$/);
      if (request.method === 'POST' && cohortAction) {
        const parent = snapshot.history.find(r => r.id === cohortAction[1]);
        if (!parent?.prospectOffer || !['completed', 'awaiting_approval'].includes(parent.status)) throw fail(409, 'No completed acquisition proposal.');
        const publicWeb = parent.prospectOffer.request.provider === 'public_web';
        if (publicWeb ? !webProspecting : !prospectProvider) throw fail(503, publicWeb ? 'Public-web prospecting is not configured.' : 'Set APOLLO_API_KEY before approving acquisition.');
        if (input.approve !== true || input.hash !== parent.prospectOffer.hash) throw fail(409, 'Explicit approval must match this exact acquisition proposal.');
        if (parent.cohortExecutionId) throw fail(409, 'This approval has already been used; no acquisition was repeated.');
        const currentOffer = quoteProspects(parent.prospectOffer.request, prospectPricing);
        const { hash: savedHash, ...savedOffer } = parent.prospectOffer;
        if (digest(savedOffer) !== savedHash || currentOffer.hash !== input.hash) throw fail(409, 'Provider pricing or scope changed; create a new proposal before approval.');
        const id = randomUUID();
        // Reservation is durable before any provider call; failures never silently retry.
        await store.append({ type: 'cohort_approved', decisionId: parent.id, executionId: id, hash: input.hash, at: now() });
        await store.append({ type: 'run_started', id, at: now(), model: model.name || 'Custom adapter',
          stateSnapshot: snapshot.state, priorDecisionIds: snapshot.history.map(r => r.id), acquisitionFrom: parent.id });
        const progress = async work => store.append({ type: 'run_progress', decisionId: id, at: now(), work });
        try {
          await progress({ stage: 'prospecting' });
          const priorIds = snapshot.history.flatMap(r => r.cohort?.prospects.map(p => p.id) || []);
          const cohort = await (publicWeb ? webProspecting : acquireCohort)({ offer: parent.prospectOffer, provider: prospectProvider, priorIds,
            record: async audit => {
              await store.append({ type: 'prospect_audit', decisionId: id, at: now(), audit });
              if (audit.cohort) await progress({ cohort: audit.cohort });
            } });
          if (!cohort.prospects.length) {
            await store.append({ type: 'run_failed', decisionId: id, at: now(), error: cohort.error || 'No reviewable prospects were returned; no scope expansion occurred.' });
            return send(201, { id });
          }
          await progress({ stage: 'decision' });
          const result = await decideFromCohort(await operatorContext(), cohort, schema => makeDecision(schema, progress, { prospecting: false }));
          await progress({ selectedEvidence: result.selectedEvidence });
          await store.append({ type: 'run_completed', decisionId: id, at: now(), model: result.model, decision: result.decision });
          return send(201, { id });
        } catch (error) {
          await store.append({ type: 'run_failed', decisionId: id, at: now(), error: error.message });
          return send(502, { error: error.message });
        }
      }
      const reviewAction = url.pathname.match(/^\/api\/decisions\/([^/]+)\/prospect-review$/);
      if (request.method === 'POST' && reviewAction) {
        const run = snapshot.history.find(r => r.id === reviewAction[1]);
        if (!run?.cohort?.prospects.length || run.status === 'pending' || run.cohortReview) throw fail(409, 'No unreviewed finished cohort.');
        try { validateReview(input, run.cohort); } catch (error) { throw fail(422, error.message); }
        const first = !snapshot.history.some(r => r.cohortReview?.metrics);
        if (first && input.metrics === null) throw fail(422, 'Capture the first cohort review time, additional research and rough normal prospecting time.');
        const text = 'Owner cohort review (contact willingness, not sending approval):\n' +
          input.reviews.map(r => r.prospectId + ': ' + r.choice + '\nReason: ' + r.reason + '\nCorrection: ' + r.correction).join('\n\n') +
          (input.metrics ? '\nInitial owner time observations: ' + JSON.stringify(input.metrics) : '');
        await store.append({ type: 'prospect_review_recorded', decisionId: run.id, cohortId: run.cohort.id,
          at: now(), reviews: input.reviews, metrics: input.metrics, text });
        return send(201, { saved: true });
      }
      const outcome = url.pathname.match(/^\/api\/decisions\/([^/]+)\/outcome$/);
      if (request.method === 'POST' && outcome) {
        const run = snapshot.history.find(item => item.id === outcome[1]);
        if (!run || !['completed', 'needs_input', 'failed'].includes(run.status)) throw fail(404, 'Finished run not found.');
        if (typeof input.text !== 'string' || !input.text.trim()) throw fail(422, 'Record a response or outcome before saving.');
        await store.append({ type: 'outcome_recorded', decisionId: run.id, at: now(), text: input.text.trim() });
        return send(201, { saved: true });
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      send(error.status || 500, { error: error.status ? error.message : `Local storage/server error: ${error.message}` });
    } finally { if (locked) busy = false; }
  });
  server.initialize = async () => { await store.recoverInterruptedRuns(); ready = true; };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const model = createModel({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL, prospecting: true });
  const pilotDirectory = join(root, 'data', 'pilot');
  const gmail = new Gmail({ directory: join(pilotDirectory, 'credentials'), clientId: process.env.GMAIL_CLIENT_ID, clientSecret: process.env.GMAIL_CLIENT_SECRET, redirectUri: `http://127.0.0.1:${port}/api/pilot/oauth/callback` });
  const server = createAppServer({ pilot: new Pilot(pilotDirectory, gmail), store: new Store(join(root, 'data')), model,
    webProspecting: createWebProspecting({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL }),
    prospectProvider: process.env.APOLLO_API_KEY?.trim() ? new ApolloProvider({ apiKey: process.env.APOLLO_API_KEY }) : null,
    prospectPricing: pricingFromEnv(process.env),
    research: createResearch({ allowPartial: true, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL }),
    makeDecision: (decisionSchema, progress, options = { prospecting: true }) => createModel({ prospecting: options.prospecting, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL, decisionSchema,
      fetchImpl: async (url, request) => {
        await progress({ strategicRequest: JSON.parse(request.body) });
        const response = await fetch(url, request), raw = await response.text();
        await progress({ strategicRawResponse: raw, strategicTransport: { httpStatus: response.status, requestId: response.headers.get('x-request-id'), receivedAt: now() } });
        return new Response(raw, { status: response.status, headers: response.headers });
      } }),
    configured: Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.OPERATOR_MODEL?.trim()) });
  server.on('error', error => { console.error(`Cannot start V0: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', async () => {
    try { await server.initialize(); console.log(`Growth Operator V0: http://127.0.0.1:${port}`); }
    catch (error) { console.error(`Cannot load V0 data: ${error.message}`); server.close(); process.exitCode = 1; }
  });
}
