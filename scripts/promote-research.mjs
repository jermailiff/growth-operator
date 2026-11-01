import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../src/store.js';
import { CHECKLIST, hash, verifyArtifact } from '../src/continuation.js';

// No provider, fetch, or research executor is instantiated by promotion.
export async function promote({ directory, store, approvedHash, serverStopped = false }) {
  if (!serverStopped) throw new Error('Stop the local server before manual promotion and acknowledge --server-stopped.');
  const artifactText = await readFile(join(directory, 'artifact.json'), 'utf8');
  const reviewText = await readFile(join(directory, 'review.json'), 'utf8');
  const review = JSON.parse(reviewText);
  const digest = hash(artifactText);
  if (review.choice === 'Do not promote') return { promoted: false };
  if (review.choice !== 'Promote' || !approvedHash || approvedHash !== digest || review.artifactSha256 !== digest) throw new Error('Explicit Promote approval bound to the exact artifact hash is required.');
  if (!review.reviewedBy?.trim() || !Number.isFinite(Date.parse(review.reviewedAt)) ||
      !Array.isArray(review.criteria) || review.criteria.length !== CHECKLIST.criteria.length ||
      review.criteria.some((item, i) => item.criterion !== CHECKLIST.criteria[i] || item.passed !== true || !item.notes?.trim())) throw new Error('Run is ineligible: complete the predetermined qualitative review with supporting notes.');
  const artifact = JSON.parse(artifactText);
  const verification = verifyArtifact(artifact);
  if (!verification.calls || !verification.hasSupportingSources) throw new Error('Run is ineligible: no sourced investigation was performed.');
  const stateBefore = await readFile(join(store.directory, 'state.json'));
  const event = { type: 'research_continuation_promoted', id: artifact.id, at: new Date().toISOString(),
    artifactSha256: digest, artifactText, reviewText };
  await store.appendPromotion(event);
  const after = await store.read();
  if (!(await readFile(join(store.directory, 'state.json'))).equals(stateBefore)) throw new Error('State changed during promotion; inspect without rewriting history.');
  const recorded = after.events.filter(item => item.type === event.type && item.id === event.id);
  if (recorded.length !== 1 || recorded[0].artifactText !== artifactText) throw new Error('Promotion verification failed; do not retry blindly.');
  return { promoted: true, id: event.id, artifactSha256: digest, promotedAt: event.at, stateUnchanged: true };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    artifact: { type: 'string' }, 'approve-sha256': { type: 'string' }, 'server-stopped': { type: 'boolean' }
  } });
  if (!values.artifact) throw new Error('Usage: node scripts/promote-research.mjs --artifact /absolute/m2-continuation --approve-sha256 REVIEWED_HASH --server-stopped');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify(await promote({ directory: values.artifact, store: new Store(join(root, 'data')),
    approvedHash: values['approve-sha256'], serverStopped: values['server-stopped'] || false }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
