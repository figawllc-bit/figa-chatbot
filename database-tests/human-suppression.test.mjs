import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// OFFLINE REPLICA ONLY. The remote summary was observed read-only at revision 2.
// Neither the original access cookie nor contact ID is available. All credentials,
// contact/owner IDs and transcript data below are fresh fictional local fixtures.
// This test never loads .dev.vars or contacts the persisted Supabase conversation.
test('HUMAN suppresses engines and outbound storage through HTTP and real SQL', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/human-suppression-tests.mjs');
  await build({ stdin: { contents: `
    export {createWorker} from './src/index';
    export {SupabaseRepository} from './src/database/supabase';
    export {HybridEngine} from './src/ai/engine';
    export {DeterministicEngine} from './src/engine';
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node',
    format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, SupabaseRepository, HybridEngine, DeterministicEngine } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create();
  const originalFetch = globalThis.fetch;
  const originalHybrid = HybridEngine.prototype.respond;
  const originalDeterministic = DeterministicEngine.prototype.respond;
  let networkAttempts = 0, inferenceAttempts = 0, engineAttempts = 0, finishAttempts = 0;
  const calls = [];
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const file of ['20261112000100_figa_schema.sql', '20261112000200_figa_transactions.sql',
      '20261113000100_staff_telegram.sql', '20261114000100_notification_preview.sql', '20261114000200_staff_controls.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    const id = '6e4b795e-75dc-4d13-bcd4-4eb1f51cc2b6';
    const contact = randomUUID(), owner = randomUUID();
    const token = 'd'.repeat(64);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const state = { version: 1, type: 'provider', collected: { city: 'Salem', count: '3',
      shift: 'night shift', state: 'Oregon', position: 'caregiver' }, awaiting: 'date', humanAttentionReasons: [] };
    await db.query('insert into auth.users(id) values($1)', [owner]);
    await db.query('insert into public.contacts(id) values($1)', [contact]);
    await db.query(`insert into public.conversations(id,contact_id,access_token_hash,mode,status,revision,classification,state,human_attention_needed)
      values($1,$2,$3,'HUMAN','open',2,'provider',$4,true)`, [id, contact, tokenHash, JSON.stringify(state)]);
    await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)', [id, owner]);
    const assignmentBefore = (await db.query('select * from public.staff_assignments where conversation_id=$1', [id])).rows;
    globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden'); };
    const forbiddenEngine = async () => { engineAttempts++; throw new Error('Engine forbidden in HUMAN'); };
    HybridEngine.prototype.respond = forbiddenEngine;
    DeterministicEngine.prototype.respond = forbiddenEngine;
    class LocalRepository extends SupabaseRepository {
      async rpc(name, parameters) {
        assert.ok(['figa_begin_turn', 'figa_restore_conversation'].includes(name), 'Only begin/restore permitted');
        calls.push(name);
        const values = Object.values(parameters);
        await db.exec('set role service_role');
        try {
          return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result;
        } finally { await db.exec('reset role'); }
      }
      async finish() { finishAttempts++; throw new Error('Controlled begin must not finish a lease'); }
    }
    const app = createWorker(new LocalRepository({}));
    // Inert per-test environment: AI appears available, but run() is a tripwire.
    // No application feature flags or local secret files are changed.
    const env = { SUPABASE_ENABLED: 'true', SUPABASE_ISOLATED_DEV_CONFIRMED: 'true',
      SUPABASE_PROJECT_REF: 'figadevtest', SUPABASE_URL: 'https://figadevtest.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_inert_test_fixture', CONVERSATION_CONTROL: 'active',
      AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true',
      AI_FREE_TIER_CONFIRMED: 'true', AI: { run: async () => { inferenceAttempts++; throw new Error('Inference forbidden'); } } };
    const body = { conversationId: id, messageId: randomUUID(), engine: 'ai', syntheticData: true,
      message: 'Fictional development follow-up: make that four caregivers in Portland tomorrow morning.',
      state: { ...state, control: 'active' } };
    const send = cookie => app.fetch(new Request('http://localhost/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }), env);
    assert.equal((await send()).status, 404);
    assert.deepEqual(calls, []);
    assert.equal((await send('figa_conversation_access=' + 'e'.repeat(64))).status, 404);
    const response = await send('figa_conversation_access=' + token);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.engine.used, 'none');
    assert.equal(result.engine.reason, 'conversation_control');
    assert.equal(result.assistantResponse, '');
    assert.equal(result.humanAttentionNeeded, true);
    assert.equal(result.state.control, 'human_takeover');
    assert.deepEqual(result.collectedInformation, state.collected);
    assert.deepEqual(result.persistence, { conversationId: id, messageId: body.messageId, revision: 3, saved: true });
    const duplicate = await send('figa_conversation_access=' + token);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), result);
    const messages = (await db.query('select * from public.messages where conversation_id=$1', [id])).rows;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].direction, 'inbound');
    assert.equal(messages[0].content, body.message);
    assert.equal(messages[0].response.assistantResponse, '');
    assert.equal(messages[0].response.engine.used, 'none');
    const conversation = (await db.query('select * from public.conversations where id=$1', [id])).rows[0];
    assert.equal(conversation.mode, 'HUMAN');
    assert.equal(conversation.status, 'open');
    assert.equal(conversation.revision, 3);
    assert.equal(conversation.contact_id, contact);
    assert.equal(conversation.pending_message_id, null);
    assert.deepEqual((await db.query('select * from public.staff_assignments where conversation_id=$1', [id])).rows, assignmentBefore);
    const events = (await db.query('select event_type from public.conversation_events where conversation_id=$1 order by event_type', [id])).rows;
    assert.deepEqual(events.map(e => e.event_type), ['reply_suppressed', 'turn_received']);
    assert.equal((await db.query('select count(*)::integer as n from public.telegram_notifications')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::integer as n from public.telegram_deliveries')).rows[0].n, 0);
    assert.equal(engineAttempts, 0); assert.equal(inferenceAttempts, 0);
    assert.equal(networkAttempts, 0); assert.equal(finishAttempts, 0);
    console.log(JSON.stringify({ scope: 'offline_replica_only', remoteFollowUpVerified: false,
      httpStatus: response.status, engine: result.engine, assistantResponse: result.assistantResponse,
      humanAttentionNeeded: result.humanAttentionNeeded, control: result.state.control,
      inboundMessages: messages.length, outboundMessages: 0, engineAttempts, inferenceAttempts,
      networkAttempts, finishAttempts, duplicateCreatedExtraRows: false, ownershipPreserved: true,
      localRevision: conversation.revision, suppressionPassed: true }));
  } finally {
    globalThis.fetch = originalFetch;
    HybridEngine.prototype.respond = originalHybrid;
    DeterministicEngine.prototype.respond = originalDeterministic;
    await db.close();
  }
});
