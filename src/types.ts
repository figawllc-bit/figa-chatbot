export type ConversationType = 'unknown' | 'provider' | 'caregiver' | 'general';
export const fields = ['name', 'homeType', 'organization', 'city', 'state', 'position', 'date', 'shift', 'count', 'urgency', 'notes', 'availability', 'experience', 'applicationStatus'] as const;
export type Field = typeof fields[number];
export type CollectedInformation = Partial<Record<Field, string>>;
export interface ConversationState {
  version: 1;
  type: ConversationType;
  collected: CollectedInformation;
  awaiting: Field | null;
  humanAttentionReasons: string[];
  control?: 'active' | 'blocked' | 'human_takeover';
  history?: string[];
}
export interface ChatRequest {
  message: string;
  state?: ConversationState;
  engine?: 'deterministic' | 'ai';
  syntheticData?: boolean;
  conversationId?: string;
  messageId?: string;
}
export interface ChatResponse {
  mode: 'LOCAL_DEVELOPMENT_DRY_RUN';
  conversationType: ConversationType;
  assistantResponse: string;
  collectedInformation: CollectedInformation;
  state: ConversationState;
  humanAttentionNeeded: boolean;
  humanAttentionReasons: string[];
  complete: boolean;
  engine?: { requested: 'deterministic' | 'ai'; used: 'deterministic' | 'workers-ai' | 'none'; reason?: string };
  informationStatus?: 'user_reported_unverified';
  persistence?: { conversationId: string; messageId: string; revision: number; saved: true };
}
// Providers never own business replies or conversation controls.
export interface ConversationEngine { respond(input: ChatRequest): Promise<ChatResponse> }
