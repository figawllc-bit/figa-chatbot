import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('timeout fallback persists history once; late results cannot overwrite corrections or staff controls', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/timeout-history-tests.mjs');
  await build({ stdin: { contents: `export {createWorker} from './src/index'; export {SupabaseRepository} from './src/database/supabase';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, SupabaseRepository } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create();
  const originalFetch = globalThis.fetch, originalInfo = console.info;
  let externalAttempts = 0, calls = 0, nextCall, entered;
  const first = "Hi, I'm Sam Example. I'm looking for a CNA job in Portland, Oregon.";
  const second = "I have three years of experience. I'm available Monday through Friday and prefer evening shifts.";
  const proposal = (values, evidence = '') => ({ intent: 'caregiver', intentEvidence: evidence, ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: Object.entries(values).map(([field, quote]) => ({ field, quote })) });
  const initial = proposal({ name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon' }, 'looking for a CNA job');
  const followup = proposal({ experience: 'three years of experience', availability: 'Monday through Friday', shift: 'evening' });
  const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    globalThis.fetch = async () => { externalAttempts++; throw new Error('External services forbidden'); };
    console.info = () => {};
    class LocalRepository extends SupabaseRepository {
      async rpc(name, parameters) {
        assert.ok(['figa_create_conversation', 'figa_restore_conversation', 'figa_begin_turn', 'figa_finish_turn'].includes(name));
        const values = Object.values(parameters).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v);
        await db.exec('set role service_role');
        try { return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result; }
        finally { await db.exec('reset role'); }
      }
    }
    const app = createWorker(new LocalRepository({}));
    const env = { SUPABASE_ENABLED: 'true', SUPABASE_ISOLATED_DEV_CONFIRMED: 'true', SUPABASE_PROJECT_REF: 'figadevtest', SUPABASE_URL: 'https://figadevtest.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_inert_fixture',
      AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true', AI_TIMEOUT_MS: '15000',
      AI: { run: async (_model, input, options) => { calls++; assert.equal(options.rejectIfBusy, true); entered?.resolve(); return nextCall(input); } } };
    const request = (path, cookie, body) => app.fetch(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    async function create() {
      const response = await request('/conversations', null, { syntheticData: true }); assert.equal(response.status, 201);
      return { id: (await response.json()).id, cookie: response.headers.get('Set-Cookie').split(';')[0] };
    }
    async function send(fixture, message, messageId = randomUUID()) {
      const response = await request('/chat', fixture.cookie, { message, messageId, conversationId: fixture.id, engine: 'ai', syntheticData: true });
      assert.equal(response.status, 200); return response.json();
    }
    const restore = async fixture => (await request('/conversations/' + fixture.id, fixture.cookie)).json();
    const count = async (id, direction) => (await db.query('select count(*)::integer as n from public.messages where conversation_id=$1 and direction=$2', [id, direction])).rows[0].n;
    const delayed = value => {
      entered = Promise.withResolvers();
      const settled = Promise.withResolvers();
      nextCall = () => new Promise(resolve => setTimeout(() => { resolve(completion(value)); settled.resolve(); }, 20000));
      return settled.promise;
    };
    const fixture = await create();
    nextCall = async () => completion(initial);
    const firstResult = await send(fixture, first); assert.equal(firstResult.engine.used, 'workers-ai');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const late = delayed(followup), id = randomUUID();
    const pending = send(fixture, second, id); await entered.promise;
    t.mock.timers.tick(15001);
    const fallback = await pending;
    assert.equal(fallback.engine.used, 'deterministic'); assert.equal(fallback.state.control, 'active');
    assert.deepEqual(fallback.state.history, [first, second]); assert.equal(fallback.complete, true);
    assert.equal(fallback.collectedInformation.availability, 'Monday through Friday');
    assert.equal((await restore(fixture)).state.collected.name, 'Sam Example');
    assert.equal(await count(fixture.id, 'outbound'), 2);
    const callsBefore = calls, inboundBefore = await count(fixture.id, 'inbound');
    assert.deepEqual(await send(fixture, second, id), fallback);
    assert.equal(calls, callsBefore); assert.equal(await count(fixture.id, 'inbound'), inboundBefore);
    assert.equal(await count(fixture.id, 'outbound'), 2);
    const correction = 'Actually, I can work weekends.';
    nextCall = async input => {
      const context = JSON.parse(input.messages[1].content).context;
      assert.deepEqual(context.history, [first, second]); assert.deepEqual(context.collected, fallback.collectedInformation);
      return completion(proposal({ availability: 'weekends' }));
    };
    const corrected = await send(fixture, correction); assert.equal(corrected.engine.used, 'workers-ai');
    assert.equal(corrected.collectedInformation.availability, 'weekends');
    assert.deepEqual(corrected.state.history, [first, second, correction]);
    t.mock.timers.tick(5000); await late; await Promise.resolve();
    assert.deepEqual((await restore(fixture)).state.collected, corrected.collectedInformation);
    assert.deepEqual((await restore(fixture)).state.history, [first, second, correction]);
    assert.equal(await count(fixture.id, 'outbound'), 3);
    assert.deepEqual((await db.query('select mode,status from public.conversations where id=$1', [fixture.id])).rows[0], { mode: 'AI', status: 'open' });
    assert.equal((await db.query('select count(*)::integer as n from public.staff_assignments where conversation_id=$1', [fixture.id])).rows[0].n, 0);
    // Authoritative SQL controls must suppress even the fallback produced after
    // takeover/closure/blocking while the model call is still pending.
    for (const control of ['HUMAN', 'closed', 'blocked']) {
      const controlled = await create();
      const lateControlled = delayed(initial);
      const pendingControlled = send(controlled, first); await entered.promise;
      let owner;
      if (control === 'HUMAN') {
        owner = randomUUID(); await db.query('insert into auth.users(id) values($1)', [owner]);
        await db.query("update public.conversations set mode='HUMAN',revision=revision+1 where id=$1", [controlled.id]);
        await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)', [controlled.id, owner]);
      } else await db.query('update public.conversations set status=$2,revision=revision+1 where id=$1', [controlled.id, control]);
      t.mock.timers.tick(15001);
      const suppressed = await pendingControlled;
      assert.equal(suppressed.engine.used, 'none'); assert.equal(suppressed.assistantResponse, '');
      assert.equal(await count(controlled.id, 'outbound'), 0);
      const saved = await restore(controlled);
      t.mock.timers.tick(5000); await lateControlled; await Promise.resolve();
      assert.deepEqual(await restore(controlled), saved); assert.equal(await count(controlled.id, 'outbound'), 0);
      if (owner) assert.deepEqual((await db.query('select staff_user_id,released_at from public.staff_assignments where conversation_id=$1', [controlled.id])).rows[0], { staff_user_id: owner, released_at: null });
      const beforeCalls = calls; await send(controlled, first); assert.equal(calls, beforeCalls);
    }
    assert.equal(externalAttempts, 0);
    console.log(JSON.stringify({ scope: 'offline_only', mockDelayMs: 20000, applicationDeadlineMs: 15000, historyPersisted: true, retryDuplicatedMessages: false, lateOverwrite: false, takeoverClosedBlockedProtected: true, externalAttempts, realInferenceCalls: 0 }));
  } finally { t.mock.timers.reset(); globalThis.fetch = originalFetch; console.info = originalInfo; await db.close(); }
});
