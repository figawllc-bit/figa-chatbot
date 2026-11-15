import { afterEach, describe, expect, it, vi } from 'vitest';
import { SingleMessageReadOnlyTestClient, READ_LIMIT_BYTES, type SingleAttemptLedger, type SingleMessageApproval } from '../src/ringcentral/read-only-test';
import { digest } from '../src/database/service';

const subject = 'Fictional group home staffing inquiry';
async function approval(): Promise<SingleMessageApproval> {
  return { host: 'https://platform.devtest.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString(), expectedDirection: 'Inbound', expectedSubjectSha256: await digest(subject) };
}
const sms = () => ({ id: '300001', type: 'SMS', direction: 'Inbound', subject, from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], messageStatus: 'Received', readStatus: 'Unread', attachments: [{ type: 'Text', contentType: 'text/plain', uri: 'https://example.invalid/never-fetch' }] });
function ledger(): SingleAttemptLedger { return { authorizedMaximum: 1, reserve: vi.fn(async () => {}) }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });


import { createOfflineHttp, type OfflineHttpStep } from '../src/ringcentral/secure-transport';
const simulate = (...steps: OfflineHttpStep[]) => createOfflineHttp(JSON.stringify(steps));
const step = (value: unknown = sms()): OfflineHttpStep => ({ body: JSON.stringify(value) });

describe('Isolated SMS reader, declarative offline transport only', () => {
  it.each(['direct', 'wrapped', 'bound', 'proxy', 'forged'] as const)('rejects %s executors before ledger or callback execution', async kind => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const wrapper = vi.fn(async (r: Request) => fetch(r));
    const transport = kind === 'direct' ? fetch : kind === 'bound' ? fetch.bind(globalThis) : kind === 'proxy' ? new Proxy(wrapper, {}) : kind === 'forged' ? Object.assign(wrapper, { offline: true }) : wrapper;
    const budget = ledger();
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, transport, budget).read()).rejects.toMatchObject({ category: 'disabled' });
    expect(budget.reserve).not.toHaveBeenCalled(); expect(wrapper).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('is disabled without opt-in or transport', async () => {
    await expect(new SingleMessageReadOnlyTestClient().read()).rejects.toMatchObject({ category: 'disabled' });
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true }).read()).rejects.toMatchObject({ category: 'disabled' });
  });
  it('sends one pinned GET, returns only metadata and rejects concurrent/repeated reads', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const http = simulate(step()), budget = ledger();
    const client = new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, budget);
    const pending = client.read();
    await expect(client.read()).rejects.toMatchObject({ category: 'budget_unavailable' });
    const result = await pending;
    expect(result).toMatchObject({ mode: 'mock_only', expectedTextMatched: true, messageId: '300001' });
    expect(JSON.stringify(result)).not.toMatch(/subject|phoneNumber|555|uri|token|Unread/);
    expect(http.audit()).toEqual([{ method: 'GET', path: '/restapi/v1.0/account/100001/extension/200001/message-store/300001', redirect: 'manual', authorizationScheme: 'Bearer', formKeys: [], grantType: null }]);
    expect(budget.reserve).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
  });
  it.each([
    { host: 'http://platform.ringcentral.com' }, { host: 'https://platform.ringcentral.com.evil.invalid' }, { host: 'https://platform.ringcentral.com:444' },
    { host: 'https://user:password@platform.ringcentral.com' }, { accountId: '~' }, { extensionId: '../200001' }, { messageId: '300001?readStatus=Read' }, { messageId: '300001/content/300001' },
    { permissions: ['SMS'] }, { permissions: ['ReadMessages', 'SMS'] }, { expectedSubjectSha256: '' }, { purpose: 'read_customer_history' },
    { expiresAt: '2000-01-01T00:00:00Z' }, { expiresAt: 'bad' }, { accessToken: 'never-loaded' }, { expectedFromSha256: 'a'.repeat(64) }, { expectedFromSha256: 'bad', expectedToSha256: 'b'.repeat(64) },
  ])('rejects invalid approval %j before reservation', async patch => {
    const http = simulate(), budget = ledger();
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: { ...await approval(), ...patch } as SingleMessageApproval }, http.executor, budget).read()).rejects.toMatchObject({ category: 'approval_invalid' });
    expect(budget.reserve).not.toHaveBeenCalled(); expect(http.audit()).toHaveLength(0);
  });
  it.each([301, 302, 303, 307, 308, 401, 403, 404, 429, 500])('never redirects or retries HTTP %i', async status => {
    const http = simulate({ status, body: 'private error', headers: { Location: 'https://example.invalid' } });
    const client = new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, ledger());
    const error = await client.read().catch(e => e);
    expect(error).toMatchObject({ category: status < 400 ? 'redirect' : 'http_status', httpStatus: status });
    expect(JSON.stringify(error)).not.toContain('private');
    await expect(client.read()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(1);
  });
  it.each([
    { type: 'VoiceMail' }, { id: '300002' }, { direction: 'Outbound' }, { subject: 'Unapproved fictional text' },
    { uri: 'https://example.invalid/wrong' }, { attachments: [{ type: 'AudioRecording', contentType: 'audio/wav' }] },
  ])('rejects mismatched message %j', async patch => {
    const http = simulate(step({ ...sms(), ...patch }));
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, ledger()).read()).rejects.toMatchObject({ category: 'message_mismatch' });
    expect(http.audit()).toHaveLength(1);
  });
  it.each([true, false])('bounds streamed/declared response size, declared=%s', async declared => {
    const http = simulate({ body: 'x'.repeat(READ_LIMIT_BYTES + 1), headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(READ_LIMIT_BYTES + 1) } : {}) } });
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, ledger()).read()).rejects.toMatchObject({ category: 'response_size' });
  });
  it.each([{ body: '{invalid' }, { body: '{}', headers: { 'Content-Type': 'text/plain' } }, step({ records: [sms()] })])('rejects malformed/non-JSON/list response', async response => {
    const http = simulate(response);
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, ledger()).read()).rejects.toBeInstanceOf(Error);
  });
  it.each([true, false])('bounds stalled body or late response, stalled=%s', async stalled => {
    vi.useFakeTimers();
    const http = simulate({ ...step(), ...(stalled ? { stalledBody: true } : { delayMs: 20000 }) });
    const client = new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, ledger());
    const pending = client.read().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000);
    await expect(client.read()).rejects.toMatchObject({ category: 'budget_unavailable' }); expect(http.audit()).toHaveLength(1);
  });
  it('does not dispatch after failed durable reservation', async () => {
    const http = simulate(step()), budget = ledger(); vi.mocked(budget.reserve).mockRejectedValue(new Error('private'));
    const client = new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: await approval() }, http.executor, budget);
    const results = await Promise.allSettled([client.read(), client.read()]);
    expect(results.every(r => r.status === 'rejected' && r.reason.category === 'budget_unavailable')).toBe(true);
    expect(budget.reserve).toHaveBeenCalledOnce(); expect(http.audit()).toHaveLength(0);
  });
  it.each(['Inbound', 'Outbound'] as const)('verifies both identities for %s without returning phone numbers', async direction => {
    const value = sms(); value.direction = direction;
    if (direction === 'Outbound') { value.from.phoneNumber = '+15035550100'; value.to[0].phoneNumber = '+15035550110'; }
    const a = { ...await approval(), expectedDirection: direction, expectedFromSha256: await digest(value.from.phoneNumber), expectedToSha256: await digest(value.to[0].phoneNumber) };
    const result = await new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: a }, simulate(step(value)).executor, ledger()).read();
    expect(result.expectedTextMatched).toBe(true); expect(result.expectedIdentitiesMatched).toBe(true); expect(JSON.stringify(result)).not.toMatch(/555|phoneNumber|Sha256/);
  });
  it.each(['from', 'to', 'multiple', 'missing', 'format'])('rejects mismatched/ambiguous identities: %s', async fault => {
    const value = sms(), a = { ...await approval(), expectedFromSha256: await digest(value.from.phoneNumber), expectedToSha256: await digest(value.to[0].phoneNumber) };
    if (fault === 'from') value.from.phoneNumber = '+15035550111';
    if (fault === 'to') value.to[0].phoneNumber = '+15035550101';
    if (fault === 'multiple') value.to.push({ phoneNumber: '+15035550101' });
    if (fault === 'missing') value.to = [];
    if (fault === 'format') value.from.phoneNumber = '5035550110';
    await expect(new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: a }, simulate(step(value)).executor, ledger()).read()).rejects.toMatchObject({ category: 'message_mismatch' });
  });
});
