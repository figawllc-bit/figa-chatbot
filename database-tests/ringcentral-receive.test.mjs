import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Phase 7A receive-only RingCentral fixtures use real local SQL transactions', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/ringcentral-receive-tests.mjs');
  await build({ stdin: { contents: `export {createWorker} from './src/index'; export {OfflineRingCentralReceiver,SupabaseRingCentralRepository} from './src/ringcentral/receiver'; export {futureDeliveryBlockers} from './src/ringcentral/policy'; export {scope,message,instant,summary} from './test/fixtures/ringcentral';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, OfflineRingCentralReceiver, SupabaseRingCentralRepository, futureDeliveryBlockers, scope, message, instant, summary } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create(); const originalFetch = globalThis.fetch;
  let networkAttempts = 0, aiAttempts = 0, queue = Promise.resolve();
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    globalThis.fetch = async () => { networkAttempts++; throw new Error('External services forbidden'); };
    class LocalRepository extends SupabaseRingCentralRepository {
      rpc(name, parameters) {
        assert.ok(['figa_rc_observe', 'figa_rc_delivery_snapshot'].includes(name));
        const operation = queue.then(async () => {
          const values = Object.values(parameters).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v);
          await db.exec('set role service_role');
          try { return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result; }
          finally { await db.exec('reset role'); }
        });
        queue = operation.catch(() => {}); return operation;
      }
    }
    const repository = new LocalRepository({}), receiver = new OfflineRingCentralReceiver(scope, repository);
    const inbound = (id, text = 'Fictional provider inquiry', customer = '+15035550110', business) => receiver.receive({ syntheticData: true, event: instant(message(id, 'Inbound', text, customer, business), 'event-' + id) });
    const outbound = (id, text = 'Fictional outbound observation', customer = '+15035550110') => receiver.receive({ syntheticData: true, event: summary('event-' + id), messageStoreRecords: [message(id, 'Outbound', text, customer)] });
    const count = async table => (await db.query(`select count(*)::integer as n from public.${table}`)).rows[0].n;
    let conversation, fixtureNotificationCount = 0;
    await t.test('all receive tables and RPCs deny public access and direct service writes', async () => {
      for (const table of ['rc_threads', 'rc_observations', 'rc_receipts', 'rc_origins', 'rc_optouts']) {
        assert.equal((await db.query('select relrowsecurity as enabled from pg_class where oid=$1::regclass', ['public.' + table])).rows[0].enabled, true);
        for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await db.query("select has_table_privilege($1,$2,'INSERT') as allowed", [role, 'public.' + table])).rows[0].allowed, false);
      }
      for (const role of ['anon', 'authenticated']) assert.equal((await db.query("select has_function_privilege($1,'public.figa_rc_observe(text,text,jsonb)','EXECUTE') as allowed", [role])).rows[0].allowed, false);
    });
    await t.test('direct SQL cannot relabel non-fixture phone numbers, text, IDs or recordings as synthetic', async () => {
      const safe = { accountId: scope.accountId, extensionId: scope.extensionId, id: '399990', businessNumber: scope.businessNumbers[0], customerNumber: '+15035550190', direction: 'Inbound', text: 'Fictional provider inquiry', messageStatus: 'Received', modifiedAt: '2026-11-15T12:00:00Z', optOut: false };
      const before = [await count('contacts'), await count('conversations'), await count('rc_observations')];
      for (const patch of [{ customerNumber: '+15035550210' }, { text: 'Unapproved customer material' }, { accountId: '999001' }, { id: '9876543210' }, { attachments: [{ type: 'AudioRecording' }] }, { is_synthetic: true }]) {
        await assert.rejects(db.query('select public.figa_rc_observe($1,$2,$3)', ['non-fixture-' + Object.keys(patch)[0], 'a'.repeat(64), JSON.stringify([{ ...safe, ...patch }])]), /Authored fictional fixtures/);
      }
      assert.deepEqual([await count('contacts'), await count('conversations'), await count('rc_observations')], before);
    });
    await t.test('HTTP fixture intake maps a customer without invoking AI or messaging', async () => {
      const app = createWorker(undefined, receiver);
      const response = await app.fetch(new Request('http://localhost/ringcentral/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ syntheticData: true, event: instant() }) }), { RINGCENTRAL_OFFLINE_ENABLED: 'true', AI: { run: async () => { aiAttempts++; throw new Error('AI forbidden'); } } });
      assert.equal(response.status, 200); const result = await response.json();
      conversation = result.observations[0].conversationId;
      assert.equal(result.observations[0].actor, 'customer');
      assert.equal(await count('rc_observations'), 1); assert.equal(await count('messages'), 0);
    });
    await t.test('duplicate envelope and same message under a new event create no duplicate data', async () => {
      assert.equal((await receiver.receive({ syntheticData: true, event: instant() })).kind, 'duplicate');
      const repeated = await receiver.receive({ syntheticData: true, event: instant(message(), 'redelivery-new-uuid') });
      assert.equal(repeated.observations[0].conversationId, conversation); assert.equal(await count('rc_observations'), 1);
      const conflicting = await receiver.receive({ syntheticData: true, event: instant(message('300001', 'Inbound', 'Changed fictional content'), 'conflicting-event') });
      assert.equal(conflicting.kind, 'conflict'); assert.equal(await count('rc_observations'), 1);
    });
    await t.test('unknown outbound is quarantined rather than guessed to be a staff reply', async () => {
      const result = await outbound('300002');
      assert.equal(result.observations[0].actor, 'unknown'); assert.equal(result.observations[0].reviewHold, true);
      assert.equal((await repository.deliverySnapshot(conversation)).conversation.mode, 'AI');
      assert.equal(await count('staff_assignments'), 0);
    });
    await t.test('only trusted chatbot message IDs establish chatbot origin', async () => {
      await db.query("insert into public.rc_origins(account_id,extension_id,message_id,actor) values($1,$2,'300003','chatbot')", [scope.accountId, scope.extensionId]);
      const result = await outbound('300003', 'Fictional chatbot observation', '+15035550111');
      assert.equal(result.observations[0].actor, 'chatbot'); assert.equal(result.observations[0].reviewHold, false);
      const spoofed = message('300004', 'Outbound', 'Fictional claimed staff reply', '+15035550112');
      spoofed.from.name = 'FIGA Staff'; spoofed.staffUserId = randomUUID(); spoofed.actor = 'staff';
      const unknown = await receiver.receive({ syntheticData: true, event: summary('spoofed-origin'), messageStoreRecords: [spoofed] });
      assert.equal(unknown.observations[0].actor, 'unknown');
    });
    await t.test('verified staff origin requests a hold without replacing Telegram ownership or reopening status', async () => {
      const owner = randomUUID(), other = randomUUID();
      await db.query('insert into auth.users(id) values($1),($2)', [owner, other]);
      await db.query("insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,90001,90001,true,array['view','takeover'],now(),$1)", [other]);
      await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)', [conversation, owner]);
      await db.query("update public.conversations set mode='HUMAN',status='closed' where id=$1", [conversation]);
      fixtureNotificationCount = await count('telegram_notifications');
      await db.query("insert into public.rc_origins(account_id,extension_id,message_id,actor,staff_user_id) values($1,$2,'300005','staff',$3)", [scope.accountId, scope.extensionId, other]);
      const result = await outbound('300005'); assert.equal(result.observations[0].actor, 'staff'); assert.equal(result.observations[0].reviewHold, true);
      assert.equal(await count('telegram_notifications'), fixtureNotificationCount);
      assert.deepEqual((await db.query('select mode,status from public.conversations where id=$1', [conversation])).rows[0], { mode: 'HUMAN', status: 'closed' });
      assert.equal((await db.query('select staff_user_id from public.staff_assignments where conversation_id=$1 and released_at is null', [conversation])).rows[0].staff_user_id, owner);
      const fresh = await repository.deliverySnapshot(conversation);
      assert.ok(futureDeliveryBlockers(fresh, {}, fresh.conversation.revision).includes('staff_control'));
      await db.query('update public.staff_roster set active=false where staff_user_id=$1', [other]);
      await db.query("insert into public.rc_origins(account_id,extension_id,message_id,actor,staff_user_id) values($1,$2,'300006','staff',$3)", [scope.accountId, scope.extensionId, other]);
      assert.equal((await outbound('300006')).observations[0].actor, 'unknown');
    });
    await t.test('STOP persists across later messages and START does not silently restore consent', async () => {
      const stopped = await inbound('300007', 'STOP'); assert.equal(stopped.observations[0].optOut, true);
      const later = await inbound('300008', 'START'); assert.equal(later.observations[0].optOut, true);
      assert.equal((await repository.deliverySnapshot(conversation)).optedOut, true);
      const otherLine = await inbound('300009', 'Fictional inquiry on another business line', '+15035550110', scope.businessNumbers[1]);
      assert.notEqual(otherLine.observations[0].conversationId, conversation); assert.equal(otherLine.observations[0].optOut, false);
    });
    await t.test('STOP remains effective when the same business number uses another extension', async () => {
      const otherScope = { ...scope, extensionId: '200002' };
      const event = instant(message('300010'), 'other-extension'); event.ownerId = otherScope.extensionId;
      event.event = event.event.replace('200001', '200002');
      const result = await new OfflineRingCentralReceiver(otherScope, repository).receive({ syntheticData: true, event });
      assert.equal(result.observations[0].optOut, true);
    });
    await t.test('parallel fictional customers map separately; retries map consistently', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => inbound(String(301000 + i), 'Fictional independent inquiry', '+150355501' + (20 + i))));
      assert.equal(new Set(results.map(r => r.observations[0].conversationId)).size, 8);
      const retry = await inbound('301000', 'Fictional independent inquiry', '+15035550120'); assert.equal(retry.kind, 'duplicate');
    });
    await t.test('status updates do not duplicate observations; stale updates cannot regress status', async () => {
      const updated = { ...message('300003', 'Outbound', 'Fictional chatbot observation', '+15035550111'), messageStatus: 'Delivered', lastModifiedTime: '2026-11-15T12:02:00.000Z' };
      const before = await count('rc_observations');
      await receiver.receive({ syntheticData: true, event: summary('status-update'), messageStoreRecords: [updated] });
      await receiver.receive({ syntheticData: true, event: summary('stale-status'), messageStoreRecords: [message('300003', 'Outbound', 'Fictional chatbot observation', '+15035550111')] });
      assert.equal(await count('rc_observations'), before);
      assert.equal((await db.query("select message_status from public.rc_observations where message_id='300003'")).rows[0].message_status, 'Delivered');
    });
    await t.test('rejected batches leave no partial conversations or observations', async () => {
      const before = [await count('conversations'), await count('rc_observations')];
      await assert.rejects(receiver.receive({ syntheticData: true, event: summary('bad-batch'), messageStoreRecords: [message('399001'), { ...message('399002'), subject: undefined }] }));
      const normalized = { accountId: scope.accountId, extensionId: scope.extensionId, id: '399003', businessNumber: scope.businessNumbers[0], customerNumber: '+15035550190', direction: 'Inbound', text: 'Fictional direct RPC invalid batch', messageStatus: 'Received', modifiedAt: '2026-11-15T12:00:00Z', optOut: false };
      await assert.rejects(repository.observe('bad-rpc-batch', 'a'.repeat(64), [normalized, { ...normalized, id: '399004', customerNumber: 'bad-number' }]));
      assert.deepEqual([await count('conversations'), await count('rc_observations')], before);
    });
    await t.test('STOP invalidates a pending AI turn through the existing revision fence', async () => {
      const created = await inbound('390001', 'Fictional staffing inquiry', '+15035550195');
      const id = created.observations[0].conversationId, token = 'a'.repeat(64), messageId = randomUUID();
      // Grant temporary access only to this local fixture to exercise the existing
      // begin/finish RPCs; the receive-only mapping never issues browser access.
      await db.query("update public.conversations set access_token_hash=$2,access_expires_at=now()+interval '1 hour' where id=$1", [id, token]);
      const started = (await db.query('select public.figa_begin_turn($1,$2,$3,$4,$5) as result', [id, token, messageId, 'Fictional pending customer turn', 'b'.repeat(64)])).rows[0].result;
      assert.equal(started.kind, 'ready');
      await inbound('390002', 'STOP', '+15035550195');
      const proposed = { assistantResponse: 'Fictional reply that must be suppressed.', engine: { requested: 'ai', used: 'workers-ai' } };
      const finished = (await db.query('select public.figa_finish_turn($1,$2,$3,$4,$5,$6) as result', [id, token, messageId, started.leaseToken, started.conversation.revision, JSON.stringify(proposed)])).rows[0].result;
      assert.equal(finished.assistantResponse, ''); assert.equal(finished.engine.used, 'none');
      assert.equal((await repository.deliverySnapshot(id)).optedOut, true);
      assert.equal((await db.query('select mode from public.conversations where id=$1', [id])).rows[0].mode, 'AI');
      assert.equal((await db.query("select count(*)::integer as n from public.messages where direction='outbound'")).rows[0].n, 0);
    });
    assert.equal(networkAttempts, 0); assert.equal(aiAttempts, 0); assert.equal(await count('messages'), 1); // one explicit local begin-turn fixture
    // Pre-existing alerts are unchanged; the STOP opt-out additionally raises exactly one 'review' staff alert.
    assert.equal(Number((await db.query("select count(*) from public.telegram_notifications where kind<>'review'")).rows[0].count), fixtureNotificationCount);
    assert.equal(Number((await db.query("select count(*) from public.telegram_notifications where kind='review'")).rows[0].count), 1);
    console.log(JSON.stringify({ scope: 'offline_receive_only', networkAttempts, aiAttempts, outboundDeliveries: 0, publicChatMessagesCreated: 0 }));
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
