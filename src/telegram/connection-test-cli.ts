// Node-only entry point. Not imported by the Worker or exposed over HTTP.
import { readFile, mkdir, open, access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { BotAPITransport } from './transport';
import { SupabaseStaffRepository } from './repository';
import { databaseConfiguration } from '../database/config';
import { connectionTestMode, runConnectionTest, type SendAttemptGuard } from './connection-test';
import type { DatabaseEnvironment } from '../database/types';

async function main() {
  let mode:'DRY_RUN'|'SEND';
  try {mode=connectionTestMode(process.argv.slice(2));}
  catch {console.error('Invalid options. Use --dry-run (default) or --send, never both.');process.exitCode=1;return;}
  let token:string,db:DatabaseEnvironment;
  try {
    const common=parseEnv(await readFile(resolve('.dev.vars'),'utf8'));
    const ai=parseEnv(await readFile(resolve('.dev.vars.workers-ai'),'utf8'));
    // Do not enable global flags, even in memory. This test has its own narrow capability.
    for(const config of [common,ai])for(const key of ['TELEGRAM_STAFF_ENABLED','TELEGRAM_LIVE_ENABLED','TELEGRAM_WEBHOOK_ENABLED']) {
      if(config[key]!==undefined&&config[key]!=='false')throw new Error('Flags must stay disabled.');
    }
    token=ai.TELEGRAM_BOT_TOKEN??'';
    if(!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token))throw new Error('Missing token.');
    db={SUPABASE_ENABLED:common.SUPABASE_ENABLED,SUPABASE_ISOLATED_DEV_CONFIRMED:common.SUPABASE_ISOLATED_DEV_CONFIRMED,
      SUPABASE_PROJECT_REF:common.SUPABASE_PROJECT_REF,SUPABASE_URL:common.SUPABASE_URL,SUPABASE_SECRET_KEY:common.SUPABASE_SECRET_KEY};
    if(!databaseConfiguration(db).configured)throw new Error('Database not configured.');
  } catch {
    console.error('Configuration check failed. Verify the bot token in .dev.vars.workers-ai, isolated Supabase settings in .dev.vars, and that all Telegram feature flags remain false. No message was sent.');
    process.exitCode=1;return;
  }
  const folder=resolve('.wrangler');
  const filename=resolve(folder,'telegram-connection-test.attempt.json');
  const guard:SendAttemptGuard={
    async exists(){try{await access(filename);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}},
    async reserve(){
      await mkdir(folder,{recursive:true});
      const file=await open(filename,'wx',0o600);
      try{await file.writeFile(JSON.stringify({state:'attempt_reserved',at:new Date().toISOString()}));await file.sync();}finally{await file.close();}
      return async()=>{await writeFile(filename,JSON.stringify({state:'sent',at:new Date().toISOString()}),{mode:0o600});};
    },
  };
  const report=await runConnectionTest(mode,BotAPITransport.forConnectionTest(token,mode==='SEND'),new SupabaseStaffRepository(db),guard);
  console.log(JSON.stringify(report,null,2));
  if(report.errors.length)process.exitCode=1;
}
await main();
