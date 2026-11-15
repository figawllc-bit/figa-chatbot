import { env } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DurablePollingStore } from '../src/ringcentral/polling-durable';
import { monitoringCredentials, type MonitoringEnvironment } from '../src/ringcentral/polling-runtime';
import { POLLING_OWNER_ID, RingCentralIncomingPoller, type PollState, type PollingStateStore } from '../src/ringcentral/polling';
import { createOfflineCredentials } from '../src/ringcentral/offline-credentials';
import { createOfflinePollingHttp } from '../src/ringcentral/secure-transport';
import { createWorker } from '../src/index';
import * as polling from '../src/ringcentral/polling';
import { scheduledMonitoring } from '../src/ringcentral/polling-runtime';

const key = 'ringcentral-incoming:' + POLLING_OWNER_ID;
const start = Date.parse('2026-11-15T12:00:00.000Z');
const iso = (n: number) => new Date(n).toISOString();
const state = (): PollState => ({ version: 1, baselineAt: iso(start), completedThrough: iso(start), lastAttemptAt: iso(start), lastSuccessfulCheck: null, notBefore: null, authBlocked: false, seen: [] });
function stub() {
  const ns = (env as MonitoringEnvironment).RINGCENTRAL_MONITOR!;
  return ns.get(ns.idFromName('fictional-test-' + crypto.randomUUID()));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Phase 8B durable receive-only monitoring', () => {
  it('persists exact checkpoint metadata across actual DO eviction', async () => {
    const s = stub();
    await runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async (loaded, save) => { expect(loaded).toBeNull(); await save(state()); });
    });
    await evictDurableObject(s);
    await runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async loaded => { expect(loaded).toEqual(state()); });
    });
  });

  it('serializes competing transactions without losing deduplication updates', async () => {
    const s = stub();
    const add = (hash: string) => runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async (loaded, save) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        const next = loaded ?? state(); next.seen.push({ hash, createdAt: iso(start) }); await save(next);
      });
    });
    await Promise.all([add('a'.repeat(64)), add('b'.repeat(64))]);
    await runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async loaded => { expect(loaded!.seen).toHaveLength(2); });
    });
  });

  it('keeps completed saves after a failed cycle and rejects late writes, foreign owners and content', async () => {
    const s = stub();
    await runInDurableObject(s, async (_instance, ctx) => {
      const store = new DurablePollingStore(ctx); let stale!: (s: PollState) => Promise<void>;
      await expect(store.exclusive(key, async (_loaded, save) => { stale = save; await save(state()); throw Error('fictional interruption'); })).rejects.toThrow('fictional interruption');
      await expect(stale(state())).rejects.toThrow('expired');
      await expect(store.exclusive('ringcentral-incoming:102', async () => {})).rejects.toThrow('owner');
      await expect(store.exclusive(key, async (_loaded, save) => save({ ...state(), subject: 'fictional secret' } as PollState))).rejects.toThrow();
      expect(await ctx.storage.get('checkpoint')).toEqual(state());
    });
  });

  it('recovers a real persisted polling baseline and dedups synthetic SMS after eviction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    const s = stub();
    const poll = () => runInDurableObject(s, async (_instance, ctx) => {
      const durable = new DurablePollingStore(ctx);
      // Fictional adapter maps only the storage key; HTTP and owner remain the
      // registered Phase 8A fictional scope, never the production mailbox.
      const store: PollingStateStore = { exclusive: (_key, work) => durable.exclusive(key, work) };
      const http = createOfflinePollingHttp(JSON.stringify([
        { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, owner_id: '200001', scope: 'ReadMessages' }) },
        { body: JSON.stringify({ records: [{ id: '300001', type: 'SMS', direction: 'Inbound', subject: 'Fictional provider inquiry', from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], messageStatus: 'Received', creationTime: iso(start + 30000) }], paging: { page: 1, perPage: 20, totalPages: 1 } }) }
      ]));
      return new RingCentralIncomingPoller({ mode: 'offline', store, http: http.executor, credentials: createOfflineCredentials('jwt', undefined, 'production'), controls: () => ({ enabled: true, paused: false }),
        fixture: { scope: { accountId: '100001', extensionId: '200001', subscriptionId: 'fictional-subscription', businessNumbers: ['+15035550100'] } } }).poll();
    });
    expect((await poll()).status).toBe('baseline');
    vi.setSystemTime(start + 120000); expect(await poll()).toMatchObject({ status: 'ok', newMessages: 1 });
    await evictDurableObject(s);
    vi.setSystemTime(start + 240000); expect(await poll()).toMatchObject({ status: 'ok', newMessages: 0, duplicates: 1 });
    await runInDurableObject(s, async (_instance, ctx) => {
      expect(JSON.stringify(await ctx.storage.get('checkpoint'))).not.toMatch(/subject|phoneNumber|300001|token|secret|Fictional/);
    });
  });

  it('reads no credentials and makes no request unless polling is enabled, unpaused AND security-approved', async () => {
    const touched = vi.fn(() => { throw Error('No secrets or network'); });
    const make = (extra: Partial<MonitoringEnvironment>): MonitoringEnvironment => ({ RINGCENTRAL_POLLING_ENABLED: 'true', ...extra,
      get RINGCENTRAL_CLIENT_ID() { return touched(); }, get RINGCENTRAL_CLIENT_SECRET() { return touched(); }, get RINGCENTRAL_JWT() { return touched(); } });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network'));
    await expect(monitoringCredentials(make({}))()).rejects.toThrow('disabled');
    await expect(monitoringCredentials(make({ RINGCENTRAL_MONITORING_SECURITY_APPROVED: 'true', RINGCENTRAL_POLLING_PAUSED: 'true' }))()).rejects.toThrow('disabled');
    await expect(createWorker().scheduled({} as ScheduledController, make({}))).rejects.toThrow('Monitoring unavailable');
    // The test Durable Object has no switches configured, so its poll stays disabled.
    expect(await stub().poll()).toMatchObject({ status: 'disabled', newMessages: 0 });
    expect(touched).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it('routes the scheduled task only to the pinned singleton with no automatic retry', async () => {
    // Mock only the outer disabled scheduler gate to inspect future wiring. The
    // real gate and real DO remain disabled; no transport or credentials exist.
    vi.spyOn(polling, 'scheduledPolling').mockImplementation(async (_env, task) => { await task!.poll(); });
    const poll = vi.fn().mockRejectedValue(Error('fictional RPC failure'));
    const idFromName = vi.fn(() => 'fictional-id'), get = vi.fn(() => ({ poll }));
    const bindings = { RINGCENTRAL_MONITORING_SECURITY_APPROVED: 'true', RINGCENTRAL_MONITOR: { idFromName, get } } as unknown as MonitoringEnvironment;
    await expect(scheduledMonitoring(bindings)).rejects.toThrow('fictional RPC failure');
    expect(idFromName).toHaveBeenCalledExactlyOnceWith(key); expect(get).toHaveBeenCalledExactlyOnceWith('fictional-id'); expect(poll).toHaveBeenCalledOnce();
  });

  it('retains authentication holds and rate-limit backoff through eviction', async () => {
    const s = stub(), held = { ...state(), authBlocked: true, notBefore: iso(start + 900000) };
    await runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async (_loaded, save) => { await save(held); });
    });
    await evictDurableObject(s);
    await runInDurableObject(s, async (_instance, ctx) => {
      await new DurablePollingStore(ctx).exclusive(key, async loaded => { expect(loaded).toEqual(held); });
    });
  });

  it('runs scheduled synthetic detection, pauses, rolls back to disabled, and restarts without duplicate intake', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    const ns = (env as MonitoringEnvironment).RINGCENTRAL_MONITOR!, s = ns.get(ns.idFromName(key));
    const bindings: MonitoringEnvironment = { RINGCENTRAL_MONITOR: ns, RINGCENTRAL_POLLING_ENABLED: 'true', RINGCENTRAL_MONITORING_SECURITY_APPROVED: 'true' };
    // Test-only scheduler simulation; production's immutable source gate remains
    // false. RPC and durable storage are real local Cloudflare runtime objects.
    vi.spyOn(polling, 'scheduledPolling').mockImplementation(async (e, task) => {
      const c = polling.pollingControls(e); if (c.enabled && !c.paused) await task!.poll();
    });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('external requests forbidden'));
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const reports: unknown[] = [];
    let requests = 0;
    const install = () => runInDurableObject(s, async (instance, ctx) => {
      const durable = new DurablePollingStore(ctx);
      const http = createOfflinePollingHttp(JSON.stringify([
        { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, owner_id: '200001', scope: 'ReadMessages' }) },
        { body: JSON.stringify({ records: [{ id: '300001', type: 'SMS', direction: 'Inbound', subject: 'Fictional provider inquiry', from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], messageStatus: 'Received', creationTime: iso(start + 30000) }], paging: { page: 1, perPage: 20, totalPages: 1 } }) }
      ]));
      const poller = new RingCentralIncomingPoller({ mode: 'offline', store: { exclusive: (_key, work) => durable.exclusive(key, work) },
        credentials: createOfflineCredentials('jwt', undefined, 'production'), http: http.executor, controls: () => polling.pollingControls(bindings),
        fixture: { scope: { accountId: '100001', extensionId: '200001', subscriptionId: 'fictional-subscription', businessNumbers: ['+15035550100'] } } });
      // RPC exposes prototype methods, never instance-owned properties.
      vi.spyOn(Object.getPrototypeOf(instance) as typeof instance, 'poll').mockImplementation(async () => {
        const before = http.audit().length, report = await poller.poll(); requests += http.audit().length - before; reports.push(report); return report;
      });
    });
    const worker = createWorker();
    await install(); await worker.scheduled({} as ScheduledController, bindings);
    expect(reports.at(-1)).toMatchObject({ status: 'baseline', newMessages: 0 }); expect(requests).toBe(0);
    vi.setSystemTime(start + 120000); await worker.scheduled({} as ScheduledController, bindings);
    expect(reports.at(-1)).toMatchObject({ status: 'ok', newMessages: 1 }); expect(requests).toBe(2);
    bindings.AI_GLOBAL_PAUSED = 'true'; vi.setSystemTime(start + 240000);
    await worker.scheduled({} as ScheduledController, bindings); expect(reports).toHaveLength(2); expect(requests).toBe(2);
    bindings.AI_GLOBAL_PAUSED = 'false'; bindings.RINGCENTRAL_POLLING_ENABLED = 'false';
    await worker.scheduled({} as ScheduledController, bindings); expect(reports).toHaveLength(2);
    await evictDurableObject(s); await install(); bindings.RINGCENTRAL_POLLING_ENABLED = 'true';
    await worker.scheduled({} as ScheduledController, bindings);
    expect(reports.at(-1)).toMatchObject({ status: 'ok', newMessages: 0, duplicates: 1 }); expect(requests).toBe(4);
    expect(network).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled();
    await runInDurableObject(s, async (_instance, ctx) => {
      expect([...(await ctx.storage.list()).keys()]).toEqual(['checkpoint']);
      expect(JSON.stringify(await ctx.storage.get('checkpoint'))).not.toMatch(/phoneNumber|subject|Fictional|300001|token|secret/);
    });
  });
});

describe('operator clearing of an authentication-review block', () => {
  it('clears authBlocked once per distinct value and keeps every other checkpoint field', async () => {
    const s = stub();
    const t = '2026-11-15T12:00:00.000Z';
    const blocked = { version: 1, baselineAt: t, completedThrough: t, lastAttemptAt: t, lastSuccessfulCheck: t, notBefore: null, authBlocked: true,
      seen: [{ hash: 'a'.repeat(64), createdAt: t }] };
    await runInDurableObject(s, async (_i, state) => { await state.storage.put('checkpoint', blocked); await state.storage.delete('auth-review-cleared'); });
    expect(await s.clearAuthReview('2026-11-15')).toBe(true);
    const after = await runInDurableObject(s, async (_i, state) => state.storage.get<PollState>('checkpoint'));
    expect(after).toEqual({ ...blocked, authBlocked: false });
    await runInDurableObject(s, async (_i, state) => { await state.storage.put('checkpoint', blocked); });
    expect(await s.clearAuthReview('2026-11-15')).toBe(false); // same value: never clears again
    expect(await s.clearAuthReview('bad value!')).toBe(false);
    expect((await runInDurableObject(s, async (_i, state) => state.storage.get<PollState>('checkpoint')))?.authBlocked).toBe(true);
  });
});
