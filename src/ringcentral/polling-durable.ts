import { DurableObject } from 'cloudflare:workers';
import { RingCentralIncomingPoller, POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED, pollingControls, validatePollState,
  type PollState, type PollingStateStore, type PollingApproval, type PollReport } from './polling';
import { monitoringCredentials, type MonitoringEnvironment } from './polling-runtime';

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

export class RingCentralMonitor extends DurableObject<MonitoringEnvironment> {
  private poller?: RingCentralIncomingPoller;
  async poll(): Promise<PollReport> {
    const controls = pollingControls(this.env);
    if (!RINGCENTRAL_POLLING_LIVE_ENABLED || !controls.enabled || controls.paused || this.env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true')
      return { status: controls.paused ? 'paused' : 'disabled', newMessages: 0, duplicates: 0, excluded: 0, errors: 0, lastSuccessfulCheck: null };
    // Invalid approval is handled by the existing poller before storage or auth.
    let approval: PollingApproval | undefined;
    try { approval = JSON.parse(this.env.RINGCENTRAL_POLLING_APPROVAL_JSON ?? 'null') ?? undefined; } catch { /* fail closed */ }
    this.poller ??= new RingCentralIncomingPoller({ mode: 'live', store: new DurablePollingStore(this.ctx), credentials: monitoringCredentials(this.env),
      http: request => fetch(request), controls: () => pollingControls(this.env), approval });
    return this.poller.poll();
  }
}

