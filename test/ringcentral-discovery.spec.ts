import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingCentralSmsDiscoverySession, requireLiveSmsDiscovery, RINGCENTRAL_SMS_DISCOVERY_ENABLED, type SmsDiscoveryApproval } from '../src/ringcentral/sms-discovery';
import { DISCOVERY_WINDOW_MS, smsDiscoveryUrl, validateSmsDiscoveryApproval, smsDiscoveryApprovalIssues } from '../src/ringcentral/discovery-approval';
import { createOfflineCredentials } from '../src/ringcentral/offline-credentials';
import { createOfflineHttp, PinnedRingCentralTransport, type OfflineHttpStep } from '../src/ringcentral/secure-transport';
import { READ_LIMIT_BYTES, type SingleAttemptLedger } from '../src/ringcentral/read-only-test';
const budget = (): SingleAttemptLedger => ({ authorizedMaximum: 1, reserve: vi.fn(async () => {}) });
function approval(): SmsDiscoveryApproval {
  const now = Date.now();
  return { operation: 'sms_discovery', approvalId: 'fictional-discovery-001', host: 'https://platform.ringcentral.com', accountId: '100001', extensionId: '200001', permissions: ['ReadMessages'], expiresAt: new Date(now + 60000).toISOString(), dateFrom: new Date(now - DISCOVERY_WINDOW_MS).toISOString(), dateTo: new Date(now).toISOString(), authorizedJwtIdentityConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001' };
}
const token = (patch = {}): OfflineHttpStep => ({ body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001', ...patch }) });
const record = (patch = {}) => ({ id: '300001', type: 'SMS', direction: 'Inbound', creationTime: new Date(Date.now() - 60000).toISOString(), subject: 'Fictional private customer text', from: { name: 'Fictional Sender', phoneNumber: '+15035550110' }, to: [{ name: 'Fictional Business', phoneNumber: '+15035550100' }], uri: 'https://platform.ringcentral.com/restapi/v1.0/account/100001/extension/200001/message-store/300001', ...patch });
const list = (value: unknown = { records: [record()], paging: { page: 1, perPage: 1 }, navigation: { nextPage: { uri: 'https://example.invalid/NEVER_FOLLOW' } } }): OfflineHttpStep => ({ body: JSON.stringify(value) });
function prepare(a = approval(), steps = [token(), list()], workflow = budget(), oauth = budget()) {
  const http = createOfflineHttp(JSON.stringify(steps));
  const session = new RingCentralSmsDiscoverySession({ mode: 'offline', approval: a }, createOfflineCredentials('jwt', undefined, 'production'), http.executor, workflow, oauth);
  return { session, http, workflow, oauth };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('minimal inbound SMS discovery, fixture-only until separately activated', () => {
  it('retains only a safe OAuth code on authentication failure and never lists messages', async () => {
    const { session, http } = prepare(approval(), [{ status: 401, body: JSON.stringify({ errors: [{ errorCode: 'OAU-146', message: 'FICTIONAL_PRIVATE_DESCRIPTION' }], access_token: 'FICTIONAL_PRIVATE_TOKEN' }) }]);
    const error = await session.discover().catch(e => e);
    expect(error).toMatchObject({ category: 'http_status', httpStatus: 401, oauthErrorCode: 'OAU-146' });
    expect(session.authenticationVerified).toBe(false); expect(session.attempts).toEqual({ oauth: 1, discovery: 0 });
    expect(JSON.stringify(error)).not.toMatch(/FICTIONAL_|access_token|message/);
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' });
    expect(http.audit()).toHaveLength(1);
  });
  it('reports a stale window independently of an unexpired approval and then reports both after expiry', () => {
    vi.useFakeTimers();
    const a = approval(), created = Date.now();
    a.expiresAt = new Date(created + 20 * 60000).toISOString();
    expect(smsDiscoveryApprovalIssues(a)).toEqual([]);
    expect(validateSmsDiscoveryApproval(a)).toEqual(a);
    vi.setSystemTime(created + 300000);
    expect(smsDiscoveryApprovalIssues(a)).toEqual([]);
    vi.setSystemTime(created + 300001);
    expect(smsDiscoveryApprovalIssues(a)).toEqual(['window_stale']);
    expect(() => validateSmsDiscoveryApproval(a)).toThrow();
    vi.setSystemTime(created + 20 * 60000);
    expect(smsDiscoveryApprovalIssues(a)).toEqual(['approval_expired', 'window_stale']);
  });
  it('reports every failed authorization check without including field values', () => {
    const a = { ...approval(), expectedOwnerId: '200002', permissions: ['ReadMessages', 'SMS'], dateFrom: 'bad', expiresAt: 'bad' } as unknown as SmsDiscoveryApproval;
    expect(smsDiscoveryApprovalIssues(a)).toEqual(['owner_pin_invalid', 'permissions_invalid', 'expiry_format_invalid', 'window_format_invalid']);
    expect(() => validateSmsDiscoveryApproval(a)).toThrow();
    expect(JSON.stringify(smsDiscoveryApprovalIssues(a))).not.toMatch(/200002|ReadMessages|bad/);
  });
  it('retains an explicitly approved internal owner and rejects a different token owner', async () => {
    const a = { ...approval(), expectedOwnerId: '200001' };
    expect((await prepare(a).session.discover()).status).toBe('selected');
    const { session, http } = prepare({ ...a, accountId: '~', extensionId: '~' }, [token({ owner_id: '200002' })]);
    await expect(session.discover()).rejects.toMatchObject({ category: 'owner_mismatch' });
    expect(http.audit()).toHaveLength(1); expect(session.attempts.discovery).toBe(0);
  });
  it.each([{ expectedOwnerId: '~' }, { expectedOwnerId: null }, { expectedOwnerId: '200002' }])('rejects invalid or conflicting owner pin %j', patch => {
    expect(() => validateSmsDiscoveryApproval({ ...approval(), ...patch } as SmsDiscoveryApproval)).toThrow();
  });
  it('disposal revokes a completed session without creating another response or request', async () => {
    const { session, http } = prepare();
    expect((await session.discover()).status).toBe('selected');
    session.dispose();
    await expect(session.discover()).rejects.toMatchObject({ category: 'disabled' });
    expect(http.audit()).toHaveLength(2);
  });
  it('disposal during OAuth prevents the later list GET', async () => {
    vi.useFakeTimers();
    const { session, http } = prepare(approval(), [{ ...token(), delayMs: 1000 }, list()]);
    const pending = session.discover().catch(e => e);
    await vi.advanceTimersByTimeAsync(100); session.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ category: 'disabled' }); expect(http.audit()).toHaveLength(1);
  });
  it.each([undefined, 'live'] as const)('rejects disabled mode %s before secrets, reservation or HTTP', async mode => {
    const inject = vi.fn(), http = vi.fn(), workflow = budget();
    expect(RINGCENTRAL_SMS_DISCOVERY_ENABLED).toBe(false); expect(requireLiveSmsDiscovery).toThrow();
    await expect(new RingCentralSmsDiscoverySession({ mode, approval: approval() }, inject, http, workflow, budget()).discover()).rejects.toMatchObject({ category: 'disabled' });
    expect(inject).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(workflow.reserve).not.toHaveBeenCalled();
  });
  it('issues one bounded list GET and returns only ID, direction and status', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { session, http, workflow, oauth } = prepare();
    const result = await session.discover();
    expect(result).toEqual({ status: 'selected', messageId: '300001', direction: 'Inbound' });
    expect(session.attempts).toEqual({ oauth: 1, discovery: 1 });
    expect(http.audit().map(r => [r.method, r.path])).toEqual([['POST', '/restapi/oauth/token'], ['GET', '/restapi/v1.0/account/100001/extension/200001/message-store']]);
    expect(JSON.stringify([result, session])).not.toMatch(/subject|phone|555|Sender|Business|private|token|secret|owner/);
    expect(workflow.reserve).toHaveBeenCalledOnce(); expect(oauth.reserve).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled(); logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });
  it('pins exactly SMS, Inbound, perPage=1, page=1 and the explicit seven-day window', () => {
    const a = approval(), url = new URL(smsDiscoveryUrl(a));
    expect([...url.searchParams.keys()].sort()).toEqual(['dateFrom', 'dateTo', 'direction', 'messageType', 'page', 'perPage']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ messageType: 'SMS', direction: 'Inbound', perPage: '1', page: '1', dateFrom: a.dateFrom, dateTo: a.dateTo });
    expect(Date.parse(a.dateTo) - Date.parse(a.dateFrom)).toBe(604800000);
  });
  it.each([['~', '~'], ['~', '200001'], ['100001', '~']])('binds supported %s / %s aliases to actual OAuth owner', async (accountId, extensionId) => {
    const a = { ...approval(), accountId, extensionId }, { session, http } = prepare(a);
    expect(await session.discover()).toEqual({ status: 'selected', messageId: '300001', direction: 'Inbound' });
    expect(http.audit()[1].path).toBe(`/restapi/v1.0/account/${accountId}/extension/${extensionId}/message-store`);
  });
  it.each([
    { host: 'https://platform.devtest.ringcentral.com' }, { host: 'https://evil.invalid' }, { accountId: '../~' }, { extensionId: '200001?x=1' }, { permissions: ['ReadMessages', 'SMS'] },
    { authorizedJwtIdentityConfirmed: false }, { independentReadMessagesOnlyEvidence: '' }, { approvalId: '../escape' }, { perPage: 2 }, { direction: 'Outbound' },
    { dateFrom: '2000-01-01T00:00:00.000Z' }, { dateTo: 'bad' }, { expiresAt: '2000-01-01T00:00:00.000Z' },
  ])('rejects invalid approval/query override %j before any credential or HTTP use', async patch => {
    const a = { ...approval(), ...patch } as SmsDiscoveryApproval;
    const http = createOfflineHttp('[]'), inject = vi.fn(), workflow = budget();
    await expect(new RingCentralSmsDiscoverySession({ mode: 'offline', approval: a }, inject, http.executor, workflow).discover()).rejects.toMatchObject({ category: 'approval_invalid' });
    expect(workflow.reserve).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled(); expect(http.audit()).toHaveLength(0);
  });
  it.each(['future', 'stale', 'short', 'long', 'noncanonical'])('rejects %s time window', fault => {
    const a = approval();
    if (fault === 'future') { a.dateTo = new Date(Date.now() + 1000).toISOString(); a.dateFrom = new Date(Date.parse(a.dateTo) - DISCOVERY_WINDOW_MS).toISOString(); }
    if (fault === 'stale') { a.dateTo = new Date(Date.now() - 300001).toISOString(); a.dateFrom = new Date(Date.parse(a.dateTo) - DISCOVERY_WINDOW_MS).toISOString(); }
    if (fault === 'short') a.dateFrom = new Date(Date.parse(a.dateFrom) + 1000).toISOString();
    if (fault === 'long') a.dateFrom = new Date(Date.parse(a.dateFrom) - 1000).toISOString();
    if (fault === 'noncanonical') a.dateTo = a.dateTo.replace('.000Z', 'Z') + ' ';
    expect(() => validateSmsDiscoveryApproval(a)).toThrow();
  });
  it('does not broaden or paginate an empty result', async () => {
    const { session, http } = prepare(approval(), [token(), list({ records: [], navigation: { nextPage: { uri: 'https://example.invalid' } } })]);
    expect(await session.discover()).toEqual({ status: 'no_matching_sms', messageId: null, direction: null });
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(2);
  });
  it.each([
    { scope: 'ReadMessages SMS' }, { scope: 'Messages' }, { scope: '' }, { owner_id: '200002' }, { owner_id: '~' }, { owner_id: undefined },
    { owner_id: 200001 }, { token_type: 'Basic' }, { expires_in: 0 }, { access_token: 'UNAPPROVED_TOKEN_SENTINEL' },
  ])('rejects invalid actual grant %j without list request', async patch => {
    const { session, http } = prepare(approval(), [token(patch)]);
    await expect(session.discover()).rejects.toBeInstanceOf(Error); expect(http.audit()).toHaveLength(1); expect(session.attempts.discovery).toBe(0);
  });
  it('requires a numeric owner even when extension is unknown', async () => {
    const { session, http } = prepare({ ...approval(), extensionId: '~' }, [token({ owner_id: '~' })]);
    await expect(session.discover()).rejects.toMatchObject({ category: 'owner_mismatch' }); expect(http.audit()).toHaveLength(1);
  });
  it('retains known credential-owner binding even when request uses aliases', async () => {
    const { session, http } = prepare({ ...approval(), accountId: '~', extensionId: '~' }, [token({ owner_id: '200002' })]);
    await expect(session.discover()).rejects.toMatchObject({ category: 'owner_mismatch' }); expect(http.audit()).toHaveLength(1);
  });
  it.each([
    { type: 'VoiceMail' }, { direction: 'Outbound' }, { id: '../private' }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { creationTime: 'bad' }, { creationTime: '2000-01-01T00:00:00.000Z' }, { creationTime: '2099-01-01T00:00:00.000Z' },
    { uri: 'https://platform.ringcentral.com/restapi/v1.0/account/100001/extension/200002/message-store/300001' },
    { uri: 'https://platform.ringcentral.com/restapi/v1.0/account/100002/extension/200001/message-store/300001' },
    { uri: 'https://evil.invalid/private' },
  ])('rejects unexpected record %j without leaking it', async patch => {
    const { session, http } = prepare(approval(), [token(), list({ records: [record(patch)] })]);
    const error = await session.discover().catch(e => e);
    expect(error).toMatchObject({ category: 'message_mismatch' }); expect(JSON.stringify(error)).not.toMatch(/private|555|subject|Sender/); expect(http.audit()).toHaveLength(2);
  });
  it.each([{ records: [record(), record()] }, { records: 'invalid' }, [], { records: [], paging: { page: 2, perPage: 1 } }, { records: [record()], paging: { perPage: 100 } }])('rejects malformed or overbroad envelopes', async value => {
    const { session } = prepare(approval(), [token(), list(value)]);
    await expect(session.discover()).rejects.toMatchObject({ category: 'response_format' });
  });
  it.each([301, 302, 307, 308, 401, 403, 429, 500])('never retries/follows list HTTP %i', async status => {
    const { session, http } = prepare(approval(), [token(), { status, body: 'Fictional private failure', headers: { Location: 'https://example.invalid' } }]);
    const error = await session.discover().catch(e => e);
    expect(error).toMatchObject({ category: status < 400 ? 'redirect' : 'http_status', httpStatus: status });
    expect(JSON.stringify(error)).not.toContain('private');
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(2);
  });
  it.each([true, false])('bounds declared/streamed bytes, declared=%s', async declared => {
    const { session } = prepare(approval(), [token(), { body: 'x'.repeat(READ_LIMIT_BYTES + 1), headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(READ_LIMIT_BYTES + 1) } : {}) } }]);
    await expect(session.discover()).rejects.toMatchObject({ category: 'response_size' });
  });
  it.each([{ body: '{private invalid' }, { body: '{}', headers: { 'Content-Type': 'text/plain' } }])('rejects invalid JSON/content type safely', async step => {
    const { session } = prepare(approval(), [token(), step]);
    const error = await session.discover().catch(e => e);
    expect(error).toMatchObject({ category: 'response_format' }); expect(JSON.stringify(error)).not.toContain('private');
  });
  it.each(['oauth', 'list', 'body'])('bounds %s at five seconds and ignores late results', async stage => {
    vi.useFakeTimers();
    const { session, http } = prepare(approval(), [stage === 'oauth' ? { ...token(), delayMs: 20000 } : token(), stage === 'body' ? { stalledBody: true } : { ...list(), delayMs: 20000 }]);
    const pending = session.discover().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000);
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(stage === 'oauth' ? 1 : 2);
  });
  it('sanitizes network failure and prevents concurrent/repeated calls', async () => {
    const { session, http } = prepare(approval(), [token(), { failure: true }]);
    const pending = session.discover();
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' });
    await expect(pending).rejects.toMatchObject({ category: 'transport' }); expect(http.audit()).toHaveLength(2);
  });
  it('rejects wrapped network and credential providers before invocation', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const wrapper = vi.fn(async (request: Request) => fetch(request)), inject = vi.fn();
    await expect(new RingCentralSmsDiscoverySession({ mode: 'offline', approval: approval() }, inject, wrapper, budget(), budget()).discover()).rejects.toMatchObject({ category: 'disabled' });
    const http = createOfflineHttp('[]');
    await expect(new RingCentralSmsDiscoverySession({ mode: 'offline', approval: approval() }, inject, http.executor, budget(), budget()).discover()).rejects.toMatchObject({ category: 'credentials_invalid' });
    expect(network).not.toHaveBeenCalled(); expect(wrapper).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled();
  });
  it('stops before OAuth on workflow ledger failure', async () => {
    const workflow = budget(); vi.mocked(workflow.reserve).mockRejectedValue(new Error('private ledger path'));
    const { session, http } = prepare(approval(), [token(), list()], workflow);
    await expect(session.discover()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(0);
  });
  it('never accepts pre-issued access tokens for owner-bound discovery', async () => {
    const http = createOfflineHttp('[]');
    const session = new RingCentralSmsDiscoverySession({ mode: 'offline', approval: approval() }, createOfflineCredentials('access_token', undefined, 'production'), http.executor, budget(), budget());
    await expect(session.discover()).rejects.toMatchObject({ category: 'credentials_invalid' }); expect(http.audit()).toHaveLength(0);
  });
  it('pins transport, requires owner binding, and forbids mutated filters, pagination and method override', async () => {
    const a = approval(), http = createOfflineHttp(JSON.stringify([list()])), transport = new PinnedRingCentralTransport(a, 'offline', http.executor);
    const request = (url: string, extra = {}) => new Request(url, { redirect: 'manual', headers: { Accept: 'application/json', Authorization: 'Bearer fictional-issued-access-token', ...extra } });
    await expect(transport.send(request(smsDiscoveryUrl(a)), 'discovery')).rejects.toMatchObject({ category: 'owner_mismatch' });
    expect(() => transport.bindDiscoveryOwner('200002')).toThrow(); transport.bindDiscoveryOwner('200001');
    for (const mutation of ['perPage=100', 'page=2', 'direction=Outbound', 'messageType=VoiceMail', '_method=DELETE']) {
      await expect(transport.send(request(smsDiscoveryUrl(a) + '&' + mutation), 'discovery')).rejects.toMatchObject({ category: 'approval_invalid' });
    }
    await expect(transport.send(request(smsDiscoveryUrl(a), { 'X-HTTP-Method-Override': 'DELETE' }), 'discovery')).rejects.toMatchObject({ category: 'approval_invalid' });
    await expect(transport.send(request(a.host + '/restapi/v1.0/account/100001/extension'), 'discovery')).rejects.toMatchObject({ category: 'approval_invalid' });
    expect(http.audit()).toHaveLength(0);
  });
});
