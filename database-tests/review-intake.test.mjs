import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('replays captured review intake into local SQL, normalizes counts and preserves idempotency/ownership', async () => {
  const captured = JSON.parse(await readFile(new URL('../test/fixtures/gemma-provider-review.json', import.meta.url), 'utf8'));
  // Verify the checked-in replay against the original ledger when available.
  let capturedLiveJSONMatched = false;
  try {
    const ledger = JSON.parse(await readFile(new URL('../.wrangler/phase6-ai-only/one-provider-ledger.json', import.meta.url), 'utf8'));
    assert.deepEqual(captured.extraction, ledger.results[0].extraction);
    assert.equal(captured.message, ledger.results[0].input);
    capturedLiveJSONMatched = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/review-intake-tests.mjs');
  await build({ stdin: { contents: `export {createWorker} from './src/index'; export {SupabaseRepository} from './src/database/supabase';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, SupabaseRepository } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create();
  const originalFetch = globalThis.fetch;
  let externalAttempts = 0, mockedCalls = 0, proposal;
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
      AI: { run: async () => { mockedCalls++; return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }] }; } } };
    const request = (path, cookie, body) => app.fetch(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    const count = async (table, id) => (await db.query(`select count(*)::integer as n from public.${table} where conversation_id=$1`, [id])).rows[0].n;
    async function create() {
      const r = await request('/conversations', null, { syntheticData: true }); assert.equal(r.status, 201);
      return { id: (await r.json()).id, cookie: r.headers.get('Set-Cookie').split(';')[0] };
    }
    const caregiverMessage = 'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.';
    for (const type of ['provider', 'caregiver']) {
      const { id, cookie } = await create();
      proposal = type === 'provider' ? captured.extraction : {
        intent: 'caregiver', intentEvidence: 'I am seeking a CNA job', ambiguous: false, needsHumanReview: true, faqIndex: -1,
        updates: [{ field: 'name', quote: 'Sam Example' }, { field: 'city', quote: 'Portland' }, { field: 'state', quote: 'Oregon' }, { field: 'position', quote: 'CNA' }, { field: 'experience', quote: 'three years of caregiving experience' }, { field: 'availability', quote: 'Monday through Friday' }, { field: 'shift', quote: 'evening shifts' }],
      };
      const body = { message: type === 'provider' ? captured.message : caregiverMessage, engine: 'ai', syntheticData: true, conversationId: id, messageId: randomUUID() };
      const response = await request('/chat', cookie, body); assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.engine.used, 'workers-ai'); assert.equal(result.persistence.saved, true);
      assert.equal(result.humanAttentionNeeded, true); assert.equal(result.complete, true);
      assert.equal(result.state.control, 'active');
      const row = (await db.query('select mode,status from public.conversations where id=$1', [id])).rows[0];
      assert.deepEqual(row, { mode: 'AI', status: 'open' });
      assert.equal(await count('staff_assignments', id), 0);
      const restored = await (await request('/conversations/' + id, cookie)).json();
      assert.deepEqual(restored.state.collected, result.collectedInformation);
      if (type === 'provider') {
        assert.deepEqual(result.collectedInformation, { name: 'Alex Example', homeType: 'group home', city: 'Salem', state: 'Oregon', count: '3', position: 'caregivers', shift: 'night shift', date: 'tonight' });
        const provider = (await db.query('select caregiver_count,city,state,shift,requested_date_text from public.provider_requests where conversation_id=$1', [id])).rows[0];
        assert.equal(provider.caregiver_count, 3); assert.equal(typeof provider.caregiver_count, 'number');
        assert.equal(provider.city, 'Salem'); assert.equal(provider.state, 'Oregon');
        assert.equal(provider.shift, 'night shift'); assert.equal(provider.requested_date_text, 'tonight');
      } else {
        const caregiver = (await db.query('select availability,preferred_shift,experience from public.caregiver_leads where conversation_id=$1', [id])).rows[0];
        assert.deepEqual(caregiver, { availability: 'Monday through Friday', preferred_shift: 'evening shifts', experience: 'three years of caregiving experience' });
      }
      const callsBefore = mockedCalls, messagesBefore = await count('messages', id), eventsBefore = await count('conversation_events', id);
      assert.deepEqual(await (await request('/chat', cookie, body)).json(), result);
      assert.equal(mockedCalls, callsBefore); assert.equal(await count('messages', id), messagesBefore); assert.equal(await count('conversation_events', id), eventsBefore);
      assert.equal(await count(type === 'provider' ? 'provider_requests' : 'caregiver_leads', id), 1);
      proposal = { ...proposal, intentEvidence: '', updates: type === 'provider' ? [{ field: 'count', quote: 'four' }, { field: 'city', quote: 'Portland' }] : [{ field: 'availability', quote: 'weekends' }] };
      const corrected = await (await request('/chat', cookie, { ...body, messageId: randomUUID(), message: type === 'provider' ? 'Actually, four caregivers in Portland instead.' : 'availability: weekends' })).json();
      assert.equal(corrected.collectedInformation.name, result.collectedInformation.name);
      assert.equal(corrected.collectedInformation[type === 'provider' ? 'count' : 'availability'], type === 'provider' ? '4' : 'weekends');
      assert.equal(await count(type === 'provider' ? 'provider_requests' : 'caregiver_leads', id), 1);
      // Control changes apply only to these new ephemeral local fixtures.
      await db.query(type === 'provider' ? "update public.conversations set mode='HUMAN' where id=$1" : "update public.conversations set status='closed' where id=$1", [id]);
      const outboundBefore = (await db.query("select count(*)::integer as n from public.messages where conversation_id=$1 and direction='outbound'", [id])).rows[0].n;
      const beforeControl = mockedCalls;
      const controlled = await (await request('/chat', cookie, { ...body, messageId: randomUUID() })).json();
      assert.equal(controlled.engine.used, 'none'); assert.equal(controlled.assistantResponse, ''); assert.equal(mockedCalls, beforeControl);
      assert.equal((await db.query("select count(*)::integer as n from public.messages where conversation_id=$1 and direction='outbound'", [id])).rows[0].n, outboundBefore);
    }
    // Active ownership remains authoritative even if the local mode column is AI.
    const owned = await create(), owner = randomUUID();
    await db.query('insert into auth.users(id) values($1)', [owner]);
    await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)', [owned.id, owner]);
    const callsBeforeOwned = mockedCalls;
    const ownedReply = await (await request('/chat', owned.cookie, { message: captured.message, engine: 'ai', syntheticData: true, conversationId: owned.id, messageId: randomUUID() })).json();
    assert.equal(ownedReply.engine.used, 'none'); assert.equal(ownedReply.assistantResponse, '');
    assert.equal(mockedCalls, callsBeforeOwned);
    assert.equal((await db.query('select released_at from public.staff_assignments where conversation_id=$1', [owned.id])).rows[0].released_at, null);
    assert.equal(externalAttempts, 0);
    console.log(JSON.stringify({ scope: 'offline_only', capturedLiveJSONMatched, providerCountInteger: 3, reviewIntakeRetained: true, ownershipUnchangedByReview: true, duplicateWrites: false, externalAttempts, realInferenceCalls: 0 }));
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
