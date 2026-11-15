import { isUUID } from '../validation';
import type { StaffAction, StaffUpdate } from './types';

export const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const telegramId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 4503599627370495;
export function parseTelegramUpdate(raw: unknown): StaffUpdate | null {
  const update=record(raw);
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id)<0) return null;
  if (!!update.callback_query === !!update.message) return null;
  const callback=record(update.callback_query);
  const message=record(update.callback_query ? callback.message : update.message);
  const actor=record(update.callback_query ? callback.from : message.from);
  const chat=record(message.chat);
  // Private staff chats only. Identity always comes from Telegram's authenticated envelope.
  if (!telegramId(actor.id) || actor.is_bot!==false || chat.type!=='private' || chat.id!==actor.id) return null;
  const base={updateId:Number(update.update_id),actor:actor.id,chat:actor.id};
  if (update.callback_query) {
    if (typeof callback.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id) || typeof callback.data!=='string') return null;
    const match=callback.data.match(/^fg:([tsra]):([a-f0-9-]{36}):([0-9]{1,10})$/);
    if (!match || !isUUID(match[2]) || Number(match[3])>2147483647) return null;
    const actions:Record<string,StaffAction>={t:'takeover',s:'summary',r:'resolve',a:'return_ai'};
    return {...base,callbackId:callback.id,action:actions[match[1]],conversationId:match[2],revision:Number(match[3])};
  }
  if (typeof message.text!=='string' || message.text.length>100) return null;
  if (/^\/(start|inbox)\s*$/.test(message.text)) return {...base,action:'inbox',conversationId:null,revision:null};
  const match=message.text.match(/^\/summary ([a-f0-9-]{36})\s*$/);
  return match && isUUID(match[1]) ? {...base,action:'summary',conversationId:match[1],revision:null} : null;
}
