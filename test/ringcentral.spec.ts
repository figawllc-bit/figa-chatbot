import { describe, it, expect, vi } from 'vitest';
import { adaptRingCentral, isOptOut } from '../src/ringcentral/events';
import { OfflineRingCentralReceiver, type RingCentralRepository } from '../src/ringcentral/receiver';
import { futureDeliveryBlockers, webhookProtocol, type DeliverySnapshot } from '../src/ringcentral/policy';
import { HybridEngine } from '../src/ai/engine';
import { createWorker } from '../src/index';
import { instant, summary, message, scope } from './fixtures/ringcentral';
import { fixtureTexts } from '../src/ringcentral/fixture-policy';
import { SupabaseRingCentralRepository } from '../src/ringcentral/receiver';
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RingCentral offline event normalization', () => {
  it('normalizes documented instant inbound SMS without attachment downloads', () => {
    const result = adaptRingCentral(instant(), scope);
    expect(result.kind).toBe('messages');
    if (result.kind === 'messages') expect(result.messages[0]).toMatchObject({ direction: 'Inbound', customerNumber: '+15035550110', businessNumber: '+15035550100', optOut: false });
  });
  it('returns a hydration requirement for aggregate events and never guesses message content', () => {
    expect(adaptRingCentral(summary(), scope)).toEqual({ kind: 'needs_message_store', eventId: 'fictional-summary-1' });
    const result = adaptRingCentral(summary(), scope, [message('300002', 'Outbound', 'Fictional outbound observation')]);
    expect(result.kind).toBe('messages');
    if (result.kind === 'messages') expect(result.messages[0].direction).toBe('Outbound');
  });
  it.each(['STOP', ' stop ', 'STOPALL', 'Unsubscribe', 'CANCEL', 'END', 'QUIT', 'please stop', 'stop please!'])('preserves opt-out %s', value => {
    expect(isOptOut(value)).toBe(true);
    const result = adaptRingCentral(instant(message('300001', 'Inbound', value)), scope);
    if (result.kind === 'messages') expect(result.messages[0].optOut).toBe(true);
  });
  it.each(['START', 'do not stop yet', 'unstoppable'])('does not invent opt-in or opt-out from %s', value => expect(isOptOut(value)).toBe(false));
  it.each([
    ['missing subject', () => ({ ...instant(), body: { ...message(), subject: undefined } })],
    ['missing identity', () => ({ ...instant(), body: { ...message(), id: undefined } })],
    ['unsafe numeric ID', () => ({ ...instant(), body: { ...message(), id: Number.MAX_SAFE_INTEGER + 1 } })],
    ['wrong subscription', () => ({ ...instant(), subscriptionId: 'other' })],
    ['wrong owner', () => ({ ...instant(), ownerId: '900001' })],
    ['wrong account', () => ({ ...instant(), event: '/restapi/v1.0/account/900001/extension/200001/message-store/instant?type=SMS' })],
    ['missing direction', () => ({ ...instant(), body: { ...message(), direction: undefined } })],
    ['outbound instant', () => instant(message('300001', 'Outbound'))],
    ['group message', () => ({ ...instant(), body: { ...message(), to: [{ phoneNumber: '+15035550100' }, { phoneNumber: '+15035550112' }] } })],
    ['unowned number', () => instant(message('300001', 'Inbound', 'Test', '+15035550110', '+15035550199'))],
    ['ambiguous business sender', () => instant(message('300001', 'Inbound', 'Test', scope.businessNumbers[1]))],
    ['malicious URI', () => ({ ...instant(), body: { ...message(), uri: 'https://example.invalid/private' } })],
    ['wrong type', () => ({ ...instant(), body: { ...message(), type: 'Fax' } })],
  ])('rejects $0 safely', (_label, fixture) => expect(() => adaptRingCentral(fixture(), scope)).toThrow());
  it('rejects conflicting duplicate IDs inside one hydration batch', () => {
    expect(() => adaptRingCentral(summary(), scope, [message(), message()])).toThrow();
  });
});

describe('Receive-only gates and webhook protocol', () => {
  const repository = (): RingCentralRepository => ({ observe: vi.fn().mockResolvedValue({ kind: 'observed' }) });
  it.each([
    { subject: 'Unapproved customer material' },
    { from: { phoneNumber: '+15035550210' } },
    { attachments: [{ type: 'AudioRecording', uri: 'https://example.invalid/recording' }] },
    { attachments: [{ type: 'Text', contentType: 'text/plain' }] },
    { id: '9876543210' },
  ])('a synthetic flag cannot authorize non-catalog material %j', async patch => {
    const repo = repository();
    await expect(new OfflineRingCentralReceiver(scope, repo).receive({ syntheticData: true, event: instant({ ...message(), ...patch }) })).rejects.toThrow();
    expect(repo.observe).not.toHaveBeenCalled();
  });
  it('requires fixed fixture scope, snapshots configuration, and has no live Supabase transport', async () => {
    const repo = repository();
    expect(() => new OfflineRingCentralReceiver({ ...scope, accountId: '999001' }, repo)).toThrow();
    const mutable = structuredClone(scope), receiver = new OfflineRingCentralReceiver(mutable, repo);
    mutable.businessNumbers.push('+15035550200');
    await expect(receiver.receive({ syntheticData: true, event: instant(message('300001', 'Inbound', fixtureTexts[0], '+15035550110', '+15035550200')) })).rejects.toThrow();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    try {
      await expect(new SupabaseRingCentralRepository().deliverySnapshot('00000000-0000-4000-8000-000000000000')).rejects.toThrow('Local SQL fixture');
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('requires explicit offline injection, localhost, and opt-in; live ingress stays disabled', async () => {
    const repo = repository(), receiver = new OfflineRingCentralReceiver(scope, repo);
    const app = createWorker(undefined, receiver);
    const request = (host = 'localhost', path = '/ringcentral/offline') => new IncomingRequest(`http://${host}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ syntheticData: true, event: instant() }) });
    expect((await app.fetch(request(), {})).status).toBe(404);
    expect((await createWorker().fetch(request(), { RINGCENTRAL_OFFLINE_ENABLED: 'true' })).status).toBe(404);
    expect((await app.fetch(request('example.invalid'), { RINGCENTRAL_OFFLINE_ENABLED: 'true' })).status).toBe(404);
    expect((await app.fetch(request('localhost', '/ringcentral/webhook'), { RINGCENTRAL_OFFLINE_ENABLED: 'true' })).status).toBe(404);
    expect((await app.fetch(request(), { RINGCENTRAL_OFFLINE_ENABLED: 'true' })).status).toBe(200);
    expect(repo.observe).toHaveBeenCalledOnce();
  });
  it('requires fictional data and rejects malformed JSON without echoing bodies', async () => {
    const repo = repository(), receiver = new OfflineRingCentralReceiver(scope, repo);
    await expect(receiver.receive({ event: instant() })).rejects.toThrow('Fictional-data');
    expect(repo.observe).not.toHaveBeenCalled();
    const r = await createWorker(undefined, receiver).fetch(new IncomingRequest('http://localhost/ringcentral/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'private invalid JSON' }), { RINGCENTRAL_OFFLINE_ENABLED: 'true' });
    expect(r.status).toBe(400); expect(await r.text()).not.toContain('private');
  });
  it('does not invoke persistence or a network client when hydration is missing', async () => {
    const repo = repository();
    expect((await new OfflineRingCentralReceiver(scope, repo).receive({ syntheticData: true, event: summary() })).kind).toBe('needs_message_store');
    expect(repo.observe).not.toHaveBeenCalled();
  });
  it('a transient persistence failure is retryable and does not acknowledge receipt', async () => {
    const repo = repository();
    vi.mocked(repo.observe).mockRejectedValueOnce(new Error('private storage error'));
    const app = createWorker(undefined, new OfflineRingCentralReceiver(scope, repo));
    const request = () => new IncomingRequest('http://localhost/ringcentral/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ syntheticData: true, event: instant() }) });
    const failed = await app.fetch(request(), { RINGCENTRAL_OFFLINE_ENABLED: 'true' });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private');
    expect((await app.fetch(request(), { RINGCENTRAL_OFFLINE_ENABLED: 'true' })).status).toBe(200);
    expect(repo.observe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repo.observe).mock.calls[0]).toEqual(vi.mocked(repo.observe).mock.calls[1]);
  });
  it('separates the validation challenge from event authentication', () => {
    const challenge = new IncomingRequest('https://example.invalid/ringcentral/webhook', { method: 'POST', headers: { 'Validation-Token': 'fictional-challenge' } });
    expect(webhookProtocol(challenge, {})?.status).toBe(404);
    const response = webhookProtocol(challenge, { enabled: true });
    expect(response?.status).toBe(200); expect(response?.headers.get('Validation-Token')).toBe('fictional-challenge');
    const event = new IncomingRequest('https://example.invalid', { method: 'POST' });
    expect(webhookProtocol(event, { enabled: true, verificationToken: 'fictional-secret' })?.status).toBe(403);
    expect(webhookProtocol(new IncomingRequest(event, { headers: { 'Verification-Token': 'fictional-secret' } }), { enabled: true, verificationToken: 'fictional-secret' })).toBeNull();
  });
  it('keeps the global AI pause off by default, and suppresses both response engines when enabled', async () => {
    const run = vi.fn(); const state = { version: 1 as const, type: 'provider' as const, collected: { name: 'Alex Example' }, awaiting: 'city' as const, humanAttentionReasons: [], history: ['Fictional prior turn'] };
    const response = await new HybridEngine({ AI: { run }, AI_GLOBAL_PAUSED: 'true' }).respond({ message: 'I need caregivers tomorrow.', state, engine: 'ai', syntheticData: true });
    expect(run).not.toHaveBeenCalled(); expect(response.assistantResponse).toBe(''); expect(response.engine?.reason).toBe('global_ai_pause');
    expect(response.state.collected).toEqual(state.collected); expect(response.state.control).toBeUndefined();
    expect((await new HybridEngine().respond({ message: 'Hello' })).assistantResponse).not.toBe('');
  });
  it('requires fresh consent, ownership, status, revision and global pause checks before any future delivery', () => {
    const snapshot: DeliverySnapshot = { conversation: { mode: 'AI', status: 'open', revision: 1 }, activeStaffOwner: false, optedOut: false, reviewHold: false };
    expect(futureDeliveryBlockers(snapshot, {}, 1)).toEqual(['phase7a_receive_only']);
    expect(futureDeliveryBlockers({ ...snapshot, activeStaffOwner: true, optedOut: true, reviewHold: true, conversation: { mode: 'HUMAN', status: 'closed', revision: 2 } }, { AI_GLOBAL_PAUSED: 'true' }, 1)).toEqual(['phase7a_receive_only', 'global_ai_pause', 'customer_opt_out', 'outbound_origin_review', 'staff_control', 'conversation_not_open', 'stale_revision']);
  });
});
