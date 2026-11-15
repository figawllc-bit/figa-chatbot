import { completionMessage, DeterministicEngine, intakeFields, isGreeting, questions, required } from '../engine';
import { approvedFaqs } from '../faq';
import { businessQuestion, controlledResponse, hasSensitiveInput, humanRequest, injection, medicalQuestion } from '../safety';
import type { ChatRequest, ChatResponse, ConversationEngine, ConversationState } from '../types';
import { aiConfiguration, type AIEnvironment } from './config';
import { validateExtraction, type ExtractionProvider } from './extraction';
import { InferenceError, WorkersAIProvider } from './workers-ai';
import { diagnoseFailure, notifyDiagnostic, type DiagnosticObserver, type FailureStage } from './diagnostics';
import { notifyTiming, type TimingObserver } from './diagnostics';
import { appendHistory } from '../history';

const numberWords: Record<string, string> = { a: '1', an: '1', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
// Local smoke-test budget survives requests in this isolate; restarting resets it.
let syntheticTestAttempts = 0;
const initial = (): ConversationState => ({ version: 1, type: 'unknown', collected: {}, awaiting: null, humanAttentionReasons: [] });
const flag = (state: ConversationState, reason: string) => { state.humanAttentionReasons = [...new Set([...state.humanAttentionReasons, reason])].slice(-10); };
function result(state: ConversationState, answer: string, complete = false): ChatResponse {
  return { mode: 'LOCAL_DEVELOPMENT_DRY_RUN', conversationType: state.type, assistantResponse: answer, collectedInformation: state.collected, state,
    humanAttentionNeeded: state.humanAttentionReasons.length > 0, humanAttentionReasons: state.humanAttentionReasons,
    complete, informationStatus: 'user_reported_unverified' };
}
// All policy decisions, state writes and final wording stay outside the provider.
export class HybridEngine implements ConversationEngine {
  private readonly fallback = new DeterministicEngine();
  constructor(private readonly env: AIEnvironment = {}, private readonly provider?: ExtractionProvider, private readonly onDiagnostic?: DiagnosticObserver, private readonly onTiming?: TimingObserver) {}
  async respond(input: ChatRequest): Promise<ChatResponse> {
    const requested = input.engine ?? 'deterministic';
    const annotate = (response: ChatResponse, used: 'deterministic' | 'workers-ai' | 'none', reason?: string) => ({ ...response,
      engine: { requested, used, ...(reason ? { reason } : {}) }, informationStatus: 'user_reported_unverified' as const });
    const controlled = controlledResponse(input, this.env.CONVERSATION_CONTROL);
    if (controlled) return annotate(controlled, 'none', 'conversation_control');
    if (this.env.AI_GLOBAL_PAUSED === 'true') {
      const state = structuredClone(input.state ?? initial());
      flag(state, 'Automated responses are globally paused.');
      return annotate(result(state, ''), 'none', 'global_ai_pause');
    }
    if (hasSensitiveInput(input)) return annotate(await this.fallback.respond(input), 'deterministic', 'sensitive_input');
    if (injection.test(input.message)) {
      const state = structuredClone(input.state ?? initial());
      flag(state, 'Safety override request requires staff review.');
      return annotate(result(state, 'I can collect basic staffing or job inquiry details, but cannot override safety rules or conversation controls. Staff review is needed; no notification has been sent.'), 'none', 'safety_guard');
    }
    // Greetings preserve intake context and never consume inference quota or add review flags.
    if (isGreeting(input.message)) return annotate(await this.fallback.respond(input), 'deterministic', 'greeting');
    // Known approved FAQs and business/human requests do not consume inference quota.
    if (approvedFaqs.some(f => f.match.test(input.message)) || businessQuestion.test(input.message) || humanRequest.test(input.message) || medicalQuestion.test(input.message)) {
      const response = await this.fallback.respond(input);
      return annotate(response, 'deterministic', 'approved_or_staff_only');
    }
    if (requested !== 'ai') return annotate(await this.fallback.respond(input), 'deterministic');
    const config = aiConfiguration(this.env);
    // Real customer data reaches Gemma only with explicit production approval; otherwise the
    // rule-based engine answers (never a developer message to a customer).
    const production = input.productionData === true && input.syntheticData !== true;
    if (production && !config.productionApproved) return annotate(await this.fallback.respond(input), 'deterministic', 'production_data_not_approved');
    if (config.configured && !config.freeTierConfirmed && !config.syntheticTestLimit && !production) {
      const response = await this.fallback.respond(input);
      response.assistantResponse = 'Free-tier access has not been confirmed, so no model request was sent. ' + response.assistantResponse;
      return annotate(response, 'deterministic', 'free_tier_unconfirmed');
    }
    if (!config.available) {
      notifyDiagnostic(this.onDiagnostic, diagnoseFailure(undefined, 'configuration', false, this.env.AI_ENABLED === 'true' && typeof this.env.AI?.run !== 'function' ? 'binding_missing' : 'configuration_disabled'));
      return annotate(await this.fallback.respond(input), 'deterministic', 'ai_not_configured');
    }
    if (!production && (input.syntheticData !== true || /\b(real|actual)\s+(customer|client|resident|patient|personal)\b/i.test(input.message))) {
      const state = structuredClone(input.state ?? initial());
      return annotate(result(state, 'AI testing accepts fictional data only. Confirm that this message, all prior messages, and collected details are fictional before using AI, or select deterministic mode.'), 'none', 'fictional_data_required');
    }
    if (!config.freeTierConfirmed && !production) {
      if (syntheticTestAttempts >= config.syntheticTestLimit) {
        const response = await this.fallback.respond(input);
        response.assistantResponse = 'The authorized synthetic AI test budget is exhausted. ' + response.assistantResponse;
        return annotate(response, 'deterministic', 'ai_test_budget_exhausted');
      }
      syntheticTestAttempts++;
    }
    const provider = this.provider ?? new WorkersAIProvider(this.env.AI!, this.onTiming);
    const controller = new AbortController();
    const started = performance.now();
    let deadlineExpired = false;
    let outcome: 'success' | 'failure' | 'timeout' = 'success';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stage: FailureStage = 'binding_call';
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        deadlineExpired = true;
        reject(new InferenceError('ai_failed', diagnoseFailure(undefined, 'application_timeout', provider instanceof WorkersAIProvider ? provider.bindingInvoked : null, 'timeout')));
        controller.abort();
      }, config.timeoutMs); });
      const value = await Promise.race([provider.extract(input, controller.signal), timeout]);
      // Also reject completions after the deadline if a busy event loop delayed
      // the timer callback. No late provider continuation can write intake state.
      if (deadlineExpired || performance.now() - started >= config.timeoutMs) {
        deadlineExpired = true;
        controller.abort();
        throw new InferenceError('ai_failed', diagnoseFailure(undefined, 'application_timeout', provider instanceof WorkersAIProvider ? provider.bindingInvoked : null, 'timeout'));
      }
      stage = 'extraction_validation';
      const validationStarted = performance.now();
      let valid = false;
      let extraction;
      try { extraction = validateExtraction(value, input.message); valid = true; }
      finally { notifyTiming(this.onTiming, 'extraction_validation', valid ? 'success' : 'failure', validationStarted); }
      const state = structuredClone(input.state ?? initial());
      // History is context only. It can never supply evidence for a new field write.
      state.history = appendHistory(state.history, input.message);
      // Urgency is application policy, including ambiguous or staff-review results.
      if (/\b(urgent|asap|tonight|immediate(?:ly)?)\b/i.test(input.message)) flag(state, 'Urgent timing requires staff review.');
      if (extraction.needsHumanReview) flag(state, 'Question requires approved staff confirmation.');
      if (extraction.ambiguous) return annotate(result(state, 'Could you clarify whether you need caregivers for an organization, are looking for a caregiver job, or have a general question? If a date, place, or quantity is uncertain, please clarify it before I record it.'), 'workers-ai');
      if (extraction.intent !== state.type && extraction.intent !== 'unknown') {
        if (!extraction.intentEvidence.trim()) throw new Error('missing_intent_evidence');
        // A general question during intake does not erase intake details.
        if (extraction.intent === 'provider' || extraction.intent === 'caregiver' || state.type === 'unknown') {
          state.type = extraction.intent;
          state.collected = {};
          state.awaiting = null;
        }
      }
      // General questions are not intake answers, even if the model proposes
      // quoted writes. Review metadata alone must not discard actual intake.
      if (extraction.intent === 'general' && (extraction.needsHumanReview || extraction.faqIndex === -1)) {
        flag(state, 'Question requires approved staff confirmation.');
        return annotate(result(state, 'That requires FIGA staff confirmation. This is a local review flag only; no notification has been sent.'), 'workers-ai');
      }
      if (extraction.faqIndex !== -1 && !extraction.needsHumanReview) return annotate(result(state, approvedFaqs[extraction.faqIndex].answer), 'workers-ai');
      if (state.type !== 'provider' && state.type !== 'caregiver') return annotate(result(state,
        extraction.needsHumanReview ? 'That requires FIGA staff confirmation. This is a local review flag only; no notification has been sent.'
          : 'Are you requesting caregivers for an organization, looking for a caregiver job, or asking a general question?'), 'workers-ai');
      for (const update of extraction.updates) {
        if (!intakeFields[state.type].includes(update.field)) throw new Error('irrelevant_field');
        if (hasSensitiveInput({ message: update.quote })) throw new Error('sensitive_extraction');
        const quote = update.quote.trim();
        const v = update.field === 'count' ? numberWords[quote.toLowerCase()] ?? quote : quote;
        if (update.field === 'count' && (!/^\d+$/.test(v) || +v < 1 || +v > 10000)) throw new Error('invalid_quantity');
        // Save user quotes, never model-written paraphrases or guessed dates/locations.
        state.collected[update.field] = v;
      }
      const missing = required[state.type].filter(f => !state.collected[f]);
      state.awaiting = missing[0] ?? null;
      if (!missing.length) {
        flag(state, 'Intake is complete and requires staff review.');
        return annotate(result(state, completionMessage, true), 'workers-ai');
      }
      const followup = missing[0] === 'position' && state.type === 'caregiver' ? 'What position are you interested in?' : questions[missing[0]];
      if (extraction.needsHumanReview) return annotate(result(state,
        'FIGA staff need to review these details; no notification has been sent. ' + followup), 'workers-ai');
      const introduction = !input.state || input.state.type !== state.type ? 'I can help collect those details; this does not confirm staffing or employment. ' : '';
      return annotate(result(state, introduction + followup), 'workers-ai');
    } catch (error) {
      outcome = deadlineExpired ? 'timeout' : 'failure';
      notifyDiagnostic(this.onDiagnostic, error instanceof InferenceError && error.diagnostic ? error.diagnostic : diagnoseFailure(error, stage, provider instanceof WorkersAIProvider ? provider.bindingInvoked : null));
      // Never include provider errors, message bodies or credentials in responses/logs.
      const fallbackStarted = performance.now();
      const response = await this.fallback.respond(input);
      notifyTiming(this.onTiming, 'fallback', 'success', fallbackStarted);
      const reason = error instanceof InferenceError ? error.reason : 'ai_failed';
      const explanation = reason === 'ai_quota_exhausted' ? 'Workers AI free quota is exhausted.' : reason === 'ai_rate_limited' ? 'Workers AI is temporarily busy or rate limited.' : 'AI is unavailable or returned an unverified result.';
      response.assistantResponse = explanation + ' The local deterministic engine handled this message. ' + response.assistantResponse;
      return annotate(response, 'deterministic', reason);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      notifyTiming(this.onTiming, 'application', outcome, started);
    }
  }
}
