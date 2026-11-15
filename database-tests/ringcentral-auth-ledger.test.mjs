import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

test('offline JWT/read ledgers reserve before HTTP and prevent OAuth or read reuse after restart', async () => {
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const directory = await mkdtemp(resolve('.wrangler/rc-auth-offline-'));
  const originalFetch = globalThis.fetch;
  let readLedger, oauthLedger, networkAttempts = 0;
  try {
    globalThis.fetch = async () => { networkAttempts++; throw new Error('External network forbidden'); };
    const outfile = join(directory, 'session.mjs');
    const built = await build({ entryPoints: [resolve('src/ringcentral/oauth-read-session.ts')], bundle: true, platform: 'node', format: 'esm', outfile, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(built.metafile.inputs).some(name => /database|supabase|telegram|ringcentral\/receiver/i.test(name)), false);
    const { RingCentralReadOnlySession, createOfflineCredentials, createOfflineHttp } = await import(pathToFileURL(outfile).href);
    const readPath = join(directory, 'read.json'), oauthPath = join(directory, 'oauth.json');
    readLedger = await createRunLedger(readPath, 1); oauthLedger = await createRunLedger(oauthPath, 1);
    const readBudget = { authorizedMaximum: 1, reserve: index => readLedger.reserve(index) };
    const oauthBudget = { authorizedMaximum: 1, reserve: index => oauthLedger.reserve(index) };
    const approval = { host: 'https://platform.devtest.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString(), expectedDirection: 'Inbound', expectedSubjectSha256: createHash('sha256').update('Fictional provider inquiry').digest('hex') };
    const inject = createOfflineCredentials('jwt');
    const httpFixture = createOfflineHttp(JSON.stringify([
      { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001' }) },
      { body: JSON.stringify({ id: '300001', type: 'SMS', direction: 'Inbound', subject: 'Fictional provider inquiry', from: { phoneNumber: '+15035550110' } }) }
    ]));
    const http = httpFixture.executor;
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval }, inject, http, readBudget, oauthBudget);
    const pending = session.read();
    assert.equal(httpFixture.audit().length, 0);
    const result = await pending;
    assert.equal(JSON.parse(await readFile(readPath, 'utf8')).attemptsReserved, 1);
    assert.equal(JSON.parse(await readFile(oauthPath, 'utf8')).attemptsReserved, 1);
    await readLedger.record(result); await readLedger.complete();
    await oauthLedger.record({ scopeAccepted: true, ownerMatched: true }); await oauthLedger.complete();
    assert.deepEqual(session.attempts, { oauth: 1, message: 1 });
    await assert.rejects(new RingCentralReadOnlySession({ mode: 'offline', approval }, inject, http, readBudget, oauthBudget).read(), error => error.category === 'budget_unavailable');
    assert.deepEqual(httpFixture.audit().map(r => r.method), ['POST', 'GET']); assert.equal(networkAttempts, 0);
    await assert.rejects(createRunLedger(readPath, 1), { code: 'EEXIST' });
    await assert.rejects(createRunLedger(oauthPath, 1), { code: 'EEXIST' });
    assert.doesNotMatch(await readFile(readPath, 'utf8') + await readFile(oauthPath, 'utf8'), /fictional-secret|signature|issued-token|refresh|555|subject|phoneNumber/);
  } finally { if (readLedger) await readLedger.close(); if (oauthLedger) await oauthLedger.close(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true }); }
});
