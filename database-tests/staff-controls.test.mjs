import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir,mkdtemp,writeFile,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';

let db,module;let sequence=0;const access='a'.repeat(64),requestHash='b'.repeat(64);
const rpc=async(name,values=[]) => (await db.query(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values.map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;
before(async()=>{
  const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler'))('esbuild'),outfile=resolve('.wrangler/staff-controls-tests.mjs');
  await build({entryPoints:['database-tests/notification-flow-entry.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
  module=await import(pathToFileURL(outfile).href);
  db=await PGlite.create();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(resolve('supabase/migrations',file),'utf8'));
});
after(async()=>{await db?.close();});
async function tester(permissions=['view','takeover','resolve','return_ai']){
  const id=randomUUID(),actor=7646333318+(++sequence);
  await db.query('insert into auth.users(id) values($1)',[id]);
  await db.query('insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,true,$3,now(),$1)',[id,actor,permissions]);
  return {id,actor};
}
async function fixture(permissions){
  const staff=await tester(permissions),conversation=await rpc('figa_create_conversation',[access]);
  await db.query("update public.conversations set classification='provider',state=state||$2::jsonb where id=$1",[conversation.id,JSON.stringify({type:'provider',collected:{count:'3',city:'Salem',state:'Oregon',shift:'night'}})]);
  class LocalRepository extends module.SupabaseStaffRepository {async rpc(name,parameters){return rpc(name,Object.values(parameters));}}
  const repo=new LocalRepository({}),transport=new module.SimulatedTelegramTransport(),bot=new module.StaffBot(repo,transport),scope={actor:staff.actor,conversationId:conversation.id};
  return {staff,conversation,repo,transport,bot,scope};
}
const callback=(actor,id,action,revision,update=++sequence)=>({update_id:update,callback_query:{id:'cb_'+update,from:{id:actor,is_bot:false},message:{chat:{id:actor,type:'private'}},data:`fg:${action}:${id}:${revision}`}});
const status=(s)=>({update_id:++sequence,message:{from:{id:s.actor,is_bot:false},chat:{id:s.actor,type:'private'},text:'/inbox'}});
const labels=f=>f.transport.messages.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.text);
const restore=id=>rpc('figa_restore_conversation',[id,access]);

test('view-only users get View Status only; forged callback identity cannot grant takeover',async()=>{
  const f=await fixture(['view']);await f.bot.handle(status(f.staff),f.scope);assert.deepEqual(labels(f),['View Status']);
  const forged={...callback(f.staff.actor,f.conversation.id,'t',0),staff_user_id:'forged',actor:999,permissions:['takeover']};
  assert.equal(await f.bot.handle(forged,f.scope),'denied');assert.equal((await restore(f.conversation.id)).mode,'AI');
  assert.equal(await f.bot.handle(callback(999999,f.conversation.id,'t',0),f.scope),'ignored');
});
test('effective permissions render Take Over and then only owner-authorized Resolve/Return to AI',async()=>{
  const f=await fixture();await f.bot.handle(status(f.staff),f.scope);assert.deepEqual(labels(f),['View Status','Take Over']);
  assert.equal(await f.bot.handle(callback(f.staff.actor,f.conversation.id,'t',0),f.scope),'applied');assert.deepEqual(labels(f),['View Status','Resolve','Return to AI']);
  const other=await tester();assert.deepEqual((await f.repo.controls(other.actor,other.actor,f.conversation.id,null)).actions,['summary']);
  await db.query("update public.staff_roster set permissions=array['view','takeover'] where staff_user_id=$1",[f.staff.id]);
  await f.bot.handle(status(f.staff),f.scope);assert.deepEqual(labels(f),['View Status']);
  assert.equal(await f.bot.handle(callback(f.staff.actor,f.conversation.id,'r',1),f.scope),'denied');
  // The controlled mode never drains unrelated notifications or acquires delivery leases.
  assert.equal((await db.query('select count(*) from public.telegram_deliveries')).rows[0].count,0);
});
test('concurrent takeover attempts and stale controls preserve one owner and refresh current status',async()=>{
  const f=await fixture(),other=await tester();
  const results=await Promise.all([f.bot.handle(callback(f.staff.actor,f.conversation.id,'t',0),f.scope),f.bot.handle(callback(other.actor,f.conversation.id,'t',0),{actor:other.actor,conversationId:f.conversation.id})]);
  assert.deepEqual(results.sort(),['applied','stale']);
  assert.equal((await db.query('select count(*) from public.staff_assignments where conversation_id=$1 and released_at is null',[f.conversation.id])).rows[0].count,1);
  assert.equal(await f.repo.controls(f.staff.actor,f.staff.actor,f.conversation.id,0),null);
});
test('takeover suppresses pending and subsequent AI replies until explicit owner return',async()=>{
  const f=await fixture(),id=f.conversation.id,messageId=randomUUID();
  const turn=await rpc('figa_begin_turn',[id,access,messageId,'Fictional pending request',requestHash]);
  await f.bot.handle(callback(f.staff.actor,id,'t',0),f.scope);
  const result=await rpc('figa_finish_turn',[id,access,messageId,turn.leaseToken,0,{state:turn.conversation.state,assistantResponse:'Must never be sent',engine:{requested:'ai'}}]);
  assert.equal(result.assistantResponse,'');assert.equal(result.engine.used,'none');
  for(let i=0;i<2;i++)assert.equal((await rpc('figa_begin_turn',[id,access,randomUUID(),'Fictional follow-up',requestHash])).kind,'controlled');
  let c=await restore(id);assert.equal(c.mode,'HUMAN');
  await f.bot.handle(callback(f.staff.actor,id,'a',c.revision),f.scope);c=await restore(id);assert.equal(c.mode,'AI');
  await f.bot.handle(callback(f.staff.actor,id,'t',c.revision),f.scope);c=await restore(id);
  const other=await tester();assert.equal(await f.bot.handle(callback(other.actor,id,'r',c.revision),{actor:other.actor,conversationId:id}),'denied');
  assert.equal(await f.bot.handle(callback(f.staff.actor,id,'r',c.revision),f.scope),'applied');assert.equal((await restore(id)).status,'closed');assert.deepEqual(labels(f),['View Status']);
});
test('checkpoint failure replays safely without repeating the staff assignment',async()=>{
  const f=await fixture(),update=callback(f.staff.actor,f.conversation.id,'t',0),source={updates:async(offset,limit)=>{assert.equal(offset,0);assert.equal(limit,1);return [update];}};
  let offset=0,failed=true;const checkpoint={load:async()=>offset,save:async next=>{if(failed)throw new Error('disk failure');offset=next;}};
  await assert.rejects(()=>module.controlledPollOnce(source,f.bot,checkpoint,f.scope),/disk failure/);assert.equal(offset,0);
  failed=false;await module.controlledPollOnce(source,f.bot,checkpoint,f.scope);assert.equal(offset,update.update_id+1);
  assert.equal((await restore(f.conversation.id)).revision,1);
  assert.equal((await db.query("select count(*) from public.conversation_events where conversation_id=$1 and event_type='human_assigned'",[f.conversation.id])).rows[0].count,1);
});
test('polling rejects malformed batches, preserves checkpoints on failure, and respects cancellation',async()=>{
  const f=await fixture();let offset=5,saved=0;const checkpoint={load:async()=>offset,save:async next=>{offset=next;saved++;}};
  await assert.rejects(()=>module.controlledPollOnce({updates:async()=>[{update_id:6},{update_id:7}]},f.bot,checkpoint,f.scope));
  await assert.rejects(()=>module.controlledPollOnce({updates:async()=>[{update_id:4}]},f.bot,checkpoint,f.scope));
  await assert.rejects(()=>module.controlledPollOnce({updates:async()=>{throw new Error('network failure');}},f.bot,checkpoint,f.scope));
  const stopped=await module.controlledPollOnce({updates:async()=>{throw new Error('must not poll');}},f.bot,checkpoint,f.scope,()=>true);
  assert.equal(stopped.processed,0);assert.equal(saved,0);assert.equal(offset,5);
});
test('exclusive lock refuses a second poller and checkpoint replacement is durable and validated',async()=>{
  const folder=await mkdtemp(resolve(tmpdir(),'figa-poll-state-')),locks=resolve(folder,'locks'),state=resolve(folder,'state');
  const results=await Promise.allSettled([module.acquirePollLock(12345,locks),module.acquirePollLock(12345,locks)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  for(const r of results)if(r.status==='fulfilled')await r.value();
  const release=await module.acquirePollLock(12345,locks);await release();
  const checkpoint=module.pollCheckpoint(12345,state);assert.equal(await checkpoint.load(),0);await checkpoint.save(10);await checkpoint.save(20);assert.equal(await checkpoint.load(),20);
  await writeFile(resolve(state,'12345.json'),JSON.stringify({version:1,botId:12345,offset:-1}));await assert.rejects(()=>checkpoint.load());
  await unlink(resolve(state,'12345.json'));await rmdir(state);await rmdir(locks);await rmdir(folder);
});
test('controls RPC is service-only and revoked staff receive neither status nor buttons',async()=>{
  const f=await fixture();
  for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);try{await assert.rejects(()=>f.repo.controls(f.staff.actor,f.staff.actor,f.conversation.id,null),/permission denied/);}finally{await db.exec('reset role');}
  }
  await db.exec('set role service_role');try{assert.deepEqual((await f.repo.controls(f.staff.actor,f.staff.actor,f.conversation.id,0)).actions,['summary','takeover']);}finally{await db.exec('reset role');}
  await db.query('update public.staff_roster set active=false where staff_user_id=$1',[f.staff.id]);assert.equal(await f.repo.controls(f.staff.actor,f.staff.actor,f.conversation.id,null),null);
});
