// Node-only CLI: default is an offline plan, never a background polling loop.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { isUUID } from '../validation';
import { databaseConfiguration } from '../database/config';
import { CONNECTION_TEST_BOT,CONNECTION_TEST_USER } from './connection-test-policy';
import { BotAPITransport } from './transport';
import { SupabaseStaffRepository } from './repository';
import { StaffBot } from './bot';
import { acquirePollLock,pollCheckpoint } from './polling-state';
import { controlledPollOnce } from './controlled-polling';

async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--dry-run') {
    console.log(JSON.stringify({mode:'DRY_RUN',networkAccess:false,pollingStarted:false,maxUpdates:1,targetUserId:CONNECTION_TEST_USER,requiresApproval:true,requiresConversationId:true}));return;
  }
  if(args.length!==4||args[0]!=='--once'||args[1]!=='--approve-live'||args[2]!=='--conversation-id'||!isUUID(args[3]))throw new Error('Invalid options.');
  const conversationId=args[3];
  const common=parseEnv(await readFile(resolve('.dev.vars'),'utf8'));
  const local=parseEnv(await readFile(resolve('.dev.vars.workers-ai'),'utf8'));
  if(local.TELEGRAM_STAFF_ENABLED!=='true'||local.TELEGRAM_LIVE_ENABLED!=='true'||local.TELEGRAM_WEBHOOK_ENABLED!=='false'||common.TELEGRAM_WEBHOOK_ENABLED==='true')throw new Error('Controlled polling not enabled.');
  const db={SUPABASE_ENABLED:common.SUPABASE_ENABLED,SUPABASE_ISOLATED_DEV_CONFIRMED:common.SUPABASE_ISOLATED_DEV_CONFIRMED,SUPABASE_PROJECT_REF:common.SUPABASE_PROJECT_REF,SUPABASE_URL:common.SUPABASE_URL,SUPABASE_SECRET_KEY:common.SUPABASE_SECRET_KEY};
  if(!databaseConfiguration(db).configured)throw new Error('Isolated database not configured.');
  const api=new BotAPITransport({TELEGRAM_STAFF_ENABLED:local.TELEGRAM_STAFF_ENABLED,TELEGRAM_LIVE_ENABLED:local.TELEGRAM_LIVE_ENABLED,TELEGRAM_BOT_TOKEN:local.TELEGRAM_BOT_TOKEN});
  const identity=await api.getMe();if(identity.username.toLowerCase()!==CONNECTION_TEST_BOT)throw new Error('Unexpected bot identity.');
  if((await api.getWebhookInfo()).url!=='')throw new Error('A registered webhook prevents polling.');
  const repository=new SupabaseStaffRepository(db);
  if(!await repository.controls(CONNECTION_TEST_USER,CONNECTION_TEST_USER,conversationId,null))throw new Error('Staff controls unavailable.');
  // No getUpdates call occurs before acquiring this bot-wide exclusive host lock.
  const release=await acquirePollLock(identity.id);let stopped=false;
  const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    const result=await controlledPollOnce(api,new StaffBot(repository,api),pollCheckpoint(identity.id),{actor:CONNECTION_TEST_USER,conversationId},()=>stopped);
    console.log(JSON.stringify({mode:'CONTROLLED_ONCE',...result,continuousPolling:false}));
  } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);await release();}
}
try{await main();}catch{console.error('Controlled poll stopped safely. Verify explicit approval, flags, bot identity, webhook status, controls migration and lock/checkpoint state. No automatic retry was started.');process.exitCode=1;}
