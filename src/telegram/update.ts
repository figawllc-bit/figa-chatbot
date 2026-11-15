import { isUUID } from '../validation';
import type { BotMode, OfficeHours, StaffAction, StaffUpdate } from './types';

const dayNumbers:Record<string,number>={mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:7};
/** Parses e.g. "mon-fri 08:00-17:00 sat 09:00-12:00", or "none" for no office hours. */
export function parseOfficeHours(spec:string):OfficeHours|null {
  const parts=spec.trim().toLowerCase().split(/\s+/);
  if(parts.length===1&&parts[0]==='none') return {};
  if(parts.length<2||parts.length%2) return null;
  const hours:OfficeHours={};
  for(let i=0;i<parts.length;i+=2) {
    const range=parts[i+1].match(/^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
    if(!range||range[1]>=range[2]) return null;
    for(const item of parts[i].split(',')) {
      const span=item.match(/^(mon|tue|wed|thu|fri|sat|sun)(?:-(mon|tue|wed|thu|fri|sat|sun))?$/);
      if(!span) return null;
      const from=dayNumbers[span[1]],to=dayNumbers[span[2]??span[1]];
      if(to<from) return null;
      for(let d=from;d<=to;d++) { const key=String(d) as keyof OfficeHours; if(hours[key]) return null; hours[key]=[range[1],range[2]]; }
    }
  }
  return hours;
}

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
    const modeButton=callback.data.match(/^fg:m:(auto|away|on_duty|paused)$/);
    if (modeButton) return {...base,callbackId:callback.id,action:'mode',mode:modeButton[1] as BotMode,conversationId:null,revision:null};
    const match=callback.data.match(/^fg:([tsra]):([a-f0-9-]{36}):([0-9]{1,10})$/);
    if (!match || !isUUID(match[2]) || Number(match[3])>2147483647) return null;
    const actions:Record<string,StaffAction>={t:'takeover',s:'summary',r:'resolve',a:'return_ai'};
    return {...base,callbackId:callback.id,action:actions[match[1]],conversationId:match[2],revision:Number(match[3])};
  }
  if (typeof message.text!=='string' || message.text.length>100) return null;
  if (/^\/(start|inbox)\s*$/.test(message.text)) return {...base,action:'inbox',conversationId:null,revision:null};
  // Global bot mode. /resume is an alias for /away (bot answers again).
  const setHours=message.text.match(/^\/sethours\s+(.+)$/);
  if (setHours) { const hours=parseOfficeHours(setHours[1]); return hours?{...base,action:'hours',hours,conversationId:null,revision:null}:null; }
  const command=message.text.match(/^\/(status|hours|auto|away|onduty|pause|resume)\s*$/);
  if (command) {
    const modes:Record<string,BotMode|null>={status:null,hours:null,auto:'auto',away:'away',resume:'away',onduty:'on_duty',pause:'paused'};
    return {...base,action:'mode',mode:modes[command[1]],conversationId:null,revision:null};
  }
  const match=message.text.match(/^\/summary ([a-f0-9-]{36})\s*$/);
  return match && isUUID(match[1]) ? {...base,action:'summary',conversationId:match[1],revision:null} : null;
}
