import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createResearch } from '../src/research.js';
import { createModel } from '../src/model.js';
import { executeContinuation, hash, writeNew } from '../src/continuation.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    origin: { type: 'string' }, execute: { type: 'boolean' }, 'manual-retry': { type: 'boolean' }
  } });
  if (!values.origin || !values.execute) throw new Error('Usage: node --env-file=.env scripts/evaluate-research.mjs --origin /absolute/isolated-m1-directory --execute [--manual-retry]');
  if (!process.env.OPENAI_API_KEY?.trim() || !process.env.OPERATOR_MODEL?.trim()) throw new Error('Set OPENAI_API_KEY and OPERATOR_MODEL.');
  const originDirectory = await realpath(values.origin);
  const rel = relative(await realpath(root), originDirectory);
  if (!rel || (!rel.startsWith('..' + '/') && !isAbsolute(rel))) throw new Error('Keep isolated evaluation artifacts outside the application directory.');
  const protectedPaths = ['state.json', 'decisions.jsonl'].map(name => join(root, 'data', name));
  const before = await Promise.all(protectedPaths.map(path => readFile(path)));
  let result;
  try {
    result = await executeContinuation({
      originDirectory, protectedDirectory: join(root, 'data'), manualRetry: values['manual-retry'] || false,
      research: createResearch({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL }),
      makeDecision: (decisionSchema, directory) => createModel({
        apiKey: process.env.OPENAI_API_KEY, model: process.env.OPERATOR_MODEL, decisionSchema,
        fetchImpl: async (url, request) => {
          await writeNew(join(directory, 'decision-request.json'), request.body);
          const response = await fetch(url, request);
          const raw = await response.text();
          await writeNew(join(directory, 'decision-response.raw.json'), raw);
          await writeNew(join(directory, 'decision-transport.json'), {
            httpStatus: response.status, requestId: response.headers.get('x-request-id'), receivedAt: new Date().toISOString()
          });
          return new Response(raw, { status: response.status, headers: response.headers });
        }
      })
    });
  } finally {
    const after = await Promise.all(protectedPaths.map(path => readFile(path)));
    if (after.some((bytes, i) => !bytes.equals(before[i]))) throw new Error('Live files changed during evaluation. No restoration was attempted; stop for inspection.');
  }
  await writeNew(join(result.directory, 'live-integrity.json'), Object.fromEntries(protectedPaths.map((path, i) => [path, { sha256: hash(before[i]), unchanged: true }])));
  console.log(JSON.stringify({ ...result, liveFilesUnchanged: true, next: 'Review the full artifact and verification.json, then explicitly choose Promote or Do not promote in review.json. Nothing has entered live history.' }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
