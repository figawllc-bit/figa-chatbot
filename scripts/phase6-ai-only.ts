// Imported only by the isolated launcher. No persistence/messaging dependencies.
import { HybridEngine } from '../src/ai/engine';
import { WORKERS_AI_MODEL } from '../src/ai/config';
import { WorkersAIProvider, type WorkersAIBinding } from '../src/ai/workers-ai';
import { validateExtraction } from '../src/ai/extraction';
import { extractionInstructions } from '../src/ai/prompt';
import { approvedKnowledge, approvalNeeded } from '../src/knowledge';
import { approvedFaqs } from '../src/faq';
import { businessQuestion, hasSensitiveInput, humanRequest, injection, medicalQuestion } from '../src/safety';
import type { ChatResponse, ConversationState, CollectedInformation } from '../src/types';
import { required, questions } from '../src/engine';
import { diagnoseFailure, type InferenceDiagnostic, type InferenceTiming } from '../src/ai/diagnostics';
import { serializableAIBinding } from './serializable-ai-binding';
import { parseRequest } from '../src/validation';
export { diagnoseFailure };

export const examples = [
  { role: 'provider', message: 'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.' },
  { role: 'caregiver', message: 'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.' },
] as const;

export function preflight() {
  if (!approvedKnowledge.every(k => extractionInstructions.includes(k.answer))) throw new Error('Approved knowledge missing');
  if (approvalNeeded.some(k => extractionInstructions.includes(k))) throw new Error('Pending knowledge included');
  for (const input of examples) {
    if (approvedFaqs.some(f => f.match.test(input.message)) || businessQuestion.test(input.message) || humanRequest.test(input.message) || injection.test(input.message) || medicalQuestion.test(input.message) || hasSensitiveInput(input)) throw new Error('Input would bypass inference');
  }
  return { model: WORKERS_AI_MODEL, approvedKnowledgeIncluded: true, pendingPolicyExcluded: true, inputsReachInference: true, examples };
}

// Test comparisons only. Production quotes and extraction validation stay exact.
export function comparisonValue(key: string, value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (key === 'shift') {
    const shift = normalized.match(/^(day|night|evening|overnight|morning|afternoon)(?: shifts?)?$/);
    return shift?.[1] ?? normalized;
  }
  return key === 'position' ? normalized.replace(/\bcaregivers\b/g, 'caregiver') : normalized;
}
export function assess(role: typeof examples[number]['role'], raw: unknown, response: ChatResponse, received: boolean) {
  let validStructuredJSON = false;
  try { validateExtraction(raw, examples.find(e => e.role === role)!.message); validStructuredJSON = true; } catch { /* Report failure, never retry. */ }
  const fields = response.collectedInformation;
  const expected: Record<string, string> = role === 'provider'
    ? { name: 'Alex Example', homeType: 'group home', city: 'Salem', state: 'Oregon', position: 'caregiver', date: 'tonight', shift: 'night shift', count: '3', urgency: 'urgent' }
    : { name: 'Sam Example', city: 'Portland', state: 'Oregon', position: 'CNA', experience: 'three years of caregiving experience', availability: 'Monday through Friday', shift: 'evening shifts' };
  const missingOrDifferent = Object.entries(expected).filter(([key, value]) => !fields[key as keyof typeof fields] || comparisonValue(key, fields[key as keyof typeof fields]!) !== comparisonValue(key, value)).map(([key]) => key);
  const extraFields = Object.keys(fields).filter(k => !(k in expected));
  const correctUrgency = role === 'provider' ? response.humanAttentionReasons.includes('Urgent timing requires staff review.') : !response.humanAttentionReasons.includes('Urgent timing requires staff review.');
  const safeRendering = role === 'provider'
    ? response.assistantResponse.includes('Nothing has been submitted') && response.complete
    : response.assistantResponse.includes('staff review') && response.complete;
  const checks = { modelReturnedResponse: received, validStructuredJSON, inferenceUsed: response.engine?.used === 'workers-ai', correctClassification: response.conversationType === role,
    missingOrDifferent, extraFields, correctUrgency, safeRendering,
    noUnsupportedPromises: !/\b(?:we guarantee|you are hired|we have caregivers available|your wage is)\b/i.test(response.assistantResponse) };
  return { ...checks, passed: received && validStructuredJSON && checks.inferenceUsed && checks.correctClassification && !missingOrDifferent.length && !extraFields.length && correctUrgency && safeRendering && checks.noUnsupportedPromises };
}

export async function runIsolated(binding: WorkersAIBinding, beforeCall: (index: number) => Promise<void>, record: (result: unknown) => Promise<void>, selection: 'both' | 'provider' | 'caregiver' = 'both') {
  const prep = preflight();
  const selected = examples.filter(e => selection === 'both' || e.role === selection);
  const rpcBinding = serializableAIBinding(binding);
  const results: unknown[] = [];
  let attempts = 0;
  for (const [index, example] of selected.entries()) {
    let received = false, raw: unknown = null, parsed: unknown = null;
    const diagnostics: InferenceDiagnostic[] = [];
    const timings: InferenceTiming[] = [];
    const counted: WorkersAIBinding = { async run(model, inputs, options) {
      if (attempts >= selected.length || attempts !== index || model !== WORKERS_AI_MODEL) throw new Error('Call budget violated');
      if (inputs.messages?.[0].role !== 'system' || inputs.messages[0].content !== extractionInstructions) throw new Error('System context changed');
      await beforeCall(index); // Persist a reservation before sending the single binding call.
      attempts++;
      const result = await rpcBinding.run(model, inputs, options);
      if (options?.signal?.aborted) return result;
      received = true;
      // Only fictional model text, never transport errors or credential metadata.
      const content = (result as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        raw = content;
        try { parsed = JSON.parse(content); } catch { /* Invalid JSON stays a failed result. */ }
      }
      return result;
    } };
    const provider = new WorkersAIProvider(counted, timing => timings.push(timing));
    const engine = new HybridEngine({ AI: counted, AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true',
      AI_FREE_TIER_CONFIRMED: 'false', AI_SYNTHETIC_TEST_CALLS: String(selected.length), AI_TIMEOUT_MS: '15000', CONVERSATION_CONTROL: 'active' }, provider, d => diagnostics.push(d), timing => timings.push(timing));
    const response = await engine.respond({ message: example.message, engine: 'ai', syntheticData: true });
    const item = { role: example.role, input: example.message, rawModelJSON: raw, extraction: parsed, response, diagnostics, timings, rpcCancellationForwarded: false, checks: assess(example.role, parsed, response, received) };
    results.push(item);
    await record(item);
  }
  return { ...prep, bindingCallsAttempted: attempts, results };
}

// Each conversation gets a fresh bundled module session with the application's
// existing two-call allowance. The launcher also enforces a durable total of four.
export const multiTurnExamples = {
  provider: [
    "Hello, I'm Alex Example. I need two caregivers for my group home in Salem, Oregon, starting tomorrow.",
    'Actually, make that three caregivers. We need them for the night shift.',
  ],
  caregiver: [
    "Hi, I'm Sam Example. I'm looking for a CNA job in Portland, Oregon.",
    "I have three years of experience. I'm available Monday through Friday and prefer evening shifts.",
  ],
} as const;
export function multiTurnPreflight() {
  const prep = preflight();
  for (const message of Object.values(multiTurnExamples).flat()) {
    if (approvedFaqs.some(f => f.match.test(message)) || businessQuestion.test(message) || humanRequest.test(message) || injection.test(message) || medicalQuestion.test(message) || hasSensitiveInput({ message })) throw new Error('Multi-turn input bypasses inference');
  }
  return { ...prep, maximum: 4, turnsPerConversation: 2 };
}
const multiTurnExpected: Record<'provider' | 'caregiver', CollectedInformation[]> = {
  provider: [
    { name: 'Alex Example', count: '2', homeType: 'group home', city: 'Salem', state: 'Oregon', position: 'caregivers', date: 'tomorrow' },
    { name: 'Alex Example', count: '3', homeType: 'group home', city: 'Salem', state: 'Oregon', position: 'caregivers', date: 'tomorrow', shift: 'night shift' },
  ],
  caregiver: [
    { name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon' },
    { name: 'Sam Example', position: 'CNA', city: 'Portland', state: 'Oregon', experience: 'three years of experience', availability: 'Monday through Friday', shift: 'evening shifts' },
  ],
};
function assessMultiTurn(role: 'provider' | 'caregiver', turn: number, response: ChatResponse, validStructuredJSON: boolean, received: boolean) {
  const expected = multiTurnExpected[role][turn];
  const fields = response.collectedInformation;
  const normalize = (key: string, value: string) => key === 'experience' ? value.trim().toLowerCase().replace(/ of experience$/, '') : comparisonValue(key, value);
  const missingOrDifferent = Object.entries(expected).filter(([key, value]) => !fields[key as keyof CollectedInformation] || normalize(key, fields[key as keyof CollectedInformation]!) !== normalize(key, value!)).map(([key]) => key);
  const extraFields = Object.keys(fields).filter(key => !(key in expected));
  const missing = required[role].filter(key => !expected[key]);
  const appropriateFollowup = response.state.awaiting === (missing[0] ?? null) && response.complete === (missing.length === 0) &&
    (missing.length === 0 ? response.assistantResponse.includes('Nothing has been submitted or sent to staff') : response.assistantResponse.includes(questions[missing[0]]));
  const noRepeatedQuestions = Object.entries(questions).every(([key, question]) => !expected[key as keyof CollectedInformation] || !response.assistantResponse.includes(question));
  const safeRendering = !/\b(?:we guarantee|you are hired|we have caregivers available|your wage is|our fee is|staff (?:have been|were) notified)\b/i.test(response.assistantResponse) && response.assistantResponse.length < 600;
  const checks = { modelReturnedResponse: received, validStructuredJSON, inferenceUsed: response.engine?.used === 'workers-ai', correctClassification: response.conversationType === role, missingOrDifferent, extraFields, appropriateFollowup, noRepeatedQuestions, safeRendering,
    controlUnchanged: response.state.control !== 'human_takeover' && response.state.control !== 'blocked',
    noFalseUrgency: !response.humanAttentionReasons.includes('Urgent timing requires staff review.') };
  return { ...checks, passed: received && validStructuredJSON && checks.inferenceUsed && checks.correctClassification && !missingOrDifferent.length && !extraFields.length && appropriateFollowup && noRepeatedQuestions && safeRendering && checks.controlUnchanged && checks.noFalseUrgency };
}
export function caregiverReplayState(capture: unknown): ConversationState {
  const ledger = capture as { results?: { role?: string; turn?: number; extraction?: unknown; response?: ChatResponse; checks?: { passed?: boolean } }[] };
  const item = ledger?.results?.find(result => result.role === 'caregiver' && result.turn === 1);
  if (!item?.checks?.passed || !item.response || item.response.engine?.used !== 'workers-ai') throw new Error('Successful caregiver capture required');
  validateExtraction(item.extraction, multiTurnExamples.caregiver[0]);
  const state = parseRequest({ message: multiTurnExamples.caregiver[1], state: item.response.state }).state!;
  if (!assessMultiTurn('caregiver', 0, item.response, true, true).passed || state.type !== 'caregiver' ||
      JSON.stringify(state.collected) !== JSON.stringify(item.response.collectedInformation) ||
      JSON.stringify(state.history) !== JSON.stringify([multiTurnExamples.caregiver[0]]) || state.humanAttentionReasons.length ||
      (state.control !== undefined && state.control !== 'active')) throw new Error('Unexpected caregiver capture state');
  return structuredClone(state);
}
export async function runCaregiverReplay(binding: WorkersAIBinding, beforeCall: (index: number) => Promise<void>, record: (result: unknown) => Promise<void>, capture: unknown) {
  return runMultiConversation(binding, beforeCall, record, 'caregiver', caregiverReplayState(capture));
}
export async function runMultiConversation(binding: WorkersAIBinding, beforeCall: (index: number) => Promise<void>, record: (result: unknown) => Promise<void>, role: 'provider' | 'caregiver', resumeState?: ConversationState) {
  multiTurnPreflight();
  if (resumeState && role !== 'caregiver') throw new Error('Unsupported replay');
  const startTurn = resumeState ? 1 : 0;
  const maximum = resumeState ? 1 : 2;
  const rpc = serializableAIBinding(binding);
  let state: ConversationState | undefined = resumeState ? structuredClone(resumeState) : undefined;
  let attempts = 0, currentTurn = 0, received = false, extraction: unknown = null, validStructuredJSON = false;
  let diagnostics: InferenceDiagnostic[] = [];
  let timings: InferenceTiming[] = [];
  const counted: WorkersAIBinding = { async run(model, inputs, options) {
    if (model !== WORKERS_AI_MODEL || attempts >= maximum || attempts !== currentTurn - startTurn) throw new Error('Conversation budget violated');
    if (options?.rejectIfBusy !== true || Object.hasOwn(inputs, 'rejectIfBusy')) throw new Error('Capacity safeguard missing');
    if (inputs.messages?.[0]?.content !== extractionInstructions) throw new Error('System instructions changed');
    const context = JSON.parse(inputs.messages?.[1]?.content as string);
    if (context.currentMessage !== multiTurnExamples[role][currentTurn] || JSON.stringify(context.context.collected) !== JSON.stringify(state?.collected ?? {}) ||
        context.context.type !== (state?.type ?? 'unknown') || context.context.awaiting !== (state?.awaiting ?? null) ||
        JSON.stringify(context.context.history) !== JSON.stringify((state?.history ?? []).slice(-3).map(m => m.slice(0, 300)))) throw new Error('State carryover failed');
    await beforeCall(attempts); // Durable reservation before calling Cloudflare.
    attempts++;
    const output = await rpc.run(model, inputs, options);
    if (options?.signal?.aborted) return output;
    received = true;
    const content = (output as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    try { extraction = validateExtraction(JSON.parse(content as string), multiTurnExamples[role][currentTurn]); validStructuredJSON = true; }
    catch { extraction = null; }
    return output;
  } };
  const engine = new HybridEngine({ AI: counted, AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'true', AI_FREE_TIER_CONFIRMED: 'false', AI_SYNTHETIC_TEST_CALLS: String(maximum), AI_TIMEOUT_MS: '15000', CONVERSATION_CONTROL: 'active' }, new WorkersAIProvider(counted, timing => timings.push(timing)), d => diagnostics.push(d), timing => timings.push(timing));
  for (currentTurn = startTurn; currentTurn < 2; currentTurn++) {
    received = false; extraction = null; validStructuredJSON = false; diagnostics = []; timings = [];
    const response = await engine.respond({ message: multiTurnExamples[role][currentTurn], state, engine: 'ai', syntheticData: true });
    const assessment = assessMultiTurn(role, currentTurn, response, validStructuredJSON, received);
    const expectedHistory = [...(state?.history ?? []), multiTurnExamples[role][currentTurn]];
    const historyRetained = JSON.stringify(response.state.history) === JSON.stringify(expectedHistory);
    const checks = { ...assessment, historyRetained, passed: assessment.passed && historyRetained };
    await record({ role, turn: currentTurn + 1, bindingCallsAttempted: attempts, extraction, response, diagnostics, timings, checks });
    // Fallback is not a successful model test. Never retry or continue on failure.
    if (!checks.passed || diagnostics.length) throw new Error('Multi-turn evaluation stopped');
    state = structuredClone(response.state);
  }
  return { bindingCallsAttempted: attempts, passed: true };
}
