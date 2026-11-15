import { hasSensitiveInput } from '../safety';
import { isUUID } from '../validation';
import { record } from './update';
import type { BotMode, StaffAction, StaffSummary, TelegramMessage } from './types';

// Deliberately exclude names, organizations, notes, experience and message bodies.
export function staffMessage(value: StaffSummary, chat: number, heading='Conversation summary',actions:readonly StaffAction[]=[]): TelegramMessage {
  if (!isUUID(value.id) || !Number.isInteger(value.revision) || value.revision<0 || value.revision>2147483647 ||
      !['open','closed','blocked'].includes(value.status) || !['AI','HUMAN'].includes(value.mode) || !['provider','caregiver','general','unknown'].includes(value.type)) throw new Error('Invalid staff summary.');
  const d=record(value.details);
  const lines=[heading,`Conversation: ${value.id}`,`Type: ${value.type}`,`Status: ${value.status} / ${value.mode}`,`Revision: ${value.revision}`];
  const safe=(v:unknown,pattern:RegExp) => typeof v==='string' && v.length<=64 && pattern.test(v) && !hasSensitiveInput({message:v});
  for(const [key,label] of [['city','City'],['state','State']] as const) if(safe(d[key],/^[A-Za-z][A-Za-z .'-]*$/)) lines.push(`${label}: ${d[key]}`);
  if(safe(d.position,/^(caregivers?|CNAs?|RNs?|LPNs?|nurses?|home health aides?)$/i)) lines.push(`Position: ${d.position}`);
  if(safe(d.count,/^\d{1,5}$/) && Number(d.count)>=1 && Number(d.count)<=10000) lines.push(`Caregivers needed: ${d.count}`);
  if(safe(d.date,/^(today|tomorrow|tonight|(?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})$/i)) lines.push(`Date: ${d.date} (user-reported; confirm timing)`);
  if(safe(d.shift,/^(day|night|evening|overnight|morning|afternoon)(?: shift)?$/i)) lines.push(`Shift: ${d.shift}`);
  if(d.availabilityReceived===true) lines.push('Availability details collected; review in the secured conversation system.');
  if(value.urgent===true) lines.push('URGENT: staffing confirmation required.');
  lines.push('Synthetic development data. No availability or employment is confirmed.');
  const button=(text:string,action:string)=>({text,callback_data:`fg:${action}:${value.id}:${value.revision}`});
  // Default deny. These capabilities must come from the authenticated roster RPC.
  const buttons=actions.includes('summary')?[button('View Status','s')]:[];
  if(value.status==='open') {
    if(value.mode==='AI'&&actions.includes('takeover')) buttons.push(button('Take Over','t'));
    if(value.mode==='HUMAN') {
      if(actions.includes('resolve'))buttons.push(button('Resolve','r'));
      if(actions.includes('return_ai'))buttons.push(button('Return to AI','a'));
    }
  }
  return {chat_id:chat,text:lines.join('\n'),protect_content:true,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:buttons.length?[buttons]:[]}};
}

const modeText:Record<BotMode,string>={
  away:'AWAY - the bot is answering caregiver and provider texts automatically.',
  on_duty:'ON DUTY - staff are answering. The bot stays silent and alerts you to each new text.',
  paused:'PAUSED - the bot is off. It will not reply to or send any text.',
};
/** Global bot mode status. Buttons are shown only to staff allowed to change it. */
export function modeMessage(mode: BotMode, chat: number, canChange: boolean, heading='Bot mode'): TelegramMessage {
  if (!(mode in modeText)) throw new Error('Invalid bot mode.');
  const lines=[heading,modeText[mode],'Per-conversation Take Over / Return to AI still apply.'];
  const options:[BotMode,string][]=[['away','Away (bot answers)'],['on_duty','On Duty (staff answer)'],['paused','Pause all']];
  const buttons=canChange?options.filter(([m])=>m!==mode).map(([m,text])=>({text,callback_data:`fg:m:${m}`})):[];
  if(!canChange) lines.push('You can view the mode but not change it.');
  return {chat_id:chat,text:lines.join('\n'),protect_content:true,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:buttons.length?[buttons]:[]}};
}
