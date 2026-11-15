// Node-only local simulator. Never imported by the Worker. No .dev.vars loading.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import assert from 'node:assert/strict';
import { SupabaseRepository } from '../database/supabase';
import { PersistentChatService, digest } from '../database/service';
import { DeterministicEngine } from '../engine';
import { SupabaseStaffRepository } from './repository';
import { StaffBot } from './bot';
import { SimulatedTelegramTransport } from './transport';
import type { ConversationSnapshot } from '../database/types';

const db=await PGlite.create();
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
  const folder=resolve('supabase/migrations');
  for(const file of (await readdir(folder)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(resolve(folder,file),'utf8'));
  const rpc=async<T>(name:string,parameters:unknown):Promise<T>=>{
    const values=Object.values(parameters as Record<string,unknown>);
    const result=await db.query<{result:T}>(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values.map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
    return result.rows[0].result;
  };
  class LocalStaff extends SupabaseStaffRepository { protected override rpc=rpc; }
  class LocalChats extends SupabaseRepository { protected override rpc=rpc; }
  const staffId=crypto.randomUUID(),staffTelegram=101001;
  await db.query('insert into auth.users(id) values($1)',[staffId]);
  await db.query("insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,true,array['view','takeover','resolve','return_ai'],now(),$1)",[staffId,staffTelegram]);
  const chats=new LocalChats({}),staff=new LocalStaff({}),transport=new SimulatedTelegramTransport(),bot=new StaffBot(staff,transport);
  const engine=new DeterministicEngine(),service=new PersistentChatService(chats,engine);
  const access='c'.repeat(64),tokenHash=await digest(access);
  const provider=await chats.create(tokenHash);
  await service.respond({message:'I need two caregivers tomorrow night in Salem.; urgency: urgent',conversationId:provider.id,messageId:crypto.randomUUID(),syntheticData:true},access);
  const caregiver=await chats.create(tokenHash);
  await service.respond({message:'I am looking for a caregiver job.',conversationId:caregiver.id,messageId:crypto.randomUUID(),syntheticData:true},access);
  console.log('LOCAL TELEGRAM SIMULATOR: ephemeral PostgreSQL, fictional staff/data, no network or AI calls.');
  let printed=0,updateId=0;
  const show=()=>{for(const m of transport.messages.slice(printed)){console.log('\n'+m.text);console.log('Buttons: '+m.reply_markup.inline_keyboard.flat().map(b=>b.text).join(' | '));}printed=transport.messages.length;};
  await bot.dispatch();show();
  const snapshot=async()=>await chats.restore(provider.id,tokenHash) as ConversationSnapshot;
  const callback=(code:string,revision:number,actor=staffTelegram,id=++updateId)=>({update_id:id,callback_query:{id:'callback_'+id,from:{id:actor,is_bot:false},message:{chat:{id:actor,type:'private'}},data:`fg:${code}:${provider.id}:${revision}`}});
  if(process.argv.includes('--interactive')) {
    const input=createInterface({input:process.stdin,output:process.stdout});
    console.log('\nCommands: takeover, return, resolve, summary, unauthorized, quit. All actions use fictional staff.');
    try { while(true) {
      const command=(await input.question('staff> ')).trim();if(command==='quit')break;
      const code:Record<string,string>={takeover:'t',return:'a',resolve:'r',summary:'s',unauthorized:'s'};
      if(!code[command])continue;
      console.log('Result: '+await bot.handle(callback(code[command],(await snapshot()).revision,command==='unauthorized'?909999:staffTelegram)));show();
    }} finally {input.close();}
  } else {
    const revision=(await snapshot()).revision;
    assert.equal(await bot.handle(callback('t',revision,909999)),'denied');
    // Simulate an inference that was already running when the employee took over.
    const messageId=crypto.randomUUID(),message='count: 3';
    const turn={conversationId:provider.id,tokenHash,messageId,message,requestHash:await digest(message)};
    const pending=await chats.begin(turn);assert.equal(pending.kind,'ready');
    if(pending.kind!=='ready')throw new Error('Expected ready turn.');
    const takeover=callback('t',revision);
    assert.equal(await bot.handle(takeover),'applied');
    assert.equal(await bot.handle(takeover),'duplicate');
    const late=await chats.finish({...turn,leaseToken:pending.leaseToken,revision,response:await engine.respond({message,state:pending.conversation.state})});
    assert.equal(late.assistantResponse,'');
    assert.equal((await chats.begin({...turn,messageId:crypto.randomUUID()})).kind,'controlled');
    assert.equal(await bot.handle(callback('r',revision)),'stale');
    assert.equal(await bot.handle(callback('a',(await snapshot()).revision)),'applied');
    assert.equal((await snapshot()).mode,'AI');
    assert.equal(await bot.handle(callback('t',(await snapshot()).revision)),'applied');
    assert.equal(await bot.handle(callback('r',(await snapshot()).revision)),'applied');
    assert.equal((await snapshot()).status,'closed');show();
    console.log('\nPASS: unauthorized denial, takeover, duplicate retry, pending reply suppression, inbound recording, stale button rejection, explicit return to AI and resolve.');
  }
} finally {await db.close();}
