import type { ChatResponse } from './types';

export function validCaregiverCount(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 10000;
}

export const countClarification = 'How many caregivers do you need? Please provide a whole number from 1 to 10,000.';

// Validate engine output before passing it to persistence; SQL independently enforces this.
export function validateProviderCount(response: ChatResponse): ChatResponse {
  if (response.state.type !== 'provider' || !Object.hasOwn(response.state.collected, 'count') || validCaregiverCount(response.state.collected.count)) return response;
  const safe = structuredClone(response);
  delete safe.state.collected.count;
  safe.collectedInformation = safe.state.collected;
  safe.state.awaiting = 'count';
  safe.complete = false;
  safe.assistantResponse = countClarification;
  return safe;
}
