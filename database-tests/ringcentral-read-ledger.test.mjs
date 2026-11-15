import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

test('mock-only read client reserves one durable slot before GET and cannot reuse it after restart', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const directory = await mkdtemp(resolve('.wrangler/rc-read-ledger-'));
  const originalFetch = globalThis.fetch;
  let ledger, networkAttempts = 0;
  try {
    globalThis.fetch = async () => { networkAttempts++; throw new Error('External network forbidden'); };
    const outfile = join(directory, 'client.mjs');
    const built = await build({ entryPoints: [resolve('src/ringcentral/read-only-test.ts')], bundle: true, platform: 'node', format: 'esm', outfile, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(built.metafile.inputs).some(name => /database|supabase|telegram|receiver/i.test(name)), false);
    const { SingleMessageReadOnlyTestClient, createOfflineHttp } = await import(pathToFileURL(outfile).href);
    const ledgerPath = join(directory, 'one-read.json');
    ledger = await createRunLedger(ledgerPath, 1);
    const approval = { host: 'https://platform.devtest.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString(), expectedDirection: 'Inbound', expectedSubjectSha256: createHash('sha256').update('Fictional provider inquiry').digest('hex') };
    const http = createOfflineHttp(JSON.stringify([{ body: JSON.stringify({ id: approval.messageId, type: 'SMS', direction: 'Inbound', subject: 'Fictional provider inquiry' }) }]));
    const mock = http.executor;
    const budget = { authorizedMaximum: 1, reserve: index => ledger.reserve(index) };
    const client = new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval }, mock, budget);
    const pending = client.read();
    assert.equal(http.audit().length, 0); // dispatch waits for durable reservation
    const result = await pending;
    assert.equal(JSON.parse(await readFile(ledgerPath, 'utf8')).attemptsReserved, 1);
    assert.equal(http.audit()[0].method, 'GET'); assert.equal(http.audit()[0].redirect, 'manual');
    await ledger.record(result); await ledger.complete();
    await assert.rejects(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval }, mock, budget).read(), error => error.category === 'budget_unavailable');
    await assert.rejects(createRunLedger(ledgerPath, 1), { code: 'EEXIST' });
    const saved = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(saved.attemptsReserved, 1); assert.equal(saved.results.length, 1);
    assert.equal(JSON.stringify(saved).includes('Fictional provider inquiry'), false);
    assert.equal(http.audit().length, 1); assert.equal(networkAttempts, 0);
  } finally { if (ledger) await ledger.close(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true }); }
});
