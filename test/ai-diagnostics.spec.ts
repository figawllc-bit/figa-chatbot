import { afterEach, describe, expect, it, vi } from 'vitest';
import { HybridEngine } from '../src/ai/engine';
import { WorkersAIProvider, InferenceError, type WorkersAIBinding } from '../src/ai/workers-ai';
import { serializableAIBinding } from '../scripts/serializable-ai-binding';
import type { InferenceDiagnostic } from '../src/ai/diagnostics';
import type { ConversationState } from '../src/types';

const config = { AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true', AI_TIMEOUT_MS: '1000' };
const message = 'I need two caregivers tomorrow.';
const input = { message, engine: 'ai' as const, syntheticData: true };
const complete = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const good = { intent: 'provider', intentEvidence: message, ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: [] };

describe('Safe internal Workers AI diagnostics (offline mocks)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it.each([
    { error: { name: 'DevalueError', message: 'Cannot stringify arbitrary non-POJOs' }, category: 'proxy_serialization', type: 'DevalueError', status: null, code: null },
    { error: { name: 'Error', status: 401, code: 10000, message: 'private authorization header' }, category: 'authentication', type: 'Error', status: 401, code: 10000 },
    { error: { statusCode: 403 }, category: 'permission', type: 'UnknownError', status: 403, code: null },
    { error: { code: 3036, status: 429 }, category: 'quota_exhausted', type: 'UnknownError', status: 429, code: 3036 },
    { error: { code: 3040, status: 429 }, category: 'rate_limited', type: 'UnknownError', status: 429, code: 3040 },
    { error: { code: 5007, message: 'No such model' }, category: 'model_unavailable', type: 'UnknownError', status: null, code: 5007 },
    { error: { status: 400, message: 'private request body' }, category: 'invalid_request', type: 'UnknownError', status: 400, code: null },
    { error: { name: 'TypeError', message: 'fetch failed', cause: { code: 'ENOTFOUND' } }, category: 'network', type: 'TypeError', status: null, code: null },
    { error: { name: 'TimeoutError' }, category: 'timeout', type: 'TimeoutError', status: null, code: null },
    { error: { name: 'AbortError' }, category: 'cancelled', type: 'AbortError', status: null, code: null },
    { error: { name: 'private secret', code: 'private secret', message: 'private secret' }, category: 'unknown', type: 'UnknownError', status: null, code: null },
  ])('records $category without exposing the original exception', async ({ error, category, type, status, code }) => {
    const diagnostics: InferenceDiagnostic[] = [];
    const run = vi.fn<WorkersAIBinding['run']>().mockRejectedValue(error);
    const response = await new HybridEngine({ ...config, AI: { run } }, undefined, d => diagnostics.push(d)).respond(input);
    expect(run).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([{ category, errorType: type, httpStatus: status, cloudflareCode: code, stage: 'binding_call', bindingInvoked: true }]);
    expect(response.engine?.used).toBe('deterministic');
    expect(JSON.stringify([diagnostics, response])).not.toMatch(/private|authorization header|request body/);
    expect(response).not.toHaveProperty('diagnostic');
  });
  it.each([
    { body: {}, category: 'response_shape', stage: 'response_validation' },
    { body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }, category: 'response_incomplete', stage: 'response_validation' },
    { body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'private refusal' } }] }, category: 'response_refused', stage: 'response_validation' },
    { body: complete('x'.repeat(65537)), category: 'response_too_large', stage: 'response_validation' },
    { body: complete('private invalid JSON'), category: 'response_json', stage: 'response_json' },
    { body: complete(JSON.stringify({ ...good, updates: [{ field: 'city', quote: 'Invented city' }] })), category: 'extraction_validation', stage: 'extraction_validation' },
  ])('separates $category from transport failures', async ({ body, category, stage }) => {
    const diagnostics: InferenceDiagnostic[] = [];
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(body);
    const r = await new HybridEngine({ ...config, AI: { run } }, undefined, d => diagnostics.push(d)).respond(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ category, stage, bindingInvoked: true });
    expect(JSON.stringify([diagnostics, r])).not.toContain('private');
    expect(r.engine?.reason).toBe('ai_failed');
  });
  it('diagnoses a missing binding without invoking one', async () => {
    const diagnostics: InferenceDiagnostic[] = [];
    await new HybridEngine(config, undefined, d => diagnostics.push(d)).respond(input);
    expect(diagnostics[0]).toMatchObject({ category: 'binding_missing', stage: 'configuration', bindingInvoked: false });
  });
  it('diagnoses application timeouts without retrying or returning internal metadata', async () => {
    vi.useFakeTimers();
    const diagnostics: InferenceDiagnostic[] = [];
    const run = vi.fn<WorkersAIBinding['run']>().mockImplementation(() => new Promise(() => {}));
    const pending = new HybridEngine({ ...config, AI: { run } }, undefined, d => diagnostics.push(d)).respond(input);
    await vi.advanceTimersByTimeAsync(1100);
    const r = await pending;
    expect(diagnostics[0]).toMatchObject({ category: 'timeout', stage: 'application_timeout', bindingInvoked: true });
    expect(run).toHaveBeenCalledOnce(); expect(r.engine?.used).toBe('deterministic');
  });
  it('preserves no-call diagnostics on pre-abort', async () => {
    const run = vi.fn<WorkersAIBinding['run']>();
    const controller = new AbortController(); controller.abort();
    try { await new WorkersAIProvider({ run }).extract({ message }, controller.signal); throw new Error('Expected abort'); }
    catch (error) { expect(error).toBeInstanceOf(InferenceError); expect((error as InferenceError).diagnostic).toMatchObject({ category: 'cancelled', bindingInvoked: false }); }
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps native Worker AbortSignal support but strips it at the Node RPC boundary', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockImplementation(async (_model, _inputs, options) => {
      expect(options).not.toHaveProperty('signal'); return complete(JSON.stringify(good));
    });
    const provider = new WorkersAIProvider(serializableAIBinding({ run }));
    expect(await provider.extract({ message }, new AbortController().signal)).toEqual(good);
    expect(run).toHaveBeenCalledOnce();
  });
  it('does not forward a pre-aborted Node RPC call', async () => {
    const run = vi.fn<WorkersAIBinding['run']>();
    const signal = AbortSignal.abort();
    expect(() => serializableAIBinding({ run }).run('@cf/google/gemma-4-26b-a4b-it', { messages: [{ role: 'user', content: message }] }, { signal })).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Exact failed-run fallback extraction and memory regressions', () => {
  const provider = 'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.';
  const caregiver = 'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.';
  it.each([
    { message: provider, type: 'provider', expected: { name: 'Alex Example', city: 'Salem', state: 'Oregon', count: '3', homeType: 'group home', shift: 'night shift', date: 'tonight', urgency: 'urgent' } },
    { message: caregiver, type: 'caregiver', expected: { name: 'Sam Example', city: 'Portland', state: 'Oregon', position: 'CNA', experience: 'three years of caregiving experience', availability: 'Monday through Friday', shift: 'evening' } },
  ])('extracts the $type inquiry on mocked inference failure', async ({ message, type, expected }) => {
    const run = vi.fn<WorkersAIBinding['run']>().mockRejectedValue(new Error('offline mock failure'));
    const engine = new HybridEngine({ ...config, AI: { run } });
    const r = await engine.respond({ message, engine: 'ai', syntheticData: true });
    expect(run).toHaveBeenCalledOnce(); expect(r.engine?.used).toBe('deterministic');
    expect(r.conversationType).toBe(type); expect(r.collectedInformation).toMatchObject(expected);
    expect(r.complete).toBe(true);
    expect(r.humanAttentionReasons.includes('Urgent timing requires staff review.')).toBe(type === 'provider');
    const saved = structuredClone(r.state);
    const next = await engine.respond({ message: type === 'provider' ? 'count: 4' : 'availability: weekends', state: r.state });
    expect(next.collectedInformation).toMatchObject({ ...expected, ...(type === 'provider' ? { count: '4' } : { availability: 'weekends' }) });
    expect(r.state).toEqual(saved);
  });
  it('preserves combined availability days and prior preferences', async () => {
    const state: ConversationState = { version: 1, type: 'caregiver', collected: { position: 'CNA' }, awaiting: 'availability', humanAttentionReasons: [] };
    const r = await new HybridEngine().respond({ message: 'I can work Monday and Wednesday, and prefer night shifts.', state });
    expect(r.collectedInformation).toMatchObject({ position: 'CNA', availability: 'Monday and Wednesday', shift: 'night' });
  });
});
