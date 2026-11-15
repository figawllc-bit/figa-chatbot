import { digest } from '../database/service';
import { parseTelegramUpdate } from './update';
import { modeMessage, staffMessage } from './summary';
import type { ControlledStaffScope, StaffRepository, StaffUpdate, TelegramTransport } from './types';

const headings={provider:'New provider request',caregiver:'New caregiver inquiry',urgent:'Urgent staffing alert',status:'Conversation status update',message:'New text received - bot is not answering (On Duty or Paused). Reply from RingCentral.',hand_reply:'Bot stopped on this conversation: someone replied to the customer by hand. Take Over, then Return to AI to hand it back.'};
export class StaffBot {
  constructor(private readonly repository:StaffRepository,private readonly transport:TelegramTransport) {}
  async dispatch():Promise<number> {
    let sent=0;
    for(const recipient of await this.repository.recipients()) sent+=await this.notify(recipient.actor,recipient.chat);
    return sent;
  }
  // Call only behind authenticated Telegram ingress, or with explicitly fictional local fixtures.
  async handle(raw:unknown,scope?:ControlledStaffScope):Promise<string> {
    let u=parseTelegramUpdate(raw);
    if(!u) return 'ignored';
    if(scope) {
      if(u.actor!==scope.actor)return 'ignored';
      if(u.action==='inbox')u={...u,action:'summary',conversationId:scope.conversationId,revision:null};
      else if(u.conversationId!==scope.conversationId)return 'ignored';
    }
    // Global switches: never from a single-conversation test scope.
    if(u.action==='mode'||u.action==='hours') return scope ? 'ignored' : this.mode(u);
    const result=await this.repository.process(u,await digest(JSON.stringify(u)));
    if(!['ok','applied','denied','stale','unavailable','duplicate','conflict'].includes(result.kind)) throw new Error('Invalid staff action result.');
    if(u.callbackId) {
      const text={ok:'Summary ready.',applied:'Conversation updated.',denied:'Access denied.',stale:'This button is stale. Use /inbox for current buttons.',unavailable:'Conversation unavailable.',duplicate:'Update already processed.',conflict:'Update rejected.'}[result.kind];
      // Telegram callback acknowledgements expire. They must not prevent delivery
      // of a status update after the database action has already committed.
      try { await this.transport.answer(u.callbackId,text); } catch { /* No sensitive error logging. */ }
    }
    if(result.kind==='ok') for(const summary of result.conversations??[]) {
      // A second authorization check immediately before each outgoing summary.
      const fresh=await this.repository.summary(u.actor,u.chat,summary.id,summary.revision);
      const controls=fresh?await this.repository.controls(u.actor,u.chat,fresh.id,fresh.revision):null;
      if(controls) await this.transport.send(staffMessage(controls.summary,u.chat,'Conversation status',controls.actions));
    }
    if(scope && (result.kind==='applied'||result.kind==='duplicate'||result.kind==='stale')) {
      const controls=await this.repository.controls(u.actor,u.chat,scope.conversationId,null);
      if(controls)await this.transport.send(staffMessage(controls.summary,u.chat,'Conversation status',controls.actions));
    } else if(!scope && (result.kind==='applied' || result.kind==='duplicate')) await this.notify(u.actor,u.chat);
    return result.kind;
  }
  private async mode(u:StaffUpdate):Promise<string> {
    const hash=await digest(JSON.stringify(u));
    const result=u.action==='hours'?await this.repository.hours(u,hash):await this.repository.mode(u,hash);
    if(!['ok','applied','denied','duplicate','conflict'].includes(result.kind)) throw new Error('Invalid bot mode result.');
    if(u.callbackId) {
      const text={ok:'Mode unchanged.',applied:'Bot mode updated.',denied:'Access denied.',duplicate:'Update already processed.',conflict:'Update rejected.'}[result.kind];
      try { await this.transport.answer(u.callbackId,text); } catch { /* No sensitive error logging. */ }
    }
    if(result.kind==='denied'||result.kind==='conflict'||!result.mode||!result.effective) return result.kind;
    const status={mode:result.mode,effective:result.effective,hours:result.hours,timezone:result.timezone};
    const changed=u.action==='hours'?'Office hours changed':'Bot mode changed';
    if(result.kind==='applied') {
      // Everyone on the roster learns the bot was switched; each gets buttons only if permitted.
      for(const r of await this.repository.recipients()) {
        const own=r.actor===u.actor;
        try { await this.transport.send(modeMessage(status,r.chat,own?result.canChange===true:false,own?changed:changed+' by a staff member')); }
        catch(error) { if(own) throw error; }
      }
    } else await this.transport.send(modeMessage(status,u.chat,result.canChange===true));
    return result.kind;
  }
  async notify(actor:number,chat:number):Promise<number> {
    const batch=await this.repository.pending(actor,chat);
    if(batch.kind!=='ok') return 0;
    let sent=0;
    for(const claim of batch.notifications??[]) {
      const notification=await this.repository.notification(actor,chat,claim);
      if(!notification) continue;
      const heading=headings[notification.kind];
      if(!heading) throw new Error('Invalid notification.');
      const controls=await this.repository.controls(actor,chat,notification.conversation.id,notification.conversation.revision);
      if(!controls)continue;
      await this.transport.send(staffMessage(controls.summary,chat,heading,controls.actions));
      if(!await this.repository.acknowledge(actor,chat,claim)) throw new Error('Notification acknowledgement unavailable.');
      sent++;
    }
    return sent;
  }
}
