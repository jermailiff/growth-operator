import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server.js';
import { temporaryStore, decision } from './helpers.js';

async function setup(t, model) {
  const store = await temporaryStore(t);
  const server = createAppServer({ store, model });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await server.initialize();
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', payload, headers = {}) => {
    const response = await fetch(url + path, { method, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: response.status, data: await response.json() };
  };
  return { store, request, url };
}

test('full M1 loop persists decisions, owner outcomes and changed evidence in the next model input', async t => {
  const inputs = [];
  const { request, store } = await setup(t, { name: 'mock', decide: async context => {
    inputs.push(context);
    // This double tests transport/state wiring, NOT actual model reasoning quality.
    return { decision: { ...decision, recommendedNextStep: context.state.includes('fully booked') ? 'Pause the acquisition proposal.' : decision.recommendedNextStep }, model: 'mock' };
  } });
  let saved = (await request('/api/state')).data;
  const run = await request('/api/run', 'POST', { revision: saved.revision });
  assert.equal(run.status, 201);
  saved = (await request('/api/state')).data;
  assert.equal((await request(`/api/decisions/${run.data.id}/outcome`, 'POST', { revision: saved.revision, text: 'Both remaining dates booked through referrals.' })).status, 201);
  saved = (await request('/api/state')).data;
  assert.equal((await request('/api/state', 'PUT', { revision: saved.revision, state: { ...saved.state, state: 'Now fully booked this quarter.' } })).status, 200);
  saved = (await request('/api/state')).data;
  assert.equal((await request('/api/run', 'POST', { revision: saved.revision })).status, 201);
  const final = await store.read();
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].decisionHistory[0].outcomes[0].text, 'Both remaining dates booked through referrals.');
  assert.equal(inputs[1].state, 'Now fully booked this quarter.');
  assert.notEqual(final.history[0].decision.recommendedNextStep, final.history[1].decision.recommendedNextStep);
  assert.equal(final.events[0].stateSnapshot.businessContext, saved.state.businessContext);
});

test('stale edits, cross-origin writes and out-of-scope routes are blocked', async t => {
  let called = false;
  const { request } = await setup(t, { name: 'mock', decide: async () => { called = true; } });
  const saved = (await request('/api/state')).data;
  assert.equal((await request('/api/run', 'POST', { revision: 'stale' })).status, 409);
  assert.equal((await request('/api/run', 'POST', { revision: saved.revision }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/execute', 'POST', { revision: saved.revision })).status, 404);
  assert.equal(called, false);
});

test('failed runs are logged without becoming decisions', async t => {
  const { request, store } = await setup(t, { name: 'mock', decide: async () => { throw new Error('Test connection failure'); } });
  const { revision } = (await request('/api/state')).data;
  assert.equal((await request('/api/run', 'POST', { revision })).status, 502);
  const saved = await store.read();
  assert.equal(saved.history[0].status, 'failed');
  assert.equal(saved.history[0].decision, null);
  assert.match(saved.history[0].error, /connection failure/);
});

test('concurrent runs cannot duplicate model requests', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { request } = await setup(t, { name: 'mock', decide: async () => { entered(); await gate; return { decision, model: 'mock' }; } });
  const { revision } = (await request('/api/state')).data;
  const first = request('/api/run', 'POST', { revision });
  await started;
  const second = await request('/api/run', 'POST', { revision });
  release();
  assert.equal(second.status, 409);
  assert.equal((await first).status, 201);
});

test('UI assets load and local runtime data files are not served', async t => {
  const { url } = await setup(t, { name: 'mock' });
  for (const path of ['/', '/app.js', '/styles.css']) assert.equal((await fetch(url + path)).status, 200);
  assert.equal((await fetch(url + '/data/state.json')).status, 404);
  assert.equal((await fetch(url + '/.env')).status, 404);
});
