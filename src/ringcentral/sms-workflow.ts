import type { ConversationEngine } from '../types';
import type { BeginTurn, FinishTurn, TurnInput } from '../database/types';
import { PersistentChatService, digest } from '../database/service';
import { SupabaseRingCentralRepository } from './receiver';
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
/** Customer-facing SMS text, or '' when the reply must go to staff instead. */
export function smsReplyText(text: string): string {
  let reply = text;
  for (const note of developerNotes) reply = reply.replace(note, '');
  // In the SMS channel a review request IS queued for staff via Telegram.
  reply = reply.replace('FIGA staff need to review these details; no notification has been sent. ', 'A FIGA team member will review these details. ');
  reply = reply.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim();
  return reply.length <= SMS_MAX_CHARACTERS ? reply : '';
}
/** Adapts the existing engine's reply for SMS before it is persisted, so the stored transcript equals what is sent. */
export class SmsChannelEngine implements ConversationEngine {
  constructor(private readonly inner: ConversationEngine) {}
  async respond(input: Parameters<ConversationEngine['respond']>[0]) {
    const response = await this.inner.respond(input);
    const original = response.assistantResponse;
    response.assistantResponse = smsReplyText(original);
    if (original.trim() && !response.assistantResponse) {
      const reasons = [...new Set([...response.humanAttentionReasons, 'Reply could not be sent as a single SMS.'])];
      response.humanAttentionNeeded = true; response.humanAttentionReasons = reasons; response.state.humanAttentionReasons = reasons;
    }
    return response;
  }
}
export class SmsWorkflowRepository extends SupabaseRingCentralRepository {
  prepare(m: SmsObservation): Promise<Job> { return this.rpc('figa_rc_sms_prepare', { p_message_id: m.id }); }
  override begin(i: TurnInput): Promise<BeginTurn> { return this.rpc('figa_rc_sms_begin', { p_id: i.conversationId, p_message_id: i.messageId, p_message: i.message, p_request_hash: i.requestHash }); }
  override finish(i: FinishTurn) { return this.rpc<Awaited<ReturnType<SupabaseRingCentralRepository['finish']>>>('figa_rc_sms_finish', { p_id: i.conversationId, p_message_id: i.messageId, p_lease_token: i.leaseToken, p_revision: i.revision, p_response: i.response }); }
  claim(id: string): Promise<{ revision: number; payload: SmsPayload } | null> { return this.rpc('figa_rc_sms_claim', { p_job: id }); }
  recheck(id: string): Promise<boolean> { return this.rpc('figa_rc_sms_recheck', { p_job: id }); }
  complete(id: string, result: SmsResult): Promise<void> { return this.rpc('figa_rc_sms_complete', { p_job: id, p_kind: result.kind, p_external: result.kind === 'accepted' ? result.messageId : null }); }
  pending(): Promise<SmsObservation[]> { return this.rpc('figa_rc_sms_pending', {}); }
}

// This concrete workflow is intentionally fixture-only, like the existing DB.
// Live activation cannot mislabel customer data as synthetic by setting a flag.
export class SyntheticSmsWorkflow {
  constructor(private readonly repo: SmsWorkflowRepository, private readonly engine: ConversationEngine, private readonly sender: SmsSender,
    private readonly controls: () => { paused: boolean; sendingEnabled: boolean }) {}
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
    assertFixtureMessages([m]);
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
      await new PersistentChatService(this.repo, new SmsChannelEngine(this.engine)).respond({ message: m.text, messageId: job.messageId, conversationId: job.conversationId, engine: 'ai', syntheticData: true }, 'fixture-internal-channel');
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
