import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, state, decision } from './helpers.js';
import { Store, validateState } from '../src/store.js';

test('state edits survive reopening, reject extra entities, and change the revision', async t => {
  const store = await temporaryStore(t);
  const before = await store.read();
  await store.saveState({ ...state, state: 'Both dates are now booked.' });
  const after = await new Store(store.directory).read();
  assert.equal(after.state.state, 'Both dates are now booked.');
  assert.notEqual(before.revision, after.revision);
  assert.throws(() => validateState({ ...state, contacts: [] }));
  assert.throws(() => validateState({ ...state, initiatives: [{ description: 'Incomplete' }] }));
});

test('outcomes append without changing earlier bytes; every outcome survives restart', async t => {
  const store = await temporaryStore(t);
  await store.append({ type: 'run_started', id: 'one', at: '2026-01-01', stateSnapshot: state });
  await store.append({ type: 'run_completed', decisionId: 'one', decision, model: 'test' });
  const path = join(store.directory, 'decisions.jsonl');
  const before = await readFile(path, 'utf8');
  await store.append({ type: 'outcome_recorded', decisionId: 'one', text: 'The owner does not know.', at: '2026-01-02' });
  await store.append({ type: 'outcome_recorded', decisionId: 'one', text: 'Correction: one partner has answered.', at: '2026-01-03' });
  assert.ok((await readFile(path, 'utf8')).startsWith(before));
  const saved = await new Store(store.directory).read();
  assert.deepEqual(saved.history[0].decision, decision);
  assert.equal(saved.history[0].outcomes.length, 2);
});

test('interrupted runs become failures and are never retried', async t => {
  const store = await temporaryStore(t);
  await store.append({ type: 'run_started', id: 'interrupted', at: '2026-01-01' });
  await store.recoverInterruptedRuns();
  await store.recoverInterruptedRuns();
  const saved = await store.read();
  assert.equal(saved.history[0].status, 'failed');
  assert.equal(saved.events.length, 2);
});

test('corrupt history fails closed without overwriting it', async t => {
  const store = await temporaryStore(t);
  const path = join(store.directory, 'decisions.jsonl');
  await writeFile(path, '{broken');
  await assert.rejects(store.read(), /damaged/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
