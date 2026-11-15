// Explicitly opt in with --run-once. Default --prepare never imports Wrangler.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createRunLedger } from './ai-run-ledger.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolated = resolve(root, '.wrangler/phase6-ai-only');
const mode = process.argv[2] ?? '--prepare';
if (!['--prepare', '--run-once', '--run-one-provider', '--run-one-caregiver', '--run-multiturn', '--run-caregiver-replay'].includes(mode) || process.argv.length > 3) throw new Error('Unknown isolated evaluation mode');

// Drop all inherited application credentials before any third-party imports.
const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
for (const key of Object.keys(process.env)) if (!allowed.has(key.toUpperCase())) delete process.env[key];
Object.assign(process.env, { WRANGLER_LOG: 'none', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CI: 'true' });

let blockedSecretReads = 0;
function guard(path) {
  if (typeof path === 'number') return;
  const name = basename(path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : String(path));
  if (/^(?:\.dev\.vars(?:\.|$)|\.env(?:\.|$))/.test(name)) {
    blockedSecretReads++;
    const error = new Error('Secret files excluded from isolated test'); error.code = 'ENOENT'; throw error;
  }
}
for (const key of ['readFileSync', 'openSync']) {
  const original = fs[key]; fs[key] = function(path, ...args) { guard(path); return original.call(this, path, ...args); };
}
for (const key of ['readFile', 'open']) {
  const original = fs[key]; fs[key] = function(path, ...args) {
    try { guard(path); } catch (error) { const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; } throw error; }
    return original.call(this, path, ...args);
  };
  const promiseOriginal = fsp[key]; fsp[key] = async function(path, ...args) { guard(path); return promiseOriginal.call(this, path, ...args); };
}
syncBuiltinESMExports();

// Suppress third-party diagnostics entirely; write only explicit safe reports.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let proxy;
let executionLock;
let runLedger;
const executionLockPath = resolve(isolated, 'execution.lock');
let stage = 'prepare';
let diagnosticFactory;
try {
  await fsp.mkdir(isolated, { recursive: true });
  process.chdir(isolated);
  const configPath = resolve(isolated, 'wrangler.json');
  await fsp.writeFile(configPath, JSON.stringify({ name: 'figa-phase6-ai-only', compatibility_date: '2026-11-10', ai: { binding: 'AI', remote: true }, send_metrics: false }));
  await fsp.writeFile(resolve(isolated, 'ai-only-empty.env'), '');
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const bundlePath = resolve(isolated, 'runner.mjs');
  const built = await build({ entryPoints: [resolve(root, 'scripts/phase6-ai-only.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundlePath, metafile: true, logLevel: 'silent' });
  if (Object.keys(built.metafile.inputs).some(p => /(?:database|telegram|ringcentral|supabase)/i.test(p))) throw new Error('Disallowed dependency');
  const runner = await import(pathToFileURL(bundlePath).href);
  diagnosticFactory = runner.diagnoseFailure;
  const prep = ['--run-multiturn', '--run-caregiver-replay'].includes(mode) ? runner.multiTurnPreflight() : runner.preflight();
  let caregiverCapture;
  if (mode === '--run-caregiver-replay') {
    caregiverCapture = JSON.parse(await fsp.readFile(resolve(isolated, 'multiturn-ledger.json'), 'utf8'));
    runner.caregiverReplayState(caregiverCapture); // Validate before connecting to Cloudflare.
  }
  emit({ stage: 'prepared', model: prep.model, approvedKnowledgeIncluded: prep.approvedKnowledgeIncluded,
    pendingPolicyExcluded: prep.pendingPolicyExcluded, inputsReachInference: prep.inputsReachInference,
    applicationSecretFilesLoaded: false, databaseOrMessagingImports: false,
    ...(caregiverCapture ? { capturedFirstTurnValidated: true, applicationDeadlineMs: 15000, authorizedMaximum: 1 } : {}) });
  if (mode !== '--prepare') {
    stage = 'reserve';
    executionLock = await fsp.open(executionLockPath, 'wx');
    // Exclusive run ledger prevents re-running this authorization after restart.
    const selection = mode === '--run-one-provider' ? 'provider' : mode === '--run-one-caregiver' ? 'caregiver' : 'both';
    const maximum = mode === '--run-caregiver-replay' ? 1 : mode === '--run-multiturn' ? 4 : selection === 'both' ? 2 : 1;
    const ledgerPath = resolve(isolated, mode === '--run-caregiver-replay' ? 'caregiver-replay-ledger.json' : mode === '--run-multiturn' ? 'multiturn-ledger.json' : selection === 'both' ? 'run-once-ledger.json' : `one-${selection}-ledger.json`);
    runLedger = await createRunLedger(ledgerPath, maximum);
    stage = 'connect-cloudflare-binding';
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ configPath, envFiles: ['ai-only-empty.env'], remoteBindings: true, persist: false });
    if (Object.keys(proxy.env).length !== 1 || !proxy.env.AI || typeof proxy.env.AI.run !== 'function') throw new Error('Unexpected bindings');
    stage = 'inference';
    const record = async item => {
      await runLedger.record(item);
      // Print only validated extraction and rendered output, never full inputs,
      // carried history, system prompts, or unvalidated raw model bodies.
      const r = item.response;
      emit({ stage: 'result', role: item.role, turn: item.turn, extraction: item.checks.validStructuredJSON ? item.extraction : null,
        response: { conversationType: r.conversationType, collectedInformation: r.collectedInformation,
          assistantResponse: r.assistantResponse, humanAttentionNeeded: r.humanAttentionNeeded,
          humanAttentionReasons: r.humanAttentionReasons, complete: r.complete, engine: r.engine },
        diagnostics: item.diagnostics, timings: item.timings, checks: item.checks });
    };
    if (mode === '--run-caregiver-replay') {
      await runner.runCaregiverReplay(proxy.env.AI, index => runLedger.reserve(index), record, caregiverCapture);
    } else if (mode === '--run-multiturn') {
      for (const [conversationIndex, role] of ['provider', 'caregiver'].entries()) {
        // Fresh bundled module session preserves the existing two-call app limit.
        // No existing secrets, feature flags, or production config are modified.
        const session = await import(pathToFileURL(bundlePath).href + '?conversation=' + role);
        await session.runMultiConversation(proxy.env.AI, index => runLedger.reserve(conversationIndex * 2 + index), record, role);
      }
    } else await runner.runIsolated(proxy.env.AI, index => runLedger.reserve(index), record, selection);
    await runLedger.complete();
    emit({ stage: 'complete', bindingCallsAttempted: runLedger.state.attemptsReserved, blockedSecretReads, applicationSecretFilesLoaded: false, resultsFile: ledgerPath });
  }
} catch (error) {
  emit({ stage, stopped: true, diagnostic: diagnosticFactory?.(error, 'setup', stage === 'inference' ? null : false), reason: 'Isolated harness stopped; no automatic retry. Inspect safe state before any further action.' });
  process.exitCode = 1;
} finally {
  if (proxy) { try { await proxy.dispose(); } catch { emit({ stage: 'dispose', cleanupFailed: true }); } }
  if (runLedger) await runLedger.close();
  if (executionLock) { await executionLock.close(); await fsp.unlink(executionLockPath); }
}
