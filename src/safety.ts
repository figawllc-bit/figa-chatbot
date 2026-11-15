import type { ChatRequest, ChatResponse } from './types';
import { approvalQuestion } from './knowledge';

const sensitive = /\b(ssn|social security|diagnos\w*|medical records?|residents?|patients?|password|dementia|medication|medical history|date of birth|dob)\b|\b\d{3}-\d{2}-\d{4}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const businessQuestion = approvalQuestion;
export const medicalQuestion = /\b(?:medical advice|treat(?:ment)?|dosage|symptoms?|prescri(?:be|ption)|clinical advice|emergency)\b/i;
export const humanRequest = /\b(human|staff member|representative|manager|takeover)\b/i;
export const injection = /\b(ignore|override|bypass)\b.*\b(instructions?|rules?|safety|blocked|takeover)\b|\b(system prompt|api key|OPENAI_API_KEY)\b/i;
export function hasSensitiveInput(input: ChatRequest): boolean {
  return [input.message, ...Object.values(input.state?.collected ?? {}), ...(input.state?.history ?? [])].some(v =>
    sensitive.test(v) || [...v.matchAll(/\+?\d[\d ()-]{8,}\d/g)].some(m => m[0].replace(/\D/g, '').length >= 10));
}
export function controlledResponse(input: ChatRequest, serverControl?: string): ChatResponse | undefined {
  const control = serverControl === 'blocked' || input.state?.control === 'blocked' ? 'blocked'
    : serverControl === 'human_takeover' || input.state?.control === 'human_takeover' ? 'human_takeover' : undefined;
  if (!control) return;
  const state = structuredClone(input.state ?? { version: 1 as const, type: 'unknown' as const, collected: {}, awaiting: null, humanAttentionReasons: [] });
  state.control = control;
  state.history = [];
  const reason = control === 'blocked' ? 'Conversation is blocked.' : 'Conversation is reserved for human review.';
  state.humanAttentionReasons = [...new Set([...state.humanAttentionReasons, reason])].slice(-10);
  return { mode: 'LOCAL_DEVELOPMENT_DRY_RUN', conversationType: state.type, collectedInformation: state.collected, state,
    assistantResponse: '',
    humanAttentionNeeded: true, humanAttentionReasons: state.humanAttentionReasons, complete: false };
}
