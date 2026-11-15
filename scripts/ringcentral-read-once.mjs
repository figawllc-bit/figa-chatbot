// No dotenv, Wrangler config, SDK, database or messaging imports.
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createRunLedger } from './ai-run-ledger.mjs';
import { promptJwtCredentials, requireCleanTerminalStartup } from './ringcentral-terminal-input.mjs';
import { hasPinnedDiscoveryAuthorization, loadPinnedDiscoveryRuntime, revokePinnedDiscoveryAuthorization } from './ringcentral-discovery-runtime.mjs';
import { discoverySafeResult } from './ringcentral-safe-result.mjs';

// Discard inherited service credentials/proxy/debug settings; never read values.
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME']);
const startupEnvironmentKeys = Object.keys(process.env);
for (const key of Object.keys(process.env)) if (!allowedEnvironment.has(key.toUpperCase())) delete process.env[key];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let readLedger, oauthLedger, session, receiptPath, discovery = false;
try {
  const args = process.argv.slice(2);
  discovery = ['--check-discovery', '--discover', '--preflight-discovery'].includes(args[0]);
  const preflight = args[0] === '--preflight-discovery';
  if (!(args.length === 1 && ['--check', '--check-discovery'].includes(args[0])) && !(args.length === 3 && ['--execute', '--discover', '--preflight-discovery'].includes(args[0]) && args[1] === '--approval')) throw new Error('invalid_arguments');
  if (discovery && !preflight && !hasPinnedDiscoveryAuthorization()) throw new Error('disabled');
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const bundle = await build({ entryPoints: [join(root, discovery ? 'src/ringcentral/sms-discovery.ts' : 'src/ringcentral/one-time-runner.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  let runner = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
  if (!discovery) runner.requireOneTimeLiveAuthorization();
  // Both operations are disabled: stop before approval or TTY input.
  if (args[0] === '--check' || args[0] === '--check-discovery') {
    console.log(JSON.stringify({ status: 'prepared', requests: 0, credentialsRead: false }));
  } else {
    if (!preflight) requireCleanTerminalStartup(process.execArgv, startupEnvironmentKeys);
    if (!preflight && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('secure_input_unavailable');
    const path = resolve(args[2]);
    if (!basename(path).endsWith('.json') || /^(?:\.dev\.vars|\.env)/i.test(basename(path)) || (await stat(path)).size > 8192) throw new Error('approval_invalid');
    let approval, serializedApproval, value;
    try {
      serializedApproval = await readFile(path, 'utf8');
      value = JSON.parse(serializedApproval);
      approval = discovery ? runner.validateSmsDiscoveryApproval(value) : runner.validateOneTimeReadApproval(value);
    } catch {
      const invalid = new Error('approval_invalid');
      if (discovery && value !== undefined) invalid.approvalIssues = runner.smsDiscoveryApprovalIssues(value);
      throw invalid;
    }
    const parent = join(root, '.wrangler/ringcentral-read-only');
    const directory = join(parent, approval.approvalId);
    if (preflight) {
      // No credentials, ledger creation, gate activation or HTTP on this path.
      try { await stat(directory); throw new Error('budget_unavailable'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      console.log(JSON.stringify({ status: 'offline_preflight_passed', requests: 0, credentialsRead: false, mailboxIdentity: 'operator_asserted_not_live_verified', ownerPinReady: !!approval.expectedOwnerId, liveEnabled: false }));
    } else {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 }); // Exclusive per approval; never resume/reset.
      if (discovery) receiptPath = join(directory, 'result.json');
      readLedger = await createRunLedger(join(directory, 'read.json'), 1);
      oauthLedger = await createRunLedger(join(directory, 'oauth.json'), 1);
      if (discovery) runner = await loadPinnedDiscoveryRuntime(root, serializedApproval);
      const read = { authorizedMaximum: 1, reserve: i => readLedger.reserve(i) };
      const oauth = { authorizedMaximum: 1, reserve: i => oauthLedger.reserve(i) };
      let injected = false;
      const target = discovery ? approval : approval.message;
      const credentials = async () => {
        if (injected) throw new Error('credentials_invalid');
        injected = true;
        return promptJwtCredentials({ host: target.host, accountId: target.accountId, extensionId: target.extensionId, appPermissions: ['ReadMessages'] });
      };
      // Native fetch is reachable only through both gates and the pinned transport.
      // Manual redirects and application deadlines are supplied by the shared core.
      session = discovery
        ? new runner.RingCentralSmsDiscoverySession({ mode: 'live', approval }, credentials, request => globalThis.fetch(request), read, oauth)
        : runner.prepareLiveOneTimeRead(approval, credentials, request => globalThis.fetch(request), read, oauth);
      const result = discovery ? await session.discover() : await session.read();
      const safe = discovery ? discoverySafeResult(session, result)
        : { status: 'verified', attempts: session.attempts, expectedTextMatched: result.expectedTextMatched, expectedIdentitiesMatched: result.expectedIdentitiesMatched, scopeEvidence: result.scopeEvidence, applicationPermissionsIndependentlyVerified: false };
      await readLedger.record(discovery ? { status: result.status, attempts: session.attempts } : safe); await readLedger.complete();
      await oauthLedger.record({ attempts: session.attempts.oauth }); await oauthLedger.complete();
      if (receiptPath) await writeFile(receiptPath, JSON.stringify(safe), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify(safe));
    }
  }
} catch (error) {
  const categories = ['disabled', 'approval_invalid', 'authorization_pin_check_failed', 'budget_unavailable', 'timeout', 'transport', 'redirect', 'http_status', 'response_size', 'response_format', 'message_mismatch', 'credentials_invalid', 'scope_rejected', 'owner_mismatch', 'owner_unverified', 'token_expired', 'secure_input_unavailable', 'invalid_arguments'];
  const candidate = error?.category ?? error?.message;
  const safe = { status: 'stopped', category: categories.includes(candidate) ? candidate : 'setup_failed', httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null, attempts: session?.attempts ?? (discovery ? { oauth: 0, discovery: 0 } : { oauth: 0, message: 0 }) };
  if (typeof error?.oauthErrorCode === 'string' && /^(?:OAU|CMN)-\d{3}$/.test(error.oauthErrorCode)) safe.oauthErrorCode = error.oauthErrorCode;
  if (safe.category === 'approval_invalid' && Array.isArray(error?.approvalIssues)) safe.approvalIssues = error.approvalIssues.filter(code => typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)).slice(0, 20);
  if (receiptPath) {
    try { await writeFile(receiptPath, JSON.stringify(discoverySafeResult(session, undefined, safe.category, safe)), { flag: 'wx', mode: 0o600 }); }
    catch { /* Never dump filesystem errors or replace an existing receipt. */ }
  }
  // Never print error objects, stack traces, URLs, requests or response bodies.
  console.log(JSON.stringify(safe)); process.exitCode = 1;
} finally {
  session?.dispose?.();
  if (discovery && process.argv[2] === '--discover') {
    try { await revokePinnedDiscoveryAuthorization(); }
    catch { console.log(JSON.stringify({ status: 'stopped', category: 'authorization_revocation_failed' })); process.exitCode = 1; }
  }
  try { await readLedger?.close(); await oauthLedger?.close(); }
  catch { console.log(JSON.stringify({ status: 'stopped', category: 'ledger_close_failed' })); process.exitCode = 1; }
}
