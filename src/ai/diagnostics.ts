// Internal metadata only. Never retain error messages, bodies, headers or prompts.
export type FailureCategory = 'binding_missing' | 'configuration_disabled' | 'proxy_serialization' | 'authentication' | 'permission' | 'quota_exhausted' | 'rate_limited' | 'model_unavailable' | 'invalid_request' | 'network' | 'timeout' | 'cancelled' | 'response_shape' | 'response_incomplete' | 'response_refused' | 'response_too_large' | 'response_json' | 'extraction_validation' | 'unknown';
export type FailureStage = 'configuration' | 'binding_call' | 'response_validation' | 'response_json' | 'extraction_validation' | 'application_timeout' | 'setup';
export interface InferenceDiagnostic {
  category: FailureCategory;
  stage: FailureStage;
  errorType: string | null;
  cloudflareCode: number | null;
  httpStatus: number | null;
  // Local binding invocation, not proof of Cloudflare-side model execution.
  bindingInvoked: boolean | null;
}
export type DiagnosticObserver = (diagnostic: InferenceDiagnostic) => void;
export interface InferenceTiming {
  phase: 'binding' | 'response_processing' | 'extraction_validation' | 'application' | 'fallback';
  outcome: 'started' | 'success' | 'failure' | 'timeout' | 'discarded';
  durationMs: number;
}
export type TimingObserver = (timing: InferenceTiming) => void;
export function notifyTiming(observer: TimingObserver | undefined, phase: InferenceTiming['phase'], outcome: InferenceTiming['outcome'], started: number) {
  // Fixed metadata only. Neither exceptions nor input/output content is exposed.
  const durationMs = Math.max(0, Math.min(86400000, Math.round(performance.now() - started)));
  try { observer?.({ phase, outcome, durationMs }); } catch { /* Telemetry must not affect conversation behavior. */ }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'DevalueError']);
export function diagnoseFailure(error: unknown, stage: FailureStage, bindingInvoked: boolean | null, forced?: FailureCategory): InferenceDiagnostic {
  const e = record(error), cause = record(e.cause);
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  const name = typeof e.name === 'string' ? e.name : error instanceof Error ? error.constructor.name : '';
  const errorType = error === undefined ? null : types.has(name) ? name : 'UnknownError';
  const candidate = String(e.code ?? message.match(/\bAiError:\s*(\d{3,6})\b/i)?.[1] ?? '');
  const cloudflareCode = /^\d{3,6}$/.test(candidate) ? Number(candidate) : null;
  const status = e.status ?? e.statusCode ?? record(e.response).status;
  const httpStatus = Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status) : null;
  let category: FailureCategory = forced ?? 'unknown';
  if (!forced) {
    if (cloudflareCode === 3036 || /\b3036\b|daily free allocation|quota (?:exceeded|exhausted)/i.test(message)) category = 'quota_exhausted';
    else if (httpStatus === 429 || cloudflareCode === 3040) category = 'rate_limited';
    else if (name === 'DevalueError' || /Cannot stringify arbitrary non-POJOs|Cannot serialize value/i.test(message)) category = 'proxy_serialization';
    else if (name === 'TimeoutError' || e.code === 'ETIMEDOUT' || cause.code === 'ETIMEDOUT' || /\b(?:timed out|timeout)\b/i.test(message)) category = 'timeout';
    else if (name === 'AbortError') category = 'cancelled';
    else if (httpStatus === 401 || /\bunauthorized\b|authentication failed|invalid.*token|token.*expired/i.test(message)) category = 'authentication';
    else if (httpStatus === 403) category = 'permission';
    else if (/no such model|model.*(?:not found|unavailable|not supported)/i.test(message)) category = 'model_unavailable';
    else if (httpStatus === 400 || httpStatus === 422) category = 'invalid_request';
    else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(e.code ?? cause.code)) || /fetch failed|network error/i.test(message)) category = 'network';
    else if (stage === 'extraction_validation') category = 'extraction_validation';
  }
  return { category, stage, errorType, cloudflareCode, httpStatus, bindingInvoked };
}
export function notifyDiagnostic(observer: DiagnosticObserver | undefined, diagnostic: InferenceDiagnostic) {
  // Diagnostic consumers cannot interrupt safe customer-facing fallback behavior.
  try { observer?.(diagnostic); } catch { /* No original error or message logs. */ }
}
