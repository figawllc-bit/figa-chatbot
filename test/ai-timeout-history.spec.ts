import { afterEach, describe, expect, it, vi } from 'vitest';
import { HybridEngine } from '../src/ai/engine';
import { DeterministicEngine } from '../src/engine';
import { WorkersAIProvider, type WorkersAIBinding } from '../src/ai/workers-ai';
import { serializableAIBinding } from '../scripts/serializable-ai-binding';
import type { ConversationState } from '../src/types';
import type { InferenceDiagnostic, InferenceTiming } from '../src/ai/diagnostics';

const config = { AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true', AI_TIMEOUT_MS: '15000' };
const first = "Hi, I'm Sam Example. I'm looking for a CNA job in Portland, Oregon.";
const message = "I have three years of experience. I'm available Monday through Friday and prefer evening shifts.";
const state = (): ConversationState => ({ version: 1, type: 'caregiver', collected: { name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon' }, awaiting: 'availability', humanAttentionReasons: [], control: 'active', history: [first] });
const proposal = (updates: { field: string; quote: string }[]) => ({ intent: 'caregiver', intentEvidence: '', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates });
const extracted = proposal([{ field: 'experience', quote: 'three years of experience' }, { field: 'availability', quote: 'Monday through Friday' }, { field: 'shift', quote: 'evening' }]);
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Timeout, fallback history and late completion (fictional mocks)', () => {
  it('records safe stage durations on normal completion and fails fast on busy capacity', async () => {
    vi.useFakeTimers();
    const timings: InferenceTiming[] = [], diagnostics: InferenceDiagnostic[] = [];
    const run = vi.fn<WorkersAIBinding['run']>().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(completion(extracted)), 250)));
    const engine = new HybridEngine({ ...config, AI: { run } }, undefined, d => diagnostics.push(d), t => timings.push(t));
    const pending = engine.respond({ message, state: state(), engine: 'ai', syntheticData: true });
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result.engine?.used).toBe('workers-ai');
    expect(result.state.history).toEqual([first, message]);
    expect(timings).toEqual(expect.arrayContaining([
      { phase: 'binding', outcome: 'success', durationMs: 250 },
      { phase: 'response_processing', outcome: 'success', durationMs: 0 },
      { phase: 'extraction_validation', outcome: 'success', durationMs: 0 },
      { phase: 'application', outcome: 'success', durationMs: 250 },
    ]));
    expect(run.mock.calls[0][2]?.rejectIfBusy).toBe(true);
    run.mockRejectedValue({ status: 429, code: 3040, message: 'private error body' });
    const fallback = await engine.respond({ message: 'availability: weekends', state: result.state, engine: 'ai', syntheticData: true });
    expect(fallback.engine?.used).toBe('deterministic'); expect(fallback.collectedInformation.availability).toBe('weekends');
    expect(diagnostics.at(-1)?.category).toBe('rate_limited');
    expect(JSON.stringify(timings)).not.toMatch(/Sam|Portland|private|prompt|content/);
  });
  it.each([false, true])('15s timeout preserves history and newer corrections despite a 20s completion (Node proxy=%s)', async proxy => {
    vi.useFakeTimers();
    const timings: InferenceTiming[] = [], diagnostics: InferenceDiagnostic[] = [];
    const run = vi.fn<WorkersAIBinding['run']>().mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(completion(extracted)), 20000)));
    const binding = proxy ? serializableAIBinding({ run }) : { run };
    const engine = new HybridEngine({ ...config, AI: binding }, undefined, d => diagnostics.push(d), t => timings.push(t));
    const before = state(), copy = structuredClone(before), delivered = vi.fn();
    const pending = engine.respond({ message, state: before, engine: 'ai', syntheticData: true }).then(result => { delivered(result); return result; });
    await vi.advanceTimersByTimeAsync(14999); expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(delivered).toHaveBeenCalledOnce(); expect(result.engine?.used).toBe('deterministic');
    expect(result.state.history).toEqual([first, message]); expect(before).toEqual(copy);
    expect(result.collectedInformation).toMatchObject({ ...before.collected, experience: 'three years of experience', availability: 'Monday through Friday', shift: 'evening' });
    expect(result.state.control).toBe('active'); expect(result.complete).toBe(true);
    expect(result.assistantResponse).not.toMatch(/we guarantee|you are hired|we have caregivers available|staff were notified/i);
    expect(diagnostics).toHaveLength(1); expect(diagnostics[0]).toMatchObject({ stage: 'application_timeout', bindingInvoked: true });
    expect(timings).toContainEqual({ phase: 'application', outcome: 'timeout', durationMs: 15000 });
    const correction = 'Actually, I can work weekends.';
    run.mockResolvedValueOnce(completion(proposal([{ field: 'availability', quote: 'weekends' }])));
    const next = await engine.respond({ message: correction, state: result.state, engine: 'ai', syntheticData: true });
    const payload = JSON.parse(run.mock.calls[1][1].messages![1].content as string);
    expect(payload.context.history).toEqual([first, message]);
    expect(payload.context.collected).toEqual(result.collectedInformation);
    expect(next.state.history).toEqual([first, message, correction]); expect(next.collectedInformation.availability).toBe('weekends');
    const snapshot = structuredClone(next);
    await vi.advanceTimersByTimeAsync(5000);
    expect(next).toEqual(snapshot); expect(delivered).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledTimes(2);
    expect(timings).toContainEqual({ phase: 'binding', outcome: 'discarded', durationMs: 20000 });
    expect(diagnostics).toHaveLength(1);
  });
  it('late model rejection cannot create a second fallback or unhandled rejection', async () => {
    vi.useFakeTimers();
    const run = vi.fn<WorkersAIBinding['run']>().mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('private body')), 21000)));
    const diagnostic = vi.fn();
    const pending = new HybridEngine({ ...config, AI: { run } }, undefined, diagnostic).respond({ message, state: state(), engine: 'ai', syntheticData: true });
    await vi.advanceTimersByTimeAsync(15000); const result = await pending; const snapshot = structuredClone(result);
    await vi.advanceTimersByTimeAsync(6000);
    expect(result).toEqual(snapshot); expect(run).toHaveBeenCalledOnce(); expect(diagnostic).toHaveBeenCalledOnce();
  });
  it('timing consumers cannot break successful completion or safe fallback', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(extracted));
    const engine = new HybridEngine({ ...config, AI: { run } }, undefined, undefined, () => { throw new Error('Observer failure'); });
    expect((await engine.respond({ message, state: state(), engine: 'ai', syntheticData: true })).engine?.used).toBe('workers-ai');
    run.mockRejectedValue(new Error('mock failure'));
    expect((await engine.respond({ message, state: state(), engine: 'ai', syntheticData: true })).state.history).toEqual([first, message]);
  });
  it('keeps bounded ordered history without dropping distinct identical-text turns', async () => {
    const engine = new DeterministicEngine();
    const before = state(); before.history = ['one', 'two', 'three', 'four', 'five', 'six'];
    const result = await engine.respond({ message: 'availability: weekends', state: before });
    expect(result.state.history).toEqual(['two', 'three', 'four', 'five', 'six', 'availability: weekends']);
    const repeated = await engine.respond({ message: 'availability: weekends', state: result.state });
    expect(repeated.state.history?.slice(-2)).toEqual(['availability: weekends', 'availability: weekends']);
    const long = await engine.respond({ message: 'x'.repeat(2000), state: result.state });
    expect(long.state.history?.at(-1)).toHaveLength(1000);
  });
  it.each(['human_takeover', 'blocked'] as const)('%s suppresses both engines and history writes', async control => {
    const run = vi.fn<WorkersAIBinding['run']>(); const before = { ...state(), control };
    const result = await new HybridEngine({ ...config, AI: { run } }).respond({ message, state: before, engine: 'ai', syntheticData: true });
    expect(run).not.toHaveBeenCalled(); expect(result.assistantResponse).toBe(''); expect(result.engine?.used).toBe('none');
    expect(result.state.history).not.toContain(message);
    expect(before.history).toEqual([first]);
  });
  it('sensitive input is omitted from history even on deterministic routing', async () => {
    const result = await new HybridEngine().respond({ message: 'patient diagnosis', state: state() });
    expect(result.state.history).toEqual([]);
  });
  it('the serializable wrapper preserves fail-fast capacity options', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(extracted));
    await new WorkersAIProvider(serializableAIBinding({ run })).extract({ message, state: state() }, new AbortController().signal);
    expect(run.mock.calls[0][2]).toEqual({ rejectIfBusy: true });
  });
});
