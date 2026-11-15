import { describe, expect, it, vi } from 'vitest';
import { HybridEngine } from '../src/ai/engine';
import type { WorkersAIBinding } from '../src/ai/workers-ai';
import { extractionInstructions } from '../src/ai/prompt';
import { approvedKnowledge, approvalNeeded } from '../src/knowledge';
import { approvedFaqs } from '../src/faq';
import type { ConversationState } from '../src/types';

const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
const extracted = { intent: 'provider', intentEvidence: 'I need two caregivers tomorrow.', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: [{ field: 'count', quote: 'two' }, { field: 'date', quote: 'tomorrow' }] };
const configured = { AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true' };
const caregiver: ConversationState = { version: 1, type: 'caregiver', collected: { name: 'Sam Example', city: 'Salem', state: 'OR', position: 'CNA' }, awaiting: 'availability', humanAttentionReasons: [] };
const inquiries = [
  { role: 'provider', message: 'What services does FIGA offer?', expected: 'adult foster home and group home', review: false },
  { role: 'provider', message: 'How do I request caregivers?', expected: 'name, home type, city and state', review: false },
  { role: 'provider', message: 'I need three caregivers tonight for a group home in Salem, OR.', expected: 'What is your name?', review: true },
  { role: 'provider', message: 'Can you confirm caregiver availability tonight?', expected: 'Only FIGA staff can confirm availability', review: true },
  { role: 'provider', message: 'What are your fees and cancellation policies?', expected: 'do not have approved FIGA information', review: true },
  { role: 'caregiver', message: 'How can I apply?', expected: 'employment inquiry for FIGA staff review and follow-up', review: false },
  { role: 'caregiver', message: 'I am looking for a CNA job in Salem, OR.', expected: 'What is your name?', review: false },
  { role: 'caregiver', message: 'I can work tonight.', state: caregiver, expected: 'Which shift or working hours?', review: true },
  { role: 'caregiver', message: 'What wages and benefits do you offer?', expected: 'do not have approved FIGA information', review: true },
  { role: 'caregiver', message: 'Do you require background checks?', expected: 'do not have approved FIGA information', review: true },
];

describe('FIGA readiness review', () => {
  it('supplies approved knowledge to the actual Gemma adapter system message, never the pending list', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(extracted));
    const engine = new HybridEngine({ ...configured, AI: { run } });
    const result = await engine.respond({ message: 'I need two caregivers tomorrow.', engine: 'ai', syntheticData: true });
    expect(result.engine?.used).toBe('workers-ai');
    expect(run).toHaveBeenCalledOnce();
    const [model, payload] = run.mock.calls[0];
    expect(model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(payload.messages?.[0]).toEqual({ role: 'system', content: extractionInstructions });
    for (const item of approvedKnowledge) expect(payload.messages?.[0].content).toContain(item.answer);
    for (const pending of approvalNeeded) {
      expect(JSON.stringify(payload)).not.toContain(pending);
      expect(approvedFaqs.some(f => f.answer.includes(pending))).toBe(false);
      expect(result.assistantResponse).not.toContain(pending);
    }
  });
  it.each(inquiries)('$role review inquiry: $message', async ({ message, state, expected, review }) => {
    const run = vi.fn<WorkersAIBinding['run']>().mockRejectedValue(new Error('Live model forbidden'));
    const result = await new HybridEngine({ ...configured, AI: { run } }).respond({ message, state, engine: 'deterministic', syntheticData: true });
    expect(result.assistantResponse).toContain(expected);
    expect(result.humanAttentionNeeded).toBe(review);
    expect(run).not.toHaveBeenCalled();
    for (const pending of approvalNeeded) expect(result.assistantResponse).not.toContain(pending);
    if (message === 'I can work tonight.') {
      expect(result.collectedInformation).toMatchObject({ ...caregiver.collected, availability: 'tonight' });
      expect(result.humanAttentionReasons).not.toContain('Staff must confirm staffing availability.');
    }
  });
  it('keeps pending information and provider error text out of a failed-inference fallback', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockRejectedValue(new Error(approvalNeeded.join('\n')));
    const r = await new HybridEngine({ ...configured, AI: { run } }).respond({ message: 'I need two caregivers tomorrow.', engine: 'ai', syntheticData: true });
    expect(r.engine?.used).toBe('deterministic');
    expect(r.engine?.reason).toBe('ai_failed');
    for (const pending of approvalNeeded) expect(r.assistantResponse).not.toContain(pending);
  });
  it('flags urgency even when mocked Gemma returns ambiguity without a review flag', async () => {
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion({ ...extracted, intent: 'unknown', intentEvidence: '', ambiguous: true, updates: [] }));
    const r = await new HybridEngine({ ...configured, AI: { run } }).respond({ message: 'Urgent, I need help immediately.', engine: 'ai', syntheticData: true });
    expect(r.humanAttentionNeeded).toBe(true);
    expect(r.humanAttentionReasons).toContain('Urgent timing requires staff review.');
    expect(r.collectedInformation).toEqual({});
  });
});
