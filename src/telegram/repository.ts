import { SupabaseRepository } from '../database/supabase';
import type { BotModeResult, NotificationClaim, NotificationPreview, StaffControls, StaffNotification, StaffRepository, StaffResult, StaffSummary, StaffUpdate } from './types';

export class SupabaseStaffRepository extends SupabaseRepository implements StaffRepository {
  controls(actor:number,chat:number,id:string,revision:number|null) {return this.rpc<StaffControls|null>('figa_telegram_controls',{p_actor:actor,p_chat:chat,p_id:id,p_revision:revision});}
  recipients() { return this.rpc<{actor:number;chat:number}[]>('figa_telegram_recipients',{}); }
  preview(actor:number,chat:number,notification:string|null=null,conversation:string|null=null) { return this.rpc<{kind:'ok'|'denied';notifications?:NotificationPreview[]}>('figa_telegram_preview',{p_actor:actor,p_chat:chat,p_notification:notification,p_conversation:conversation}); }
  claimOne(actor:number,chat:number,notification:string) { return this.rpc<{kind:'claimed';claim:NotificationClaim}|{kind:'denied'|'unavailable'}>('figa_telegram_claim_one',{p_actor:actor,p_chat:chat,p_notification:notification}); }
  process(u:StaffUpdate, hash:string) { return this.rpc<StaffResult>('figa_telegram_process',{p_update_id:u.updateId,p_actor:u.actor,p_chat:u.chat,p_action:u.action,p_id:u.conversationId,p_revision:u.revision,p_request_hash:hash}); }
  summary(actor:number,chat:number,id:string,revision:number) { return this.rpc<StaffSummary|null>('figa_telegram_summary',{p_actor:actor,p_chat:chat,p_id:id,p_revision:revision}); }
  pending(actor:number,chat:number) { return this.rpc<{kind:'ok'|'denied';notifications?:NotificationClaim[]}>('figa_telegram_pending',{p_actor:actor,p_chat:chat}); }
  notification(actor:number,chat:number,c:NotificationClaim) { return this.rpc<StaffNotification|null>('figa_telegram_notification',{p_actor:actor,p_chat:chat,p_notification:c.id,p_lease:c.leaseToken}); }
  acknowledge(actor:number,chat:number,c:NotificationClaim) { return this.rpc<boolean>('figa_telegram_ack',{p_actor:actor,p_chat:chat,p_notification:c.id,p_lease:c.leaseToken}); }
  mode(u:StaffUpdate, hash:string) { return this.rpc<BotModeResult>('figa_telegram_mode',{p_update_id:u.updateId,p_actor:u.actor,p_chat:u.chat,p_mode:u.mode??null,p_request_hash:hash}); }
  hours(u:StaffUpdate, hash:string) { return this.rpc<BotModeResult>('figa_telegram_hours',{p_update_id:u.updateId,p_actor:u.actor,p_chat:u.chat,p_hours:u.hours,p_request_hash:hash}); }
}
