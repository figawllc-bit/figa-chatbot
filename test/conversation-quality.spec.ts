import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../src/index';
import { HybridEngine } from '../src/ai/engine';
import { comparisonValue, assess, examples } from '../scripts/phase6-ai-only.js';
import { validateExtraction } from '../src/ai/extraction';
import { questions } from '../src/engine';
import type { ChatResponse, ConversationState } from '../src/types';
import type { WorkersAIBinding } from '../src/ai/workers-ai';
import { conversationScenarios } from './fixtures/conversation-quality';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const config = { AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'true' };
const completion = (extraction: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(extraction) } }] });

describe('Test-only shift comparisons', () => {
  it.each(['evening', 'evening shift', 'evening shifts', ' EVENING   SHIFTS '])('accepts equivalent %s', value => {
    expect(comparisonValue('shift', value)).toBe(comparisonValue('shift', 'evening shifts'));
  });
  it.each(['night', 'overnight', 'evening weekends', 'evening 6pm–10pm', 'evening or night'])('does not erase meaningful differences in %s', value => {
    expect(comparisonValue('shift', value)).not.toBe(comparisonValue('shift', 'evening'));
  });
  it('does not relax the production requirement for exact current-message evidence', () => {
    expect(() => validateExtraction({ intent: 'caregiver', intentEvidence: '', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: [{ field: 'shift', quote: 'evening shifts' }] }, 'evening')).toThrow();
  });
  it('accepts the real caregiver wording when replayed with a mocked binding', async () => {
    const extraction = { intent: 'caregiver', intentEvidence: 'seeking a CNA job', ambiguous: false, needsHumanReview: false, faqIndex: -1, updates: [
      { field: 'name', quote: 'Sam Example' }, { field: 'position', quote: 'CNA' }, { field: 'city', quote: 'Portland' }, { field: 'state', quote: 'Oregon' }, { field: 'experience', quote: 'three years of caregiving experience' }, { field: 'availability', quote: 'Monday through Friday' }, { field: 'shift', quote: 'evening' },
    ] };
    const run = vi.fn<WorkersAIBinding['run']>().mockResolvedValue(completion(extraction));
    const response = await new HybridEngine({ ...config, AI: { run } }).respond({ message: examples[1].message, engine: 'ai', syntheticData: true });
    expect(assess('caregiver', extraction, response, true).passed).toBe(true);
    expect(response.collectedInformation.shift).toBe('evening');
  });
});

describe('20 mocked Gemma multi-turn HTTP conversations', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it.each(conversationScenarios)('$id retains context, corrections and review through all turns', async scenario => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
    const run = vi.fn<WorkersAIBinding['run']>();
    const worker = createWorker();
    let state: ConversationState | undefined;
    let previous: ChatResponse | undefined;
    for (const [index, turn] of scenario.turns.entries()) {
      const callsBefore = run.mock.calls.length;
      run.mockResolvedValue(completion(turn.extraction));
      const response = await worker.fetch(new IncomingRequest('http://localhost/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: turn.message, state, engine: 'ai', syntheticData: true }) }), { ...config, AI: { run } });
      expect(response.status).toBe(200);
      const result = await response.json<ChatResponse>();
      expect(result.conversationType).toBe(index === 0 ? 'unknown' : scenario.type);
      expect(result.collectedInformation).toEqual(turn.expected);
      expect(result.state.collected).toEqual(turn.expected);
      expect(result.state.awaiting).toBe(turn.awaiting);
      if (turn.awaiting && turn.extraction) expect(result.assistantResponse).toContain(turn.awaiting === 'position' && scenario.type === 'caregiver' ? 'What position are you interested in?' : questions[turn.awaiting]);
      expect(result.complete).toBe(turn.complete ?? false);
      expect(result.state.control).not.toBe('human_takeover');
      expect(run.mock.calls.length - callsBefore).toBe(turn.extraction ? 1 : 0);
      if (turn.extraction) {
        expect(result.engine?.used).toBe('workers-ai');
        const modelContext = JSON.parse(run.mock.calls.at(-1)![1].messages![1].content as string);
        expect(modelContext.context.collected).toEqual(state?.collected ?? {});
        expect(modelContext.context.history.length).toBeLessThanOrEqual(3);
      }
      if (turn.extraction?.needsHumanReview || turn.complete || previous?.humanAttentionNeeded) expect(result.humanAttentionNeeded).toBe(true);
      if (turn.urgent) expect(result.humanAttentionReasons).toContain('Urgent timing requires staff review.');
      expect((result.assistantResponse.match(/\?/g) ?? []).length).toBeLessThanOrEqual(2);
      expect(result.assistantResponse.length).toBeLessThan(600);
      expect(result.assistantResponse).not.toMatch(/(?:we have caregivers available|you are hired|your wage is|our fee is|staff (?:have been|were) notified)/i);
      // Do not re-ask information already collected, including after an FAQ detour.
      for (const [field, question] of Object.entries(questions)) if (field in result.collectedInformation) expect(result.assistantResponse).not.toContain(question);
      if (index === scenario.turns.length - 1) {
        expect(result.assistantResponse).toContain('do not have approved FIGA information');
        expect(result.assistantResponse).not.toContain('confirm availability or placement');
      }
      if (index > 1 && turn.extraction && !turn.extraction.needsHumanReview && !turn.complete) expect(result.assistantResponse).not.toContain('I can help collect those details');
      if (turn.complete) expect(result.assistantResponse).toMatch(/Nothing has been submitted|do not have approved FIGA information/);
      previous = result; state = structuredClone(result.state);
    }
    expect(network).not.toHaveBeenCalled();
  });
});
