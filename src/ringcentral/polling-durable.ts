import { DurableObject } from 'cloudflare:workers';
import { RingCentralIncomingPoller, POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED, pollingControls, validatePollState,
  type PollState, type PollingStateStore, type PollingApproval, type PollReport } from './polling';
import { monitoringCredentials } from './polling-runtime';
import { productionScope, productionStaffBot, productionWorkflow, verifySmsApp, type ProductionEnvironment } from '../production/runtime';
import { TelegramPoller } from '../telegram/ingress';
import { TelegramTransportError } from '../telegram/transport';
import { DatabaseError } from '../database/supabase';
import { productionDatabaseConfiguration } from '../database/config';

const KEY = 'ringcentral-incoming:' + POLLING_OWNER_ID;
// Only used INSIDE the singleton DO. Never split lock acquisition and saves
// across RPCs or rely on an expiring lease during external I/O.
export class DurablePollingStore implements PollingStateStore {
  constructor(private readonly ctx: DurableObjectState) {}
  async exclusive<T>(key: string, work: (state: PollState | null, save: (next: PollState) => Promise<void>) => Promise<T>): Promise<T> {
    if (key !== KEY) throw new Error('Polling owner rejected.');
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const loaded = await this.ctx.storage.get<PollState>('checkpoint');
        if (loaded) validatePollState(loaded);
        let active = true;
        try {
          const value = await work(loaded ?? null, async next => {
            if (!active) throw new Error('Polling write expired.');
            validatePollState(next); // Reject content, tokens, extra fields before storage.
            await this.ctx.storage.put('checkpoint', structuredClone(next));
          });
          return { ok: true as const, value };
        } finally { active = false; }
      } catch (error) { return { ok: false as const, error }; }
    });
    // Ordinary network/auth failures must not reset the DO. Runtime timeout or
    // process loss still fences all in-flight work; completed puts survive.
    if (!result.ok) throw result.error;
    return result.value;
  }
}

export interface StaffPollReport { status: 'disabled' | 'ok' | 'error'; processed: number; failure?: 'telegram' | 'database' | 'other'; httpStatus?: number | null; code?: string | null; keyCheck?: number | null; bot?: string | null; webhookSet?: boolean | null; smsApp?: string; webhook?: string; results?: Record<string, number> }
export class RingCentralMonitor extends DurableObject<ProductionEnvironment> {
  private poller?: RingCentralIncomingPoller;
  private botIdentityLogged = false;
  private webhookChecked = false;
  async poll(): Promise<PollReport> {
    const controls = pollingControls(this.env);
    if (!RINGCENTRAL_POLLING_LIVE_ENABLED || !controls.enabled || controls.paused || this.env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true')
      return { status: controls.paused ? 'paused' : 'disabled', newMessages: 0, duplicates: 0, excluded: 0, errors: 0, lastSuccessfulCheck: null };
    const cleared = this.env.RINGCENTRAL_AUTH_REVIEW_CLEARED;
    if (cleared) await this.clearAuthReview(cleared);
    // Invalid approval is handled by the existing poller before storage or auth.
    let approval: PollingApproval | undefined;
    try { approval = JSON.parse(this.env.RINGCENTRAL_POLLING_APPROVAL_JSON ?? 'null') ?? undefined; } catch { /* fail closed */ }
    // Real texts flow into the production workflow only when every processing gate is open
    // (productionReadiness); otherwise polling stays receive-only with no content sink.
    const sink = productionWorkflow(this.env);
    this.poller ??= new RingCentralIncomingPoller({ mode: 'live', store: new DurablePollingStore(this.ctx), credentials: monitoringCredentials(this.env),
      http: request => fetch(request), controls: () => pollingControls(this.env), approval, ...(sink ? { live: { scope: productionScope(this.env), sink } } : {}) });
    return this.poller.poll();
  }
  /**
   * Clears an authentication-review block once per distinct operator value. Only authBlocked changes;
   * the baseline, window and seen-message checkpoints are kept, so nothing is re-read or skipped.
   */
  async clearAuthReview(value: string): Promise<boolean> {
    if (!/^[A-Za-z0-9:._-]{1,64}$/.test(value)) return false;
    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<string>('auth-review-cleared')) === value) return false;
      const state = await this.ctx.storage.get<PollState>('checkpoint');
      if (state?.authBlocked) {
        const next = { ...structuredClone(state), authBlocked: false };
        validatePollState(next);
        await this.ctx.storage.put('checkpoint', next);
      }
      await this.ctx.storage.put('auth-review-cleared', value);
      console.info('figa_auth_review_cleared', { wasBlocked: !!state?.authBlocked });
      return !!state?.authBlocked;
    });
  }
  /** One Telegram pass: staff commands (getUpdates) then queued staff alerts. No public webhook. */
  async staff(): Promise<StaffPollReport> {
    const staff = productionStaffBot(this.env);
    if (!staff) return { status: 'disabled', processed: 0 };
    // Webhook mode: Telegram pushes button presses to /telegram/webhook instantly. getUpdates cannot run
    // alongside a webhook, so this pass only (re)registers the webhook once per isolate and sends alerts.
    const webhookUrl = this.env.TELEGRAM_WEBHOOK_ENABLED === 'true' ? this.env.TELEGRAM_WEBHOOK_URL ?? '' : '';
    if (webhookUrl) {
      try {
        let webhook: string | undefined;
        if (!this.webhookChecked) {
          this.webhookChecked = true;
          const current = (await staff.transport.getWebhookInfo()).url;
          if (current !== webhookUrl) { await staff.transport.setWebhook(webhookUrl, this.env.TELEGRAM_WEBHOOK_SECRET ?? ''); webhook = 'registered'; }
          else webhook = 'active';
        }
        await staff.bot.dispatch();
        return { status: 'ok' as const, processed: 0, ...(webhook ? { webhook } : {}) };
      } catch (error) {
        this.webhookChecked = false;
        return { status: 'error' as const, processed: 0, failure: error instanceof TelegramTransportError ? 'telegram' as const : error instanceof DatabaseError ? 'database' as const : 'other' as const };
      }
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const offset = (await this.ctx.storage.get<number>('telegram-offset')) ?? 0;
      try {
        // The offset advances only after updates are handled; update-ID dedupe in SQL covers a crash in between.
        const results: Record<string, number> = {};
        const next = await new TelegramPoller(staff.transport, staff.bot).once(offset, kind => { results[kind] = (results[kind] ?? 0) + 1; });
        if (next !== offset) await this.ctx.storage.put('telegram-offset', next);
        // Once per isolate: which bot this token belongs to (public username) and whether a webhook
        // would divert updates, so staff can confirm they are messaging the right bot.
        let bot: string | null | undefined, webhookSet: boolean | null | undefined, smsApp: string | undefined;
        if (!this.botIdentityLogged) {
          this.botIdentityLogged = true;
          try { bot = '@' + (await staff.transport.getMe()).username; } catch { bot = null; }
          try { webhookSet = (await staff.transport.getWebhookInfo()).url !== ''; } catch { webhookSet = null; }
          smsApp = await verifySmsApp(this.env); // sign-in check only; never sends
        }
        return { status: 'ok' as const, processed: next - offset, results, ...(bot !== undefined ? { bot, webhookSet, smsApp } : {}) };
      } catch (error) {
        // Category only. No Telegram bodies, tokens or database responses in logs.
        const failure = error instanceof TelegramTransportError ? 'telegram' as const : error instanceof DatabaseError ? 'database' as const : 'other' as const;
        const httpStatus = error instanceof DatabaseError ? error.httpStatus : null;
        // On 401, ask the project's API root whether it accepts this key at all (status number only):
        // 200 = key valid (the database refused the bot's functions); 401 = key not valid for this project.
        let keyCheck: number | null = null;
        if (httpStatus === 401) {
          const db = productionDatabaseConfiguration(this.env);
          try { const r = await fetch(`${db.url}/rest/v1/`, { headers: { apikey: db.key! }, redirect: 'manual', signal: AbortSignal.timeout(5000) }); keyCheck = r.status; await r.body?.cancel(); } catch { keyCheck = null; }
        }
        return { status: 'error' as const, processed: 0, failure, httpStatus, code: error instanceof DatabaseError ? error.code : null, keyCheck };
      }
    });
  }
}

