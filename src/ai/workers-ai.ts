import { WORKERS_AI_MODEL } from './config';
import { extractionSchema, type ExtractionContext, type ExtractionProvider } from './extraction';
import { extractionInstructions } from './prompt';
import { diagnoseFailure, notifyTiming, type TimingObserver, type FailureCategory, type FailureStage, type InferenceDiagnostic } from './diagnostics';

export const MAX_OUTPUT_TOKENS = 1024;
const HISTORY_MESSAGES = 3;
const HISTORY_CHARACTERS = 300;
const FIELD_CHARACTERS = 200;

// Narrow, mockable contract; a real generated Workers Ai binding satisfies it.
export interface WorkersAIBinding {
  run(model: typeof WORKERS_AI_MODEL, inputs: AiModels[typeof WORKERS_AI_MODEL]['inputs'], options?: AiOptions & { rejectIfBusy?: boolean }): Promise<unknown>;
}
export class InferenceError extends Error {
  constructor(readonly reason: 'ai_quota_exhausted' | 'ai_rate_limited' | 'ai_failed', readonly diagnostic?: InferenceDiagnostic) { super(reason); }
}
function failure(error: unknown, stage: FailureStage, invoked: boolean, category?: FailureCategory): InferenceError {
  const diagnostic = diagnoseFailure(error, stage, invoked, category);
  const reason = diagnostic.category === 'quota_exhausted' ? 'ai_quota_exhausted' : diagnostic.category === 'rate_limited' ? 'ai_rate_limited' : 'ai_failed';
  return new InferenceError(reason, diagnostic);
}

export class WorkersAIProvider implements ExtractionProvider {
  bindingInvoked = false;
  constructor(private readonly binding: WorkersAIBinding, private readonly onTiming?: TimingObserver) {}
  async extract(context: ExtractionContext, signal: AbortSignal): Promise<unknown> {
    this.bindingInvoked = false;
    if (signal.aborted) throw failure(signal.reason, 'binding_call', false, 'cancelled');
    if (typeof this.binding?.run !== 'function') throw failure(undefined, 'configuration', false, 'binding_missing');
    let output: unknown;
    const bindingStarted = performance.now();
    notifyTiming(this.onTiming, 'binding', 'started', bindingStarted);
    try {
      this.bindingInvoked = true;
      output = await this.binding.run(WORKERS_AI_MODEL, {
        messages: [
          { role: 'system', content: extractionInstructions },
          { role: 'user', content: JSON.stringify({ currentMessage: context.message,
            context: { type: context.state?.type ?? 'unknown', awaiting: context.state?.awaiting ?? null,
              collected: Object.fromEntries(Object.entries(context.state?.collected ?? {}).map(([key, value]) => [key, value.slice(0, FIELD_CHARACTERS)])),
              history: (context.state?.history ?? []).slice(-HISTORY_MESSAGES).map(m => m.slice(0,HISTORY_CHARACTERS)) } }) },
        ],
        stream: false, store: false, temperature: 0, max_completion_tokens: MAX_OUTPUT_TOKENS,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'figa_intake', strict: true, schema: extractionSchema } },
      }, { signal, rejectIfBusy: true });
      notifyTiming(this.onTiming, 'binding', signal.aborted ? 'discarded' : 'success', bindingStarted);
    } catch (error) {
      notifyTiming(this.onTiming, 'binding', signal.aborted ? 'discarded' : 'failure', bindingStarted);
      throw failure(error, 'binding_call', true);
    }
    if (signal.aborted) throw failure(signal.reason, 'binding_call', true, 'cancelled');
    const processingStarted = performance.now();
    let processed = false;
    try {
    // Gemma 4 returns chat-completion choices, not the legacy { response } format.
    if (!output || typeof output !== 'object') throw failure(undefined, 'response_validation', true, 'response_shape');
    const body = output as { choices?: { finish_reason?: string; message?: { role?: string; content?: unknown; refusal?: unknown; tool_calls?: unknown; function_call?: unknown } }[] };
    if (!Array.isArray(body.choices) || body.choices.length !== 1) throw failure(undefined, 'response_validation', true, 'response_shape');
    const choice = body.choices[0];
    const message = choice.message;
    if (message?.refusal) throw failure(undefined, 'response_validation', true, 'response_refused');
    if (choice.finish_reason !== 'stop') throw failure(undefined, 'response_validation', true, 'response_incomplete');
    if (message?.role !== 'assistant' || message.tool_calls || message.function_call || typeof message.content !== 'string') throw failure(undefined, 'response_validation', true, 'response_shape');
    if (new TextEncoder().encode(message.content).length > 65536) throw failure(undefined, 'response_validation', true, 'response_too_large');
    try { const result = JSON.parse(message.content); processed = true; return result; }
    catch (error) { throw failure(error, 'response_json', true, 'response_json'); }
    } finally { notifyTiming(this.onTiming, 'response_processing', processed ? 'success' : 'failure', processingStarted); }
  }
}
