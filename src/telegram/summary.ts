import { hasSensitiveInput } from '../safety';
import { isUUID } from '../validation';
import { record } from './update';
import type { StaffAction, StaffSummary, TelegramMessage } from './types';

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
