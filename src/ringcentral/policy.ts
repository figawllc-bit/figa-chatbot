import type { ConversationSnapshot } from '../database/types';
export interface RingCentralEnvironment { RINGCENTRAL_OFFLINE_ENABLED?: string; AI_GLOBAL_PAUSED?: string; RINGCENTRAL_POLLING_ENABLED?: string; RINGCENTRAL_POLLING_PAUSED?: string; RINGCENTRAL_POLL_INTERVAL_SECONDS?: string }
export interface DeliverySnapshot {
  conversation: Pick<ConversationSnapshot, 'mode' | 'status' | 'revision'>;
  activeStaffOwner: boolean; optedOut: boolean; reviewHold: boolean;
}
// No transport, OAuth client, subscription writer or send-SMS function is provided.
// A future dispatcher MUST obtain this authoritative snapshot again immediately
// before delivery; a previously generated reply is never authorization to send.
export function futureDeliveryBlockers(snapshot: DeliverySnapshot, env: RingCentralEnvironment, expectedRevision: number): string[] {
  const reasons = ['phase7a_receive_only'];
  if (env.AI_GLOBAL_PAUSED === 'true') reasons.push('global_ai_pause');
  if (snapshot.optedOut) reasons.push('customer_opt_out');
  if (snapshot.reviewHold) reasons.push('outbound_origin_review');
  if (snapshot.conversation.mode !== 'AI' || snapshot.activeStaffOwner) reasons.push('staff_control');
  if (snapshot.conversation.status !== 'open') reasons.push('conversation_not_open');
  if (snapshot.conversation.revision !== expectedRevision) reasons.push('stale_revision');
  return reasons;
}
// Pure offline protocol helper. The live Worker route remains unconditionally
// disabled. Validation-Token is a setup challenge, not webhook authentication.
export function webhookProtocol(request: Request, options: { enabled?: boolean; verificationToken?: string }): Response | null {
  const headers = { 'Cache-Control': 'no-store' };
  if (!options.enabled) return new Response(null, { status: 404, headers });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers });
  const challenge = request.headers.get('Validation-Token');
  if (challenge) {
    if (challenge.length > 200 || !/^[\x21-\x7e]+$/.test(challenge)) return new Response(null, { status: 400, headers });
    return new Response(null, { status: 200, headers: { ...headers, 'Validation-Token': challenge } });
  }
  const supplied = request.headers.get('Verification-Token'), expected = options.verificationToken;
  if (!expected || !supplied || supplied.length !== expected.length) return new Response(null, { status: 403, headers });
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return different ? new Response(null, { status: 403, headers }) : null;
}
