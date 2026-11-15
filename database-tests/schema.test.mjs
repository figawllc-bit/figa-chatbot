import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let db;
const token = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const tables = ['contacts','conversations','messages','provider_requests','caregiver_leads','staff_assignments','conversation_events'];
before(async () => {
  db = await PGlite.create();
  // Only the minimal Supabase roles/auth fixture; everything is ephemeral and local.
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
  for (const file of ['20261112000100_figa_schema.sql','20261112000200_figa_transactions.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
});
after(async () => { await db?.close(); });
async function rpc(name, args) {
  const result = await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`, args.map(v=>v && typeof v === 'object' ? JSON.stringify(v) : v));
  return result.rows[0].result;
}
const create = () => rpc('figa_create_conversation',[token]);
const begin = (id, messageId = randomUUID(), message = 'Fictional staffing inquiry', requestHash = hash) => rpc('figa_begin_turn',[id,token,messageId,message,requestHash]);
function response(type='provider', fields={count:'2',city:'Salem',date:'tomorrow',shift:'night'}) {
  return { mode:'LOCAL_DEVELOPMENT_DRY_RUN', conversationType:type, assistantResponse:'What is your name?', collectedInformation:fields,
    state:{version:1,type,collected:fields,awaiting:'name',humanAttentionReasons:[]}, humanAttentionNeeded:false,humanAttentionReasons:[],complete:false,
    engine:{requested:'deterministic',used:'deterministic'},informationStatus:'user_reported_unverified' };
}
const finish = (id, msgId, turn, reply=response()) => rpc('figa_finish_turn',[id,token,msgId,turn.leaseToken,turn.conversation.revision,reply]);
const count = async(table,id) => +(await db.query(`select count(*) from public.${table} where conversation_id=$1`,[id])).rows[0].count;

test('all seven tables have RLS and deny direct public/service table privileges', async () => {
  const rows=(await db.query("select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'")).rows;
  assert.equal(rows.length,7);
  for (const table of tables) {
    assert.equal(rows.find(r=>r.relname===table)?.relrowsecurity,true);
    for (const role of ['anon','authenticated','service_role']) {
      const result=await db.query('select has_table_privilege($1,$2,\'SELECT\') as allowed',[role,`public.${table}`]);
      assert.equal(result.rows[0].allowed,false);
    }
  }
});
test('anonymous and authenticated roles cannot execute RPCs or read tables', async () => {
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(()=>db.query('select * from public.conversations'),/permission denied/);
      await assert.rejects(()=>rpc('figa_create_conversation',[token]),/permission denied/);
      await assert.rejects(()=>rpc('figa_assign_human',[randomUUID(),randomUUID(),0]),/permission denied/);
    } finally { await db.exec('reset role'); }
  }
});
test('only the service role can call app RPCs; internal snapshot stays private', async () => {
  await db.exec('set role service_role');
  try {
    assert.ok((await create()).id);
    await assert.rejects(()=>rpc('figa_snapshot',[randomUUID()]),/permission denied/);
  } finally { await db.exec('reset role'); }
});
test('create/restore returns no token hash or lease secrets', async () => {
  const c=await create();
  assert.equal(c.mode,'AI');
  assert.deepEqual(c.messages,[]);
  assert.deepEqual(await rpc('figa_restore_conversation',[c.id,token]),c);
  assert.equal(JSON.stringify(c).includes(token),false);
  assert.equal(c.access_token_hash,undefined);
});
test('wrong token and unknown ID are indistinguishable; expired access is denied', async () => {
  const c=await create();
  assert.equal(await rpc('figa_restore_conversation',[c.id,'c'.repeat(64)]),null);
  assert.equal(await rpc('figa_restore_conversation',[randomUUID(),token]),null);
  await db.query("update public.conversations set access_expires_at=now()-interval '1 second' where id=$1",[c.id]);
  assert.equal(await rpc('figa_restore_conversation',[c.id,token]),null);
  assert.equal((await begin(c.id)).kind,'not_found');
});
test('saves inbound, outbound, provider fields and metadata-only audit events atomically', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id);
  const r=await finish(c.id,id,t);
  assert.equal(r.persistence.saved,true);
  assert.equal(await count('messages',c.id),2);
  const saved=await rpc('figa_restore_conversation',[c.id,token]);
  assert.equal(saved.state.collected.count,'2');
  assert.equal(saved.messages[0].clientMessageId,id);
  const provider=(await db.query('select * from public.provider_requests where conversation_id=$1',[c.id])).rows[0];
  assert.equal(provider.caregiver_count,2);
  assert.equal(provider.information_status,'user_reported_unverified');
  assert.equal(await count('conversation_events',c.id),3);
});
test('duplicate requests return cached response and create no messages/events', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id);
  const original=await finish(c.id,id,t);
  const duplicate=await begin(c.id,id);
  assert.equal(duplicate.kind,'duplicate');
  assert.deepEqual(duplicate.response,original);
  assert.equal(await count('messages',c.id),2);
  assert.equal(await count('conversation_events',c.id),3);
});
test('reusing an ID with different input conflicts', async () => {
  const c=await create(), id=randomUUID(); await begin(c.id,id);
  assert.equal((await begin(c.id,id,'Other fictional input','c'.repeat(64))).kind,'conflict');
});
test('a live turn lease prevents overlapping requests', async () => {
  const c=await create(); await begin(c.id);
  assert.equal((await begin(c.id)).kind,'busy');
  assert.equal(await count('messages',c.id),1);
});
test('expired lease recovery never inserts the same inbound twice and rejects stale completion', async () => {
  const c=await create(), id=randomUUID(), old=await begin(c.id,id);
  await db.query("update public.conversations set lease_expires_at=now()-interval '1 second' where id=$1",[c.id]);
  const next=await begin(c.id,id);
  assert.equal(next.kind,'ready');
  await assert.rejects(()=>finish(c.id,id,old),/Stale turn lease/);
  await finish(c.id,id,next);
  assert.equal(await count('messages',c.id),2);
});
test('corrections update the provider row without adding a second request', async () => {
  const c=await create(), first=randomUUID(); await finish(c.id,first,await begin(c.id,first));
  const second=randomUUID(), t=await begin(c.id,second,'Make that three caregivers');
  await finish(c.id,second,t,response('provider',{count:'3',city:'Portland'}));
  const rows=(await db.query('select caregiver_count,city from public.provider_requests where conversation_id=$1',[c.id])).rows;
  assert.deepEqual(rows,[{caregiver_count:3,city:'Portland'}]);
});
test('caregiver records persist availability, experience and application status', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id,'Fictional caregiver application');
  await finish(c.id,id,t,response('caregiver',{name:'Sam Example',position:'CNA',availability:'weekdays',experience:'two years',applicationStatus:'not applied'}));
  const r=(await db.query('select * from public.caregiver_leads where conversation_id=$1',[c.id])).rows[0];
  assert.equal(r.preferred_position,'CNA'); assert.equal(r.availability,'weekdays'); assert.equal(r.application_status,'not applied');
});
test('human takeover racing with inference suppresses the assistant write', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id), staff=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[staff]);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,0]),true);
  const result=await finish(c.id,id,t);
  assert.equal(result.assistantResponse,''); assert.equal(result.engine.used,'none');
  assert.equal(result.state.control,'human_takeover');
  assert.equal(await count('messages',c.id),1);
  assert.equal(await count('provider_requests',c.id),0);
});
test('duplicate replay after takeover cannot replay an old AI reply', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id), staff=randomUUID();
  await finish(c.id,id,t);
  await db.query('insert into auth.users(id) values($1)',[staff]);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,1]),true);
  const duplicate=await begin(c.id,id);
  assert.equal(duplicate.response.assistantResponse,'');
  assert.equal(duplicate.response.engine.used,'none');
});
test('staff ownership uses revision checks and one active owner', async () => {
  const c=await create(), staff=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[staff]);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,99]),false);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,null]),false);
  assert.equal(await rpc('figa_assign_human',[c.id,null,0]),false);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,0]),true);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,1]),false);
  assert.equal(await count('staff_assignments',c.id),1);
});
test('blocked conversations suppress replies regardless of proposed engine state', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id);
  await db.query("update public.conversations set status='blocked' where id=$1",[c.id]);
  const r=await finish(c.id,id,t,response());
  assert.equal(r.assistantResponse,''); assert.equal(r.state.control,'blocked');
  assert.equal(await count('messages',c.id),1);
});
test('external message IDs and active staff assignments have uniqueness protection', async () => {
  const c=await create(), id=randomUUID(); await begin(c.id,id);
  await db.query("update public.messages set channel='ringcentral',external_message_id='fictional-rc-1' where conversation_id=$1",[c.id]);
  await assert.rejects(()=>db.query("insert into public.messages(conversation_id,client_message_id,direction,sender_type,content,channel,external_message_id) values($1,$2,'inbound','customer','fictional','ringcentral','fictional-rc-1')",[c.id,randomUUID()]),/duplicate key/);
});
test('late completion failure rolls back all writes and preserves the retry lease', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id);
  // Fails at the final conversation update, after provider/outbound/cache writes.
  const invalid=response(); invalid.humanAttentionNeeded='invalid boolean';
  await assert.rejects(()=>finish(c.id,id,t,invalid),/invalid input syntax for type boolean/);
  assert.equal(await count('provider_requests',c.id),0);
  assert.equal(await count('messages',c.id),1);
  assert.equal((await rpc('figa_restore_conversation',[c.id,token])).revision,0);
  assert.equal(await count('conversation_events',c.id),2);
  const inbound=(await db.query('select response from public.messages where conversation_id=$1',[c.id])).rows[0];
  assert.equal(inbound.response,null);
  assert.equal((await finish(c.id,id,t)).persistence.saved,true);
});

test('invalid engine state is rejected before collected information is persisted', async () => {
  const c=await create(), id=randomUUID(), t=await begin(c.id,id);
  const invalid=response(); invalid.state.version=2;
  await assert.rejects(()=>finish(c.id,id,t,invalid),/Invalid engine state/);
  assert.equal(await count('provider_requests',c.id),0);
});

test('an invalid correction clears the old count but preserves other staffing details', async () => {
  const c=await create(), first=randomUUID();
  await finish(c.id,first,await begin(c.id,first));
  const id=randomUUID(), result=await finish(c.id,id,await begin(c.id,id,'count: 10001'),response('provider',{count:'10001',city:'Salem',shift:'night'}));
  assert.deepEqual(result.state.collected,{city:'Salem',shift:'night'});
  assert.equal(result.state.awaiting,'count'); assert.equal(result.complete,false);
  assert.equal(await count('provider_requests',c.id),1);
  assert.equal((await db.query('select caregiver_count from public.provider_requests where conversation_id=$1',[c.id])).rows[0].caregiver_count,null);
});

test('table-level caregiver count constraint remains a final safeguard', async () => {
  const c=await create();
  await assert.rejects(()=>db.query('insert into public.provider_requests(conversation_id,caregiver_count) values($1,10001)',[c.id]),/check constraint/);
  assert.equal(await count('provider_requests',c.id),0);
});

for (const control of ['HUMAN','blocked','closed','assigned']) {
  test(`${control} turns record inbound without issuing an AI lease and deduplicate safely`, async () => {
    const c=await create(), id=randomUUID();
    if(control==='assigned') {
      const staff=randomUUID(); await db.query('insert into auth.users(id) values($1)',[staff]);
      // Deliberately leave mode=AI: the assignment itself must be authoritative.
      await db.query('insert into public.staff_assignments(conversation_id,staff_user_id) values($1,$2)',[c.id,staff]);
      const restored=await rpc('figa_restore_conversation',[c.id,token]);
      assert.equal(restored.mode,'HUMAN'); assert.equal(restored.state.control,'human_takeover');
    } else if(control==='HUMAN') await db.query("update public.conversations set mode='HUMAN' where id=$1",[c.id]);
    else await db.query('update public.conversations set status=$2 where id=$1',[c.id,control]);
    const denied=await rpc('figa_begin_turn',[c.id,'c'.repeat(64),id,'Fictional message',hash]);
    assert.equal(denied.kind,'not_found'); assert.equal(await count('messages',c.id),0);
    const result=await begin(c.id,id);
    assert.equal(result.kind,'controlled'); assert.equal(result.leaseToken,undefined);
    assert.equal(result.response.assistantResponse,''); assert.equal(result.response.engine.used,'none');
    assert.equal(result.response.humanAttentionNeeded,true); assert.equal(result.response.complete,false);
    assert.equal(result.response.state.control,control==='blocked'||control==='closed'?'blocked':'human_takeover');
    assert.equal(result.response.persistence.saved,true);
    const duplicate=await begin(c.id,id);
    assert.equal(duplicate.kind,'duplicate'); assert.equal(duplicate.response.assistantResponse,'');
    assert.equal((await begin(c.id,id,'Changed input','c'.repeat(64))).kind,'conflict');
    assert.equal(await count('messages',c.id),1); assert.equal(await count('conversation_events',c.id),3);
    const stored=(await db.query('select revision,pending_message_id from public.conversations where id=$1',[c.id])).rows[0];
    assert.equal(stored.revision,1); assert.equal(stored.pending_message_id,null);
  });
}

test('controlled inbound preserves an older lease and late inference remains suppressed', async () => {
  const c=await create(), first=randomUUID(), old=await begin(c.id,first), staff=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[staff]);
  assert.equal(await rpc('figa_assign_human',[c.id,staff,0]),true);
  assert.equal((await begin(c.id,randomUUID())).kind,'controlled');
  const pending=(await db.query('select pending_message_id,pending_lease_token from public.conversations where id=$1',[c.id])).rows[0];
  assert.equal(pending.pending_message_id,first); assert.equal(pending.pending_lease_token,old.leaseToken);
  const late=await finish(c.id,first,old);
  assert.equal(late.assistantResponse,''); assert.equal(late.engine.used,'none');
  assert.equal(await count('messages',c.id),2); assert.equal(await count('provider_requests',c.id),0);
});

for(const value of ['0','-1','10001','99999','999999999999999999999999','1.5','unknown','a few','',null,0,-1,10001,1.5,1e100,1e-100,{},[]]) {
  test(`invalid count ${JSON.stringify(value)} clarifies without failing the transaction`, async () => {
    const c=await create(), id=randomUUID(), t=await begin(c.id,id);
    const candidate=response('provider',{count:value,city:'Salem'}); candidate.complete=true;
    const result=await finish(c.id,id,t,candidate);
    assert.equal(result.complete,false); assert.equal(result.state.awaiting,'count');
    assert.match(result.assistantResponse,/whole number from 1 to 10,000/);
    assert.equal(Object.hasOwn(result.state.collected,'count'),false);
    assert.deepEqual(result.collectedInformation,{city:'Salem'});
    assert.equal((await db.query('select caregiver_count from public.provider_requests where conversation_id=$1',[c.id])).rows[0].caregiver_count,null);
    const saved=await rpc('figa_restore_conversation',[c.id,token]);
    assert.equal(saved.revision,1); assert.equal(saved.state.collected.count,undefined);
    assert.equal(await count('messages',c.id),2);
    assert.deepEqual((await begin(c.id,id)).response,result);
    const correction=randomUUID();
    await finish(c.id,correction,await begin(c.id,correction,'count: 3'),response('provider',{count:'3',city:'Salem'}));
    assert.equal((await db.query('select caregiver_count from public.provider_requests where conversation_id=$1',[c.id])).rows[0].caregiver_count,3);
  });
}

for(const [literal,expected] of [['2.0','2'],['1e4','10000']]) {
  test(`JSON numeric literal ${literal} normalizes without losing its integer value`, async () => {
    const c=await create(), id=randomUUID(), t=await begin(c.id,id);
    // Preserve raw JSON numeric notation instead of JS serialization reducing 2.0 to 2.
    const raw=JSON.stringify(response('provider',{count:2})).replaceAll('"count":2',`"count":${literal}`);
    const result=await finish(c.id,id,t,raw);
    assert.equal(result.state.collected.count,expected);
    assert.equal(result.collectedInformation.count,expected);
    assert.equal((await db.query('select caregiver_count from public.provider_requests where conversation_id=$1',[c.id])).rows[0].caregiver_count,Number(expected));
  });
}

for(const value of ['1','10000',1,2,10000]) {
  test(`${typeof value} count ${value} is accepted and stored as a string in state`, async () => {
    const c=await create(), id=randomUUID();
    const result=await finish(c.id,id,await begin(c.id,id),response('provider',{count:value}));
    assert.equal(result.state.collected.count,String(value));
    assert.equal(result.collectedInformation.count,String(value));
    assert.equal((await rpc('figa_restore_conversation',[c.id,token])).state.collected.count,String(value));
    assert.equal((await db.query('select caregiver_count from public.provider_requests where conversation_id=$1',[c.id])).rows[0].caregiver_count,Number(value));
  });
}
