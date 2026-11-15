import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';

let db,app,staff,chats,runNotificationTest,notificationTestOptions,BotAPITransport;
const target=7646333318,hash='c'.repeat(64),actorId=randomUUID();
const env={SUPABASE_ENABLED:'true',SUPABASE_ISOLATED_DEV_CONFIRMED:'true',SUPABASE_PROJECT_REF:'figadevtest',SUPABASE_URL:'https://figadevtest.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_inert_test_fixture',AI_ENABLED:'false'};
const rpc=async(name,parameters)=>{
  const values=Object.values(parameters);
  return (await db.query(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values.map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;
};
before(async()=>{
  const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler'))('esbuild');
  const outfile=resolve('.wrangler/notification-flow-tests.mjs');
  await build({entryPoints:['database-tests/notification-flow-entry.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
  const module=await import(pathToFileURL(outfile).href);
  ({runNotificationTest,notificationTestOptions,BotAPITransport}=module);
  class LocalChats extends module.SupabaseRepository {rpc=rpc;}
  class LocalStaff extends module.SupabaseStaffRepository {rpc=rpc;}
  chats=new LocalChats({});staff=new LocalStaff({});app=module.createWorker(chats);
  db=await PGlite.create();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const file of ['20261112000100_figa_schema.sql','20261112000200_figa_transactions.sql','20261113000100_staff_telegram.sql','20261114000100_notification_preview.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await db.query('insert into auth.users(id) values($1)',[actorId]);
  await db.query("insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,true,array['view'],now(),$1)",[actorId,target]);
});
after(async()=>{await db?.close();});
async function fixture() {
  // Inspect existing queue before creating any fixture. This operation is read only.
  assert.equal((await staff.preview(target,target)).kind,'ok');
  const created=await app.fetch(new Request('http://localhost/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({syntheticData:true})}),env);
  assert.equal(created.status,201);
  const cookie=created.headers.get('Set-Cookie').split(';')[0],conversation=await created.json();
  const body={message:'I need three caregivers for a night shift in Salem, Oregon.',engine:'deterministic',syntheticData:true,conversationId:conversation.id,messageId:randomUUID()};
  const send=()=>app.fetch(new Request('http://localhost/chat',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}),env);
  const response=await send();assert.equal(response.status,200);const saved=await response.json();
  const preview=await staff.preview(target,target,null,conversation.id);
  assert.equal(preview.kind,'ok');assert.equal(preview.notifications.length,1);
  return {conversation:conversation.id,saved,notification:preview.notifications[0],send};
}
function guard(){let taken=false;return {exists:async()=>taken,reserve:async()=>{if(taken)throw new Error('locked');taken=true;return async()=>{};}};}
function api(){const state={sent:0};return {state,getMe:async()=>({id:123456789,is_bot:true,username:'figa_staff_assistant_bot'}),send:async message=>{assert.equal(message.chat_id,target);assert.deepEqual(message.reply_markup.inline_keyboard,[]);state.sent++;}};}
async function snapshot() {
  const tables=['contacts','conversations','messages','provider_requests','caregiver_leads','staff_assignments','conversation_events','staff_roster','telegram_updates','telegram_notifications','telegram_deliveries'];
  return Promise.all(tables.map(async name=>(await db.query(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from public.${name} t`)).rows[0].digest));
}

test('existing queue can be inspected without changing records before fixture creation',async()=>{
  const before=await snapshot();
  assert.equal((await staff.preview(target,target)).kind,'ok');
  assert.deepEqual(await snapshot(),before);
});
test('synthetic request submitted through the chat API is persisted, classified and queued once',async()=>{
  const f=await fixture();assert.equal(f.saved.persistence.saved,true);
  assert.deepEqual(f.saved.collectedInformation,{city:'Salem',state:'Oregon',position:'caregiver',shift:'night shift',count:'3'});
  assert.equal(f.notification.kind,'provider');assert.equal(f.notification.deliveryState,'pending');
  const row=(await db.query('select caregiver_count,city,state,shift from public.provider_requests where conversation_id=$1',[f.conversation])).rows[0];
  assert.deepEqual(row,{caregiver_count:3,city:'Salem',state:'Oregon',shift:'night shift'});
  assert.equal((await f.send()).status,200);
  assert.equal((await staff.preview(target,target,null,f.conversation)).notifications.length,1);
});
test('dry run succeeds inside a READ ONLY transaction and leaves every database table unchanged',async()=>{
  const f=await fixture(),network=api();const before=await snapshot();
  await db.exec('begin read only');let report;
  try {report=await runNotificationTest({mode:'DRY_RUN',notificationId:f.notification.id,conversationId:f.conversation},network,staff,guard());}
  finally {await db.exec('rollback');}
  assert.deepEqual(await snapshot(),before);assert.equal(report.readyForSending,true);assert.equal(report.sendAttempted,false);assert.equal(report.messageSent,false);assert.deepEqual(report.errors,[]);assert.equal(network.state.sent,0);
  for(const text of ['City: Salem','State: Oregon','Caregivers needed: 3','Shift: night shift','Status: open / AI'])assert.ok(report.notifications[0].safeText.includes(text));
  assert.equal((await db.query('select count(*) from public.telegram_deliveries')).rows[0].count,0);
});
test('preview is authorized and private; it cannot expose data to unknown, inactive or unbound recipients',async()=>{
  const f=await fixture();
  for(const [actor,chat] of [[999999,999999],[target,-target],[target,999999]])assert.equal((await staff.preview(actor,chat,f.notification.id)).kind,'denied');
  await db.query('update public.staff_roster set active=false where staff_user_id=$1',[actorId]);
  try{assert.equal((await staff.preview(target,target,f.notification.id)).kind,'denied');assert.equal((await staff.claimOne(target,target,f.notification.id)).kind,'denied');}
  finally{await db.query('update public.staff_roster set active=true where staff_user_id=$1',[actorId]);}
});
test('one selected notification is claimed, sent and acknowledged once; all others remain untouched',async()=>{
  const f=await fixture(),other=await fixture(),network=api(),local=guard();
  const options={mode:'SEND',notificationId:f.notification.id,conversationId:f.conversation};
  const first=await runNotificationTest(options,network,staff,local);
  assert.equal(first.messageSent,true);assert.equal(first.deliveryAcknowledged,true);assert.equal(network.state.sent,1);
  assert.equal((await staff.preview(target,target,f.notification.id)).notifications[0].deliveryState,'delivered');
  assert.equal((await staff.preview(target,target,other.notification.id)).notifications[0].deliveryState,'pending');
  const again=await runNotificationTest(options,network,staff,guard());assert.equal(again.messageSent,false);assert.equal(network.state.sent,1);
});
test('competing targeted claims cannot acquire the same delivery lease',async()=>{
  const f=await fixture();const claims=await Promise.all([staff.claimOne(target,target,f.notification.id),staff.claimOne(target,target,f.notification.id)]);
  assert.deepEqual(claims.map(c=>c.kind).sort(),['claimed','unavailable']);
});
test('uncertain Telegram delivery is not acknowledged or retried after lease expiry',async()=>{
  const f=await fixture(),local=guard(),network=api();network.send=async()=>{network.state.sent++;throw new Error('uncertain outcome');};
  const options={mode:'SEND',notificationId:f.notification.id,conversationId:f.conversation};
  const first=await runNotificationTest(options,network,staff,local);assert.equal(first.deliveryAcknowledged,false);
  await db.query("update public.telegram_deliveries set lease_expires_at=now()-interval '1 second' where notification_id=$1",[f.notification.id]);
  const second=await runNotificationTest(options,network,staff,local);assert.equal(second.sendAttempted,false);assert.equal(network.state.sent,1);
});
test('personal fields and unsafe free text never enter the prepared notification',async()=>{
  const f=await fixture();
  await db.query("update public.conversations set state=jsonb_set(state,'{collected}',state->'collected'||$2::jsonb) where id=$1",[f.conversation,JSON.stringify({name:'Secret Name',organization:'Secret Organization',notes:'resident diagnosis',experience:'patient history',city:'Resident dementia'})]);
  const report=await runNotificationTest({mode:'DRY_RUN',notificationId:f.notification.id,conversationId:null},api(),staff,guard());
  const text=report.notifications[0].safeText;for(const forbidden of ['Secret Name','Secret Organization','resident diagnosis','patient history','Resident dementia'])assert.ok(!text.includes(forbidden));
});
test('new helpers deny public access and maintain service-only RPC privileges',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);
    try{await assert.rejects(()=>staff.preview(target,target),/Database|permission denied/);await assert.rejects(()=>staff.claimOne(target,target,randomUUID()),/Database|permission denied/);}
    finally{await db.exec('reset role');}
  }
  await db.exec('set role service_role');
  try{assert.equal((await staff.preview(target,target)).kind,'ok');}
  finally{await db.exec('reset role');}
});
test('send mode requires an explicit UUID and default mode is read only',()=>{
  assert.equal(notificationTestOptions([]).mode,'DRY_RUN');
  for(const args of [['--send'],['--send','--dry-run'],['--send','--notification-id','bad'],['--recipient','999']])assert.throws(()=>notificationTestOptions(args));
});
test('scoped transport cannot send more than its approved payload or enable polling',async()=>{
  const f=await fixture();const preview=await runNotificationTest({mode:'DRY_RUN',notificationId:f.notification.id,conversationId:null},api(),staff,guard());
  const message={chat_id:target,text:preview.notifications[0].safeText,protect_content:true,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[]}};
  let calls=0;
  const network=async()=>{calls++;return Response.json({ok:true,result:{message_id:1,text:message.text,chat:{id:target,type:'private'}}});};
  const sdk=BotAPITransport.forNotificationTest('123456789:fictional_not_a_real_token_12345',message,true,network);
  await assert.rejects(()=>sdk.send({...message,text:'unapproved text'}));await assert.rejects(()=>sdk.updates(0));assert.equal(calls,0);
  await sdk.send(message);await assert.rejects(()=>sdk.send(message));assert.equal(calls,1);
});
