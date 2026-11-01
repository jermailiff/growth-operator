import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { createWebProspecting } from '../src/providers/public-web.js';
import { state, decision } from '../test/helpers.js';
import { webPlan, webPayload, candidate } from '../test/public-web-fixtures.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (const scenario of ['review', 'missing-contact', 'unsupported-source', 'incomplete', 'professional-discovery', 'excluded-redirect', 'staged-owner-request']) {
    const directory = await mkdtemp(join(tmpdir(), 'web-cohort-browser-'));
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const store = new Store(directory), contexts = [], errors = []; let calls = 0;
    const c = candidate(); if (scenario === 'missing-contact') { c.contact = null; c.location = null; }
    if (scenario === 'unsupported-source') c.name.sourceUrl += '/invented';
    const plan = structuredClone(webPlan);
    if (['professional-discovery', 'staged-owner-request'].includes(scenario)) { plan.scope.sourceMode = 'public_professional'; plan.sourceDomains = []; }
    const payload = webPayload([c]);
    if (scenario === 'excluded-redirect') {
      payload.output.unshift({ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://workshop.example/team' } });
      const report = JSON.parse(payload.output.at(-1).content[0].text);
      report.incidents = [{ kind: 'automatic_redirect', requestedUrl: 'https://workshop.example/team', observedUrl: 'https://elsewhere.example/', excludedFromEvidence: true, explanation: 'Reported redirect excluded.' }];
      payload.output.at(-1).content[0].text = JSON.stringify(report);
    } if (scenario === 'incomplete') payload.status = 'incomplete';
    const server = createAppServer({ store,
      model: { name: 'mock', decide: async context => { contexts.push(context); return { model: 'mock', decision: { ...decision, ownerInputRequired: false, ownerApprovalRequired: true }, prospectRequest: plan }; } },
      webProspecting: createWebProspecting({ apiKey: 'fake', model: 'mock', fetchImpl: async () => { calls++; return Response.json(payload); } }),
      makeDecision: () => ({ decide: async context => ({ model: 'mock', decision: { ...decision, recommendedNextStep: 'Review the public-web candidates.', evidenceUsed: context.evidenceUsedOptions } }) }) });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); await server.initialize();
    const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    try {
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
      if (scenario === 'staged-owner-request') {
        const base = 'http://127.0.0.1:' + server.address().port;
        const snapshot = await (await fetch(base + '/api/state')).json();
        const staged = await fetch(base + '/api/prospect-proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: snapshot.revision, request: plan }) });
        assert.equal(staged.status, 201); assert.equal(contexts.length, 0);
        await page.reload(); await page.waitForFunction(() => !document.querySelector('#run').disabled);
        assert.match(await page.locator('#decisions').innerText(), /Staged directly from your specified request/);
      } else { await page.locator('#run').click(); await page.waitForFunction(() => !document.querySelector('#run').disabled); }
      assert.equal(calls, 0);
      const approvalText = await page.locator('#decisions').innerText();
      assert.match(approvalText, ['professional-discovery', 'staged-owner-request'].includes(scenario) ? /no fixed domain allowlist/ : /exact hostnames only/);
      assert.match(approvalText, /5 total web calls, 180 seconds and 6,000 output tokens/);
      for (const [key, value] of Object.entries(plan.scope)) if (!['sourceMode','pageTypes'].includes(key)) assert.ok(approvalText.includes(value));
      await page.getByRole('button', { name: 'Approve & build cohort', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
      assert.equal(calls, 1);
      if (['incomplete', 'unsupported-source'].includes(scenario)) {
        assert.equal(await page.locator('.prospect').count(), 0);
        assert.match(await page.locator('#decisions').innerText(), /could not finish/);
      } else {
        assert.equal(await page.locator('.prospect').count(), 1);
        assert.ok(await page.locator('a[href="https://workshop.example/team"]').count() > 0);
        const content = await page.locator('#decisions').innerText();
        assert.match(content, scenario === 'missing-contact' ? /supported employer \+ location matches: 0; provisional: 1/ : /supported employer \+ location matches: 1; provisional: 0/);
        assert.match(content, scenario === 'missing-contact' ? /No supported contact route found/ : /taylor@workshop.example/);
        await page.locator('.prospect select').selectOption('approve');
        await page.getByLabel('Minutes spent reviewing this cohort', { exact: true }).fill('3');
        await page.getByLabel('Did you need additional manual research? Describe briefly, or say no.', { exact: true }).fill('Checked location');
        await page.getByLabel('Roughly how many minutes would equivalent prospecting normally take you?', { exact: true }).fill('20');
        await page.getByRole('button', { name: 'Save cohort review', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Review recorded'));
        await page.locator('#run').click(); await page.waitForFunction(() => !document.querySelector('#run').disabled);
        assert.equal(contexts.at(-1).decisionHistory[1].outcomes[0].cohortReview.reviews[0].choice, 'approve');
      }
      assert.deepEqual(errors, []); console.log('PASS public-web browser ' + scenario);
    } finally { await page.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
