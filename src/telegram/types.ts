export type StaffAction = 'inbox' | 'summary' | 'takeover' | 'resolve' | 'return_ai' | 'mode' | 'hours';
// Global bot mode: away = bot answers; on_duty = staff answer; paused = bot fully off;
// auto = on_duty during office hours, away otherwise.
export type BotMode = 'auto' | 'away' | 'on_duty' | 'paused';
export type EffectiveBotMode = Exclude<BotMode, 'auto'>;
/** Office hours keyed by ISO weekday '1' (Mon) .. '7' (Sun): [start, end) as HH:MM, end may be 24:00. */
export type OfficeHours = Partial<Record<'1'|'2'|'3'|'4'|'5'|'6'|'7', [string, string]>>;
export type BotModeResult = { kind: 'ok' | 'applied' | 'denied' | 'duplicate' | 'conflict'; mode?: BotMode; effective?: EffectiveBotMode; hours?: OfficeHours; timezone?: string; canChange?: boolean };
export interface StaffUpdate {
  updateId: number; actor: number; chat: number; action: StaffAction;
  conversationId: string | null; revision: number | null; callbackId?: string;
  /** Only for action 'mode': the requested mode, or null for status only. */
  mode?: BotMode | null;
  /** Only for action 'hours': the complete new office-hours schedule. */
  hours?: OfficeHours;
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
export interface StaffNotification { id: string; kind: 'provider' | 'caregiver' | 'urgent' | 'status' | 'message' | 'hand_reply' | 'review'; conversation: StaffSummary }
export interface NotificationPreview extends StaffNotification { deliveryState:'pending'|'leased'|'delivered' }
export interface StaffRepository {
  controls(actor:number,chat:number,id:string,revision:number|null):Promise<StaffControls|null>;
  recipients(): Promise<{actor: number; chat: number}[]>;
  process(update: StaffUpdate, requestHash: string): Promise<StaffResult>;
  summary(actor: number, chat: number, id: string, revision: number): Promise<StaffSummary | null>;
  pending(actor: number, chat: number): Promise<{ kind: 'ok' | 'denied'; notifications?: NotificationClaim[] }>;
  notification(actor: number, chat: number, claim: NotificationClaim): Promise<StaffNotification | null>;
  acknowledge(actor: number, chat: number, claim: NotificationClaim): Promise<boolean>;
  mode(update: StaffUpdate, requestHash: string): Promise<BotModeResult>;
  hours(update: StaffUpdate, requestHash: string): Promise<BotModeResult>;
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
