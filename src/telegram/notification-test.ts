import type { SupabaseStaffRepository } from './repository';
import type { BotAPITransport } from './transport';
import type { SendAttemptGuard } from './connection-test';
import { CONNECTION_TEST_BOT, CONNECTION_TEST_USER } from './connection-test-policy';
import { staffMessage } from './summary';
import { isUUID } from '../validation';

export type NotificationTestOptions={mode:'DRY_RUN'|'SEND';notificationId:string|null;conversationId:string|null};
export function notificationTestOptions(args:string[]):NotificationTestOptions {
  let mode:'DRY_RUN'|'SEND'='DRY_RUN',seenMode=false,notificationId:string|null=null,conversationId:string|null=null;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--dry-run'||arg==='--send') {if(seenMode)throw new Error('Conflicting mode.');seenMode=true;mode=arg==='--send'?'SEND':'DRY_RUN';}
    else if(arg==='--notification-id'&&notificationId===null) {notificationId=args[++i]??'';if(!isUUID(notificationId))throw new Error('Invalid notification ID.');}
    else if(arg==='--conversation-id'&&conversationId===null) {conversationId=args[++i]??'';if(!isUUID(conversationId))throw new Error('Invalid conversation ID.');}
    else throw new Error('Invalid arguments.');
  }
  if(mode==='SEND'&&!notificationId)throw new Error('Explicit notification ID required.');
  return {mode,notificationId,conversationId};
}
export function notificationTestMessage(notification:import('./types').StaffNotification) {
  if(!['provider','caregiver','urgent','status'].includes(notification.kind))throw new Error('Invalid notification.');
  const headings={provider:'New provider request',caregiver:'New caregiver inquiry',urgent:'Urgent staffing alert',status:'Conversation status update'};
  const message=staffMessage(notification.conversation,CONNECTION_TEST_USER,headings[notification.kind as keyof typeof headings]);
  // This recipient is view-only. No takeover, resolve, or return buttons are exposed.
  message.reply_markup={inline_keyboard:[]};
  return message;
}
type Repository=Pick<SupabaseStaffRepository,'recipients'|'preview'|'claimOne'|'notification'|'acknowledge'>;
export async function runNotificationTest(options:NotificationTestOptions,api:Pick<BotAPITransport,'getMe'|'send'>,repo:Repository,guard:SendAttemptGuard) {
  const report={mode:options.mode,botIdentityVerified:false,recipientAuthorized:false,targetUserId:CONNECTION_TEST_USER,
    queueInspected:false,notifications:[] as {id:string;kind:string;conversationId:string;deliveryState:string;safeText:string}[],readyForSending:false,sendAttempted:false,messageSent:false,deliveryAcknowledged:false,errors:[] as string[]};
  try {
    const bot=await api.getMe();if(bot.is_bot!==true||bot.username.toLowerCase()!==CONNECTION_TEST_BOT)throw new Error();report.botIdentityVerified=true;
  } catch {report.errors.push('Approved Telegram bot identity could not be verified.');return report;}
  try {
    report.recipientAuthorized=(await repo.recipients()).some(s=>s.actor===CONNECTION_TEST_USER&&s.chat===CONNECTION_TEST_USER);
    if(!report.recipientAuthorized){report.errors.push('Approved recipient is not active and authorized to view.');return report;}
  } catch {report.errors.push('Staff authorization unavailable.');return report;}
  try {
    const result=await repo.preview(CONNECTION_TEST_USER,CONNECTION_TEST_USER,options.notificationId,options.conversationId);
    if(result.kind!=='ok')throw new Error();
    report.queueInspected=true;
    for(const notification of result.notifications??[]) {
      if(!isUUID(notification.id))throw new Error();
      const message=notificationTestMessage(notification);
      report.notifications.push({id:notification.id,kind:notification.kind,conversationId:notification.conversation.id,deliveryState:notification.deliveryState,safeText:message.text});
    }
  } catch {report.errors.push('Read-only queue preview unavailable. Review/apply the pending notification-preview migration before retrying; no leases were acquired.');return report;}
  const selected=report.notifications.find(n=>n.id===options.notificationId&&n.deliveryState==='pending');
  report.readyForSending=!!selected&&!await guard.exists();
  if(options.mode==='DRY_RUN')return report;
  if(!selected||!report.readyForSending){report.errors.push('Selected notification is unavailable, already delivered, leased, or has a previous local attempt.');return report;}
  try {
    // Local durable guard also blocks retries after an ambiguous send, even after SQL lease expiry.
    const markSent=await guard.reserve();report.readyForSending=false;
    const result=await repo.claimOne(CONNECTION_TEST_USER,CONNECTION_TEST_USER,selected.id);
    if(result.kind!=='claimed')throw new Error();
    const notification=await repo.notification(CONNECTION_TEST_USER,CONNECTION_TEST_USER,result.claim);
    if(!notification||notification.id!==selected.id)throw new Error();
    const message=notificationTestMessage(notification);
    report.sendAttempted=true;await api.send(message);report.messageSent=true;
    report.deliveryAcknowledged=await repo.acknowledge(CONNECTION_TEST_USER,CONNECTION_TEST_USER,result.claim);
    await markSent();
    if(!report.deliveryAcknowledged)report.errors.push('Message sent but acknowledgement was not confirmed. Do not resend.');
  } catch {report.errors.push('One-shot delivery could not be fully confirmed. No retry was made. Inspect the outcome manually; the local attempt remains locked.');}
  return report;
}
