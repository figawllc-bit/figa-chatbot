import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Phase 6 persists home type and job preferences, restores memory, and suppresses closed replies', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const outfile = resolve('.wrangler/phase6-persistence-tests.mjs');
  await build({ stdin: { contents: `export {createWorker} from './src/index'; export {SupabaseRepository} from './src/database/supabase';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
  const { createWorker, SupabaseRepository } = await import(pathToFileURL(outfile).href);
  const db = await PGlite.create();
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0, inferenceAttempts = 0;
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    globalThis.fetch = async () => { networkAttempts++; throw new Error('External network forbidden'); };
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
      AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true', AI: { run: async () => { inferenceAttempts++; throw new Error('No live inference'); } } };
    const request = (path, cookie, body) => app.fetch(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    for (const type of ['provider', 'caregiver']) {
      const created = await request('/conversations', null, { syntheticData: true });
      assert.equal(created.status, 201);
      const cookie = created.headers.get('Set-Cookie').split(';')[0];
      const { id } = await created.json();
      const messages = type === 'provider'
        ? ['I need two caregivers tomorrow night in Salem, OR.', 'My name is Alex Example.', 'Group home']
        : ['I am looking for a CNA job in Salem, OR.', 'My name is Sam Example.', 'Available weekends.', 'Night shift', 'Two years of caregiving experience.'];
      let result;
      for (const message of messages) {
        const response = await request('/chat', cookie, { message, conversationId: id, messageId: randomUUID(), syntheticData: true });
        assert.equal(response.status, 200); result = await response.json();
        assert.equal(result.persistence.saved, true);
      }
      assert.equal(result.complete, true);
      const restored = await (await request('/conversations/' + id, cookie)).json();
      assert.deepEqual(restored.state.collected, result.collectedInformation);
      if (type === 'provider') {
        assert.equal(restored.state.collected.homeType, 'Group home');
        const row = (await db.query('select * from public.provider_requests where conversation_id=$1', [id])).rows[0];
        assert.equal(row.caregiver_count, 2); assert.equal(row.city, 'Salem');
      } else {
        const row = (await db.query('select * from public.caregiver_leads where conversation_id=$1', [id])).rows[0];
        assert.equal(row.availability, 'weekends'); assert.equal(row.preferred_shift, 'Night shift');
        assert.equal(row.experience, 'Two years of caregiving experience');
      }
      const outboundBefore = restored.messages.filter(m => m.direction === 'outbound').length;
      // Only this ephemeral local fixture is marked closed; no Resolve action.
      await db.query("update public.conversations set status='closed' where id=$1", [id]);
      const closedResponse = await request('/chat', cookie, { message: 'Fictional follow-up: need four caregivers.', engine: 'ai', conversationId: id, messageId: randomUUID(), syntheticData: true });
      assert.equal(closedResponse.status, 200);
      const closed = await closedResponse.json();
      assert.equal(closed.engine.used, 'none'); assert.equal(closed.assistantResponse, '');
      assert.equal(closed.humanAttentionNeeded, true);
      const after = await (await request('/conversations/' + id, cookie)).json();
      assert.equal(after.messages.filter(m => m.direction === 'outbound').length, outboundBefore);
      assert.equal(after.status, 'closed');
    }
    assert.equal(networkAttempts, 0); assert.equal(inferenceAttempts, 0);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
