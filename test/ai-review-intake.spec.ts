import { describe, expect, it, vi } from 'vitest';
import { HybridEngine } from '../src/ai/engine';
import type { WorkersAIBinding } from '../src/ai/workers-ai';
import type { ConversationState } from '../src/types';
import captured from './fixtures/gemma-provider-review.json';

const config = { AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true' };
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
const expectedProvider = { name: 'Alex Example', homeType: 'group home', city: 'Salem', state: 'Oregon', count: '3', position: 'caregivers', shift: 'night shift', date: 'tonight' };
function fixture(value: unknown = captured.extraction) {
  const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(value));
  return { run, engine: new HybridEngine({ ...config, AI: { run } }) };
}
const request = (message = captured.message, state?: ConversationState) => ({ message, state, engine: 'ai' as const, syntheticData: true });

describe('Review-required model intake (mocked captured Gemma JSON)', () => {
  it('retains every captured provider field, normalizes count, and flags urgency without takeover', async () => {
    const { run, engine } = fixture();
    const r = await engine.respond(request());
    expect(run).toHaveBeenCalledOnce(); expect(r.engine?.used).toBe('workers-ai');
    expect(r.collectedInformation).toEqual(expectedProvider);
    expect(r.state.collected).toEqual(expectedProvider);
    expect(r.state.awaiting).toBeNull(); expect(r.complete).toBe(true);
    expect(r.humanAttentionReasons).toEqual(expect.arrayContaining(['Urgent timing requires staff review.', 'Question requires approved staff confirmation.', 'Intake is complete and requires staff review.']));
    expect(r.state.control).toBeUndefined();
    expect(r.assistantResponse).toContain('staff review');
    expect(r.assistantResponse).toContain('Nothing has been submitted or sent to staff');
    expect(r.assistantResponse).toContain('not guaranteed');
  });
  it.each([false, true])('merges normal/review intake consistently (review=%s)', async needsHumanReview => {
    const { engine } = fixture({ ...captured.extraction, needsHumanReview });
    const r = await engine.respond(request());
    expect(r.collectedInformation).toEqual(expectedProvider);
    expect(r.engine?.used).toBe('workers-ai'); expect(r.complete).toBe(true);
  });
  it('preserves caregiver fields when model review is required', async () => {
    const message = 'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.';
    const { engine } = fixture({ intent: 'caregiver', intentEvidence: 'I am seeking a CNA job', ambiguous: false, needsHumanReview: true, faqIndex: -1,
      updates: [{ field: 'name', quote: 'Sam Example' }, { field: 'city', quote: 'Portland' }, { field: 'state', quote: 'Oregon' }, { field: 'position', quote: 'CNA' }, { field: 'experience', quote: 'three years of caregiving experience' }, { field: 'availability', quote: 'Monday through Friday' }, { field: 'shift', quote: 'evening shifts' }] });
    const r = await engine.respond(request(message));
    expect(r.collectedInformation).toEqual({ name: 'Sam Example', city: 'Portland', state: 'Oregon', position: 'CNA', experience: 'three years of caregiving experience', availability: 'Monday through Friday', shift: 'evening shifts' });
    expect(r.humanAttentionNeeded).toBe(true); expect(r.complete).toBe(true);
    expect(r.state.control).toBeUndefined(); expect(r.engine?.used).toBe('workers-ai');
  });
  it('retains memory and explicit corrections without mutating the previous state', async () => {
    const { run, engine } = fixture();
    const first = await engine.respond(request());
    first.state.collected.organization = 'Fictional Home'; first.state.control = 'active';
    const before = structuredClone(first.state);
    run.mockResolvedValue(completion({ ...captured.extraction, intentEvidence: '', updates: [{ field: 'count', quote: 'four' }, { field: 'city', quote: 'Portland' }] }));
    const r = await engine.respond(request('Actually, four caregivers in Portland instead.', first.state));
    expect(r.collectedInformation).toEqual({ ...expectedProvider, count: '4', city: 'Portland', organization: 'Fictional Home' });
    expect(first.state).toEqual(before); expect(r.state.control).toBe('active');
    expect(r.humanAttentionNeeded).toBe(true);
  });
  it('retains partial intake and asks for the next missing field while flagging review', async () => {
    const { engine } = fixture({ ...captured.extraction, updates: [{ field: 'city', quote: 'Salem' }, { field: 'count', quote: 'three' }] });
    const r = await engine.respond(request());
    expect(r.collectedInformation).toEqual({ city: 'Salem', count: '3' });
    expect(r.state.awaiting).toBe('name'); expect(r.complete).toBe(false);
    expect(r.assistantResponse).toContain('no notification has been sent');
    expect(r.assistantResponse).toContain('What is your name?');
  });
  it.each([
    { field: 'city', quote: 'Invented City' },
    { field: 'count', quote: 'tonight' },
    { field: 'availability', quote: 'tonight' },
    { field: 'companyFee', quote: 'three' },
  ])('rejects invalid review updates without accepting a partial model merge: $field=$quote', async update => {
    const { engine } = fixture({ ...captured.extraction, updates: [{ field: 'name', quote: 'Example' }, update] });
    const r = await engine.respond(request());
    expect(r.engine).toMatchObject({ used: 'deterministic', reason: 'ai_failed' });
    // Independent deterministic extraction may recover the user's actual facts.
    expect(r.collectedInformation.name).toBe('Alex Example');
    expect(JSON.stringify(r.collectedInformation)).not.toContain('Invented City');
    expect(r.collectedInformation).not.toHaveProperty('availability');
    expect(r.collectedInformation).not.toHaveProperty('companyFee');
    expect(r.collectedInformation.count).toBe('3');
  });
  it('leaves ambiguous review proposals unmerged', async () => {
    const { engine } = fixture({ ...captured.extraction, ambiguous: true });
    const r = await engine.respond(request());
    expect(r.collectedInformation).toEqual({}); expect(r.humanAttentionNeeded).toBe(true);
  });
  it('keeps general questions from writing intake fields under review', async () => {
    const { engine } = fixture({ ...captured.extraction, intent: 'general', intentEvidence: 'Is parking included', updates: [{ field: 'notes', quote: 'parking' }] });
    const state: ConversationState = { version: 1, type: 'provider', collected: { name: 'Alex Example', city: 'Salem' }, awaiting: 'homeType', humanAttentionReasons: [] };
    const r = await engine.respond(request('Is parking included?', state));
    expect(r.collectedInformation).toEqual(state.collected); expect(r.humanAttentionNeeded).toBe(true);
  });
  it.each(['human_takeover', 'blocked'] as const)('preserves %s suppression before any model call', async control => {
    const { run, engine } = fixture();
    const r = await engine.respond(request(captured.message, { version: 1, type: 'provider', collected: { city: 'Salem' }, awaiting: 'name', humanAttentionReasons: [], control }));
    expect(run).not.toHaveBeenCalled(); expect(r.assistantResponse).toBe('');
    expect(r.engine?.used).toBe('none'); expect(r.collectedInformation).toEqual({ city: 'Salem' });
  });
});
