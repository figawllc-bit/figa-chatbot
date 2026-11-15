export type StaffAction = 'inbox' | 'summary' | 'takeover' | 'resolve' | 'return_ai';
export interface StaffUpdate {
  updateId: number; actor: number; chat: number; action: StaffAction;
  conversationId: string | null; revision: number | null; callbackId?: string;
}
export interface StaffSummary {
  id: string; type: 'unknown' | 'provider' | 'caregiver' | 'general';
  status: 'open' | 'closed' | 'blocked'; mode: 'AI' | 'HUMAN'; revision: number;
  urgent: boolean; details: Record<string, unknown>;
}
export interface StaffControls { actions:StaffAction[]; summary:StaffSummary }
export interface ControlledStaffScope { actor:number; conversationId:string }
export type StaffResult = { kind: 'ok' | 'applied' | 'denied' | 'stale' | 'unavailable' | 'duplicate' | 'conflict'; conversations?: StaffSummary[] };
export interface NotificationClaim { id: string; leaseToken: string }
export interface StaffNotification { id: string; kind: 'provider' | 'caregiver' | 'urgent' | 'status'; conversation: StaffSummary }
export interface NotificationPreview extends StaffNotification { deliveryState:'pending'|'leased'|'delivered' }
export interface StaffRepository {
  controls(actor:number,chat:number,id:string,revision:number|null):Promise<StaffControls|null>;
  recipients(): Promise<{actor: number; chat: number}[]>;
  process(update: StaffUpdate, requestHash: string): Promise<StaffResult>;
  summary(actor: number, chat: number, id: string, revision: number): Promise<StaffSummary | null>;
  pending(actor: number, chat: number): Promise<{ kind: 'ok' | 'denied'; notifications?: NotificationClaim[] }>;
  notification(actor: number, chat: number, claim: NotificationClaim): Promise<StaffNotification | null>;
  acknowledge(actor: number, chat: number, claim: NotificationClaim): Promise<boolean>;
}
export interface TelegramMessage {
  chat_id: number; text: string;
  protect_content: true; link_preview_options: { is_disabled: true };
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
}
export interface TelegramTransport {
  send(message: TelegramMessage): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
}
export interface TelegramEnvironment {
  TELEGRAM_STAFF_ENABLED?: string;
  TELEGRAM_WEBHOOK_ENABLED?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_LIVE_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
}
