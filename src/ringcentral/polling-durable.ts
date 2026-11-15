import { DurableObject } from 'cloudflare:workers';
import { RingCentralIncomingPoller, POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED, pollingControls, validatePollState,
  type PollState, type PollingStateStore, type PollingApproval, type PollReport } from './polling';
import { monitoringCredentials } from './polling-runtime';
import { productionScope, productionStaffBot, productionWorkflow, type ProductionEnvironment } from '../production/runtime';
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

export interface StaffPollReport { status: 'disabled' | 'ok' | 'error'; processed: number; failure?: 'telegram' | 'database' | 'other'; httpStatus?: number | null; code?: string | null; keyCheck?: number | null }
export class RingCentralMonitor extends DurableObject<ProductionEnvironment> {
  private poller?: RingCentralIncomingPoller;
  async poll(): Promise<PollReport> {
    const controls = pollingControls(this.env);
    if (!RINGCENTRAL_POLLING_LIVE_ENABLED || !controls.enabled || controls.paused || this.env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true')
      return { status: controls.paused ? 'paused' : 'disabled', newMessages: 0, duplicates: 0, excluded: 0, errors: 0, lastSuccessfulCheck: null };
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
  /** One Telegram pass: staff commands (getUpdates) then queued staff alerts. No public webhook. */
  async staff(): Promise<StaffPollReport> {
    const staff = productionStaffBot(this.env);
    if (!staff) return { status: 'disabled', processed: 0 };
    return this.ctx.blockConcurrencyWhile(async () => {
      const offset = (await this.ctx.storage.get<number>('telegram-offset')) ?? 0;
      try {
        // The offset advances only after updates are handled; update-ID dedupe in SQL covers a crash in between.
        const next = await new TelegramPoller(staff.transport, staff.bot).once(offset);
        if (next !== offset) await this.ctx.storage.put('telegram-offset', next);
        return { status: 'ok' as const, processed: next - offset };
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

