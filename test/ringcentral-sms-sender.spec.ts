import { describe, it, expect, vi, afterEach } from 'vitest';
import { RingCentralSmsSender } from '../src/ringcentral/sms-sender';
import { exchangeSmsJwt, exchangeReadOnlyJwt, type SmsGrant } from '../src/ringcentral/oauth-read-session';
import { createOfflinePollingHttp, type OfflineHttpStep } from '../src/ringcentral/secure-transport';
import { smsReplyText, SmsChannelEngine, SMS_MAX_CHARACTERS } from '../src/ringcentral/sms-workflow';

const payload = { from: '+15035550100', to: '+15035550110', text: 'Fictional safe response.' };
const credentials = { kind: 'jwt' as const, clientId: 'fictional-client', clientSecret: 'fictional-secret', jwt: 'fictional.header.signature', accountId: '100001', extensionId: '200001', host: 'https://platform.ringcentral.com' as const, appPermissions: ['ReadMessages', 'SMS'] as const };
const target = { host: 'https://platform.ringcentral.com' as const, extensionId: '200001' };
const oauth = (patch = {}) => ({ body: JSON.stringify({ access_token: 'fictional-issued-access-token', token_type: 'Bearer', scope: 'ReadMessages SMS', owner_id: '200001', expires_in: 3600, ...patch }) });
const accepted = { body: JSON.stringify({ id: '399999', direction: 'Outbound', type: 'SMS', messageStatus: 'Queued' }) };
const budget = () => ({ authorizedMaximum: 1 as const, reserve: vi.fn(async () => {}) });
function setup(step: OfflineHttpStep = accepted, grantPatch = {}) {
  const http = createOfflinePollingHttp(JSON.stringify([oauth(grantPatch), step]));
  const sender = new RingCentralSmsSender({ mode: 'offline', sender: payload.from, enabled: () => true, privacyApproved: () => false, http: http.executor,
    grant: () => exchangeSmsJwt(credentials, target, { send: r => http.executor(r) }, budget()) });
  return { sender, http };
}
afterEach(() => vi.useRealTimers());

describe('disabled SMS sender and strict SMS OAuth policy', () => {
  it('uses exactly the documented SMS POST, with no redirects or attachment endpoint', async () => {
    const { sender, http } = setup(); expect(await sender.send(payload, async () => true)).toEqual({ kind: 'accepted', messageId: '399999' });
    expect(http.audit().map(r => [r.method, r.path, r.redirect])).toEqual([
      ['POST','/restapi/oauth/token','manual'], ['POST','/restapi/v1.0/account/~/extension/200001/sms','manual']
    ]);
  });
  it.each([{ scope: 'ReadMessages' }, { scope: 'ReadMessages SMS EditExtensions' }, { scope: 'SMS SMS ReadMessages' }, { owner_id: '200002' }, { expires_in: 1 }])('rejects incorrect grants before sending: %j', async patch => {
    const { sender, http } = setup(accepted, patch); expect((await sender.send(payload, async () => true)).kind).toBe('failed'); expect(http.audit()).toHaveLength(1);
  });
  it('keeps the existing read-only exchange unable to accept SMS scope', async () => {
    const http = createOfflinePollingHttp(JSON.stringify([oauth()]));
    await expect(exchangeReadOnlyJwt({ ...credentials, appPermissions: ['ReadMessages'] }, target, { send: r => http.executor(r) }, budget())).rejects.toMatchObject({ category: 'scope_rejected' });
  });
  it('does not treat caller-created permission metadata as a verified OAuth grant', async () => {
    const http = createOfflinePollingHttp('[]');
    const sender = new RingCentralSmsSender({ mode: 'offline', sender: payload.from, enabled: () => true, privacyApproved: () => true, http: http.executor,
      grant: async () => ({ smsScopeVerified: true, ownerId: '200001', accessToken: 'fictional-issued-access-token', expiresAt: Date.now()+60000 } as SmsGrant) });
    expect(await sender.send(payload, async () => true)).toMatchObject({ category: 'grant_rejected' }); expect(http.audit()).toHaveLength(0);
  });
  it.each([{ status: 429 }, { status: 401 }, { status: 503 }, { status: 302 }, { failure: true }, { body: '{malformed' }, { body: 'x'.repeat(16385) }])('returns a safe terminal result without retries: %j', async step => {
    const { sender, http } = setup(step); const r = await sender.send(payload, async () => true); expect(r.kind).not.toBe('accepted'); expect(http.audit()).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/fictional-client|phoneNumber|Fictional safe|Bearer/);
  });
  it('times out once and ignores late successful completion', async () => {
    vi.useFakeTimers(); const { sender, http } = setup({ ...accepted, delayMs: 6000 });
    const pending = sender.send(payload, async () => true);
    await vi.advanceTimersByTimeAsync(5001); expect(await pending).toMatchObject({ kind: 'uncertain', category: 'timeout' });
    await vi.advanceTimersByTimeAsync(2000); expect(http.audit()).toHaveLength(2);
  });
  it('rechecks ownership and opt-out after auth and before POST', async () => {
    const { sender, http } = setup(); expect((await sender.send(payload, async () => false)).kind).toBe('suppressed'); expect(http.audit()).toHaveLength(1);
  });
  it('rejects a wrapped network executor in offline mode before accessing a grant', async () => {
    const grant = vi.fn(), wrapped = vi.fn(async r => fetch(r));
    const sender = new RingCentralSmsSender({ mode: 'offline', sender: payload.from, enabled: () => true, privacyApproved: () => true, http: wrapped, grant });
    expect((await sender.send(payload, async () => true)).kind).toBe('suppressed'); expect(grant).not.toHaveBeenCalled(); expect(wrapped).not.toHaveBeenCalled();
  });
});

describe('SMS channel reply text', () => {
  const reply = 'What city and state is the position in?';
  it.each([
    'Workers AI free quota is exhausted. The local deterministic engine handled this message. ',
    'Workers AI is temporarily busy or rate limited. The local deterministic engine handled this message. ',
    'AI is unavailable or returned an unverified result. The local deterministic engine handled this message. ',
    'Free-tier access has not been confirmed, so no model request was sent. ',
    'The authorized synthetic AI test budget is exhausted. ',
  ])('removes developer diagnostics before a customer SMS: %s', note => {
    expect(smsReplyText(note + reply)).toBe(reply);
  });
  it('rewords the review notice truthfully for the SMS channel', () => {
    expect(smsReplyText('FIGA staff need to review these details; no notification has been sent. ' + reply)).toBe('A FIGA team member will review these details. ' + reply);
  });
  it('routes an over-length reply to staff instead of sending a truncated SMS', async () => {
    const long = 'x'.repeat(SMS_MAX_CHARACTERS + 1);
    const inner = { respond: async () => ({ mode: 'LOCAL_DEVELOPMENT_DRY_RUN' as const, conversationType: 'provider' as const, assistantResponse: long, collectedInformation: {}, complete: false,
      humanAttentionNeeded: false, humanAttentionReasons: [], state: { version: 1 as const, type: 'provider' as const, collected: {}, awaiting: null, humanAttentionReasons: [] } }) };
    const r = await new SmsChannelEngine(inner).respond({ message: 'Fictional provider inquiry' });
    expect(r.assistantResponse).toBe(''); expect(r.humanAttentionNeeded).toBe(true); expect(r.state.humanAttentionReasons).toContain('Reply could not be sent as a single SMS.');
    expect(smsReplyText('y'.repeat(SMS_MAX_CHARACTERS))).toHaveLength(SMS_MAX_CHARACTERS);
  });
});
