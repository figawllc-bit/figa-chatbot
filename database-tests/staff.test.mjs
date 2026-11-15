import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let db;let sequence=0;
const token='a'.repeat(64),hash='b'.repeat(64);
const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args.map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;
before(async()=>{
  db=await PGlite.create();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
  for(const file of ['20261112000100_figa_schema.sql','20261112000200_figa_transactions.sql','20261113000100_staff_telegram.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});
async function staff(permissions=['view','takeover','resolve','return_ai'],active=true) {
  const id=randomUUID(),telegram=100000+(++sequence);
  await db.query('insert into auth.users(id) values($1)',[id]);
  await db.query('insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,$3,$4,now(),$1)',[id,telegram,active,permissions]);
  return {id,telegram};
}
const create=()=>rpc('figa_create_conversation',[token]);
const action=(s,id,revision,kind='takeover',update=++sequence,requestHash=hash)=>rpc('figa_telegram_process',[update,s.telegram,s.telegram,kind,id,revision,requestHash]);
const begin=(id,messageId=randomUUID())=>rpc('figa_begin_turn',[id,token,messageId,'Fictional staffing request',hash]);
const restore=id=>rpc('figa_restore_conversation',[id,token]);
const reply=(type='provider')=>({mode:'LOCAL_DEVELOPMENT_DRY_RUN',conversationType:type,assistantResponse:'What is your name?',collectedInformation:{count:'2'},state:{version:1,type,collected:{count:'2',city:'Salem',date:'tonight',notes:'Never send this note',experience:'Never send this experience',name:'Fictional Customer'},awaiting:'name',humanAttentionReasons:[]},humanAttentionNeeded:false,humanAttentionReasons:[],complete:false});
const finish=(id,messageId,turn,type)=>rpc('figa_finish_turn',[id,token,messageId,turn.leaseToken,turn.conversation.revision,reply(type)]);

test('all new tables deny public and service direct access; legacy takeover RPC is retired',async()=>{
  for(const name of ['staff_roster','telegram_updates','telegram_notifications','telegram_deliveries']) {
    assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass',['public.'+name])).rows[0].relrowsecurity,true);
    for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,$2,'SELECT') as allowed",[role,'public.'+name])).rows[0].allowed,false);
  }
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.figa_assign_human(uuid,uuid,integer)','EXECUTE') as allowed",[role])).rows[0].allowed,false);
  for(const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    try { await assert.rejects(()=>rpc('figa_telegram_recipients'),/permission denied/); }
    finally { await db.exec('reset role'); }
  }
});
test('unknown/inactive/unprivileged staff cannot access or take conversations',async()=>{
  const c=await create(),inactive=await staff(undefined,false),viewer=await staff(['view']),noView=await staff(['takeover']);
  assert.equal((await action({telegram:999999},c.id,0)).kind,'denied');
  for(const s of [inactive,viewer,noView])assert.equal((await action(s,c.id,0)).kind,'denied');
  assert.equal((await action(inactive,c.id,0,'summary')).kind,'denied');
  assert.equal((await restore(c.id)).mode,'AI');
});
test('service role can execute the authorized action RPC but cannot bypass it with the legacy primitive',async()=>{
  const c=await create(),s=await staff();
  await db.exec('set role service_role');
  try {
    await assert.rejects(()=>rpc('figa_assign_human',[c.id,s.id,0]),/permission denied/);
    assert.equal((await action(s,c.id,0)).kind,'applied');
  } finally {await db.exec('reset role');}
});
test('chat binding is authoritative and verified staff identities cannot be spoofed',async()=>{
  const c=await create(),s=await staff();
  assert.equal((await rpc('figa_telegram_process',[++sequence,s.telegram,s.telegram+1,'summary',c.id,0,hash])).kind,'denied');
  assert.equal((await rpc('figa_telegram_process',[++sequence,s.telegram,-s.telegram,'takeover',c.id,0,hash])).kind,'denied');
  assert.equal(await rpc('figa_assign_human',[c.id,randomUUID(),0]),false);
});
test('authorized takeover pauses new AI turns and records inbound messages',async()=>{
  const c=await create(),s=await staff();
  assert.equal((await action(s,c.id,0)).kind,'applied');
  const after=await restore(c.id);assert.equal(after.mode,'HUMAN');assert.equal(after.revision,1);
  assert.equal((await begin(c.id)).kind,'controlled');
  assert.equal((await restore(c.id)).messages.length,1);
});
test('takeover suppresses a pending AI response without persisting its generated facts',async()=>{
  const c=await create(),s=await staff(),messageId=randomUUID(),turn=await begin(c.id,messageId);
  assert.equal((await action(s,c.id,0)).kind,'applied');
  const result=await finish(c.id,messageId,turn);
  assert.equal(result.assistantResponse,'');assert.equal(result.engine.used,'none');
  assert.equal((await restore(c.id)).messages.length,1);
  assert.equal((await db.query('select count(*) from public.provider_requests where conversation_id=$1',[c.id])).rows[0].count,0);
});
test('competing staff claims and stale buttons produce only one active owner',async()=>{
  const c=await create(),a=await staff(),b=await staff();
  const results=await Promise.all([action(a,c.id,0),action(b,c.id,0)]);
  assert.deepEqual(results.map(r=>r.kind).sort(),['applied','stale']);
  assert.equal((await db.query('select count(*) from public.staff_assignments where conversation_id=$1 and released_at is null',[c.id])).rows[0].count,1);
  assert.equal((await action(a,c.id,0,'resolve')).kind,'stale');
});
test('only the current owner with the specific permission can return to AI or resolve',async()=>{
  const c=await create(),owner=await staff(['view','takeover']),other=await staff();
  await action(owner,c.id,0);
  assert.equal((await action(owner,c.id,1,'return_ai')).kind,'denied');
  assert.equal((await action(other,c.id,1,'resolve')).kind,'denied');
  await db.query("update public.staff_roster set permissions=array['view','takeover','return_ai','resolve'] where staff_user_id=$1",[owner.id]);
  assert.equal((await action(owner,c.id,1,'return_ai')).kind,'applied');
  assert.equal((await restore(c.id)).mode,'AI');
  assert.equal((await action(owner,c.id,2)).kind,'applied');
  assert.equal((await action(owner,c.id,3,'resolve')).kind,'applied');
  const done=await restore(c.id);assert.equal(done.status,'closed');
  assert.equal((await action(owner,c.id,4,'return_ai')).kind,'unavailable');
  assert.equal((await begin(c.id)).kind,'controlled');
});
test('blocked/closed conversations cannot be taken over or reopened by Telegram actions',async()=>{
  const s=await staff();
  for(const status of ['blocked','closed']) {const c=await create();await db.query('update public.conversations set status=$2 where id=$1',[c.id,status]);assert.equal((await action(s,c.id,0)).kind,'unavailable');}
});
test('a pre-takeover pending reply stays suppressed even after an explicit return to AI',async()=>{
  const c=await create(),s=await staff(),messageId=randomUUID(),turn=await begin(c.id,messageId);
  assert.equal((await action(s,c.id,0)).kind,'applied');
  assert.equal((await action(s,c.id,1,'return_ai')).kind,'applied');
  const result=await finish(c.id,messageId,turn);assert.equal(result.assistantResponse,'');assert.equal(result.engine.used,'none');
  assert.equal((await restore(c.id)).mode,'AI');assert.equal((await begin(c.id)).kind,'ready');
});
test('permission changes, NULL revisions and missing conversations fail closed',async()=>{
  const c=await create(),s=await staff();
  assert.equal((await action(s,c.id,null)).kind,'stale');
  assert.equal((await action(s,randomUUID(),0)).kind,'unavailable');
  await action(s,c.id,0);
  await db.query("update public.staff_roster set permissions=array['view'] where staff_user_id=$1",[s.id]);
  assert.equal((await action(s,c.id,1,'resolve')).kind,'denied');
  assert.equal((await restore(c.id)).mode,'HUMAN');
});
test('duplicate updates do not duplicate assignments/audits and changed retries conflict',async()=>{
  const c=await create(),s=await staff(),id=++sequence;
  assert.equal((await action(s,c.id,0,'takeover',id)).kind,'applied');
  assert.equal((await action(s,c.id,0,'takeover',id)).kind,'duplicate');
  assert.equal((await action(s,c.id,0,'takeover',id,'c'.repeat(64))).kind,'conflict');
  assert.equal((await restore(c.id)).revision,1);
  assert.equal((await db.query("select count(*) from public.conversation_events where conversation_id=$1 and event_type='human_assigned'",[c.id])).rows[0].count,1);
  await db.query('update public.staff_roster set active=false where staff_user_id=$1',[s.id]);
  assert.equal((await action(s,c.id,0,'takeover',id)).kind,'denied');
});
test('new provider, caregiver and urgent notifications are queued without private transcripts',async()=>{
  const s=await staff(),provider=await create(),caregiver=await create();
  for(const [c,type]of [[provider,'provider'],[caregiver,'caregiver']]){const messageId=randomUUID();await finish(c.id,messageId,await begin(c.id,messageId),type);}
  const kinds=(await db.query('select kind from public.telegram_notifications where conversation_id=$1 order by kind',[provider.id])).rows.map(r=>r.kind);
  assert.deepEqual(kinds,['provider','urgent']);
  assert.equal((await db.query('select kind from public.telegram_notifications where conversation_id=$1',[caregiver.id])).rows[0].kind,'caregiver');
  const summary=await rpc('figa_telegram_summary',[s.telegram,s.telegram,provider.id,1]);
  for(const forbidden of ['Never send','Fictional Customer','access_token_hash','messages','experience','notes'])assert.equal(JSON.stringify(summary).includes(forbidden),false);
});
test('notification leases prevent concurrent dispatch; acknowledgements deduplicate and authorization is rechecked',async()=>{
  const s=await staff(),c=await create();await action(s,c.id,0);
  const batch=await rpc('figa_telegram_pending',[s.telegram,s.telegram]);assert.equal(batch.kind,'ok');assert.ok(batch.notifications.length>0);
  const again=await rpc('figa_telegram_pending',[s.telegram,s.telegram]);
  const ids=new Set(batch.notifications.map(n=>n.id));assert.equal(again.notifications.some(n=>ids.has(n.id)),false);
  const claim=batch.notifications[0];
  assert.ok(await rpc('figa_telegram_notification',[s.telegram,s.telegram,claim.id,claim.leaseToken]));
  assert.equal(await rpc('figa_telegram_ack',[s.telegram,s.telegram,claim.id,randomUUID()]),false);
  assert.equal(await rpc('figa_telegram_ack',[s.telegram,s.telegram,claim.id,claim.leaseToken]),true);
  assert.equal(await rpc('figa_telegram_ack',[s.telegram,s.telegram,claim.id,claim.leaseToken]),false);
  await db.query('update public.staff_roster set active=false where staff_user_id=$1',[s.id]);
  assert.equal((await rpc('figa_telegram_pending',[s.telegram,s.telegram])).kind,'denied');
  assert.equal(await rpc('figa_telegram_summary',[s.telegram,s.telegram,c.id,1]),null);
});
test('notification expiry allows recovery and revocation suppresses already-claimed notifications',async()=>{
  const s=await staff(),c=await create();await action(s,c.id,0);
  const old=(await rpc('figa_telegram_pending',[s.telegram,s.telegram])).notifications[0];
  await db.query("update public.telegram_deliveries set lease_expires_at=now()-interval '1 second' where notification_id=$1 and staff_user_id=$2",[old.id,s.id]);
  const next=(await rpc('figa_telegram_pending',[s.telegram,s.telegram])).notifications.find(n=>n.id===old.id);
  assert.ok(next);assert.notEqual(next.leaseToken,old.leaseToken);
  assert.equal(await rpc('figa_telegram_notification',[s.telegram,s.telegram,old.id,old.leaseToken]),null);
  await db.query('update public.staff_roster set active=false where staff_user_id=$1',[s.id]);
  assert.equal(await rpc('figa_telegram_notification',[s.telegram,s.telegram,next.id,next.leaseToken]),null);
});
