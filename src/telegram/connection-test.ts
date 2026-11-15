import { BotAPITransport } from './transport';
import type { SupabaseStaffRepository } from './repository';
import { CONNECTION_TEST_BOT, CONNECTION_TEST_USER } from './connection-test-policy';

export interface SendAttemptGuard {
  exists():Promise<boolean>;
  // Must atomically reserve, fail if any earlier attempt exists, and never auto-reset.
  reserve():Promise<() => Promise<void>>;
}
export interface ConnectionTestReport {
  mode:'DRY_RUN'|'SEND'; botIdentityVerified:boolean; botUsername:string|null;
  staffAuthorizationVerified:boolean; targetUserId:number; readyForSending:boolean;
  previousAttemptRecorded:boolean; sendAttempted:boolean; messageSent:boolean; errors:string[];
}
export function connectionTestMode(args:string[]):'DRY_RUN'|'SEND' {
  if(args.length===0 || args.length===1&&args[0]==='--dry-run')return 'DRY_RUN';
  if(args.length===1&&args[0]==='--send')return 'SEND';
  throw new Error('Use only --dry-run or --send.');
}
export async function runConnectionTest(mode:'DRY_RUN'|'SEND',api:Pick<BotAPITransport,'getMe'|'sendConnectionTest'>,repository:Pick<SupabaseStaffRepository,'recipients'>,guard:SendAttemptGuard):Promise<ConnectionTestReport> {
  const report:ConnectionTestReport={mode,botIdentityVerified:false,botUsername:null,staffAuthorizationVerified:false,targetUserId:CONNECTION_TEST_USER,readyForSending:false,previousAttemptRecorded:false,sendAttempted:false,messageSent:false,errors:[]};
  try {
    const bot=await api.getMe();
    if(bot.is_bot!==true || bot.username.toLowerCase()!==CONNECTION_TEST_BOT) {
      report.errors.push('Bot identity does not match the approved FIGA staff bot.');return report;
    }
    report.botIdentityVerified=true;report.botUsername=CONNECTION_TEST_BOT;
  } catch {report.errors.push('Telegram getMe verification failed. Check the token and network locally; no message was sent.');return report;}
  try {
    // This existing read-only RPC selects only active roster members with view permission.
    const recipients=await repository.recipients();
    report.staffAuthorizationVerified=Array.isArray(recipients)&&recipients.some(s=>s.actor===CONNECTION_TEST_USER&&s.chat===CONNECTION_TEST_USER);
    if(!report.staffAuthorizationVerified){report.errors.push('The approved private recipient is not an active staff roster member with view permission.');return report;}
  } catch {report.errors.push('Supabase staff authorization could not be verified. No message was sent.');return report;}
  try {
    report.previousAttemptRecorded=await guard.exists();
    if(report.previousAttemptRecorded){report.errors.push('A previous send attempt is recorded. Automatic retries and duplicate sends are blocked.');return report;}
    report.readyForSending=true;
    if(mode==='DRY_RUN')return report;
    // Exclusive local reservation persists even if the result becomes uncertain.
    const markSent=await guard.reserve();
    report.readyForSending=false;report.sendAttempted=true;
    try {await api.sendConnectionTest();report.messageSent=true;await markSent();}
    catch {report.errors.push('Send outcome could not be fully confirmed. Inspect Telegram manually; do not retry. The attempt remains locked.');}
  } catch {report.readyForSending=false;report.errors.push('The local send guard could not be reserved or checked. No automatic retry was made.');}
  return report;
}
