// Node-only one-shot CLI. Never registered as a Worker HTTP endpoint.
import { readFile,access,mkdir,open,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { databaseConfiguration } from '../database/config';
import type { DatabaseEnvironment } from '../database/types';
import { SupabaseStaffRepository } from './repository';
import { BotAPITransport } from './transport';
import { notificationTestOptions,runNotificationTest } from './notification-test';
import type { SendAttemptGuard } from './connection-test';

async function main() {
  let options;
  try {options=notificationTestOptions(process.argv.slice(2));}
  catch {console.error('Use --dry-run [--notification-id UUID] [--conversation-id UUID], or --send --notification-id UUID.');process.exitCode=1;return;}
  let token:string,db:DatabaseEnvironment;
  try {
    const common=parseEnv(await readFile(resolve('.dev.vars'),'utf8'));
    const ai=parseEnv(await readFile(resolve('.dev.vars.workers-ai'),'utf8'));
    for(const config of [common,ai])for(const key of ['TELEGRAM_STAFF_ENABLED','TELEGRAM_LIVE_ENABLED','TELEGRAM_WEBHOOK_ENABLED'])if(config[key]!==undefined&&config[key]!=='false')throw new Error();
    token=ai.TELEGRAM_BOT_TOKEN??'';
    if(!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token))throw new Error();
    db={SUPABASE_ENABLED:common.SUPABASE_ENABLED,SUPABASE_ISOLATED_DEV_CONFIRMED:common.SUPABASE_ISOLATED_DEV_CONFIRMED,SUPABASE_PROJECT_REF:common.SUPABASE_PROJECT_REF,SUPABASE_URL:common.SUPABASE_URL,SUPABASE_SECRET_KEY:common.SUPABASE_SECRET_KEY};
    if(!databaseConfiguration(db).configured)throw new Error();
  } catch {console.error('Configuration unavailable. Keep Telegram flags false and verify ignored local credentials. No message was sent.');process.exitCode=1;return;}
  const folder=resolve('.wrangler','notification-test-attempts'),filename=resolve(folder,(options.notificationId??'preview')+'.json');
  const guard:SendAttemptGuard={
    async exists(){try{await access(filename);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
    async reserve(){await mkdir(folder,{recursive:true});const file=await open(filename,'wx',0o600);try{await file.writeFile(JSON.stringify({state:'attempt_reserved',at:new Date().toISOString()}));await file.sync();}finally{await file.close();}return async()=>{await writeFile(filename,JSON.stringify({state:'sent',at:new Date().toISOString()}),{mode:0o600});};},
  };
  const identity=BotAPITransport.forConnectionTest(token,false);
  let attempted=false;
  const api={getMe:()=>identity.getMe(),send:async(message:import('./types').TelegramMessage)=>{
    if(options.mode!=='SEND'||attempted)throw new Error('Delivery disabled.');attempted=true;
    await BotAPITransport.forNotificationTest(token,message,true).send(message);
  }};
  const report=await runNotificationTest(options,api,new SupabaseStaffRepository(db),guard);
  console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
}
try {await main();}catch{console.error('Notification test unavailable. No automatic retry was made; inspect any local attempt record before further testing.');process.exitCode=1;}
