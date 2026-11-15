// Production deployment profile, offline. Uses FICTIONAL but production-shaped data
// (NANPA 555-01xx numbers outside the development fixture range); nothing real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const outfile = resolve('.wrangler/production-profile-offline.mjs');
await build({ stdin: { contents: `export {SmsWorkflow,SmsWorkflowRepository,SyntheticSmsWorkflow,productionSmsRepository} from './src/ringcentral/sms-workflow'; export {HybridEngine} from './src/ai/engine'; export {productionDatabaseConfiguration} from './src/database/config';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
const app = await import(pathToFileURL(outfile).href);

const ACCOUNT = '400123456', OWNER = '3322425015', BUSINESS = '+15415550100';
async function database() {
  const db = await PGlite.create();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for (const f of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8'));
  return db;
}
const configure = db => db.query(`update public.figa_deployment set kind='production',rc_account_id=$1,rc_extension_ids=array[$2],rc_business_numbers=array[$3]`, [ACCOUNT, OWNER, BUSINESS]);
const realMessage = (id, text, customer = '+15415550123', direction = 'Inbound') => ({ id, accountId: ACCOUNT, extensionId: OWNER, businessNumber: BUSINESS, customerNumber: customer,
  direction, text, messageStatus: direction === 'Inbound' ? 'Received' : 'Sent', modifiedAt: '2026-11-16T17:00:00.000Z', optOut: false });

test('deployment profile guard: development refuses real rows; switching is one-way and only while empty', async () => {
  const db = await PGlite.create(); await db.close();
  const dev = await database();
  try {
    assert.equal((await dev.query('select kind from public.figa_deployment')).rows[0].kind, 'development');
    // A production-shaped message is rejected by the development database itself.
    await assert.rejects(dev.query('select public.figa_rc_observe($1,$2,$3)', ['e1', 'a'.repeat(64), JSON.stringify([realMessage('9000000001', 'Hello')])]));
    // Production with fixture identifiers is refused.
    await assert.rejects(dev.query(`update public.figa_deployment set kind='production'`), /real RingCentral identifiers/);
    await assert.rejects(dev.query('insert into public.figa_deployment(singleton) values(true)'));
    await assert.rejects(dev.query('delete from public.figa_deployment'));
    // Once a development conversation exists, the profile can never change.
    await dev.query("select public.figa_create_conversation($1)", ['b'.repeat(64)]);
    await assert.rejects(configure(dev), /fixed once conversations exist/);
  } finally { await dev.close(); }
  const prod = await database();
  try {
    await configure(prod);
    await assert.rejects(prod.query(`update public.figa_deployment set kind='development'`), /cannot become development/);
  } finally { await prod.close(); }
});

test('production profile: real-shaped SMS -> Gemma (only when approved) -> customer-ready reply; fixtures, sensitive text, staff alerts', async t => {
  const db = await database(); const originalFetch = globalThis.fetch; let network = 0, models = 0, queue = Promise.resolve(), seq = 0;
  globalThis.fetch = async () => { network++; throw Error('external network prohibited'); };
  try {
    await configure(db);
    await db.query("update public.figa_bot_mode set mode='away'");
    class LocalRepo extends app.SmsWorkflowRepository {
      rpc(name, params) {
        const op = queue.then(async () => { await db.exec('set role service_role');
          try { const values = Object.values(params).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v); return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result; }
          finally { await db.exec('reset role'); } });
        queue = op.catch(() => {}); return op;
      }
    }
    const repo = new LocalRepo('production');
    const sent = [];
    const sender = { async send(payload, authorize) { if (!await authorize()) return { kind: 'suppressed', category: 'delivery_recheck' }; sent.push(payload); return { kind: 'accepted', messageId: String(800000000000 + sent.length) }; } };
    const controls = () => ({ paused: false, sendingEnabled: true });
    const provider = 'Hi, I need two caregivers for a group home in Bend, Oregon starting this weekend.';
    const engine = approved => new app.HybridEngine({ AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', ...(approved ? { AI_PRODUCTION_DATA_APPROVED: 'true' } : {}), AI: { run: async (model, input) => {
      models++; const m = JSON.parse(input.messages.at(-1).content).currentMessage ?? '';
      const updates = m.includes('Bend') ? [{ field: 'count', quote: 'two' }, { field: 'position', quote: 'caregivers' }, { field: 'homeType', quote: 'group home' }, { field: 'city', quote: 'Bend' }, { field: 'state', quote: 'Oregon' }] : [];
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ intent: 'provider', intentEvidence: m.includes('need two caregivers') ? 'need two caregivers' : '', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates }) } }] };
    } } }, undefined, () => {});
    const flow = approved => new app.SmsWorkflow(repo, engine(approved), sender, controls);
    const job = async id => (await db.query('select j.status,j.conversation_id,c.is_synthetic,c.state,c.human_attention_needed from public.rc_sms_jobs j join public.conversations c on c.id=j.conversation_id where j.inbound_id=$1', [id])).rows[0];
    const reply = async id => (await db.query("select m.response->>'assistantResponse' as t from public.rc_sms_jobs j join public.messages m on m.client_message_id=j.client_message_id and m.direction='inbound' where j.inbound_id=$1", [id])).rows[0].t;
    const devWording = /\b(test|fictional|dry run|synthetic|Workers AI|deterministic)\b/i;

    await t.test('approved: real provider text is understood by Gemma and answered with a disclosed, opt-out-ready first reply', async () => {
      const before = models; await flow(true).process(realMessage('9000000001', provider));
      const j = await job('9000000001'); assert.equal(models, before + 1); assert.equal(j.status, 'accepted'); assert.equal(j.is_synthetic, false);
      assert.equal(j.state.type, 'provider'); assert.equal(j.state.collected.city, 'Bend'); assert.equal(j.state.collected.count, '2');
      const text = await reply('9000000001'); assert.match(text, /^This is FIGA's automated assistant\. /); assert.match(text, / Reply STOP to opt out\.$/); assert.doesNotMatch(text, devWording);
      assert.deepEqual(sent.at(-1), { from: BUSINESS, to: '+15415550123', text });
    });
    await t.test('not approved: Gemma is never called; the rule-based reply is still customer-ready', async () => {
      const before = models; await flow(false).process(realMessage('9000000002', 'Hello, what do you do?', '+15415550124'));
      assert.equal(models, before); const j = await job('9000000002'); assert.equal(j.status, 'accepted'); assert.doesNotMatch(await reply('9000000002'), devWording);
    });
    await t.test('follow-up turn: no repeated disclosure, history kept', async () => {
      await flow(true).process(realMessage('9000000003', 'Thanks, what shift options do you have?'));
      const text = await reply('9000000003'); assert.doesNotMatch(text, /automated assistant|Reply STOP/); assert.doesNotMatch(text, devWording);
      assert.equal((await job('9000000003')).state.collected.city, 'Bend');
    });
    await t.test('sensitive text is stored, never sent to Gemma, flagged for staff, and does not wedge the poller', async () => {
      const before = models; await flow(true).process(realMessage('9000000004', 'My SSN is 123-45-6789, can I work nights?', '+15415550125'));
      assert.equal(models, before); const j = await job('9000000004'); assert.equal(j.human_attention_needed, true); assert.ok(['accepted', 'suppressed'].includes(j.status));
      if (j.status === 'accepted') assert.doesNotMatch(await reply('9000000004'), devWording);
    });
    await t.test('a later escalation queues a "review" staff alert; a fixture message is rejected outright', async () => {
      const conv = (await job('9000000001')).conversation_id;
      await flow(true).process(realMessage('9000000005', 'Can I talk to a human representative please?'));
      assert.equal((await db.query("select count(*)::int n from public.telegram_notifications where conversation_id=$1 and kind='review'", [conv])).rows[0].n, 1);
      const fixture = { ...realMessage('300001', 'Fictional provider inquiry', '+15035550110'), accountId: '100001', extensionId: '200001', businessNumber: '+15035550100' };
      await assert.rejects(flow(true).process(fixture));
      assert.throws(() => new app.SyntheticSmsWorkflow(repo, engine(true), sender, controls), /Fixture repository required/);
    });
    await t.test('hand reply from a real staff phone holds the thread; STOP is honoured', async () => {
      await flow(true).observeOutbound(realMessage('9000000006', 'Hi, this is Dana from FIGA, calling you shortly.', '+15415550126', 'Outbound'));
      const before = sent.length; await flow(true).process(realMessage('9000000007', 'Great, thanks!', '+15415550126'));
      assert.equal(sent.length, before); assert.equal((await job('9000000007')).status, 'suppressed');
      await flow(true).process(realMessage('9000000008', 'STOP', '+15415550123'));
      const after = sent.length; await flow(true).process(realMessage('9000000009', 'Actually one more question', '+15415550123'));
      assert.equal(sent.length, after); assert.equal((await job('9000000009')).status, 'suppressed');
    });
    await t.test('production repository is inert without a separate, fully configured production project', async () => {
      const cfg = app.productionDatabaseConfiguration;
      assert.equal(cfg({}).configured, false);
      const ok = { SUPABASE_PRODUCTION_ENABLED: 'true', SUPABASE_PRODUCTION_PROJECT_REF: 'figaprod01', SUPABASE_PRODUCTION_URL: 'https://figaprod01.supabase.co', SUPABASE_PRODUCTION_SECRET_KEY: 'sb_secret_inert_test_fixture' };
      assert.equal(cfg(ok).configured, true);
      assert.equal(cfg({ ...ok, SUPABASE_PROJECT_REF: 'figaprod01' }).configured, false, 'must differ from the development project');
      assert.equal(cfg({ ...ok, SUPABASE_PRODUCTION_URL: 'https://evil.example.com' }).configured, false);
      await assert.rejects(app.productionSmsRepository({}).pending());
    });
    assert.equal(network, 0);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
