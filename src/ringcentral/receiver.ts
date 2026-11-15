import { adaptRingCentral, type RingCentralScope, type SmsObservation } from './events';
import { digest } from '../database/service';
import { SupabaseRepository } from '../database/supabase';
import type { DeliverySnapshot } from './policy';
import { InputError } from '../validation';
import { assertFixtureMessages, assertFixtureScope, assertNoFixtureAttachments } from './fixture-policy';

export interface ReceiveResult { kind: 'observed' | 'duplicate' | 'conflict'; observations?: { conversationId: string; actor: 'customer' | 'staff' | 'chatbot' | 'unknown'; optOut: boolean; reviewHold: boolean }[] }
export interface RingCentralRepository { observe(eventId: string, hash: string, messages: SmsObservation[]): Promise<ReceiveResult> }
export class SupabaseRingCentralRepository extends SupabaseRepository implements RingCentralRepository {
  // No environment credentials or live Supabase transport in the fixture adapter.
  // Ephemeral SQL tests override rpc(); a real repository needs separate review.
  constructor() { super({}); }
  protected override async rpc<T>(_name: string, _parameters: unknown): Promise<T> { throw new Error('Local SQL fixture repository required.'); }
  deliverySnapshot(conversationId: string) { return this.rpc<DeliverySnapshot | null>('figa_rc_delivery_snapshot', { p_id: conversationId }); }
  async observe(eventId: string, hash: string, messages: SmsObservation[]) {
    assertFixtureMessages(messages);
    return this.rpc<ReceiveResult>('figa_rc_observe', { p_event_id: eventId, p_hash: hash, p_messages: messages });
  }
}
export class OfflineRingCentralReceiver {
  private readonly scope: RingCentralScope;
  constructor(scope: RingCentralScope, private readonly repository: RingCentralRepository) {
    assertFixtureScope(scope); this.scope = structuredClone(scope);
  }
  async receive(input: { syntheticData?: unknown; event: unknown; messageStoreRecords?: unknown[] }) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.syntheticData !== true) throw new InputError('Fictional-data confirmation required.');
    assertNoFixtureAttachments(input.event, input.messageStoreRecords);
    const event = adaptRingCentral(input.event, this.scope, input.messageStoreRecords);
    if (event.kind === 'needs_message_store') return event; // No RingCentral client exists here.
    assertFixtureMessages(event.messages);
    return this.repository.observe([this.scope.accountId, this.scope.extensionId, this.scope.subscriptionId, event.eventId].join(':'), await digest(JSON.stringify(event.messages)), event.messages);
  }
}
