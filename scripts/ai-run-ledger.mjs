import { open } from 'node:fs/promises';

// A persistent wx ledger cannot be resumed/reused after interruption. Reserving
// before dispatch means an uncertain call still consumes its authorized slot.
export async function createRunLedger(path, maximum) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4) throw new Error('Invalid budget');
  const handle = await open(path, 'wx');
  const state = { authorizedMaximum: maximum, attemptsReserved: 0, results: [], complete: false };
  async function save() {
    const data = JSON.stringify(state, null, 2);
    await handle.write(data, 0, 'utf8');
    await handle.truncate(Buffer.byteLength(data));
    await handle.sync();
  }
  try { await save(); } catch (error) { await handle.close(); throw error; }
  return {
    state,
    async reserve(index) {
      if (state.complete || index !== state.attemptsReserved || index >= maximum) throw new Error('Budget unavailable');
      state.attemptsReserved++; await save();
    },
    async record(item) { state.results.push(item); await save(); },
    async complete() { state.complete = true; await save(); },
    close: () => handle.close(),
  };
}
