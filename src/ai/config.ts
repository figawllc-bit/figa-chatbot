import type { WorkersAIBinding } from './workers-ai';
export const WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it' as const;
export interface AIEnvironment {
  AI?: WorkersAIBinding;
  AI_ENABLED?: string;
  AI_PROVIDER?: string;
  AI_ALLOW_SYNTHETIC_REQUESTS?: string;
  // Set only after verifying Workers Free plan and available daily AI quota.
  AI_FREE_TIER_CONFIRMED?: string;
  // Explicit local smoke-test allowance; 0 by default, at most two attempts.
  AI_SYNTHETIC_TEST_CALLS?: string;
  AI_TIMEOUT_MS?: string;
  CONVERSATION_CONTROL?: string;
  AI_GLOBAL_PAUSED?: string;
}
export function aiConfiguration(env: AIEnvironment) {
  const configured = env.AI_ENABLED === 'true' && env.AI_PROVIDER === 'workers-ai' && env.AI_ALLOW_SYNTHETIC_REQUESTS === 'true' && typeof env.AI?.run === 'function';
  const freeTierConfirmed = env.AI_FREE_TIER_CONFIRMED === 'true';
  const testLimit = Number(env.AI_SYNTHETIC_TEST_CALLS ?? '0');
  const syntheticTestLimit = Number.isInteger(testLimit) && testLimit > 0 ? Math.min(2, testLimit) : 0;
  const available = configured && (freeTierConfirmed || syntheticTestLimit > 0);
  const timeout = Number(env.AI_TIMEOUT_MS ?? '8000');
  return { available, configured, freeTierConfirmed, syntheticTestLimit, provider: 'workers-ai' as const, model: WORKERS_AI_MODEL, timeoutMs: Number.isFinite(timeout) ? Math.min(15000, Math.max(1000, timeout)) : 8000 };
}
