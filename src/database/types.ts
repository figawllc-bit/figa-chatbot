import type { ChatResponse, ConversationState } from '../types';

export interface StoredMessage { id: string; clientMessageId: string; direction: 'inbound' | 'outbound'; senderType: 'customer' | 'assistant' | 'staff' | 'system'; content: string; createdAt: string }
export interface ConversationSnapshot {
  id: string;
  status: 'open' | 'blocked' | 'closed';
  mode: 'AI' | 'HUMAN';
  revision: number;
  humanAttentionNeeded: boolean;
  state: ConversationState;
  messages: StoredMessage[];
}
export interface TurnInput { conversationId: string; tokenHash: string; messageId: string; message: string; requestHash: string }
export type BeginTurn = { kind: 'ready'; conversation: ConversationSnapshot; leaseToken: string }
  | { kind: 'duplicate' | 'controlled'; response: ChatResponse }
  | { kind: 'not_found' | 'busy' | 'conflict' };
export interface FinishTurn extends TurnInput { leaseToken: string; revision: number; response: ChatResponse }
export interface ConversationRepository {
  create(tokenHash: string): Promise<ConversationSnapshot>;
  restore(id: string, tokenHash: string): Promise<ConversationSnapshot | null>;
  begin(input: TurnInput): Promise<BeginTurn>;
  finish(input: FinishTurn): Promise<ChatResponse>;
}
export interface DatabaseEnvironment {
  SUPABASE_ENABLED?: string;
  SUPABASE_ISOLATED_DEV_CONFIRMED?: string;
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
}
