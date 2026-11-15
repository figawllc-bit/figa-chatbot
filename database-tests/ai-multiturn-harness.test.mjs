import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

test('the bundled isolated sessions share four durable reservations and preserve two-turn state offline', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const directory = await mkdtemp(resolve('.wrangler/multiturn-offline-'));
  let ledger;
  const originalFetch = globalThis.fetch;
  let calls = 0, externalAttempts = 0;
  try {
    globalThis.fetch = async () => { externalAttempts++; throw new Error('External services forbidden'); };
    const outfile = join(directory, 'runner.mjs');
    const built = await build({ entryPoints: [resolve('scripts/phase6-ai-only.ts')], bundle: true, platform: 'node', format: 'esm', outfile, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(built.metafile.inputs).some(p => /(?:database|telegram|ringcentral|supabase)/i.test(p)), false);
    ledger = await createRunLedger(join(directory, 'ledger.json'), 4);
    const facts = {
      provider: [
        { name: 'Alex Example', count: 'two', position: 'caregivers', homeType: 'group home', city: 'Salem', state: 'Oregon', date: 'tomorrow' },
        { count: 'three', shift: 'night shift' },
      ],
      caregiver: [
        { name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon' },
        { experience: 'three years', availability: 'Monday through Friday', shift: 'evening' },
      ],
    };
    const records = [];
    for (const [conversationIndex, role] of ['provider', 'caregiver'].entries()) {
      const session = await import(pathToFileURL(outfile).href + '?conversation=' + role);
      let turn = 0;
      const binding = { async run(model, input) {
        assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
        assert.equal(ledger.state.attemptsReserved, calls + 1, 'Reservation precedes dispatch');
        const context = JSON.parse(input.messages[1].content);
        assert.equal(context.context.type, turn === 0 ? 'unknown' : role);
        if (turn === 0) assert.deepEqual(context.context.collected, {});
        else assert.deepEqual(context.context.collected, records.at(-1).response.state.collected);
        const extraction = { intent: role, intentEvidence: turn === 0 ? (role === 'provider' ? 'I need two caregivers' : "I'm looking for a CNA job") : '', ambiguous: false, needsHumanReview: true, faqIndex: -1,
          updates: Object.entries(facts[role][turn]).map(([field, quote]) => ({ field, quote })) };
        turn++; calls++;
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(extraction) } }] };
      } };
      await session.runMultiConversation(binding, index => ledger.reserve(conversationIndex * 2 + index), async item => { records.push(item); await ledger.record(item); }, role);
    }
    assert.equal(calls, 4); assert.equal(records.length, 4);
    assert.ok(records.every(item => item.checks.passed));
    await assert.rejects(ledger.reserve(4));
    await ledger.complete(); assert.equal(externalAttempts, 0);
  } finally { globalThis.fetch = originalFetch; if (ledger) await ledger.close(); await rm(directory, { recursive: true }); }
});
