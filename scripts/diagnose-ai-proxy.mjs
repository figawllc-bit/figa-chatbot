// Local fake RPC binding only. Never configures or imports a real AI binding.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const outfile = resolve(root, '.wrangler/offline-ai-proxy.mjs');
await build({ stdin: { contents: `export {WorkersAIProvider} from './src/ai/workers-ai'; export {serializableAIBinding} from './scripts/serializable-ai-binding';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { WorkersAIProvider, serializableAIBinding } = await import(pathToFileURL(outfile).href);

const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { name: 'offline-host', modules: true, script: 'export default {};', serviceBindings: { FAKE: { name: 'offline-fake', entrypoint: 'Fake' } } },
  { name: 'offline-fake', modules: true, compatibilityDate: '2026-11-10', script: `
    import { WorkerEntrypoint } from 'cloudflare:workers';
    let calls = 0;
    export class Fake extends WorkerEntrypoint { run(_model, _inputs, _options) {
      return { invoked: true, calls: ++calls, choices: [{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({offline:true})}}] };
    } }
    export default {};
  ` },
] }));
try {
  const { FAKE } = await mf.getBindings();
  assert.equal((await FAKE.run('offline-fake', {}, {})).calls, 1);
  let failure;
  try { await FAKE.run('offline-fake', {}, { signal: new AbortController().signal }); }
  catch (error) { failure = error; }
  assert.equal(failure?.name, 'DevalueError');
  assert.equal(failure.message, 'Cannot stringify arbitrary non-POJOs');
  const final = await FAKE.run('offline-fake', {}, {});
  assert.equal(final.calls, 2); // The signal-bearing call did not enter run().
  let diagnostic;
  try { await new WorkersAIProvider(FAKE).extract({ message: 'Fictional offline probe' }, new AbortController().signal); }
  catch (error) { diagnostic = error.diagnostic; }
  assert.equal(diagnostic.category, 'proxy_serialization');
  assert.equal(diagnostic.errorType, 'DevalueError');
  const fixed = await new WorkersAIProvider(serializableAIBinding(FAKE)).extract({ message: 'Fictional offline probe' }, new AbortController().signal);
  assert.deepEqual(fixed, { offline: true });
  assert.equal((await FAKE.run('offline-fake', {}, {})).calls, 4); // 2 controls + fixed adapter + final control.
  process.stdout.write(JSON.stringify({ offlineOnly: true, realAIBindings: 0, externalRequests: 0,
    nodeAbortSignalRejectedByProxy: !!failure, fakeRunCount: final.calls,
    syntheticFailureType: 'DevalueError', category: 'proxy_serialization', actualAdapterReproduced: true, fixedNodeWrapperPassed: true }) + '\n');
} finally { await mf.dispose(); }
