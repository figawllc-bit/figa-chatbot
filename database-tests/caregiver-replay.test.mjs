import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

test('captured caregiver state replays offline with one durable attempt and the unchanged 15s deadline', async t => {
  const capturePath = resolve('.wrangler/phase6-ai-only/multiturn-ledger.json');
  const originalCapture = await readFile(capturePath, 'utf8');
  const capture = JSON.parse(originalCapture);
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const directory = await mkdtemp(resolve('.wrangler/caregiver-replay-offline-'));
  const originalFetch = globalThis.fetch;
  let externalAttempts = 0;
  const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
  const extracted = { intent: 'caregiver', intentEvidence: '', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: [
    { field: 'experience', quote: 'three years of experience' }, { field: 'availability', quote: 'Monday through Friday' }, { field: 'shift', quote: 'evening' },
  ] };
  try {
    globalThis.fetch = async () => { externalAttempts++; throw new Error('External services forbidden'); };
    const outfile = join(directory, 'runner.mjs');
    const built = await build({ stdin: { contents: `export * from './scripts/phase6-ai-only'; export {HybridEngine} from './src/ai/engine';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile, metafile: true, logLevel: 'silent' });
    assert.equal(Object.keys(built.metafile.inputs).some(p => /(?:database|telegram|ringcentral|supabase)/i.test(p)), false);
    for (const scenario of ['success', 'capacity', 'timeout', 'reservation_failure', 'invalid_capture']) {
      const session = await import(pathToFileURL(outfile).href + '?scenario=' + scenario);
      const capturedState = session.caregiverReplayState(capture);
      const firstCapture = capture.results.find(item => item.role === 'caregiver' && item.turn === 1);
      // Re-render the successful captured JSON locally; this is a mock, not inference.
      const first = await new session.HybridEngine({ AI: { run: async () => completion(firstCapture.extraction) }, AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true' }).respond({ message: session.multiTurnExamples.caregiver[0], engine: 'ai', syntheticData: true });
      assert.deepEqual(first.state, capturedState);
      const ledgerPath = join(directory, scenario + '.json');
      const ledger = await createRunLedger(ledgerPath, 1);
      let calls = 0;
      const dispatched = Promise.withResolvers();
      const records = [];
      try {
        await assert.rejects(createRunLedger(ledgerPath, 1), { code: 'EEXIST' });
        const binding = { async run(model, inputs, options) {
          calls++; assert.equal(calls, 1); assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
          assert.equal(JSON.parse(await readFile(ledgerPath, 'utf8')).attemptsReserved, 1);
          assert.equal(options.rejectIfBusy, true); assert.equal('signal' in options, false); assert.equal('rejectIfBusy' in inputs, false);
          const context = JSON.parse(inputs.messages[1].content);
          assert.equal(context.currentMessage, "I have three years of experience. I'm available Monday through Friday and prefer evening shifts.");
          assert.deepEqual(context.context.collected, capturedState.collected);
          assert.deepEqual(context.context.history, capturedState.history); assert.equal(context.context.awaiting, 'availability');
          if (scenario === 'capacity') throw { status: 429, code: 3040 };
          if (scenario === 'timeout') return new Promise(resolve => { setTimeout(() => resolve(completion(extracted)), 20000); dispatched.resolve(); });
          return completion(extracted);
        } };
        const record = async item => { records.push(structuredClone(item)); await ledger.record(item); };
        const reserve = async index => { if (scenario === 'reservation_failure') throw new Error('Ledger unavailable'); await ledger.reserve(index); };
        let inputCapture = capture;
        if (scenario === 'invalid_capture') { inputCapture = structuredClone(capture); inputCapture.results.find(item => item.role === 'caregiver' && item.turn === 1).response.state.control = 'human_takeover'; }
        if (scenario === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        // Attach rejection handling immediately, including for fake-time failures.
        const pending = session.runCaregiverReplay(binding, reserve, record, inputCapture).then(value => ({ value }), error => ({ error }));
        if (scenario === 'timeout') {
          await dispatched.promise;
          // The timeout deadline is measured from respond(), independent of dispatch.
          t.mock.timers.tick(14999); await Promise.resolve(); assert.equal(records.length, 0);
          t.mock.timers.tick(1);
        }
        const result = await pending;
        if (scenario === 'success') {
          assert.equal(result.error, undefined); assert.equal(result.value.bindingCallsAttempted, 1);
          assert.equal(records[0].checks.passed, true); assert.equal(records[0].response.complete, true);
          assert.equal(records[0].response.humanAttentionNeeded, true);
          assert.deepEqual(records[0].response.state.history, [...capturedState.history, session.multiTurnExamples.caregiver[1]]);
          await ledger.complete();
        } else assert.ok(result.error);
        if (scenario === 'timeout') {
          assert.equal(records[0].diagnostics[0].stage, 'application_timeout');
          assert.deepEqual(records[0].response.state.history, [...capturedState.history, session.multiTurnExamples.caregiver[1]]);
          t.mock.timers.tick(20001); await new Promise(resolve => setImmediate(resolve));
          assert.equal(records.length, 1); t.mock.timers.reset();
        }
        assert.equal(calls, ['reservation_failure', 'invalid_capture'].includes(scenario) ? 0 : 1);
        assert.equal(records.length, scenario === 'invalid_capture' ? 0 : 1);
        await assert.rejects(ledger.reserve(1));
      } finally { t.mock.timers.reset(); await ledger.close(); }
    }
    assert.equal(await readFile(capturePath, 'utf8'), originalCapture);
    assert.equal(externalAttempts, 0);
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); await rm(directory, { recursive: true }); }
});
