import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunLedger } from '../scripts/ai-run-ledger.mjs';

test('AI-only ledger exclusively reserves four durable attempts with no reuse', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.wrangler/ledger-test-'));
  const path = join(directory, 'ledger.json');
  let ledger;
  try {
    ledger = await createRunLedger(path, 4);
    await assert.rejects(createRunLedger(path, 4), { code: 'EEXIST' });
    await assert.rejects(ledger.reserve(1));
    for (let index = 0; index < 4; index++) {
      await ledger.reserve(index);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).attemptsReserved, index + 1);
      await assert.rejects(ledger.reserve(index));
      await ledger.record({ turn: index });
    }
    await assert.rejects(ledger.reserve(4));
    await ledger.complete(); await assert.rejects(ledger.reserve(0));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).results.length, 4);
    await ledger.close(); ledger = undefined;
    await assert.rejects(createRunLedger(path, 4), { code: 'EEXIST' });
  } finally { if (ledger) await ledger.close(); await rm(directory, { recursive: true }); }
});
