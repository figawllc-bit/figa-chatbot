import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingCentralReadOnlySession, createOfflineCredentials, exchangeReadOnlyJwt } from '../src/ringcentral/oauth-read-session';
import { PinnedRingCentralTransport, RINGCENTRAL_LIVE_CONNECTION_ENABLED, createOfflineHttp, type OfflineHttpStep } from '../src/ringcentral/secure-transport';
import { digest } from '../src/database/service';
import { READ_LIMIT_BYTES, type SingleAttemptLedger, type SingleMessageApproval } from '../src/ringcentral/read-only-test';
import type { OfflineCredentialFault } from '../src/ringcentral/offline-credentials';
const subject = 'Fictional provider inquiry';
async function approval(): Promise<SingleMessageApproval> { return { host: 'https://platform.devtest.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', expectedDirection: 'Inbound', expectedSubjectSha256: await digest(subject), permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString() }; }
const budget = (): SingleAttemptLedger => ({ authorizedMaximum: 1, reserve: vi.fn(async () => {}) });
const simulate = (...steps: OfflineHttpStep[]) => createOfflineHttp(JSON.stringify(steps));
const token = (patch = {}): OfflineHttpStep => ({ body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001', refresh_token: 'fictional-ignored', ...patch }) });
const sms = (patch = {}): OfflineHttpStep => ({ body: JSON.stringify({ id: '300001', type: 'SMS', direction: 'Inbound', subject, from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], ...patch }) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Phase 7B fixture-only authentication and transport', () => {
  it('matches the documented production JWT request using independently decoded fictional Basic credentials', async () => {
    const credentials = await createOfflineCredentials('jwt', undefined, 'production')();
    if (credentials.kind !== 'jwt') throw Error('fictional fixture incorrect');
    credentials.clientSecret = 'fictional+secret/:=!?';
    const a = { ...await approval(), host: 'https://platform.ringcentral.com' as const };
    const http = simulate(token()), transport = new PinnedRingCentralTransport(a, 'offline', http.executor);
    const send = transport.send.bind(transport);
    const inspect = vi.spyOn(transport, 'send').mockImplementation(async (request, kind) => {
      expect(kind).toBe('oauth'); expect(request.method).toBe('POST'); expect(request.redirect).toBe('manual');
      expect(request.url).toBe('https://platform.ringcentral.com/restapi/oauth/token');
      expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      const header = request.headers.get('Authorization')!;
      expect(header.startsWith('Basic ')).toBe(true);
      expect(atob(header.slice(6))).toBe(credentials.clientId + ':' + credentials.clientSecret);
      const raw = new TextDecoder().decode(await request.clone().arrayBuffer()), form = new URLSearchParams(raw);
      expect([...form.keys()].sort()).toEqual(['assertion', 'grant_type']);
      expect(form.get('assertion')).toBe(credentials.jwt);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(raw).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
      return send(request, kind);
    });
    await exchangeReadOnlyJwt(credentials, a, transport, budget());
    expect(inspect).toHaveBeenCalledOnce(); expect(http.audit()).toHaveLength(1);
  });
  it.each([
    [{ errorCode: 'OAU-146' }, 'OAU-146'],
    [{ errors: [{ errorCode: 'OAU-125', message: 'FICTIONAL_SENSITIVE_DESCRIPTION' }] }, 'OAU-125'],
    [{ errorCode: 'CMN-301' }, 'CMN-301'],
    [{ errorCode: 'FICTIONAL_SECRET_TOKEN', error_description: 'FICTIONAL_SENSITIVE_DESCRIPTION' }, null],
    [{ errorCode: 'OAU-146\nFICTIONAL_SECRET_TOKEN' }, null],
    [{ errorCode: { value: 'OAU-146' } }, null],
    [{ errorCode: 'OAU-146-extra' }, null],
    [{ error: 'invalid_client', error_description: 'FICTIONAL_SENSITIVE_DESCRIPTION' }, null],
    [null, null],
    [[], null],
  ] as const)('keeps only a bounded OAuth numeric code from error fixture %#', async (value, code) => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const http = simulate({ status: 401, body: JSON.stringify(value) });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, budget(), budget());
    const error = await session.read().catch(e => e);
    expect(error).toMatchObject({ category: 'http_status', httpStatus: 401, oauthErrorCode: code });
    expect(JSON.stringify(error)).not.toMatch(/FICTIONAL_|description|error_description|invalid_client/);
    expect(http.audit()).toHaveLength(1); expect(session.attempts.message).toBe(0);
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' });
    expect(http.audit()).toHaveLength(1); logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });
  it.each([
    { body: 'FICTIONAL_PRIVATE_HTML', headers: { 'Content-Type': 'text/html' } },
    { body: 'FICTIONAL_PRIVATE_INVALID_JSON' },
    { body: JSON.stringify({ errorCode: 'OAU-146', privateData: 'x'.repeat(READ_LIMIT_BYTES) }) },
    { body: JSON.stringify({ errorCode: 'OAU-146' }), headers: { 'Content-Type': 'application/json', 'Content-Length': String(READ_LIMIT_BYTES + 1) } },
  ] as OfflineHttpStep[])('discards malformed or oversized OAuth errors %# without changing request limits', async step => {
    const http = simulate({ ...step, status: 401 });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, budget(), budget());
    const error = await session.read().catch(e => e);
    expect(error).toMatchObject({ category: 'http_status', httpStatus: 401, oauthErrorCode: null });
    expect(JSON.stringify(error)).not.toMatch(/FICTIONAL_|privateData|OAU-146/);
    expect(session.attempts).toEqual({ oauth: 1, message: 0 }); expect(http.audit()).toHaveLength(1);
  });
  it('applies the original five-second deadline to a stalled OAuth error body without retries', async () => {
    vi.useFakeTimers();
    const http = simulate({ status: 401, stalledBody: true });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, budget(), budget());
    const pending = session.read().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ category: 'timeout', oauthErrorCode: null });
    expect(session.attempts).toEqual({ oauth: 1, message: 0 }); expect(http.audit()).toHaveLength(1);
  });
  it('accepts only serialized simulator data and fixed credential selectors', () => {
    const callback = vi.fn();
    expect(() => createOfflineHttp(callback as never)).toThrow();
    expect(() => createOfflineHttp(JSON.stringify([{ executor: 'fetch' }]))).toThrow();
    expect(() => createOfflineCredentials('UNAPPROVED_TOKEN_SENTINEL' as never)).toThrow();
    expect(() => createOfflineCredentials('jwt', { clientSecret: 'UNAPPROVED_SECRET_SENTINEL' } as never)).toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
  it.each([undefined, 'live'] as const)('rejects disabled mode %s before accessing providers or ledger', async mode => {
    const inject = vi.fn(), http = vi.fn(), read = budget();
    expect(RINGCENTRAL_LIVE_CONNECTION_ENABLED).toBe(false);
    await expect(new RingCentralReadOnlySession({ mode, approval: await approval() }, inject, http, read).read()).rejects.toMatchObject({ category: 'disabled' });
    expect(inject).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(read.reserve).not.toHaveBeenCalled();
  });
  it.each(['wrapper', 'bound', 'proxy', 'forged'])('rejects %s network executors without invoking them', async kind => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const wrapper = vi.fn(async (r: Request) => fetch(r));
    const executor = kind === 'bound' ? fetch.bind(globalThis) : kind === 'proxy' ? new Proxy(wrapper, {}) : kind === 'forged' ? Object.assign(wrapper, { offline: true }) : wrapper;
    const read = budget();
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), executor, read, budget()).read()).rejects.toMatchObject({ category: 'disabled' });
    expect(network).not.toHaveBeenCalled(); expect(wrapper).not.toHaveBeenCalled(); expect(read.reserve).not.toHaveBeenCalled();
  });
  it.each(['jwt', 'access_token', 'wrapped_fixture', 'forged_provider'])('rejects arbitrary credential providers: %s', async kind => {
    const fixture = createOfflineCredentials('access_token');
    // Sentinel values only: no actual credential is read or constructed.
    const inject = vi.fn(kind === 'wrapped_fixture' ? () => fixture() : async () => ({ kind, jwt: 'UNAPPROVED_JWT_SENTINEL', clientSecret: 'UNAPPROVED_SECRET_SENTINEL', accessToken: 'UNAPPROVED_TOKEN_SENTINEL' }));
    if (kind === 'forged_provider') Object.assign(inject, { offline: true });
    const http = simulate(sms()), read = budget();
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, inject as never, http.executor, read).read()).rejects.toMatchObject({ category: 'credentials_invalid' });
    expect(inject).not.toHaveBeenCalled(); expect(read.reserve).not.toHaveBeenCalled(); expect(http.audit()).toHaveLength(0);
  });
  it('simulates one JWT exchange and one GET with truthful permission evidence', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const http = simulate(token(), sms()), read = budget(), oauth = budget();
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, read, oauth);
    const result = await session.read();
    expect(result).toMatchObject({ mode: 'offline_simulation', expectedTextMatched: true, scopeEvidence: 'fictional_fixture', applicationPermissionsIndependentlyVerified: false });
    expect(session.attempts).toEqual({ oauth: 1, message: 1 }); expect(read.reserve).toHaveBeenCalledOnce(); expect(oauth.reserve).toHaveBeenCalledOnce();
    expect(http.audit()).toEqual([
      { method: 'POST', path: '/restapi/oauth/token', redirect: 'manual', authorizationScheme: 'Basic', formKeys: ['assertion', 'grant_type'], grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer' },
      { method: 'GET', path: '/restapi/v1.0/account/100001/extension/200001/message-store/300001', redirect: 'manual', authorizationScheme: 'Bearer', formKeys: [], grantType: null },
    ]);
    expect(JSON.stringify([result, session, http.audit()])).not.toMatch(/fictional-secret|signature|access-token|refresh|phoneNumber|subject|555/);
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' });
    expect(http.audit()).toHaveLength(2); expect(network).not.toHaveBeenCalled();
  });
  it('simulates a pre-issued token without claiming independent permission verification', async () => {
    const http = simulate(sms()), oauth = budget();
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('access_token'), http.executor, budget(), oauth);
    expect(await session.read()).toMatchObject({ scopeEvidence: 'fictional_fixture', applicationPermissionsIndependentlyVerified: false });
    expect(session.attempts).toEqual({ oauth: 0, message: 1 }); expect(oauth.reserve).not.toHaveBeenCalled();
  });
  it.each([
    ['expired', 'token_expired'], ['short_lived', 'token_expired'], ['scope', 'scope_rejected'], ['legacy_scope', 'scope_rejected'], ['owner', 'owner_mismatch'],
    ['account', 'credentials_invalid'], ['host', 'credentials_invalid'], ['type', 'credentials_invalid'], ['header', 'credentials_invalid'], ['app_permissions', 'scope_rejected'],
  ] as const)('rejects predefined fixture fault %s', async (fault: OfflineCredentialFault, category) => {
    const http = simulate();
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('access_token', fault), http.executor, budget()).read()).rejects.toMatchObject({ category });
    expect(http.audit()).toHaveLength(0);
  });
  it.each([{ scope: 'ReadMessages SMS' }, { scope: '' }, { owner_id: '200002' }, { expires_in: 0 }, { token_type: 'Basic' }, { access_token: 'UNAPPROVED_TOKEN_SENTINEL' }])('rejects unsafe simulated OAuth output %j before GET', async patch => {
    const http = simulate(token(patch));
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, budget(), budget());
    await expect(session.read()).rejects.toBeInstanceOf(Error); expect(http.audit()).toHaveLength(1); expect(session.attempts.message).toBe(0);
  });
  it.each([401, 403, 429, 500])('does not retry OAuth HTTP %i', async status => {
    const http = simulate({ status, body: 'private response' });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, budget(), budget());
    const error = await session.read().catch(e => e);
    expect(error).toMatchObject({ category: 'http_status', httpStatus: status }); expect(JSON.stringify(error)).not.toContain('private');
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(1);
  });
  it.each([401, 403, 429, 500])('does not refresh or retry GET HTTP %i', async status => {
    const http = simulate({ status, body: 'private response' });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('access_token'), http.executor, budget());
    await expect(session.read()).rejects.toMatchObject({ category: 'http_status', httpStatus: status }); expect(http.audit()).toHaveLength(1);
  });
  it.each(['~', '../300001', '300001?readStatus=Read', '300001/content/1'])('rejects invalid ID %s before reservation', async messageId => {
    const http = simulate(), read = budget();
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: { ...await approval(), messageId } }, createOfflineCredentials('access_token'), http.executor, read).read()).rejects.toMatchObject({ category: 'approval_invalid' });
    expect(read.reserve).not.toHaveBeenCalled(); expect(http.audit()).toHaveLength(0);
  });
  it.each([{ subject: 'Unexpected fictional text' }, { id: '300002' }, { direction: 'Outbound' }, { type: 'VoiceMail' }])('validates selected SMS %j', async patch => {
    const http = simulate(sms(patch));
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('access_token'), http.executor, budget()).read()).rejects.toMatchObject({ category: 'message_mismatch' });
  });
  it.each(['jwt', 'access_token'] as const)('sanitizes %s simulated transport failure', async kind => {
    const http = simulate({ failure: true });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials(kind), http.executor, budget(), budget());
    const error = await session.read().catch(e => e);
    expect(error).toMatchObject({ category: 'transport' }); expect(http.audit()).toHaveLength(1);
  });
  it.each(['jwt', 'access_token'] as const)('%s deadline discards late completion without retry', async kind => {
    vi.useFakeTimers();
    const http = simulate({ ...(kind === 'jwt' ? token() : sms()), delayMs: 20000 });
    const session = new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials(kind), http.executor, budget(), budget());
    const pending = session.read().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000);
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(1);
  });
  it('rechecks token expiry after durable reservation', async () => {
    vi.useFakeTimers();
    const http = simulate(), read = budget(), provider = createOfflineCredentials('access_token'), a = await approval();
    a.expiresAt = new Date(Date.now() + 120000).toISOString();
    vi.mocked(read.reserve).mockImplementation(async () => { await vi.advanceTimersByTimeAsync(60001); });
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: a }, provider, http.executor, read).read()).rejects.toMatchObject({ category: 'token_expired' }); expect(http.audit()).toHaveLength(0);
  });
  it('failed workflow reservation prevents OAuth and GET', async () => {
    const http = simulate(token(), sms()), read = budget(); vi.mocked(read.reserve).mockRejectedValue(new Error('private ledger failure'));
    await expect(new RingCentralReadOnlySession({ mode: 'offline', approval: await approval() }, createOfflineCredentials('jwt'), http.executor, read, budget()).read()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(0);
  });
  it('transport rejects enumeration and OAuth redirect', async () => {
    const http = simulate({ status: 307, headers: { Location: 'https://example.invalid' } }), a = await approval();
    const transport = new PinnedRingCentralTransport(a, 'offline', http.executor);
    await expect(transport.send(new Request(a.host + `/restapi/v1.0/account/${a.accountId}/extension/${a.extensionId}/message-store`, { redirect: 'manual', headers: { Accept: 'application/json', Authorization: 'Bearer fictional' } }), 'message')).rejects.toMatchObject({ category: 'approval_invalid' }); expect(http.audit()).toHaveLength(0);
    await expect(transport.send(new Request(a.host + '/restapi/oauth/token', { method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ZmljdGlvbmFs' } }), 'oauth')).rejects.toMatchObject({ category: 'redirect' }); expect(http.audit()).toHaveLength(1);
  });
});
