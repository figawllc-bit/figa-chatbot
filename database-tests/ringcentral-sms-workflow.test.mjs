import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const outfile = resolve('.wrangler/sms-workflow-offline.mjs');
await build({ stdin: { contents: `export {SyntheticSmsWorkflow,SmsWorkflowRepository} from './src/ringcentral/sms-workflow'; export {RingCentralSmsSender,RINGCENTRAL_SMS_DELIVERY_ENABLED} from './src/ringcentral/sms-sender'; export {exchangeSmsJwt} from './src/ringcentral/oauth-read-session'; export {createOfflinePollingHttp} from './src/ringcentral/secure-transport'; export {createOfflineCredentials} from './src/ringcentral/offline-credentials'; export {RingCentralIncomingPoller} from './src/ringcentral/polling'; export {HybridEngine} from './src/ai/engine'; export {adaptRingCentral} from './src/ringcentral/events'; export {scope,message,instant} from './test/fixtures/ringcentral'; export {StaffBot} from './src/telegram/bot'; export {SupabaseStaffRepository} from './src/telegram/repository'; export {SimulatedTelegramTransport} from './src/telegram/transport';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'silent' });
const app = await import(pathToFileURL(outfile).href);
const provider = 'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.';
const caregiver = 'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.';
const pFields = { name:'Alex Example',homeType:'group home',city:'Salem',state:'Oregon',count:'three',position:'caregivers',shift:'night shift',date:'tonight' };
const cFields = { name:'Sam Example',position:'CNA',city:'Portland',state:'Oregon',experience:'three years',availability:'Monday through Friday',shift:'evening shifts' };

test('SMS detection to persisted Gemma intake and guarded SMS POST, fictional only', async t => {
 const db = await PGlite.create(); const originalFetch = globalThis.fetch, originalNow = Date.now;
 let network=0, models=0, seq=0, queue=Promise.resolve();
 globalThis.fetch=async()=>{network++;throw Error('external network prohibited');};
 try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
  class LocalRepo extends app.SmsWorkflowRepository {
   rpc(name, params) {
    assert.ok(['figa_rc_observe','figa_rc_delivery_snapshot','figa_rc_sms_prepare','figa_rc_sms_begin','figa_rc_sms_finish','figa_rc_sms_claim','figa_rc_sms_recheck','figa_rc_sms_complete','figa_rc_sms_pending'].includes(name));
    const op=queue.then(async()=>{
     await db.exec('set role service_role');
     try {const values=Object.values(params).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as result`,values)).rows[0].result;}
     finally {await db.exec('reset role');}
    });queue=op.catch(()=>{});return op;
   }
  }
  const repo=new LocalRepo();
  // A fresh database starts with the bot PAUSED; nothing is ever sent by default.
  assert.equal((await db.query('select mode from public.figa_bot_mode')).rows[0].mode,'paused');
  await db.query("update public.figa_bot_mode set mode='away'");
  const observe=(text=provider,customer='+15035550110')=>app.adaptRingCentral(app.instant(app.message(String(310000+(++seq)),'Inbound',text,customer),'sms-event-'+seq),app.scope).messages[0];
  const engine=(hook)=>new app.HybridEngine({AI_ENABLED:'true',AI_PROVIDER:'workers-ai',AI_ALLOW_SYNTHETIC_REQUESTS:'true',AI_FREE_TIER_CONFIRMED:'true',AI:{run:async(model,input)=>{
   models++;assert.equal(model,'@cf/google/gemma-4-26b-a4b-it');assert.match(input.messages[0].content,/FIGA/);
   if(hook)await hook();
   const m=input.messages.at(-1).content; const c=m.includes('Sam Example');
   const extraction={intent:c?'caregiver':'provider',intentEvidence:c?'seeking a CNA job':'need three caregivers',ambiguous:false,needsHumanReview:!c,faqIndex:-1,updates:Object.entries(c?cFields:pFields).map(([field,quote])=>({field,quote}))};
   return {choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(extraction)}}]};
  }}});
  const sender=(patch={},hook)=>{
   const external=String(390000+(++seq));
   const http=app.createOfflinePollingHttp(JSON.stringify([{body:JSON.stringify({access_token:'fictional-issued-access-token',token_type:'Bearer',scope:'ReadMessages SMS',owner_id:'200001',expires_in:3600})},{body:JSON.stringify({id:external,type:'SMS',direction:'Outbound',messageStatus:'Queued'}),...patch}]));
   let grant;
   const s=new app.RingCentralSmsSender({mode:'offline',sender:'+15035550100',enabled:()=>true,privacyApproved:()=>false,http:http.executor,grant:async()=>{
    if(hook)await hook();
    return grant??=await app.exchangeSmsJwt({kind:'jwt',clientId:'fictional-client',clientSecret:'fictional-secret',jwt:'fictional.header.signature',host:'https://platform.ringcentral.com',accountId:'100001',extensionId:'200001',appPermissions:['ReadMessages','SMS']},{host:'https://platform.ringcentral.com',extensionId:'200001'},{send:r=>http.executor(r)},{authorizedMaximum:1,async reserve(){}});
   }});
   return {s,http,external};
  };
  const controls={paused:false,sendingEnabled:true};
  const status=async m=>(await db.query('select status from public.rc_sms_jobs where inbound_id=$1',[m.id])).rows[0]?.status;
  await t.test('new polled provider SMS uses Gemma, retains intake, queues exactly one SMS and correlates chatbot origin',async()=>{
   const start=Date.parse('2026-11-15T12:00:00Z');let now=start;Date.now=()=>now;
   const m=observe(), out=sender();
   const raw=app.message(m.id,'Inbound',m.text);raw.creationTime=new Date(start+30000).toISOString();
   const http=app.createOfflinePollingHttp(JSON.stringify([{body:JSON.stringify({access_token:'fictional-issued-access-token',token_type:'Bearer',expires_in:3600,owner_id:'200001',scope:'ReadMessages'})},{body:JSON.stringify({records:[raw]})},{body:JSON.stringify({records:[raw]})}]));
   let checkpoint=null;const store={async exclusive(k,work){return work(checkpoint,async s=>{checkpoint=structuredClone(s);});}};
   const workflow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);
   const poller=new app.RingCentralIncomingPoller({mode:'offline',store,credentials:app.createOfflineCredentials('jwt',undefined,'production'),http:http.executor,controls:()=>({enabled:true,paused:false}),fixture:{scope:app.scope,processor:workflow}});
   assert.equal((await poller.poll()).status,'baseline');now+=120000;assert.equal((await poller.poll()).newMessages,1);
   now+=120000;assert.equal((await poller.poll()).duplicates,1);
   assert.equal(await status(m),'accepted');assert.equal(out.http.audit().length,2);
   const row=(await db.query('select c.state,c.mode,c.human_attention_needed from public.conversations c join public.rc_sms_jobs j on j.conversation_id=c.id where j.inbound_id=$1',[m.id])).rows[0];
   assert.equal(row.state.type,'provider');assert.equal(row.state.collected.count,'3');assert.equal(row.state.collected.city,'Salem');assert.equal(row.mode,'AI');assert.equal(row.human_attention_needed,true);
   assert.equal((await db.query('select actor from public.rc_origins where message_id=$1',[out.external])).rows[0].actor,'chatbot');
   Date.now=originalNow;
  });
  await t.test('caregiver response persists, does not promise hiring, and replay does not infer or send again',async()=>{
   const m=observe(caregiver,'+15035550111'),out=sender();const flow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);
   await flow.process(m);const n=models;await flow.process(m);assert.equal(models,n);assert.equal(out.http.audit().length,2);assert.equal(await status(m),'accepted');
   const row=(await db.query("select c.state,m.response from public.rc_sms_jobs j join public.conversations c on c.id=j.conversation_id join public.messages m on m.client_message_id=j.client_message_id and m.direction='inbound' where j.inbound_id=$1",[m.id])).rows[0];
   assert.equal(row.state.type,'caregiver');assert.equal(row.state.collected.position,'CNA');assert.equal(row.state.collected.city,'Portland');assert.match(row.state.collected.experience,/three years/);assert.match(row.state.collected.shift,/evening/);
   assert.doesNotMatch(row.response.assistantResponse,/(?:we guarantee|you (?:will|are guaranteed to) (?:get|be hired))|staff (?:have been|were) notified|\$\d/);
  });
  await t.test('STOP and START never invoke Gemma or restore consent',async()=>{
   const out=sender(),flow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);const before=models;
   for(const text of ['STOP','START',provider])await flow.process(observe(text,'+15035550112'));
   assert.equal(models,before);assert.equal(out.http.audit().length,0);
  });
  await t.test('HUMAN, closed, blocked and active staff ownership suppress inference and POST',async()=>{
   for(const kind of ['HUMAN','closed','blocked','assignment']){
    const m=observe(provider,'+150355501'+String(20+seq%50).padStart(2,'0'));await repo.observe('fixture-'+m.id,'a'.repeat(64),[m]);const job=await repo.prepare(m);
    if(kind==='HUMAN')await db.query("update public.conversations set mode='HUMAN' where id=$1",[job.conversationId]);
    else if(kind==='assignment'){const staff=(await db.query('insert into auth.users(id) values(gen_random_uuid()) returning id')).rows[0].id;await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)',[job.conversationId,staff]);}
    else await db.query('update public.conversations set status=$2 where id=$1',[job.conversationId,kind]);
    const out=sender(),before=models;await new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls).process(m);assert.equal(models,before);assert.equal(out.http.audit().length,0);
   }
  });
  await t.test('takeover during pending model completion fences response and prevents delivery',async()=>{
   const m=observe(provider,'+15035550170'),out=sender();let job;
   const e=engine(async()=>{job=await repo.prepare(m);await db.query("update public.conversations set mode='HUMAN',revision=revision+1 where id=$1",[job.conversationId]);});
   await new app.SyntheticSmsWorkflow(repo,e,out.s,()=>controls).process(m);assert.equal(await status(m),'suppressed');assert.equal(out.http.audit().length,0);
  });
  await t.test('STOP received during authentication cancels a claimed response before SMS POST',async()=>{
   const m=observe(provider,'+15035550171');const out=sender({},async()=>{const stop=observe('STOP',m.customerNumber);await repo.observe('stop-'+stop.id,'b'.repeat(64),[stop]);});
   await new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls).process(m);assert.equal(await status(m),'suppressed');assert.equal(out.http.audit().length,1);
  });
  await t.test('pause and send-disable preserve generated response for later authorized fictional dispatch',async()=>{
   const m=observe(provider,'+15035550172'),out=sender(),flow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);
   controls.paused=true;const before=models;await flow.process(m);assert.equal(models,before);controls.paused=false;controls.sendingEnabled=false;
   await flow.process(m);assert.equal(await status(m),'generated');assert.equal(out.http.audit().length,0);const after=models;
   controls.sendingEnabled=true;await flow.drain();assert.equal(models,after);assert.equal(await status(m),'accepted');
  });
  await t.test('ambiguous network failure stays terminal after workflow restart',async()=>{
   const m=observe(provider,'+15035550173'),out=sender({failure:true});await new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls).process(m);
   assert.equal(await status(m),'uncertain');const fresh=sender();await new app.SyntheticSmsWorkflow(new LocalRepo(),engine(),fresh.s,()=>controls).process(m);assert.equal(fresh.http.audit().length,0);
  });
  await t.test('concurrent duplicate processing cannot claim two sends',async()=>{
   const m=observe(provider,'+15035550174'),out=sender();const flow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);
   await Promise.allSettled([flow.process(m),flow.process(m)]);await flow.process(m);assert.equal(out.http.audit().filter(x=>x.path.endsWith('/sms')).length,1);
  });
  await t.test('Telegram Take Over / Return to AI govern SMS replies; staff-handled messages are never auto-answered later; history carries across SMS turns',async()=>{
   const customer='+15035550175',first=observe(provider,customer),out1=sender();
   await new app.SyntheticSmsWorkflow(repo,engine(),out1.s,()=>controls).process(first);assert.equal(await status(first),'accepted');
   const conv=(await db.query('select conversation_id from public.rc_sms_jobs where inbound_id=$1',[first.id])).rows[0].conversation_id;
   // Escalation (urgent provider) is queued for the existing Telegram staff dispatcher.
   const kinds=(await db.query('select kind from public.telegram_notifications where conversation_id=$1',[conv])).rows.map(r=>r.kind);
   assert.ok(kinds.includes('provider')&&kinds.includes('urgent'));
   const staffId=(await db.query('insert into auth.users(id) values(gen_random_uuid()) returning id')).rows[0].id,actor=7646339000+seq;
   await db.query("insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,true,array['view','takeover','resolve','return_ai'],now(),$1)",[staffId,actor]);
   const staff=async action=>{const c=(await db.query('select revision from public.conversations where id=$1',[conv])).rows[0];
    return (await db.query('select public.figa_telegram_process($1,$2,$3,$4,$5,$6,$7) as r',[++seq,actor,actor,action,conv,c.revision,'c'.repeat(64)])).rows[0].r.kind;};
   assert.equal(await staff('takeover'),'applied');
   const during=observe('Fictional staffing inquiry',customer),out2=sender(),before=models;
   await new app.SyntheticSmsWorkflow(repo,engine(),out2.s,()=>controls).process(during);
   assert.equal(models,before);assert.equal(out2.http.audit().length,0);assert.equal(await status(during),'suppressed');
   assert.equal((await db.query('select conversation_id from public.rc_sms_jobs where inbound_id=$1',[during.id])).rows[0].conversation_id,conv);
   assert.equal(await staff('return_ai'),'applied');
   // Draining after Return to AI must not answer the message staff already handled.
   await new app.SyntheticSmsWorkflow(repo,engine(),out2.s,()=>controls).drain();assert.equal(models,before);assert.equal(out2.http.audit().length,0);
   let sawHistory=false;
   const followEngine=new app.HybridEngine({AI_ENABLED:'true',AI_PROVIDER:'workers-ai',AI_ALLOW_SYNTHETIC_REQUESTS:'true',AI_FREE_TIER_CONFIRMED:'true',AI:{run:async(_m,input)=>{
    models++;sawHistory=input.messages.at(-1).content.includes('Alex Example');
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({intent:'provider',intentEvidence:'',ambiguous:false,needsHumanReview:false,faqIndex:-1,updates:[]})}}]};
   }}});
   const next=observe('Fictional provider inquiry',customer),out3=sender();
   await new app.SyntheticSmsWorkflow(repo,followEngine,out3.s,()=>controls).process(next);
   assert.equal(await status(next),'accepted');assert.ok(sawHistory,'prior SMS turn supplied as history');
   assert.equal(out3.http.audit().filter(x=>x.path.endsWith('/sms')).length,1);
   const row=(await db.query('select state,mode from public.conversations where id=$1',[conv])).rows[0];
   assert.equal(row.mode,'AI');assert.equal(row.state.type,'provider');assert.equal(row.state.collected.city,'Salem');assert.equal(row.state.collected.count,'3');
  });
  await t.test('Gemma failure still yields one customer-appropriate SMS with no developer diagnostics',async()=>{
   const m=observe(provider,'+15035550176'),out=sender();
   const failing=new app.HybridEngine({AI_ENABLED:'true',AI_PROVIDER:'workers-ai',AI_ALLOW_SYNTHETIC_REQUESTS:'true',AI_FREE_TIER_CONFIRMED:'true',AI:{run:async()=>{models++;throw Error('fictional outage');}}},undefined,()=>{});
   const tried=models;await new app.SyntheticSmsWorkflow(repo,failing,out.s,()=>controls).process(m);assert.ok(models>tried,'Gemma was attempted');
   assert.equal(await status(m),'accepted');assert.equal(out.http.audit().filter(x=>x.path.endsWith('/sms')).length,1);
   const text=(await db.query("select m.response->>'assistantResponse' as t from public.rc_sms_jobs j join public.messages m on m.client_message_id=j.client_message_id and m.direction='inbound' where j.inbound_id=$1",[m.id])).rows[0].t;
   assert.ok(text.length>0&&text.length<=1000);assert.doesNotMatch(text,/Workers AI|deterministic engine|free-tier|no notification has been sent|synthetic/i);
  });
  await t.test('Telegram bot mode: /onduty and /pause silence the bot and alert staff, /away resumes, never answering staff-period texts',async()=>{
   class StaffRepo extends app.SupabaseStaffRepository {rpc(name,params){const op=queue.then(async()=>{await db.exec('set role service_role');try{const values=Object.values(params).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);return (await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as result`,values)).rows[0].result;}finally{await db.exec('reset role');}});queue=op.catch(()=>{});return op;}}
   const transport=new app.SimulatedTelegramTransport(),bot=new app.StaffBot(new StaffRepo({}),transport);
   const addStaff=async permissions=>{const id=(await db.query('insert into auth.users(id) values(gen_random_uuid()) returning id')).rows[0].id,actor=7646340000+(++seq);
    await db.query('insert into public.staff_roster(staff_user_id,telegram_user_id,telegram_chat_id,active,permissions,verified_at,verified_by) values($1,$2,$2,true,$3,now(),$1)',[id,actor,permissions]);return actor;};
   const manager=await addStaff(['view','takeover','resolve','return_ai','bot_mode']),viewer=await addStaff(['view']);
   const say=(actor,text,update=++seq)=>bot.handle({update_id:update,message:{from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
   const mode=async()=>(await db.query('select mode from public.figa_bot_mode')).rows[0].mode;
   const alerts=async conv=>Number((await db.query("select count(*) from public.telegram_notifications where conversation_id=$1 and kind='message'",[conv])).rows[0].count);
   const conversationOf=async m=>(await db.query('select conversation_id from public.rc_sms_jobs where inbound_id=$1',[m.id])).rows[0].conversation_id;
   // View-only staff can see the mode but cannot switch it.
   assert.equal(await say(viewer,'/status'),'ok');assert.match(transport.messages.at(-1).text,/AWAY/);assert.equal(transport.messages.at(-1).reply_markup.inline_keyboard.length,0);
   assert.equal(await say(viewer,'/pause'),'denied');assert.equal(await mode(),'away');
   // ON DUTY: every new text is silenced and alerted to staff, never answered later.
   const replay=++seq,mark=transport.messages.length;assert.equal(await say(manager,'/onduty',replay),'applied');assert.equal(await mode(),'on_duty');
   // Every roster member is told; only the person who switched it gets buttons.
   const sent=transport.messages.slice(mark);
   assert.equal(sent.filter(m=>m.chat_id===manager&&m.text.startsWith('Bot mode changed\n')).length,1);
   assert.ok(sent.some(m=>m.chat_id===viewer));
   assert.ok(sent.filter(m=>m.chat_id!==manager).every(m=>m.text.startsWith('Bot mode changed by a staff member')&&m.reply_markup.inline_keyboard.length===0));
   assert.equal(await say(manager,'/onduty',replay),'duplicate');assert.equal(await mode(),'on_duty');
   const customer='+15035550177',a=observe(provider,customer),b=observe('Fictional staffing inquiry',customer),out=sender(),before=models;
   const flow=new app.SyntheticSmsWorkflow(repo,engine(),out.s,()=>controls);
   await flow.process(a);await flow.process(b);
   assert.equal(models,before);assert.equal(out.http.audit().length,0);assert.equal(await status(a),'suppressed');assert.equal(await status(b),'suppressed');
   const conv=await conversationOf(a);assert.equal(await alerts(conv),2);
   const queued=(await db.query("select count(*) from public.telegram_notifications n where n.conversation_id=$1 and n.kind='message'",[conv])).rows[0].count;assert.equal(Number(queued),2);
   const beforeAlerts=transport.messages.length;for(let i=0;i<10&&await bot.notify(manager,manager)>0;i++);
   const delivered=transport.messages.slice(beforeAlerts).filter(m=>m.chat_id===manager&&m.text.startsWith('New text received')&&m.text.includes(conv));
   assert.equal(delivered.length,2);assert.ok(delivered.every(m=>m.reply_markup.inline_keyboard.flat().some(x=>x.text==='Take Over')));
   assert.ok(transport.messages.every(m=>!m.text.includes(customer)&&!m.text.includes('Alex Example')),'no phone numbers or names in Telegram');
   // AWAY via a button: the bot answers new texts, but never the On Duty ones.
   assert.equal(await bot.handle({update_id:++seq,callback_query:{id:'cb'+seq,from:{id:manager,is_bot:false},message:{chat:{id:manager,type:'private'}},data:'fg:m:away'}}),'applied');assert.equal(await mode(),'away');
   await flow.drain();assert.equal(models,before);assert.equal(out.http.audit().length,0);
   const c=observe('Fictional provider inquiry',customer),out2=sender();await new app.SyntheticSmsWorkflow(repo,engine(),out2.s,()=>controls).process(c);
   assert.equal(await status(c),'accepted');assert.equal(out2.http.audit().filter(x=>x.path.endsWith('/sms')).length,1);
   // PAUSE: blocks an already-generated reply, and also a reply whose send is in progress.
   const d=observe(provider,'+15035550178'),out3=sender();controls.sendingEnabled=false;await new app.SyntheticSmsWorkflow(repo,engine(),out3.s,()=>controls).process(d);assert.equal(await status(d),'generated');
   assert.equal(await say(manager,'/pause'),'applied');controls.sendingEnabled=true;
   await new app.SyntheticSmsWorkflow(repo,engine(),out3.s,()=>controls).drain();assert.equal(await status(d),'generated');assert.equal(out3.http.audit().length,0);
   assert.equal(await say(manager,'/resume'),'applied');
   const pauseDuringSend=sender({},async()=>{await db.query("update public.figa_bot_mode set mode='paused'");});
   await new app.SyntheticSmsWorkflow(repo,engine(),pauseDuringSend.s,()=>controls).drain();
   assert.equal(await status(d),'suppressed');assert.equal(pauseDuringSend.http.audit().filter(x=>x.path.endsWith('/sms')).length,0);
   await db.query("update public.figa_bot_mode set mode='away'");
  });
  await t.test('unapproved real-like material and live sender cannot touch credentials or network',async()=>{
   const m=observe();await assert.rejects(new app.SyntheticSmsWorkflow(repo,engine(),sender().s,()=>controls).process({...m,text:'unapproved customer material'}));
   let accessed=0;const live=new app.RingCentralSmsSender({mode:'live',sender:'+15035550100',enabled:()=>true,privacyApproved:()=>true,http:async()=>{accessed++;throw Error();},grant:async()=>{accessed++;throw Error();}});
   assert.equal((await live.send({from:'+15035550100',to:'+15035550110',text:'fictional'},async()=>true)).category,'sending_disabled');assert.equal(accessed,0);assert.equal(app.RINGCENTRAL_SMS_DELIVERY_ENABLED,false);
  });
  assert.equal(network,0);
 } finally {Date.now=originalNow;globalThis.fetch=originalFetch;await db.close();}
});
