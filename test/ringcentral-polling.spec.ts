import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RingCentralIncomingPoller, POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED, pollingControls, type PollingStateStore, type PollState } from '../src/ringcentral/polling';
import { createOfflinePollingHttp, type OfflineHttpStep } from '../src/ringcentral/secure-transport';
import { createOfflineCredentials } from '../src/ringcentral/offline-credentials';
import { OfflineRingCentralReceiver } from '../src/ringcentral/receiver';
import { createWorker } from '../src/index';

const start = Date.parse('2026-11-15T12:00:00.000Z');
const scope = { accountId: '100001', extensionId: '200001', subscriptionId: 'fictional-subscription', businessNumbers: ['+15035550100'] };
const jwt = (patch = {}) => ({ body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, owner_id: '200001', scope: 'ReadMessages', ...patch }) });
const sms = (id = '300001', patch = {}) => ({ id, type: 'SMS', direction: 'Inbound', subject: 'Fictional provider inquiry', from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], messageStatus: 'Received', creationTime: new Date(start + 30000).toISOString(), uri: `https://platform.ringcentral.com/restapi/v1.0/account/100001/extension/200001/message-store/${id}`, ...patch });
const page = (records: unknown[] = [], current = 1, total = 1) => ({ body: JSON.stringify({ records, paging: { page: current, perPage: 20, totalPages: total }, navigation: { nextPage: { uri: 'https://example.invalid/never-follow' } } }) });
class Store implements PollingStateStore {
  state: PollState | null = null; writes = 0; calls = 0;
  #tail = Promise.resolve();
  async exclusive<T>(_key: string, work: (state: PollState | null, save: (next: PollState) => Promise<void>) => Promise<T>): Promise<T> {
    this.calls++; const before = this.#tail; let unlock!: () => void; this.#tail = new Promise(resolve => { unlock = resolve; });
    await before;
    try { return await work(structuredClone(this.state), async state => { this.writes++; this.state = structuredClone(state); }); }
    finally { unlock(); }
  }
}
function setup(steps: OfflineHttpStep[] = [jwt(), page([sms()])], store = new Store(), options: { receiver?: OfflineRingCentralReceiver; paused?: () => boolean; mode?: 'offline' | 'live'; enabled?: boolean; interval?: number } = {}) {
  const http = createOfflinePollingHttp(JSON.stringify(steps));
  const poller = new RingCentralIncomingPoller({ mode: options.mode ?? 'offline', store, credentials: createOfflineCredentials('jwt', undefined, 'production'), http: http.executor,
    controls: () => ({ enabled: options.enabled ?? true, paused: options.paused?.() ?? false, intervalSeconds: options.interval }), fixture: { scope, receiver: options.receiver } });
  return { poller, http, store };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Phase 8A receive-only polling', () => {
  it('baselines without credentials, historical enumeration, or external calls', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('forbidden'));
    const { poller, http, store } = setup();
    expect(await poller.poll()).toMatchObject({ status: 'baseline', newMessages: 0, lastSuccessfulCheck: null });
    expect(store.state?.completedThrough).toBe(new Date(start).toISOString());
    expect(http.audit()).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  });
  it('detects an incoming fictional SMS, reuses intake, deduplicates, and returns only safe counts', async () => {
    const observe = vi.fn(async () => ({ kind: 'observed' as const, observations: [] }));
    const receiver = new OfflineRingCentralReceiver(scope, { observe });
    const { poller, http, store } = setup([jwt(), page([sms()]), page([sms()])], new Store(), { receiver });
    await poller.poll(); vi.setSystemTime(start + 120000);
    const first = await poller.poll(); expect(first).toMatchObject({ status: 'ok', newMessages: 1, duplicates: 0 });
    expect(observe).toHaveBeenCalledOnce();
    vi.setSystemTime(start + 240000);
    const again = await poller.poll(); expect(again).toMatchObject({ status: 'ok', newMessages: 0, duplicates: 1 });
    expect(observe).toHaveBeenCalledOnce(); expect(http.audit().map(x => x.method)).toEqual(['POST', 'GET', 'GET']);
    expect(JSON.stringify([first, again, store.state])).not.toMatch(/subject|phone|555|300001|Fictional|signature|token|secret/);
    for (const audit of http.audit().filter(x => x.method === 'GET')) expect(audit.path).toBe('/restapi/v1.0/account/100001/extension/200001/message-store');
  });
  it('recovers checkpoints and deduplication across new poller instances', async () => {
    const { poller, store } = setup(); await poller.poll(); vi.setSystemTime(start + 120000); await poller.poll();
    const restarted = setup([jwt(), page([sms()])], store);
    expect(await restarted.poller.poll()).toMatchObject({ status: 'not_due', newMessages: 0 });
    vi.setSystemTime(start + 240000);
    expect(await restarted.poller.poll()).toMatchObject({ status: 'ok', duplicates: 1, newMessages: 0 });
  });
  it('serializes overlapping cycles so only one performs detection', async () => {
    const { poller, store } = setup(); await poller.poll(); vi.setSystemTime(start + 120000);
    const other = setup([jwt(), page([sms()])], store);
    const result = await Promise.all([poller.poll(), other.poller.poll()]);
    expect(result.map(x => x.status).sort()).toEqual(['not_due', 'ok']); expect(other.http.audit()).toHaveLength(0);
  });
  it('excludes old records, outbound SMS, voicemail, MMS and attachments', async () => {
    const records = [sms('300001', { creationTime: new Date(start).toISOString() }), sms('300002', { direction: 'Outbound' }), sms('300003', { type: 'VoiceMail' }), sms('300004', { type: 'MMS' }), sms('300005', { attachments: [{ uri: 'https://example.invalid/recording' }] })];
    const { poller, http } = setup([jwt(), page(records)]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'ok', newMessages: 0, excluded: 5 }); expect(http.audit()).toHaveLength(2);
  });
  it('rejects unapproved customer-like material before it can reach fixture intake or state', async () => {
    const observe = vi.fn(), receiver = new OfflineRingCentralReceiver(scope, { observe });
    const { poller, store } = setup([jwt(), page([sms('300001', { subject: 'UNAPPROVED_MATERIAL', from: { phoneNumber: '+18001234567' } })])], new Store(), { receiver });
    await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'error', newMessages: 0 }); expect(observe).not.toHaveBeenCalled(); expect(store.state?.seen).toEqual([]);
  });
  it('never advances a checkpoint on intake failure; retries reuse the stable event identity', async () => {
    const observe = vi.fn().mockRejectedValueOnce(Error('FICTIONAL_PRIVATE_ERROR')).mockResolvedValue({ kind: 'observed', observations: [] });
    const receiver = new OfflineRingCentralReceiver(scope, { observe });
    const { poller, store } = setup([jwt(), page([sms()]), page([sms()])], new Store(), { receiver });
    await poller.poll(); vi.setSystemTime(start + 120000);
    const failed = await poller.poll(); expect(failed.status).toBe('error'); expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    expect(store.state?.completedThrough).toBe(new Date(start).toISOString());
    vi.setSystemTime(start + 240000); expect(await poller.poll()).toMatchObject({ status: 'ok', newMessages: 1 });
    expect(observe.mock.calls[0][0]).toBe(observe.mock.calls[1][0]);
  });
  it('bounds pagination to three fixed pages and holds the checkpoint on overflow', async () => {
    const pages = Array.from({ length: 3 }, (_, p) => page(Array.from({ length: 20 }, (_, n) => sms(String(300001 + p * 20 + n))), p + 1, 4));
    const { poller, http, store } = setup([jwt(), ...pages]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'backlog', newMessages: 60 });
    expect(http.audit()).toHaveLength(4); expect(store.state?.completedThrough).toBe(new Date(start).toISOString()); expect(store.state?.lastSuccessfulCheck).toBe(null);
    const restarted = setup([jwt(), ...pages], store); vi.setSystemTime(start + 240000);
    expect(await restarted.poller.poll()).toMatchObject({ status: 'backlog', newMessages: 0, duplicates: 60 });
  });
  it('completes a bounded two-page window without following supplied navigation links', async () => {
    const { poller, http, store } = setup([jwt(), page([sms()], 1, 2), page([sms('300002')], 2, 2)]);
    await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'ok', newMessages: 2 }); expect(http.audit()).toHaveLength(3);
    expect(store.state?.completedThrough).toBe(new Date(start + 110000).toISOString());
  });
  it('accepts a legitimately empty zero-page envelope without broadening the scan', async () => {
    const { poller, http } = setup([jwt(), page([], 1, 0)]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'ok', newMessages: 0 }); expect(http.audit()).toHaveLength(2);
  });
  it('reauthenticates an expired cached token on a later cycle without retrying a request', async () => {
    const { poller, http } = setup([jwt({ expires_in: 6 }), page([]), jwt(), page([])]);
    await poller.poll(); vi.setSystemTime(start + 120000); expect((await poller.poll()).status).toBe('ok');
    vi.setSystemTime(start + 240000); expect((await poller.poll()).status).toBe('ok');
    expect(http.audit().map(x => x.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
  });
  it.each([
    sms('300001', { ownerId: '200002' }),
    sms('300001', { uri: 'https://platform.ringcentral.com/restapi/v1.0/account/100001/extension/200002/message-store/300001' }),
    sms('300001', { creationTime: '2026-11-15T12:00:30' }),
  ])('rejects conflicting owner identity or ambiguous record timestamp %#', async record => {
    const { poller, store } = setup([jwt(), page([record])]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect((await poller.poll()).status).toBe('error'); expect(store.state?.seen).toEqual([]);
  });
  it.each([{ owner_id: '200002' }, { scope: 'ReadMessages SMS' }, { token_type: 'Basic' }])('stops on unsafe OAuth grant %# before listing', async patch => {
    const { poller, http, store } = setup([jwt(patch)]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect((await poller.poll()).status).toBe('error'); expect(http.audit()).toHaveLength(1); expect(store.state?.completedThrough).toBe(new Date(start).toISOString());
  });
  it('blocks invalid JWT authentication until operator review instead of repeating it every interval', async () => {
    const { poller, http, store } = setup([{ status: 401, body: JSON.stringify({ errorCode: 'OAU-146' }) }]);
    await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'error', httpStatus: 401, oauthErrorCode: 'OAU-146' }); expect(store.state?.authBlocked).toBe(true);
    vi.setSystemTime(start + 240000);
    expect(await poller.poll()).toMatchObject({ errorCategory: 'authentication_review_required' }); expect(http.audit()).toHaveLength(1);
  });
  it('invalidates an expired API token without refreshing or retrying the failed GET', async () => {
    const { poller, http } = setup([jwt(), { status: 401, body: '{}' }, jwt(), page([])]);
    await poller.poll(); vi.setSystemTime(start + 120000);
    expect(await poller.poll()).toMatchObject({ status: 'error', httpStatus: 401 }); expect(http.audit()).toHaveLength(2);
    vi.setSystemTime(start + 240000); expect((await poller.poll()).status).toBe('ok'); expect(http.audit()).toHaveLength(4);
  });
  it('honors rate-limit Retry-After across restarts and does not advance the checkpoint', async () => {
    const { poller, http, store } = setup([jwt(), { status: 429, body: '{}', headers: { 'Content-Type': 'application/json', 'Retry-After': '600' } }]);
    await poller.poll(); vi.setSystemTime(start + 120000); expect(await poller.poll()).toMatchObject({ httpStatus: 429 });
    expect(http.audit()).toHaveLength(2); expect(store.state?.completedThrough).toBe(new Date(start).toISOString());
    const restarted = setup([jwt(), page([])], store); vi.setSystemTime(start + 240000);
    expect((await restarted.poller.poll()).status).toBe('not_due'); expect(restarted.http.audit()).toHaveLength(0);
    vi.setSystemTime(start + 720000); expect((await restarted.poller.poll()).status).toBe('ok');
  });
  it.each([{ failure: true }, { status: 500, body: '{}' }, { status: 302, headers: { Location: 'https://example.invalid' } }, { body: 'invalid JSON' }, { body: 'x'.repeat(65537) }] as OfflineHttpStep[])('stops safely on list failure %#', async step => {
    const { poller, http, store } = setup([jwt(), step]); await poller.poll(); vi.setSystemTime(start + 120000);
    expect((await poller.poll()).status).toBe('error'); expect(http.audit()).toHaveLength(2); expect(store.state?.completedThrough).toBe(new Date(start).toISOString());
  });
  it('enforces the five-second list deadline and discards late completion', async () => {
    vi.useFakeTimers(); const { poller, http, store } = setup([jwt(), { ...page([sms()]), delayMs: 16000 }]);
    await poller.poll(); vi.setSystemTime(start + 120000); const pending = poller.poll();
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ errorCategory: 'timeout' });
    await vi.advanceTimersByTimeAsync(12000); expect(store.state?.seen).toEqual([]); expect(http.audit()).toHaveLength(2);
  });
  it.each(['oauth', 'list'])('late %s failures cannot overwrite a newer persisted checkpoint', async stage => {
    vi.useFakeTimers();
    const late = { status: stage === 'oauth' ? 401 : 429, body: '{}', delayMs: 16000, headers: { 'Content-Type': 'application/json', 'Retry-After': '600' } };
    const { poller, store } = setup(stage === 'oauth' ? [late] : [jwt(), late]);
    await poller.poll(); vi.setSystemTime(start + 120000); const pending = poller.poll();
    await vi.advanceTimersByTimeAsync(5000); expect((await pending).errorCategory).toBe('timeout');
    vi.setSystemTime(start + 240000);
    const newer = setup([jwt(), page([])], store); expect((await newer.poller.poll()).status).toBe('ok');
    const saved = structuredClone(store.state);
    await vi.advanceTimersByTimeAsync(12000);
    expect(store.state).toEqual(saved); expect(store.state?.notBefore).toBe(null); expect(store.state?.authBlocked).toBe(false);
  });
  it('checks global pause again after pending HTTP before intake or checkpoint completion', async () => {
    vi.useFakeTimers(); let paused = false;
    const observe = vi.fn(), receiver = new OfflineRingCentralReceiver(scope, { observe });
    const { poller, store } = setup([jwt(), { ...page([sms()]), delayMs: 1000 }], new Store(), { paused: () => paused, receiver });
    await poller.poll(); vi.setSystemTime(start + 120000); const pending = poller.poll();
    await vi.advanceTimersByTimeAsync(100); paused = true; await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe('paused'); expect(observe).not.toHaveBeenCalled(); expect(store.state?.seen).toEqual([]);
  });
  it('live polling needs a valid recurring approval; the schedule polls only when explicitly enabled and not paused', async () => {
    expect(POLLING_OWNER_ID).toBe('3322425015'); expect(RINGCENTRAL_POLLING_LIVE_ENABLED).toBe(true);
    const { poller, store, http } = setup([], new Store(), { mode: 'live' });
    expect(await poller.poll()).toMatchObject({ status: 'error', errorCategory: 'approval_invalid' }); expect(store.calls).toBe(0); expect(http.audit()).toHaveLength(0);
    const poll = vi.fn(); const app = createWorker(undefined, undefined, { poll });
    const tick = { cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} };
    await app.scheduled(tick, {}); await app.scheduled(tick, { RINGCENTRAL_POLLING_ENABLED: 'true', RINGCENTRAL_POLLING_PAUSED: 'true' });
    await app.scheduled(tick, { RINGCENTRAL_POLLING_ENABLED: 'true', AI_GLOBAL_PAUSED: 'true' });
    expect(poll).not.toHaveBeenCalled();
    await app.scheduled(tick, { RINGCENTRAL_POLLING_ENABLED: 'true' }); expect(poll).toHaveBeenCalledTimes(1);
  });
  it('validates interval configuration and requires explicit enablement', async () => {
    expect(pollingControls({})).toEqual({ enabled: false, paused: false, intervalSeconds: 120 });
    expect(pollingControls({ AI_GLOBAL_PAUSED: 'true' }).paused).toBe(true);
    for (const interval of [0, 1, 119, 3601, NaN]) expect((await setup([], new Store(), { interval }).poller.poll()).errorCategory).toBe('interval_invalid');
    expect((await setup([], new Store(), { enabled: false }).poller.poll()).status).toBe('disabled');
  });
  it('rejects wrapped network executors before even opening the checkpoint store', async () => {
    const store = new Store(), http = vi.fn(async () => fetch('https://example.invalid'));
    const poller = new RingCentralIncomingPoller({ mode: 'offline', store, http, credentials: createOfflineCredentials('jwt'), controls: () => ({ enabled: true, paused: false }), fixture: { scope } });
    expect((await poller.poll()).status).toBe('disabled'); expect(http).not.toHaveBeenCalled(); expect(store.calls).toBe(0);
  });
  it('fails closed for invalid checkpoint state and excessive catch-up windows', async () => {
    const { poller, store, http } = setup(); await poller.poll();
    store.state!.version = 2 as 1; vi.setSystemTime(start + 120000);
    expect((await poller.poll()).errorCategory).toBe('checkpoint_invalid'); expect(http.audit()).toHaveLength(0);
    store.state!.version = 1; vi.setSystemTime(start + 8 * 86400000);
    expect((await poller.poll()).errorCategory).toBe('backfill_approval_required'); expect(http.audit()).toHaveLength(0);
  });
});
