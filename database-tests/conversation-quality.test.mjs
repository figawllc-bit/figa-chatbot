import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('20 fictional multi-turn conversations persist through actual SQL RPCs without external services', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/conversation-quality-tests.mjs');
  await build({ stdin: { contents: `export {createWorker} from './src/index'; export {SupabaseRepository} from './src/database/supabase'; export {conversationScenarios} from './test/fixtures/conversation-quality';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, SupabaseRepository, conversationScenarios } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create();
  const originalFetch = globalThis.fetch;
  let externalAttempts = 0, mockedCalls = 0, turnCount = 0, proposal, expectedContext;
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    globalThis.fetch = async () => { externalAttempts++; throw new Error('External services forbidden'); };
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
      AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true',
      AI: { run: async (_model, input) => {
        mockedCalls++; assert.ok(proposal, 'Unexpected model invocation');
        assert.deepEqual(JSON.parse(input.messages[1].content).context.collected, expectedContext);
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }] };
      } } };
    const request = (path, cookie, body) => app.fetch(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    const count = async (table, id) => (await db.query(`select count(*)::integer as n from public.${table} where conversation_id=$1`, [id])).rows[0].n;
    for (const scenario of conversationScenarios) {
      const created = await request('/conversations', null, { syntheticData: true }); assert.equal(created.status, 201);
      const id = (await created.json()).id, cookie = created.headers.get('Set-Cookie').split(';')[0];
      let prior = {}, lastBody, lastResult;
      for (const [index, turn] of scenario.turns.entries()) {
        proposal = turn.extraction; expectedContext = prior;
        const callsBefore = mockedCalls;
        const body = { message: turn.message, engine: 'ai', syntheticData: true, conversationId: id, messageId: randomUUID() };
        const response = await request('/chat', cookie, body); assert.equal(response.status, 200, scenario.id);
        const result = await response.json();
        assert.deepEqual(result.collectedInformation, turn.expected, `${scenario.id} turn ${index}`);
        assert.equal(result.conversationType, index === 0 ? 'unknown' : scenario.type);
        assert.equal(result.state.awaiting, turn.awaiting); assert.equal(result.complete, turn.complete ?? false);
        assert.equal(result.persistence.saved, true); assert.equal(result.state.control, 'active');
        assert.equal(mockedCalls - callsBefore, turn.extraction ? 1 : 0);
        if (turn.extraction?.needsHumanReview || turn.complete) assert.equal(result.humanAttentionNeeded, true);
        if (turn.urgent) assert.ok(result.humanAttentionReasons.includes('Urgent timing requires staff review.'));
        const restoredResponse = await request('/conversations/' + id, cookie); assert.equal(restoredResponse.status, 200);
        const restored = await restoredResponse.json(); assert.deepEqual(restored.state.collected, turn.expected);
        assert.deepEqual((await db.query('select mode,status from public.conversations where id=$1', [id])).rows[0], { mode: 'AI', status: 'open' });
        assert.equal(await count('staff_assignments', id), 0);
        prior = turn.expected; lastBody = body; lastResult = result; turnCount++;
      }
      const callsBefore = mockedCalls, messagesBefore = await count('messages', id), eventsBefore = await count('conversation_events', id);
      assert.deepEqual(await (await request('/chat', cookie, lastBody)).json(), lastResult);
      assert.equal(mockedCalls, callsBefore); assert.equal(await count('messages', id), messagesBefore); assert.equal(await count('conversation_events', id), eventsBefore);
      assert.equal(await count(scenario.type === 'provider' ? 'provider_requests' : 'caregiver_leads', id), 1);
      if (scenario.type === 'provider') {
        const row = (await db.query('select caregiver_count,city from public.provider_requests where conversation_id=$1', [id])).rows[0];
        assert.deepEqual(row, { caregiver_count: 4, city: 'Fictional Springs' });
      } else {
        const row = (await db.query('select availability,preferred_shift,experience from public.caregiver_leads where conversation_id=$1', [id])).rows[0];
        assert.deepEqual(row, { availability: 'weekends', preferred_shift: 'evening', experience: 'three years of caregiving experience' });
      }
      // Only ephemeral local fixtures are controlled here; remote records are inaccessible.
      await db.query(scenario.type === 'provider' ? "update public.conversations set mode='HUMAN' where id=$1" : "update public.conversations set status='closed' where id=$1", [id]);
      const outbound = async () => (await db.query("select count(*)::integer as n from public.messages where conversation_id=$1 and direction='outbound'", [id])).rows[0].n;
      const before = await outbound(); proposal = undefined;
      const controlled = await (await request('/chat', cookie, { ...lastBody, messageId: randomUUID(), message: 'Please update my request.' })).json();
      assert.equal(controlled.engine.used, 'none'); assert.equal(controlled.assistantResponse, '');
      assert.equal(mockedCalls, callsBefore); assert.equal(await outbound(), before);
    }
    assert.equal(externalAttempts, 0); assert.equal(turnCount, 180);
    console.log(JSON.stringify({ providerConversations: 10, caregiverConversations: 10, persistedTurns: turnCount, mockedCalls, realInferenceCalls: 0, externalAttempts, duplicateWrites: false }));
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
