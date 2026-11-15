import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';

test('Phase 8A fictional polling persists safe checkpoints, recovers after restart, and reuses existing SQL intake', async t => {
  const directory = await mkdtemp(resolve('.wrangler/rc-polling-sql-'));
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let db, network = 0, simulatedNow = Date.parse('2026-11-15T12:00:00.000Z'), stateQueue = Promise.resolve(), failCheckpoint = true;
  const start = simulatedNow;
  try {
    const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
    const built = await build({ stdin: { contents: "export * from './src/ringcentral/polling'; export {createOfflineCredentials} from './src/ringcentral/offline-credentials'; export {createOfflinePollingHttp} from './src/ringcentral/secure-transport'; export {OfflineRingCentralReceiver,SupabaseRingCentralRepository} from './src/ringcentral/receiver';", resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    const { RingCentralIncomingPoller, createOfflineCredentials, createOfflinePollingHttp, OfflineRingCentralReceiver, SupabaseRingCentralRepository } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
    db = await PGlite.create(join(directory, 'pgdata'));
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const name of (await readdir('supabase/migrations')).filter(x => x.endsWith('.sql')).sort()) await db.exec(await readFile(join('supabase/migrations', name), 'utf8'));
    // Local test table only: no migration, remote connection, or production data.
    await db.exec('create table fixture_poll_checkpoint(key text primary key,state jsonb not null)');
    globalThis.fetch = async () => { network++; throw Error('External network forbidden'); };
    Date.now = () => simulatedNow;
    const store = {
      async exclusive(key, work) {
        const previous = stateQueue; let unlock; stateQueue = new Promise(resolve => { unlock = resolve; }); await previous;
        try {
          const loaded = (await db.query('select state from fixture_poll_checkpoint where key=$1', [key])).rows[0]?.state ?? null;
          return await work(loaded, async state => {
            if (failCheckpoint && state.seen.length) { failCheckpoint = false; throw Error('Fictional checkpoint interruption'); }
            await db.query('insert into fixture_poll_checkpoint values($1,$2) on conflict(key) do update set state=excluded.state', [key, JSON.stringify(state)]);
          });
        } finally { unlock(); }
      },
    };
    class Repository extends SupabaseRingCentralRepository {
      async rpc(name, parameters) {
        assert.equal(name, 'figa_rc_observe');
        await db.exec('set role service_role');
        try { return (await db.query('select public.figa_rc_observe($1,$2,$3) as result', [parameters.p_event_id, parameters.p_hash, JSON.stringify(parameters.p_messages)])).rows[0].result; }
        finally { await db.exec('reset role'); }
      }
    }
    const scope = { accountId: '100001', extensionId: '200001', subscriptionId: 'fictional-subscription', businessNumbers: ['+15035550100'] };
    const receiver = new OfflineRingCentralReceiver(scope, new Repository());
    const record = (id, text, when) => ({ id, type: 'SMS', direction: 'Inbound', subject: text, messageStatus: 'Received', from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], creationTime: new Date(when).toISOString() });
    const first = record('300001', 'Fictional provider inquiry', start + 30000);
    const token = { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, owner_id: '200001', scope: 'ReadMessages' }) };
    const make = records => {
      const http = createOfflinePollingHttp(JSON.stringify([token, { body: JSON.stringify({ records, paging: { page: 1, perPage: 20, totalPages: 1 } }) }]));
      return { http, poller: new RingCentralIncomingPoller({ mode: 'offline', store, http: http.executor, credentials: createOfflineCredentials('jwt', undefined, 'production'), controls: () => ({ enabled: true, paused: false }), fixture: { scope, receiver } }) };
    };
    const count = async name => (await db.query(`select count(*)::int as n from public.${name}`)).rows[0].n;
    let instance = make([first]);
    await t.test('first startup saves a baseline and never reads or imports old messages', async () => {
      assert.equal((await instance.poller.poll()).status, 'baseline'); assert.equal(instance.http.audit().length, 0);
      assert.equal(await count('rc_observations'), 0);
    });
    await t.test('an interrupted checkpoint keeps receiver intake idempotent and leaves the window uncompleted', async () => {
      simulatedNow = start + 120000;
      assert.equal((await instance.poller.poll()).status, 'error');
      assert.equal(await count('rc_observations'), 1);
      const state = (await db.query('select state from fixture_poll_checkpoint')).rows[0].state;
      assert.equal(state.completedThrough, new Date(start).toISOString()); assert.deepEqual(state.seen, []);
      assert.equal(await count('messages'), 0); assert.equal(await count('telegram_notifications'), 0);
    });
    await t.test('closing and reopening the disk-backed SQL store recovers without baseline reset or duplicate intake', async () => {
      await db.close(); db = await PGlite.create(join(directory, 'pgdata'));
      simulatedNow = start + 240000; instance = make([first]);
      const result = await instance.poller.poll();
      assert.equal(result.status, 'ok'); assert.equal(result.newMessages, 0); assert.equal(result.duplicates, 1);
      assert.equal(await count('rc_observations'), 1); assert.equal(await count('contacts'), 1);
      const state = (await db.query('select state from fixture_poll_checkpoint')).rows[0].state;
      assert.equal(state.baselineAt, new Date(start).toISOString()); assert.equal(state.completedThrough, new Date(start + 230000).toISOString());
      assert.doesNotMatch(JSON.stringify(state) + JSON.stringify(result), /subject|phone|555|300001|Fictional|secret|token|signature/);
    });
    await t.test('later STOP uses existing opt-out safeguards without producing a public reply or staff ownership change', async () => {
      simulatedNow = start + 360000;
      instance = make([record('300002', 'STOP', start + 270000)]);
      assert.equal((await instance.poller.poll()).newMessages, 1);
      assert.equal(await count('rc_observations'), 2); assert.equal(await count('rc_optouts'), 1);
      assert.equal(await count('messages'), 0); assert.equal(await count('staff_assignments'), 0); assert.equal(await count('telegram_notifications'), 0);
      assert.equal(network, 0);
    });
  } finally {
    Date.now = originalNow; globalThis.fetch = originalFetch; await db?.close();
    assert.ok(directory.startsWith(resolve('.wrangler') + sep)); await rm(directory, { recursive: true });
  }
});
