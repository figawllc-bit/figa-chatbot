import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkersAIBinding } from '../src/ai/workers-ai';
import type { Extraction } from '../src/ai/extraction';
import type { ChatResponse } from '../src/types';

const extraction = (intent: 'provider' | 'caregiver', intentEvidence: string, values: Record<string, string>, needsHumanReview = false): Extraction => ({ intent, intentEvidence, ambiguous: false, needsHumanReview, faqIndex: -1, updates: Object.entries(values).map(([field, quote]) => ({ field: field as Extraction['updates'][number]['field'], quote })) });
const proposals = {
  provider: [extraction('provider', 'I need two caregivers', { name: 'Alex Example', count: 'two', position: 'caregivers', homeType: 'group home', city: 'Salem', state: 'Oregon', date: 'tomorrow' }), extraction('provider', '', { count: 'three', shift: 'night shift' }, true)],
  caregiver: [extraction('caregiver', "I'm looking for a CNA job", { name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon' }), extraction('caregiver', '', { experience: 'three years of experience', availability: 'Monday through Friday', shift: 'evening' }, true)],
};
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
afterEach(() => vi.restoreAllMocks());

describe('Isolated real-evaluation state carryover (mocks only)', () => {
  it.each(['provider', 'caregiver'] as const)('%s carries updated state and exact context across two calls', async role => {
    vi.resetModules();
    const { runMultiConversation, multiTurnExamples } = await import('../scripts/phase6-ai-only.js');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    const run = vi.fn<WorkersAIBinding['run']>();
    for (const value of proposals[role]) run.mockResolvedValueOnce(completion(value));
    const reserve = vi.fn(async () => {});
    const records: { response: ChatResponse; checks: { passed: boolean } }[] = [];
    const result = await runMultiConversation({ run }, reserve, async value => { records.push(value as typeof records[number]); }, role);
    expect(result).toEqual({ bindingCallsAttempted: 2, passed: true });
    expect(run).toHaveBeenCalledTimes(2); expect(reserve.mock.calls).toEqual([[0], [1]]);
    const secondContext = JSON.parse(run.mock.calls[1][1].messages![1].content as string);
    expect(secondContext.context.collected).toEqual(records[0].response.state.collected);
    expect(secondContext.context.history).toEqual([multiTurnExamples[role][0]]);
    expect(secondContext.context.type).toBe(role);
    expect(records.every(item => item.checks.passed)).toBe(true);
    expect(records[1].response.state.collected.name).toBe(role === 'provider' ? 'Alex Example' : 'Sam Example');
    expect(records[1].response.complete).toBe(true);
    expect(records[1].response.humanAttentionNeeded).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['binding failure', 'invalid JSON', 'incorrect extraction', 'reservation failure', 'record failure'])('stops without another call after %s', async failure => {
    vi.resetModules();
    const { runMultiConversation } = await import('../scripts/phase6-ai-only.js');
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(proposals.provider[0]));
    if (failure === 'binding failure') run.mockRejectedValue(new Error('Synthetic failure'));
    if (failure === 'invalid JSON') run.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{' } }] });
    if (failure === 'incorrect extraction') run.mockResolvedValue(completion({ ...proposals.provider[0], updates: [] }));
    const reserve = vi.fn(async () => { if (failure === 'reservation failure') throw new Error('Ledger unavailable'); });
    const record = vi.fn(async () => { if (failure === 'record failure') throw new Error('Ledger unavailable'); });
    await expect(runMultiConversation({ run }, reserve, record, 'provider')).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(failure === 'reservation failure' ? 0 : 1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
