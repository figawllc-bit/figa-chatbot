import type { ChatResponse, ConversationEngine } from '../types';
import type { BeginTurn, FinishTurn, TurnInput } from '../database/types';
import { PersistentChatService, digest } from '../database/service';
import { SupabaseRepository, type DatabaseConfigurator } from '../database/supabase';
import { productionDatabaseConfiguration, type ProductionDatabaseEnvironment } from '../database/config';
import type { ReceiveResult } from './receiver';
import type { DeliverySnapshot } from './policy';
import { assertFixtureMessages } from './fixture-policy';
import type { SmsObservation } from './events';
import type { SmsPayload, SmsResult, SmsSender } from './sms-sender';
import { futureDeliveryBlockers } from './policy';

type Job = { id: string; conversationId: string; messageId: string; status: string };

// RingCentral accepts at most 1000 characters of SMS text per request.
export const SMS_MAX_CHARACTERS = 1000;
// Diagnostic notes written for the local developer UI. They must never reach a
// caregiver or provider by SMS; the reply that follows them stays intact.
const developerNotes = [
  /^Free-tier access has not been confirmed, so no model request was sent\. /,
  /^The authorized synthetic AI test budget is exhausted\. /,
  /^(?:Workers AI free quota is exhausted\.|Workers AI is temporarily busy or rate limited\.|AI is unavailable or returned an unverified result\.) The local deterministic engine handled this message\. /,
];
// The local test UI's wording, rewritten for a real SMS conversation. Exact matches only.
const channelWording: [string, string][] = [
  ['FIGA staff need to review these details; no notification has been sent. ', 'A FIGA team member will review these details. '],
  [' This test does not submit a request or notify staff.', ' A FIGA team member reviews every request.'],
  [' This test does not submit an application or notify staff.', ' A FIGA team member reviews every inquiry.'],
  ["I am FIGA's local test assistant. Please use fictional details. This chat does not send customer messages or notify staff.", "I am FIGA's automated assistant. A FIGA team member can also help you."],
  [' Use fictional information in this test.', ''],
  [' Nothing has been submitted or sent to staff in this test.', ' A FIGA team member will review them.'],
  [' This dry run has not contacted anyone.', ' A FIGA team member will review your request.'],
  ['This conversation needs FIGA staff attention. No staff member has been notified by this test.', 'I have asked a FIGA team member to review this conversation.'],
  [' Please use fictional details and omit medical or resident information.', ' Please do not include medical or resident information.'],
];
export const SMS_FIRST_REPLY_PREFIX = "This is FIGA's automated assistant. ";
export const SMS_OPT_OUT_NOTICE = ' Reply STOP to opt out.';
/** Customer-facing SMS text, or '' when the reply must go to staff instead. */
export function smsReplyText(text: string, firstReply = false): string {
  let reply = text;
  for (const note of developerNotes) reply = reply.replace(note, '');
  for (const [from, to] of channelWording) reply = reply.replace(from, to);
  reply = reply.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim();
  // First contact: say it is automated and how to opt out (A2P messaging registration expectations).
  if (reply && firstReply) reply = SMS_FIRST_REPLY_PREFIX + reply + SMS_OPT_OUT_NOTICE;
  return reply.length <= SMS_MAX_CHARACTERS ? reply : '';
}
/** Adapts the existing engine's reply for SMS before it is persisted, so the stored transcript equals what is sent. */
export class SmsChannelEngine implements ConversationEngine {
  constructor(private readonly inner: ConversationEngine) {}
  async respond(input: Parameters<ConversationEngine['respond']>[0]) {
    const firstReply = !input.state?.history?.length;
    const response = await this.inner.respond(input);
    const original = response.assistantResponse;
    response.assistantResponse = smsReplyText(original, firstReply);
    if (original.trim() && !response.assistantResponse) {
      const reasons = [...new Set([...response.humanAttentionReasons, 'Reply could not be sent as a single SMS.'])];
      response.humanAttentionNeeded = true; response.humanAttentionReasons = reasons; response.state.humanAttentionReasons = reasons;
    }
    return response;
  }
}

/**
 * fixture: authored fictional fixtures only, against the development database (tests override rpc()).
 * production: approved real customer data, against the SEPARATE production Supabase project, whose
 * deployment profile independently rejects fixture rows (and the development profile rejects real rows).
 */
export type SmsDataPolicy = 'fixture' | 'production';
export class SmsWorkflowRepository<E extends object = Record<string, never>> extends SupabaseRepository<E> {
  constructor(readonly policy: SmsDataPolicy = 'fixture', env?: E, transport?: typeof fetch, configure?: DatabaseConfigurator<E>) {
    super((env ?? {}) as E, transport, configure);
  }
  protected override async rpc<T>(name: string, parameters: unknown): Promise<T> {
    if (this.policy === 'fixture') throw new Error('Local SQL fixture repository required.');
    return super.rpc<T>(name, parameters);
  }
  deliverySnapshot(conversationId: string) { return this.rpc<DeliverySnapshot | null>('figa_rc_delivery_snapshot', { p_id: conversationId }); }
  observe(eventId: string, hash: string, messages: SmsObservation[]) {
    if (this.policy === 'fixture') assertFixtureMessages(messages);
    return this.rpc<ReceiveResult>('figa_rc_observe', { p_event_id: eventId, p_hash: hash, p_messages: messages });
  }
  prepare(m: SmsObservation): Promise<Job> { return this.rpc('figa_rc_sms_prepare', { p_message_id: m.id }); }
  override begin(i: TurnInput): Promise<BeginTurn> { return this.rpc('figa_rc_sms_begin', { p_id: i.conversationId, p_message_id: i.messageId, p_message: i.message, p_request_hash: i.requestHash }); }
  override finish(i: FinishTurn) { return this.rpc<ChatResponse>('figa_rc_sms_finish', { p_id: i.conversationId, p_message_id: i.messageId, p_lease_token: i.leaseToken, p_revision: i.revision, p_response: i.response }); }
  claim(id: string): Promise<{ revision: number; payload: SmsPayload } | null> { return this.rpc('figa_rc_sms_claim', { p_job: id }); }
  recheck(id: string): Promise<boolean> { return this.rpc('figa_rc_sms_recheck', { p_job: id }); }
  complete(id: string, result: SmsResult): Promise<void> { return this.rpc('figa_rc_sms_complete', { p_job: id, p_kind: result.kind, p_external: result.kind === 'accepted' ? result.messageId : null }); }
  pending(): Promise<SmsObservation[]> { return this.rpc('figa_rc_sms_pending', {}); }
}
/** Repository for the separate production database. Inert unless that project is configured. */
export function productionSmsRepository(env: ProductionDatabaseEnvironment, transport: typeof fetch = fetch) {
  return new SmsWorkflowRepository<ProductionDatabaseEnvironment>('production', env, transport, productionDatabaseConfiguration);
}

type Controls = () => { paused: boolean; sendingEnabled: boolean };
export class SmsWorkflow {
  constructor(protected readonly repo: SmsWorkflowRepository<object>, private readonly engine: ConversationEngine, private readonly sender: SmsSender,
    private readonly controls: Controls) {}
  get policy(): SmsDataPolicy { return this.repo.policy; }
  async drain(): Promise<void> {
    if (this.controls().paused) return;
    for (const message of await this.repo.pending()) await this.process(message);
  }
  /** Records an outgoing text. One the bot did not send (a staff hand reply) puts a hold on the thread. */
  async observeOutbound(m: SmsObservation): Promise<void> {
    if (m.direction !== 'Outbound') throw Error('Outbound SMS required.');
    await this.observe(m);
  }
  private async observe(m: SmsObservation): Promise<void> {
    if (this.policy === 'fixture') assertFixtureMessages([m]);
    const hash = await digest(JSON.stringify([m.id,m.accountId,m.extensionId,m.businessNumber,m.customerNumber,m.direction,m.text,m.messageStatus,m.modifiedAt,m.optOut]));
    const observed = await this.repo.observe(`sms-workflow:${m.accountId}:${m.extensionId}:${m.id}`, hash, [m]);
    if (observed.kind === 'conflict') throw Error('Conflicting SMS observation.');
  }
  async process(m: SmsObservation): Promise<void> {
    if (m.direction !== 'Inbound') throw Error('Inbound SMS required.');
    await this.observe(m);
    const job = await this.repo.prepare(m);
    if (!['new', 'generated'].includes(job.status) || this.controls().paused) return;
    const snapshot = await this.repo.deliverySnapshot(job.conversationId);
    if (!snapshot || futureDeliveryBlockers(snapshot, {}, snapshot.conversation.revision).some(x => x !== 'phase7a_receive_only')) return;
    if (job.status === 'new') {
      const turn = { message: m.text, messageId: job.messageId, conversationId: job.conversationId, engine: 'ai' as const };
      await new PersistentChatService(this.repo, new SmsChannelEngine(this.engine)).respond(
        this.policy === 'production' ? { ...turn, productionData: true } : { ...turn, syntheticData: true }, 'sms-internal-channel');
    }
    if (this.controls().paused || !this.controls().sendingEnabled) return;
    const claim = await this.repo.claim(job.id); if (!claim) return;
    // Once claimed, an ambiguous failure is terminal: restart/replay MUST NOT
    // issue another POST. Operators reconcile uncertain results separately.
    let result: SmsResult;
    try { result = await this.sender.send(claim.payload, async () => !this.controls().paused && this.controls().sendingEnabled && await this.repo.recheck(job.id)); }
    catch { result = { kind: 'uncertain', category: 'sender_failed' }; }
    await this.repo.complete(job.id, result);
  }
}
/** Fixture-only workflow used by offline tests; refuses anything but authored fictional fixtures. */
export class SyntheticSmsWorkflow extends SmsWorkflow {
  constructor(repo: SmsWorkflowRepository<object>, engine: ConversationEngine, sender: SmsSender, controls: Controls) {
    if (repo.policy !== 'fixture') throw new Error('Fixture repository required.');
    super(repo, engine, sender, controls);
  }
}
