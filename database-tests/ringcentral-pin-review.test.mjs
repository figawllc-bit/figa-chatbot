import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discoveryApprovalDigest, readDiscoveryPins, replaceDiscoveryPin } from '../scripts/ringcentral-discovery-pin.mjs';

test('offline pin verifier checks exact bytes, owner, disabled state and retired approvals without a compiler or credentials', async () => {
  const directory = await mkdtemp(resolve('.wrangler/rc-pin-review-'));
  try {
    await mkdir(join(directory, 'scripts')); await mkdir(join(directory, '.wrangler'));
    for (const name of ['ringcentral-review-discovery.mjs', 'ringcentral-discovery-pin.mjs']) await writeFile(join(directory, 'scripts', name), await readFile(join('scripts', name)));
    const original = await readFile('scripts/ringcentral-discovery-runtime.mjs', 'utf8');
    const a = { operation: 'sms_discovery', approvalId: 'fictional-pin-review-001', host: 'https://platform.ringcentral.com', accountId: '~', extensionId: '3322425015', expectedOwnerId: '3322425015', permissions: ['ReadMessages'], expiresAt: new Date(Date.now() + 60000).toISOString() };
    const path = join(directory, '.wrangler', a.approvalId + '.authorization.json');
    const serialized = JSON.stringify(a), pin = discoveryApprovalDigest(Buffer.from(serialized));
    const runtimePath = join(directory, 'scripts/ringcentral-discovery-runtime.mjs');
    const reviewed = replaceDiscoveryPin(original, 'REVIEWED', readDiscoveryPins(original).reviewed, pin);
    await writeFile(path.replace('.json', '.sha256'), pin + '\n');
    const run = async () => new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/offline-guard.mjs')).href, join(directory, 'scripts/ringcentral-review-discovery.mjs'), '--verify', '--approval', path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = ''; child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v);
      child.on('error', reject); child.on('close', code => { try { assert.equal(err, ''); resolveResult({ code, result: JSON.parse(out) }); } catch (error) { reject(error); } });
    });
    for (const [name, bytes, source, category] of [
      ['valid', serialized, reviewed, null],
      ['changed bytes', serialized + ' ', reviewed, 'authorization_pin_check_failed'],
      ['wrong owner', JSON.stringify({ ...a, expectedOwnerId: '200002' }), reviewed, 'approval_invalid'],
      ['unexpected scope', JSON.stringify({ ...a, permissions: ['ReadMessages', 'SMS'] }), reviewed, 'approval_invalid'],
      ['live pin present', serialized, replaceDiscoveryPin(reviewed, 'AUTHORIZED', '', pin), 'disabled'],
      ['duplicate declaration', serialized, reviewed + "\nexport const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';\n", 'authorization_pin_check_failed'],
    ]) {
      await writeFile(path, bytes); await writeFile(runtimePath, source);
      const { code, result } = await run();
      assert.equal(code, category ? 1 : 0, name);
      assert.equal(result.status, category ? 'stopped' : 'reviewed_pin_verified', name);
      if (category) assert.equal(result.category, category, name);
      else assert.equal(result.approvalValidation, 'not_run');
      assert.equal(result.requests, 0); assert.equal(result.credentialsRead, false); assert.equal(result.liveEnabled, false);
    }
    await writeFile(path, serialized); await writeFile(runtimePath, reviewed);
    await mkdir(join(directory, '.wrangler/ringcentral-read-only'), { recursive: true });
    await mkdir(join(directory, '.wrangler/ringcentral-read-only', a.approvalId));
    assert.equal((await run()).result.category, 'budget_unavailable');
  } finally {
    assert.ok(directory.startsWith(resolve('.wrangler') + sep));
    await rm(directory, { recursive: true });
  }
});
