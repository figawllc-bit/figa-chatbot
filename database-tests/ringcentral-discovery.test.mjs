import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requireCleanTerminalStartup } from '../scripts/ringcentral-terminal-input.mjs';
import { discoverySafeResult } from '../scripts/ringcentral-safe-result.mjs';
import { readDiscoveryPins, replaceDiscoveryPin, discoveryApprovalDigest, verifyDiscoveryApprovalPin } from '../scripts/ringcentral-discovery-pin.mjs';
import { requirePinnedDiscoveryAuthorization, hasPinnedDiscoveryAuthorization } from '../scripts/ringcentral-discovery-runtime.mjs';

test('unpinned live activation and debugger/preload credential entry fail closed', () => {
  assert.equal(hasPinnedDiscoveryAuthorization(), false);
  assert.throws(() => requirePinnedDiscoveryAuthorization('{}'), { message: 'disabled' });
  for (const key of ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_V8_COVERAGE']) assert.throws(() => requireCleanTerminalStartup([], [key]), { message: 'secure_input_unavailable' });
  assert.throws(() => requireCleanTerminalStartup(['--inspect'], []), { message: 'secure_input_unavailable' });
  requireCleanTerminalStartup([], ['PATH']);
});
test('one approved fictional hash arms only an ephemeral runtime; source flags stay false and session is revoked', async () => {
  const directory = await mkdtemp(resolve('.wrangler/rc-lease-offline-'));
  const originalFetch = globalThis.fetch;
  let network = 0;
  try {
    globalThis.fetch = async () => { network++; throw new Error('forbidden'); };
    const now = Date.now();
    const approval = { operation: 'sms_discovery', approvalId: 'fictional-lease-001', expectedOwnerId: '200001', host: 'https://platform.ringcentral.com', accountId: '~', extensionId: '~', permissions: ['ReadMessages'], expiresAt: new Date(now + 60000).toISOString(), dateFrom: new Date(now - 604800000).toISOString(), dateTo: new Date(now).toISOString(), authorizedJwtIdentityConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001' };
    const serialized = JSON.stringify(approval), pin = createHash('sha256').update(serialized).digest('hex');
    // Test-only helper copy, pinned to fictional data; never changes a real gate.
    const source = await readFile('scripts/ringcentral-discovery-runtime.mjs', 'utf8');
    const temporaryHelper = join(directory, 'fixture-runtime.mjs');
    const pins = readDiscoveryPins(source);
    const reviewed = replaceDiscoveryPin(source, 'REVIEWED', pins.reviewed, pin);
    await writeFile(temporaryHelper, replaceDiscoveryPin(reviewed, 'AUTHORIZED', '', pin));
    await writeFile(join(directory, 'ringcentral-discovery-pin.mjs'), await readFile('scripts/ringcentral-discovery-pin.mjs'));
    const fixtureHelper = await import(pathToFileURL(temporaryHelper).href);
    await assert.rejects(fixtureHelper.loadPinnedDiscoveryRuntime(resolve('.'), serialized + ' '), { message: 'authorization_pin_check_failed' });
    const runtime = await fixtureHelper.loadPinnedDiscoveryRuntime(resolve('.'), serialized);
    assert.equal(fixtureHelper.hasPinnedDiscoveryAuthorization(), false);
    assert.match(await readFile(temporaryHelper, 'utf8'), /AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = ''/);
    await assert.rejects(fixtureHelper.loadPinnedDiscoveryRuntime(resolve('.'), serialized), { message: 'disabled' });
    let calls = 0, readReserved = false, oauthReserved = false;
    const workflow = { authorizedMaximum: 1, async reserve() { if (readReserved) throw new Error('used'); readReserved = true; } };
    const oauth = { authorizedMaximum: 1, async reserve() { if (oauthReserved) throw new Error('used'); oauthReserved = true; } };
    const inject = async () => ({ kind: 'jwt', host: approval.host, accountId: '~', extensionId: '~', appPermissions: ['ReadMessages'], clientId: 'fictional-client', clientSecret: 'fictional-secret', jwt: 'fictional.header.signature' });
    const mock = async request => {
      calls++; assert.equal(readReserved, true); assert.equal(oauthReserved, true);
      if (request.method === 'POST') return Response.json({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001' });
      assert.equal(new URL(request.url).searchParams.get('perPage'), '1');
      return Response.json({ records: [{ id: '300001', type: 'SMS', direction: 'Inbound', creationTime: new Date(now - 60000).toISOString(), subject: 'Fictional private text', from: { name: 'Fictional Sender', phoneNumber: '+15035550110' } }] });
    };
    const session = new runtime.RingCentralSmsDiscoverySession({ mode: 'live', approval }, inject, mock, workflow, oauth);
    assert.deepEqual(await session.discover(), { status: 'selected', messageId: '300001', direction: 'Inbound' });
    assert.equal(session.authenticationVerified, true);
    session.dispose(); await assert.rejects(session.discover(), e => e.category === 'disabled');
    const again = new runtime.RingCentralSmsDiscoverySession({ mode: 'live', approval }, inject, mock, workflow, oauth);
    await assert.rejects(again.discover(), e => e.category === 'budget_unavailable');
    assert.equal(calls, 2); assert.equal(network, 0);
    for (const expectedOwnerId of [undefined, '200002']) {
      let ownerCheckCalls = 0;
      const newBudget = () => ({ authorizedMaximum: 1, async reserve() {} });
      const blocked = new runtime.RingCentralSmsDiscoverySession({ mode: 'live', approval: { ...approval, expectedOwnerId } }, inject, async request => {
        ownerCheckCalls++; assert.equal(request.method, 'POST');
        return Response.json({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001' });
      }, newBudget(), newBudget());
      await assert.rejects(blocked.discover(), e => e.category === (expectedOwnerId ? 'owner_mismatch' : 'owner_unverified'));
      assert.equal(ownerCheckCalls, 1); assert.equal(blocked.attempts.discovery, 0);
      assert.equal(blocked.authenticationVerified, false);
    }
    assert.match(await readFile('src/ringcentral/secure-transport.ts', 'utf8'), /RINGCENTRAL_LIVE_CONNECTION_ENABLED = false/);
    assert.match(await readFile('src/ringcentral/discovery-approval.ts', 'utf8'), /RINGCENTRAL_SMS_DISCOVERY_ENABLED = false/);
    assert.match(await readFile('scripts/ringcentral-discovery-runtime.mjs', 'utf8'), /AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = ''/);
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(directory.startsWith(resolve('.wrangler') + sep)); await rm(directory, { recursive: true });
  }
});

test('live reporting retains only verification metadata and never exposes selected identifiers or customer fields', () => {
  const sensitiveResult = { status: 'selected', messageId: '300001', subject: 'Fictional private text', phoneNumber: '+15035550110' };
  const session = { authenticationVerified: true, attempts: { oauth: 1, discovery: 1 } };
  assert.deepEqual(discoverySafeResult(session, sensitiveResult), {
    authentication: 'verified', requests: { oauth: 1, discovery: 1 }, smsDiscovered: true, errorCategory: null, safetyRestrictionsEnforced: true,
  });
  assert.equal(discoverySafeResult(undefined, undefined, 'owner_mismatch').smsDiscovered, null);
  assert.equal(discoverySafeResult(undefined, undefined, 'owner_mismatch').authentication, 'failed_or_unverified');
  assert.equal(discoverySafeResult(session, { status: 'no_matching_sms' }).smsDiscovered, false);
  assert.doesNotMatch(JSON.stringify(discoverySafeResult(session, sensitiveResult)), /300001|private|555|subject|phoneNumber/);
});

test('OAuth failure receipts retain status and numeric code without any raw diagnostics', () => {
  const session = { authenticationVerified: false, attempts: { oauth: 1, discovery: 0 } };
  const safe = discoverySafeResult(session, undefined, 'http_status', { httpStatus: 401, oauthErrorCode: 'OAU-146', body: 'FICTIONAL_PRIVATE_BODY', error_description: 'FICTIONAL_PRIVATE_DESCRIPTION', access_token: 'FICTIONAL_PRIVATE_TOKEN' });
  assert.equal(safe.httpStatus, 401); assert.equal(safe.oauthErrorCode, 'OAU-146');
  assert.deepEqual(safe.requests, { oauth: 1, discovery: 0 });
  assert.doesNotMatch(JSON.stringify(safe), /FICTIONAL_|body|description|access_token/);
  for (const oauthErrorCode of ['FICTIONAL_PRIVATE_TOKEN', 'OAU-146\nPRIVATE', 'OAU-146-extra', {}, null]) {
    const rejected = discoverySafeResult(session, undefined, 'http_status', { httpStatus: 999, oauthErrorCode });
    assert.equal(Object.hasOwn(rejected, 'oauthErrorCode'), false); assert.equal(Object.hasOwn(rejected, 'httpStatus'), false);
  }
});
test('offline preflight validates approval without arming gates, credentials or ledger creation', async () => {
  const directory = await mkdtemp(resolve('.wrangler/rc-preflight-offline-'));
  try {
    const now = Date.now(), a = { operation: 'sms_discovery', approvalId: 'fictional-preflight-' + now, host: 'https://platform.ringcentral.com', accountId: '~', extensionId: '~', permissions: ['ReadMessages'], expiresAt: new Date(now + 60000).toISOString(), dateFrom: new Date(now - 604800000).toISOString(), dateTo: new Date(now).toISOString(), authorizedJwtIdentityConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001' };
    const path = join(directory, 'approval.json');
    for (const confirmed of [true, false]) {
      await writeFile(path, JSON.stringify({ ...a, authorizedJwtIdentityConfirmed: confirmed }));
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', './scripts/offline-guard.mjs', 'scripts/ringcentral-read-once.mjs', '--preflight-discovery', '--approval', path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '', err = ''; child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v); child.on('error', reject); child.on('close', code => resolve({ out, err, code }));
      });
      assert.equal(result.err, ''); assert.equal(result.code, confirmed ? 0 : 1);
      if (confirmed) assert.deepEqual(JSON.parse(result.out), { status: 'offline_preflight_passed', requests: 0, credentialsRead: false, mailboxIdentity: 'operator_asserted_not_live_verified', ownerPinReady: false, liveEnabled: false });
      else assert.equal(JSON.parse(result.out).category, 'approval_invalid');
    }
    await assert.rejects(readFile(join('.wrangler/ringcentral-read-only', a.approvalId, 'read.json')), { code: 'ENOENT' });
  } finally { assert.ok(directory.startsWith(resolve('.wrangler') + sep)); await rm(directory, { recursive: true }); }
});

test('discovery reserves one durable OAuth/list workflow and never retains customer fields or reuses ledgers', async () => {
  const directory = await mkdtemp(resolve('.wrangler/rc-discovery-offline-'));
  const previousFetch = globalThis.fetch;
  let workflow, oauth, network = 0;
  try {
    globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
    const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
    const built = await build({ stdin: { contents: "export * from './src/ringcentral/sms-discovery'; export { createOfflineCredentials } from './src/ringcentral/offline-credentials'; export { createOfflineHttp } from './src/ringcentral/secure-transport';", resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(built.metafile.inputs).some(p => /database|supabase|telegram|receiver|src\/ai|src\/index/.test(p)), false);
    const { RingCentralSmsDiscoverySession, createOfflineCredentials, createOfflineHttp } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
    const now = Date.now();
    const approval = { operation: 'sms_discovery', approvalId: 'fictional-discovery-001', host: 'https://platform.ringcentral.com', accountId: '~', extensionId: '~', permissions: ['ReadMessages'], expiresAt: new Date(now + 60000).toISOString(), dateFrom: new Date(now - 604800000).toISOString(), dateTo: new Date(now).toISOString(), authorizedJwtIdentityConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001' };
    const http = createOfflineHttp(JSON.stringify([
      { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001' }) },
      { body: JSON.stringify({ records: [{ id: '300001', direction: 'Inbound', type: 'SMS', creationTime: new Date(now - 60000).toISOString(), subject: 'Fictional confidential customer text', from: { name: 'Fictional Customer', phoneNumber: '+15035550110' }, to: [{ name: 'Fictional FIGA', phoneNumber: '+15035550100' }] }], paging: { page: 1, perPage: 1 }, navigation: { nextPage: { uri: 'https://example.invalid/NEVER_FOLLOW' } } }) }
    ]));
    const workflowPath = join(directory, 'workflow.json'), oauthPath = join(directory, 'oauth.json');
    workflow = await createRunLedger(workflowPath, 1); oauth = await createRunLedger(oauthPath, 1);
    const readBudget = { authorizedMaximum: 1, reserve: i => workflow.reserve(i) }, oauthBudget = { authorizedMaximum: 1, reserve: i => oauth.reserve(i) };
    const provider = createOfflineCredentials('jwt', undefined, 'production');
    const session = new RingCentralSmsDiscoverySession({ mode: 'offline', approval }, provider, http.executor, readBudget, oauthBudget);
    const pending = session.discover(); assert.equal(http.audit().length, 0);
    const result = await pending;
    assert.deepEqual(result, { status: 'selected', messageId: '300001', direction: 'Inbound' });
    assert.deepEqual(session.attempts, { oauth: 1, discovery: 1 }); assert.equal(network, 0);
    assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).attemptsReserved, 1); assert.equal(JSON.parse(await readFile(oauthPath, 'utf8')).attemptsReserved, 1);
    await workflow.record({ status: result.status, attempts: session.attempts }); await workflow.complete(); await oauth.record({ attempts: 1 }); await oauth.complete();
    await assert.rejects(new RingCentralSmsDiscoverySession({ mode: 'offline', approval }, provider, http.executor, readBudget, oauthBudget).discover(), e => e.category === 'budget_unavailable');
    assert.equal(http.audit().length, 2); await assert.rejects(createRunLedger(workflowPath, 1), { code: 'EEXIST' });
    assert.doesNotMatch(await readFile(workflowPath, 'utf8') + await readFile(oauthPath, 'utf8') + JSON.stringify(result), /confidential|Customer|FIGA|555|subject|phoneNumber|secret|signature|access-token/);
  } finally {
    await workflow?.close(); await oauth?.close(); globalThis.fetch = previousFetch;
    assert.ok(directory.startsWith(resolve('.wrangler') + sep)); await rm(directory, { recursive: true });
  }
});
test('discovery CLI remains disabled before approval/credentials/ledger access', async () => {
  for (const args of [['--check-discovery'], ['--discover', '--approval', '.env.must-not-open.json']]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', './scripts/offline-guard.mjs', 'scripts/ringcentral-read-once.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = ''; child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v);
      child.on('error', reject); child.on('close', code => resolve({ out, err, code }));
    });
    assert.equal(result.code, 1); assert.equal(result.err, '');
    assert.deepEqual(JSON.parse(result.out), { status: 'stopped', category: 'disabled', httpStatus: null, attempts: { oauth: 0, discovery: 0 } });
  }
});
