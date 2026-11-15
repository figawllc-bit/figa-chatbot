import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { promptHidden, promptJwtCredentials } from '../scripts/ringcentral-terminal-input.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

class Terminal extends EventEmitter {
  isTTY = true; isRaw = false; displayed = ''; paused = true;
  rawTransitions = [];
  setRawMode(value) { this.isRaw = value; this.rawTransitions.push(value); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  write(value) { this.displayed += value; }
}
test('hidden terminal input does not echo, retains no listeners and restores terminal modes', async () => {
  const input = new Terminal(), output = new Terminal();
  const result = promptJwtCredentials({ host: 'fictional' }, { input, output });
  input.emit('data', Buffer.from('fictional-client\r'));
  await new Promise(resolve => setImmediate(resolve));
  input.emit('data', Buffer.from('fictional-secret\r'));
  await new Promise(resolve => setImmediate(resolve));
  input.emit('data', Buffer.from('fictional.header.signature\r'));
  assert.deepEqual(await result, { host: 'fictional', kind: 'jwt', clientId: 'fictional-client', clientSecret: 'fictional-secret', jwt: 'fictional.header.signature' });
  assert.doesNotMatch(output.displayed, /fictional|secret\r|signature/);
  assert.equal(input.isRaw, false); assert.equal(input.paused, true); assert.equal(input.listenerCount('data'), 0);
});

test('a split Windows CRLF cannot submit the following hidden prompt', async () => {
  const input = new Terminal(), output = new Terminal();
  let settled = false;
  const pending = promptJwtCredentials({ host: 'fictional' }, { input, output });
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    input.emit('data', Buffer.from('fictional-client\r'));
    await new Promise(resolve => setImmediate(resolve));
    input.emit('data', Buffer.from('\n'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'trailing LF must not complete Client Secret');
    assert.match(output.displayed, /Client Secret \(hidden\): /);
    assert.doesNotMatch(output.displayed, /JWT \(hidden\): /);
    assert.equal(input.isRaw, true);
    input.emit('data', Buffer.from('fictional-secret\r'));
    await new Promise(resolve => setImmediate(resolve));
    input.emit('data', Buffer.from('\n'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'JWT must also await its own value');
    input.emit('data', Buffer.from('fictional.header.signature\r\n'));
    assert.deepEqual(await pending, { host: 'fictional', kind: 'jwt', clientId: 'fictional-client', clientSecret: 'fictional-secret', jwt: 'fictional.header.signature' });
    assert.doesNotMatch(output.displayed, /fictional|signature/);
  } finally {
    input.emit('data', Buffer.from('\x03')); await pending.catch(() => {});
  }
});

for (const ending of ['\r', '\n', '\r\n']) {
  test(`three hidden prompts independently accept pasted chunks with ${JSON.stringify(ending)} endings`, async () => {
    const input = new Terminal(), output = new Terminal();
    let settled = false;
    const pending = promptJwtCredentials({}, { input, output });
    pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      // A queued Enter, blank paste line, or repeated Enter cannot submit a field.
      input.emit('data', Buffer.from('\r\n\n'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.equal(output.displayed, 'Client ID (hidden): ');
      input.emit('data', Buffer.from('dummy-')); input.emit('data', Buffer.from('client' + ending));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.deepEqual(input.rawTransitions, [true]);
      assert.match(output.displayed, /Client Secret \(hidden\): $/);
      input.emit('data', Buffer.from('\r\n'));
      assert.doesNotMatch(output.displayed, /JWT/);
      input.emit('data', Buffer.from('dummy-secret+/:=' + ending));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.deepEqual(input.rawTransitions, [true]);
      assert.match(output.displayed, /JWT \(hidden\): $/);
      input.emit('data', Buffer.from('dummy.header.')); input.emit('data', Buffer.from('signature' + ending));
      assert.deepEqual(await pending, { kind: 'jwt', clientId: 'dummy-client', clientSecret: 'dummy-secret+/:=', jwt: 'dummy.header.signature' });
      assert.deepEqual(input.rawTransitions, [true, false]);
      assert.doesNotMatch(output.displayed, /dummy|signature|\+\//);
      for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0);
    } finally { input.emit('data', Buffer.from('\x03')); await pending.catch(() => {}); }
  });
}

test('buffered readable-stream CRLF events stay hidden and cannot race between prompts', async () => {
  const input = new PassThrough(), output = new Terminal();
  input.isTTY = true; input.isRaw = false;
  const transitions = [];
  input.setRawMode = value => { input.isRaw = value; transitions.push(value); };
  input.pause();
  input.write(Buffer.from('dummy-client\r')); input.write(Buffer.from('\n'));
  const pending = promptJwtCredentials({}, { input, output });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.match(output.displayed, /Client Secret \(hidden\): $/);
    assert.deepEqual(transitions, [true]);
    input.write(Buffer.from('dummy-secret\r')); input.write(Buffer.from('\n'));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(output.displayed, /JWT \(hidden\): $/);
    input.write(Buffer.from('dummy.header.signature\r')); input.write(Buffer.from('\n'));
    assert.deepEqual(await pending, { kind: 'jwt', clientId: 'dummy-client', clientSecret: 'dummy-secret', jwt: 'dummy.header.signature' });
    assert.deepEqual(transitions, [true, false]); assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount('data'), 0); assert.doesNotMatch(output.displayed, /dummy|signature/);
  } finally { input.emit('data', Buffer.from('\x03')); await pending.catch(() => {}); input.destroy(); }
});

test('concurrent hidden readers and multiline credential pastes fail without echoing or accepting secrets', async () => {
  const input = new Terminal(), output = new Terminal();
  const pending = promptJwtCredentials({}, { input, output });
  await assert.rejects(promptHidden('JWT', { input, output }), { message: 'secure_input_unavailable' });
  assert.equal(input.listenerCount('data'), 1); assert.deepEqual(input.rawTransitions, [true]);
  input.emit('data', Buffer.from('dummy-client\r\ndummy-secret\r\n'));
  await assert.rejects(pending, { message: 'secure_input_unavailable' });
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
  assert.doesNotMatch(output.displayed, /dummy|Client Secret|JWT/);
  // Failure releases the reader so a later independent invocation is possible.
  const next = promptHidden('JWT', { input, output }); input.emit('data', Buffer.from('dummy\r'));
  assert.equal(await next, 'dummy');
});

test('each field keeps its own bounded timeout and restores raw mode on cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new Terminal(), output = new Terminal();
  const pending = promptJwtCredentials({}, { input, output });
  pending.catch(() => {});
  t.mock.timers.tick(119000); input.emit('data', Buffer.from('dummy-client\r\n'));
  t.mock.timers.tick(119000);
  assert.equal(input.isRaw, true); assert.match(output.displayed, /Client Secret \(hidden\): $/);
  input.emit('data', Buffer.from('dummy-secret\r\n'));
  t.mock.timers.tick(119000);
  assert.equal(input.isRaw, true); assert.match(output.displayed, /JWT \(hidden\): $/);
  t.mock.timers.tick(1000);
  await assert.rejects(pending, { message: 'secure_input_unavailable' });
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
  assert.doesNotMatch(output.displayed, /dummy/);
});
test('secure input rejects non-interactive input, cancellation, invalid controls and overlong secrets', async () => {
  for (const text of ['\x03', 'x'.repeat(513), '\x1b']) {
    const input = new Terminal(), output = new Terminal();
    const pending = promptHidden('Client Secret', { input, output });
    input.emit('data', Buffer.from(text));
    await assert.rejects(pending, { message: 'secure_input_unavailable' });
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
    assert.doesNotMatch(output.displayed, /xxx|bad/);
  }
  const input = new Terminal(), output = new Terminal(); input.isTTY = false;
  await assert.rejects(promptHidden('JWT', { input, output }), { message: 'secure_input_unavailable' });
  assert.equal(output.displayed, '');
});
test('backspace and prior raw mode are preserved without echoing input', async () => {
  const input = new Terminal(), output = new Terminal(); input.isRaw = true;
  const pending = promptHidden('JWT', { input, output }); input.emit('data', Buffer.from('fictionalX\x7f\r'));
  assert.equal(await pending, 'fictional'); assert.equal(input.isRaw, true); assert.doesNotMatch(output.displayed, /fictional/);
});
test('live CLI stops at disabled gate before opening approval, prompting credentials or creating ledgers', async () => {
  for (const args of [['--check'], ['--execute', '--approval', '.env.must-not-be-opened.json']]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', './scripts/offline-guard.mjs', 'scripts/ringcentral-read-once.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v);
      child.on('error', reject); child.on('close', code => resolve({ out, err, code }));
    });
    assert.equal(result.code, 1); assert.equal(result.err, '');
    assert.deepEqual(JSON.parse(result.out), { status: 'stopped', category: 'disabled', httpStatus: null, attempts: { oauth: 0, message: 0 } });
    assert.doesNotMatch(result.out, /hidden|Client|JWT|\.env/);
  }
});
test('production-host orchestration uses fictional fixtures, exclusive durable ledgers and no service imports/network', async () => {
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const directory = await mkdtemp(resolve('.wrangler/rc-runner-offline-'));
  const previousFetch = globalThis.fetch;
  let read, oauth, network = 0;
  try {
    globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
    const buildResult = await build({ entryPoints: [resolve('src/ringcentral/one-time-runner.ts')], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(buildResult.metafile.inputs).some(p => /database|supabase|telegram|receiver|src\/index/i.test(p)), false);
    const { prepareOfflineOneTimeRead } = await import('data:text/javascript;base64,' + Buffer.from(buildResult.outputFiles[0].contents).toString('base64'));
    const hash = value => createHash('sha256').update(value).digest('hex');
    const text = 'Fictional runner verification';
    const approval = { approvalId: 'fictional-ledger-001', appName: 'FIGA Chatbot Read-Only', privateProductionJwtAppConfirmed: true, authorizedExtensionConfirmed: true, fictionalMessageConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001', authorizedRequests: ['oauth_token', 'one_sms_get'],
      message: { host: 'https://platform.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', expectedDirection: 'Inbound', expectedSubjectSha256: hash(text), expectedFromSha256: hash('+15035550110'), expectedToSha256: hash('+15035550100'), permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString() } };
    const steps = JSON.stringify([
      { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001' }) },
      { body: JSON.stringify({ id: '300001', type: 'SMS', direction: 'Inbound', subject: text, from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }] }) }
    ]);
    const readPath = join(directory, 'read.json'), oauthPath = join(directory, 'oauth.json');
    read = await createRunLedger(readPath, 1); oauth = await createRunLedger(oauthPath, 1);
    const readBudget = { authorizedMaximum: 1, reserve: i => read.reserve(i) }, oauthBudget = { authorizedMaximum: 1, reserve: i => oauth.reserve(i) };
    const { session, audit } = prepareOfflineOneTimeRead(approval, steps, readBudget, oauthBudget);
    const result = await session.read();
    assert.equal(result.expectedIdentitiesMatched, true); assert.equal(result.applicationPermissionsIndependentlyVerified, false);
    assert.deepEqual(session.attempts, { oauth: 1, message: 1 }); assert.equal(audit().length, 2);
    await read.record(result); await read.complete(); await oauth.record({ attempts: 1 }); await oauth.complete();
    const restart = prepareOfflineOneTimeRead(approval, steps, readBudget, oauthBudget);
    await assert.rejects(restart.session.read(), e => e.category === 'budget_unavailable'); assert.equal(restart.audit().length, 0);
    await assert.rejects(createRunLedger(readPath, 1), { code: 'EEXIST' });
    assert.doesNotMatch(await readFile(readPath, 'utf8') + await readFile(oauthPath, 'utf8'), /Fictional runner|phoneNumber|555|secret|signature|access-token/);
    assert.equal(network, 0);
  } finally {
    await read?.close(); await oauth?.close(); globalThis.fetch = previousFetch;
    assert.ok(directory.startsWith(resolve('.wrangler') + sep));
    await rm(directory, { recursive: true });
  }
});
