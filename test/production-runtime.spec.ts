import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { productionReadiness, productionStaffBot, productionWorkflow, productionScope, workerFetch, RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED, type ProductionEnvironment } from '../src/production/runtime';
import { RingCentralIncomingPoller, POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED } from '../src/ringcentral/polling';
import { RINGCENTRAL_SMS_DELIVERY_ENABLED } from '../src/ringcentral/sms-sender';
import { createOfflineCredentials } from '../src/ringcentral/offline-credentials';
import { createOfflinePollingHttp } from '../src/ringcentral/secure-transport';
import { createWorker } from '../src/index';

// Inert, fictional placeholders shaped like real configuration. Never real credentials.
const full: ProductionEnvironment = {
  FIGA_PRIVACY_APPROVED: 'true', RINGCENTRAL_MONITORING_SECURITY_APPROVED: 'true', RINGCENTRAL_POLLING_ENABLED: 'true', RINGCENTRAL_POLLING_PAUSED: 'false',
  RINGCENTRAL_POLLING_APPROVAL_JSON: '{"operation":"receive_only_polling"}', RINGCENTRAL_CLIENT_ID: 'fictional-read-client', RINGCENTRAL_CLIENT_SECRET: 'fictional-read-secret', RINGCENTRAL_JWT: 'fictional.read.jwt',
  RINGCENTRAL_ACCOUNT_ID: '400123456', RINGCENTRAL_SMS_NUMBERS: '+15415550100, +15415550101', RINGCENTRAL_SMS_SENDING_ENABLED: 'true',
  RINGCENTRAL_SMS_CLIENT_ID: 'fictional-sms-client', RINGCENTRAL_SMS_CLIENT_SECRET: 'fictional-sms-secret', RINGCENTRAL_SMS_JWT: 'fictional.sms.jwt',
  SUPABASE_PRODUCTION_ENABLED: 'true', SUPABASE_PRODUCTION_PROJECT_REF: 'figaprod01', SUPABASE_PRODUCTION_URL: 'https://figaprod01.supabase.co', SUPABASE_PRODUCTION_SECRET_KEY: 'sb_secret_inert_test_fixture',
  AI_ENABLED: 'true', AI_PROVIDER: 'workers-ai', AI_PRODUCTION_DATA_APPROVED: 'true', AI: { run: vi.fn() } as unknown as ProductionEnvironment['AI'],
  TELEGRAM_STAFF_ENABLED: 'true', TELEGRAM_LIVE_ENABLED: 'true', TELEGRAM_POLLING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '1234567:fictional_token_value_abcdef',
};

describe('production wiring: reading approved in code, sending still locked; env approvals gate everything', () => {
  it('reading locks are on (stage 2); the sending lock stays off until the test text', () => {
    expect([RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED, RINGCENTRAL_POLLING_LIVE_ENABLED, RINGCENTRAL_SMS_DELIVERY_ENABLED]).toEqual([true, true, false]);
  });
  it('an empty environment lists every missing approval, switch and credential by name', () => {
    const r = productionReadiness({});
    expect(r.processing).toEqual(expect.arrayContaining(['approval: FIGA_PRIVACY_APPROVED', 'secret: RINGCENTRAL_JWT', 'var: RINGCENTRAL_ACCOUNT_ID', 'var: RINGCENTRAL_SMS_NUMBERS', 'secret/var: SUPABASE_PRODUCTION_* (separate production project)']));
    expect(r.sending).toEqual(expect.arrayContaining(['var: RINGCENTRAL_SMS_SENDING_ENABLED', 'secret: RINGCENTRAL_SMS_JWT']));
    expect(r.ai).toContain('approval: AI_PRODUCTION_DATA_APPROVED');
    expect(r.telegram).toContain('secret: TELEGRAM_BOT_TOKEN (rotate first)');
  });
  it('with everything configured, processing is ready and only the sending code lock blocks sending; values never appear', () => {
    const r = productionReadiness(full);
    expect(r.processing).toEqual([]);
    expect(r.sending).toEqual(['code: RINGCENTRAL_SMS_DELIVERY_ENABLED is false']);
    expect(r.ai).toEqual([]); expect(r.telegram).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/fictional|sb_secret|400123456|5415550100|1234567/);
  });
  it('a pause blocks processing even when everything else is ready', () => {
    expect(productionReadiness({ ...full, AI_GLOBAL_PAUSED: 'true' }).processing).toContain('var: RINGCENTRAL_POLLING_PAUSED / AI_GLOBAL_PAUSED is on');
  });
  it('the live workflow is built only with every approval, and building it touches no network', () => {
    const http = vi.fn();
    expect(productionWorkflow({ ...full, FIGA_PRIVACY_APPROVED: 'false' }, http as unknown as typeof fetch)).toBeNull();
    expect(productionWorkflow({ ...full, RINGCENTRAL_POLLING_APPROVAL_JSON: undefined }, http as unknown as typeof fetch)).toBeNull();
    expect(productionWorkflow({ ...full, AI_GLOBAL_PAUSED: 'true' }, http as unknown as typeof fetch)).toBeNull();
    expect(productionWorkflow(full, http as unknown as typeof fetch)).not.toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
  it('the staff bot needs its own Telegram readiness (rotated token, production DB, polling switch)', () => {
    expect(productionStaffBot({ ...full, TELEGRAM_POLLING_ENABLED: 'false' })).toBeNull();
    expect(productionStaffBot({ ...full, SUPABASE_PRODUCTION_ENABLED: 'false' })).toBeNull();
    const http = vi.fn();
    expect(productionStaffBot(full, http as unknown as typeof fetch)).not.toBeNull(); expect(http).not.toHaveBeenCalled();
  });
  it('the scope matches the deployment profile fields', () => {
    expect(productionScope(full)).toEqual({ accountId: '400123456', extensionId: POLLING_OWNER_ID, subscriptionId: 'figa-polling', businessNumbers: ['+15415550100', '+15415550101'] });
    expect(productionReadiness({ ...full, RINGCENTRAL_SMS_NUMBERS: '+15415550100,not-a-number' }).processing).toContain('var: RINGCENTRAL_SMS_NUMBERS');
  });
  it('the live poller refuses to run without a valid recurring approval, before credentials or network', async () => {
    const credentials = vi.fn(), http = vi.fn(), sink = { process: vi.fn() };
    const poller = new RingCentralIncomingPoller({ mode: 'live', store: { exclusive: vi.fn() }, credentials, http, controls: () => ({ enabled: true, paused: false }),
      live: { scope: productionScope(full), sink } });
    expect(await poller.poll()).toMatchObject({ status: 'error', errorCategory: 'approval_invalid' });
    expect(credentials).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(sink.process).not.toHaveBeenCalled();
  });
  it('an offline poller can never carry a live sink', async () => {
    const http = createOfflinePollingHttp('[]'), sink = { process: vi.fn() };
    const poller = new RingCentralIncomingPoller({ mode: 'offline', store: { exclusive: vi.fn() }, credentials: createOfflineCredentials('jwt'), http: http.executor,
      controls: () => ({ enabled: true, paused: false }), live: { scope: productionScope(full), sink } });
    expect(await poller.poll()).toMatchObject({ status: 'disabled' }); expect(http.audit()).toHaveLength(0);
  });
  it('the Durable Object staff pass and the scheduled handler are inert without Telegram configuration', async () => {
    const monitor = env.RINGCENTRAL_MONITOR!; const stub = monitor.get(monitor.idFromName('ringcentral-incoming:' + POLLING_OWNER_ID));
    expect(await stub.staff()).toEqual({ status: 'disabled', processed: 0 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await createWorker().scheduled({} as ScheduledController, { ...env, TELEGRAM_POLLING_ENABLED: 'true' } as never);
    // Polling enabled without the monitoring security approval: refused, still no request.
    await expect(createWorker().scheduled({} as ScheduledController, { ...env, RINGCENTRAL_POLLING_ENABLED: 'true' } as never)).rejects.toThrow('Monitoring unavailable');
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
});

describe('production transport', () => {
  it('forwards the method, API key header and body to fetch (regression: a one-argument wrapper dropped them)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    try {
      const { productionSmsRepository } = await import('../src/ringcentral/sms-workflow');
      await productionSmsRepository(full, workerFetch).pending();
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://figaprod01.supabase.co/rest/v1/rpc/figa_rc_sms_pending');
      expect(init.method).toBe('POST'); expect((init.headers as Record<string, string>).apikey).toBe('sb_secret_inert_test_fixture'); expect(init.body).toBe('{}');
    } finally { spy.mockRestore(); }
  });
});
