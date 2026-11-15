import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createDiscoveryApproval, writeDiscoveryApproval } from '../scripts/ringcentral-prepare-discovery.mjs';
import { readDiscoveryPins } from '../scripts/ringcentral-discovery-pin.mjs';

test('just-in-time builder pins the approved mailbox, ReadMessages, canonical UTC dates and unique IDs', () => {
  const now = Date.now(), a = createDiscoveryApproval(now), b = createDiscoveryApproval(now);
  assert.notEqual(a.approvalId, b.approvalId);
  assert.equal(a.extensionId, '3322425015'); assert.equal(a.expectedOwnerId, '3322425015');
  assert.equal(a.accountId, '~'); assert.equal(a.host, 'https://platform.ringcentral.com');
  assert.deepEqual(a.permissions, ['ReadMessages']);
  assert.equal(Date.parse(a.dateTo), now); assert.equal(Date.parse(a.dateTo) - Date.parse(a.dateFrom), 604800000);
  assert.equal(Date.parse(a.expiresAt) - now, 1200000);
  for (const value of [a.dateFrom, a.dateTo, a.expiresAt]) assert.equal(new Date(value).toISOString(), value);
  assert.throws(() => createDiscoveryApproval(now, '../escape'));
  assert.throws(() => createDiscoveryApproval(NaN));
});

test('fictional preparation, human review, independent byte verification and preflight pass with live gates disabled', async () => {
  // All generated authorizations and reviewed pins exist only in this fixture root.
  const directory = await mkdtemp(resolve('.wrangler/rc-prepare-offline-'));
  const mainRuntime = await readFile('scripts/ringcentral-discovery-runtime.mjs');
  try {
    await mkdir(join(directory, 'scripts')); await mkdir(join(directory, 'src/ringcentral'), { recursive: true });
    for (const name of ['ringcentral-prepare-discovery.mjs', 'ringcentral-review-discovery.mjs', 'ringcentral-discovery-pin.mjs', 'ringcentral-discovery-runtime.mjs', 'ringcentral-read-once.mjs', 'ai-run-ledger.mjs', 'ringcentral-terminal-input.mjs', 'ringcentral-safe-result.mjs']) await writeFile(join(directory, 'scripts', name), await readFile(join('scripts', name)));
    for (const name of ['discovery-approval.ts', 'read-only-test.ts', 'secure-transport.ts', 'sms-discovery.ts', 'oauth-read-session.ts', 'offline-credentials.ts', 'one-time-runner.ts']) await writeFile(join(directory, 'src/ringcentral', name), await readFile(join('src/ringcentral', name)));
    const run = (script, ...args) => new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/offline-guard.mjs')).href, join(directory, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = ''; child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v);
      child.on('error', reject); child.on('close', code => { try { assert.equal(err, ''); resolveResult({ code, result: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    const prepared = await run('ringcentral-prepare-discovery.mjs', '--create');
    assert.equal(prepared.code, 0); assert.equal(prepared.result.status, 'approval_created_review_required');
    const path = prepared.result.approvalPath;
    assert.ok(path.startsWith(directory + sep));
    const bytes = await readFile(path), a = JSON.parse(bytes);
    assert.equal(a.expectedOwnerId, '3322425015'); assert.equal(a.extensionId, '3322425015');
    assert.deepEqual(a.permissions, ['ReadMessages']);
    assert.equal(Date.parse(a.dateTo) - Date.parse(a.dateFrom), 604800000);
    assert.equal(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), false);
    // Exclusive writes preserve the first authorization on collisions.
    await assert.rejects(writeDiscoveryApproval(join(directory, '.wrangler'), a), { code: 'EEXIST' });
    assert.deepEqual(await readFile(path), bytes);
    const review = await run('ringcentral-review-discovery.mjs', '--review', '--approval', path);
    assert.equal(review.code, 0); assert.equal(review.result.approvalValidation, 'validated');
    const verify = await run('ringcentral-review-discovery.mjs', '--verify', '--approval', path);
    assert.equal(verify.code, 0); assert.equal(verify.result.sha256, createHash('sha256').update(bytes).digest('hex'));
    const pins = readDiscoveryPins(await readFile(join(directory, 'scripts/ringcentral-discovery-runtime.mjs'), 'utf8'));
    assert.equal(pins.reviewed, verify.result.sha256); assert.equal(pins.authorized, '');
    const preflight = await run('ringcentral-read-once.mjs', '--preflight-discovery', '--approval', path);
    assert.equal(preflight.code, 0); assert.equal(preflight.result.status, 'offline_preflight_passed');
    for (const { result } of [prepared, review, verify, preflight]) {
      assert.equal(result.requests, 0); assert.equal(result.credentialsRead, false); assert.equal(result.liveEnabled, false);
    }
    await assert.rejects(readFile(join(directory, '.wrangler/ringcentral-read-only', a.approvalId, 'read.json')), { code: 'ENOENT' });
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
    assert.equal((await run('ringcentral-review-discovery.mjs', '--verify', '--approval', path)).result.category, 'authorization_pin_check_failed');
    // An edited/invalid approval reports fixed reasons before credential access.
    await writeFile(path, JSON.stringify({ ...a, permissions: ['ReadMessages', 'SMS'] }));
    const invalid = await run('ringcentral-read-once.mjs', '--preflight-discovery', '--approval', path);
    assert.equal(invalid.result.category, 'approval_invalid'); assert.deepEqual(invalid.result.approvalIssues, ['permissions_invalid']);
    assert.deepEqual(invalid.result.attempts, { oauth: 0, discovery: 0 });
    assert.equal((await run('ringcentral-read-once.mjs', '--discover', '--approval', path)).result.category, 'disabled');
    assert.deepEqual(await readFile('scripts/ringcentral-discovery-runtime.mjs'), mainRuntime);
  } finally {
    assert.ok(directory.startsWith(resolve('.wrangler') + sep)); await rm(directory, { recursive: true });
  }
});
