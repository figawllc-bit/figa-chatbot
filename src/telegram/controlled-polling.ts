import type { StaffBot } from './bot';
import type { ControlledStaffScope } from './types';
import { record } from './update';

export interface PollCheckpoint {load():Promise<number>;save(offset:number):Promise<void>}
// Exactly one bounded poll, at most one update, no queue dispatcher or retry loop.
export async function controlledPollOnce(source:{updates(offset:number,limit:number):Promise<unknown[]>},bot:Pick<StaffBot,'handle'>,checkpoint:PollCheckpoint,scope:ControlledStaffScope,stopped=()=>false) {
  const offset=await checkpoint.load();
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid checkpoint.');
  if(stopped())return {processed:0,nextOffset:offset};
  const updates=await source.updates(offset,1);
  if(stopped())return {processed:0,nextOffset:offset};
  if(!Array.isArray(updates)||updates.length>1)throw new Error('Unexpected polling batch.');
  if(!updates.length)return {processed:0,nextOffset:offset};
  const id=record(updates[0]).update_id;
  if(!Number.isSafeInteger(id)||Number(id)<offset||Number(id)>=Number.MAX_SAFE_INTEGER)throw new Error('Invalid update ID.');
  await bot.handle(updates[0],scope);
  // Persist only after successful processing. DB update-ID dedupe handles a crash
  // after action commit but before checkpoint replacement; never acknowledge early.
  await checkpoint.save(Number(id)+1);
  return {processed:1,nextOffset:Number(id)+1};
}
