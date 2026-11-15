import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareLiveOneTimeRead, prepareOfflineOneTimeRead, validateOneTimeReadApproval, requireOneTimeLiveAuthorization, ONE_TIME_RINGCENTRAL_RUNNER_ENABLED, type OneTimeReadApproval } from '../src/ringcentral/one-time-runner';
import { digest } from '../src/database/service';
import type { SingleAttemptLedger } from '../src/ringcentral/read-only-test';
const budget = (): SingleAttemptLedger => ({ authorizedMaximum: 1, reserve: vi.fn(async () => {}) });
const subject = 'Fictional Phase 7B controlled SMS';
async function approval(): Promise<OneTimeReadApproval> {
  return { approvalId: 'fictional-run-001', appName: 'FIGA Chatbot Read-Only', privateProductionJwtAppConfirmed: true,
    authorizedExtensionConfirmed: true, fictionalMessageConfirmed: true, independentReadMessagesOnlyEvidence: 'fictional-evidence-001', authorizedRequests: ['oauth_token', 'one_sms_get'],
    message: { host: 'https://platform.ringcentral.com', accountId: '100001', extensionId: '200001', messageId: '300001', permissions: ['ReadMessages'], purpose: 'fictional_sms_verification', expiresAt: new Date(Date.now() + 60000).toISOString(), expectedDirection: 'Inbound', expectedSubjectSha256: await digest(subject), expectedFromSha256: await digest('+15035550110'), expectedToSha256: await digest('+15035550100') } };
}
const responses = (tokenPatch = {}, smsPatch = {}, delayMs = 0) => JSON.stringify([
  { body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'bearer', expires_in: 3600, scope: 'ReadMessages', owner_id: '200001', ...tokenPatch }), delayMs },
  { body: JSON.stringify({ id: '300001', type: 'SMS', direction: 'Inbound', subject, from: { phoneNumber: '+15035550110' }, to: [{ phoneNumber: '+15035550100' }], ...smsPatch }) },
]);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('one-time local production read runner, disabled and offline tested', () => {
  it('cannot activate live execution or invoke native fetch, credential prompts or ledgers', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const credentials = vi.fn(), http = vi.fn((r: Request) => fetch(r)), read = budget(), oauth = budget();
    expect(ONE_TIME_RINGCENTRAL_RUNNER_ENABLED).toBe(false);
    expect(requireOneTimeLiveAuthorization).toThrow();
    const a = await approval();
    expect(() => prepareLiveOneTimeRead(a, credentials, http, read, oauth)).toThrow();
    expect(credentials).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(read.reserve).not.toHaveBeenCalled(); expect(oauth.reserve).not.toHaveBeenCalled();
  });
  it('reuses JWT exchange, pinned transport and exact SMS/hash/identity verification offline', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden'));
    const read = budget(), oauth = budget(), { session, audit } = prepareOfflineOneTimeRead(await approval(), responses(), read, oauth);
    const pending = session.read();
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' });
    expect(await pending).toMatchObject({ mode: 'offline_simulation', expectedTextMatched: true, expectedIdentitiesMatched: true, scopeEvidence: 'fictional_fixture', applicationPermissionsIndependentlyVerified: false });
    expect(session.attempts).toEqual({ oauth: 1, message: 1 });
    expect(audit().map(r => [r.method, r.path])).toEqual([['POST', '/restapi/oauth/token'], ['GET', '/restapi/v1.0/account/100001/extension/200001/message-store/300001']]);
    expect(read.reserve).toHaveBeenCalledOnce(); expect(oauth.reserve).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify([session, audit()])).not.toMatch(/secret|signature|phoneNumber|555|subject/);
  });
  it.each([
    { approvalId: '../escape' }, { appName: 'Other app' }, { privateProductionJwtAppConfirmed: false }, { authorizedExtensionConfirmed: false },
    { fictionalMessageConfirmed: false }, { independentReadMessagesOnlyEvidence: '' }, { authorizedRequests: ['one_sms_get'] }, { enableLive: true },
  ])('rejects inadequate approval %j', async patch => {
    const a = { ...await approval(), ...patch } as OneTimeReadApproval;
    expect(() => validateOneTimeReadApproval(a)).toThrow();
  });
  it.each([
    { host: 'https://platform.devtest.ringcentral.com' }, { accountId: '~' }, { extensionId: '~' }, { messageId: '' },
    { messageId: '300001?readStatus=Read' }, { permissions: ['ReadMessages', 'SMS'] }, { expectedFromSha256: undefined }, { expectedToSha256: undefined },
  ])('requires exact production tuple and both identity hashes: %j', async patch => {
    const a = await approval(); Object.assign(a.message, patch);
    expect(() => validateOneTimeReadApproval(a)).toThrow();
  });
  it.each([{ scope: 'ReadMessages SMS' }, { scope: 'Messages' }, { owner_id: '200002' }])('stops before SMS GET on unsafe grant %j', async patch => {
    const { session, audit } = prepareOfflineOneTimeRead(await approval(), responses(patch), budget(), budget());
    await expect(session.read()).rejects.toBeInstanceOf(Error); expect(audit()).toHaveLength(1); expect(session.attempts.message).toBe(0);
  });
  it.each([{ id: '300002' }, { direction: 'Outbound' }, { subject: 'Wrong fictional text' }, { from: { phoneNumber: '+15035550111' } }, { to: [{ phoneNumber: '+15035550101' }] }, { attachments: [{ type: 'AudioRecording', contentType: 'audio/wav' }] }])('rejects incorrect/unsupported SMS %j without follow-up', async patch => {
    const { session, audit } = prepareOfflineOneTimeRead(await approval(), responses({}, patch), budget(), budget());
    await expect(session.read()).rejects.toMatchObject({ category: 'message_mismatch' }); expect(audit()).toHaveLength(2);
    await expect(session.read()).rejects.toMatchObject({ category: 'budget_unavailable' });
  });
  it('preserves five-second deadline and consumes the workflow on timeout', async () => {
    vi.useFakeTimers();
    const { session, audit } = prepareOfflineOneTimeRead(await approval(), responses({}, {}, 20000), budget(), budget());
    const pending = session.read().catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000); expect(audit()).toHaveLength(1); expect(session.attempts).toEqual({ oauth: 1, message: 0 });
  });
});
