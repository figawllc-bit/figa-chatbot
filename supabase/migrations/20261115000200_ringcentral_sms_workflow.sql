-- OFFLINE ONLY. Separate approval required before any remote migration.
-- Preserves synthetic-only constraints; does not authorize real message storage.
begin;
create or replace function public.figa_rc_fixture_text(p_text text) returns boolean
language sql immutable set search_path='' as $$
  select p_text = any(array[
    'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.',
    'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.',
    'Fictional group home staffing inquiry','Fictional provider inquiry',
    'Changed fictional content','Fictional outbound observation',
    'Fictional chatbot observation','Fictional claimed staff reply',
    'Fictional inquiry on another business line','Fictional independent inquiry',
    'Fictional direct RPC invalid batch','Fictional staffing inquiry',
    'STOP','START',' stop ','STOPALL','Unsubscribe','CANCEL','END','QUIT','please stop','stop please!'
  ]::text[]);
$$;

create table public.rc_sms_jobs (
 id uuid primary key default gen_random_uuid(),
 inbound_id text not null unique check(inbound_id ~ '^3\d{5}$'),
 conversation_id uuid not null references public.conversations(id),
 client_message_id uuid not null unique default gen_random_uuid(),
 status text not null default 'new' check(status in ('new','generated','sending','accepted','suppressed','failed','uncertain')),
 expected_revision integer, external_message_id text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.rc_sms_jobs enable row level security;
revoke all on public.rc_sms_jobs from public,anon,authenticated,service_role;

create function public.figa_rc_sms_allowed(p_id uuid,p_revision integer default null) returns boolean
language sql security definer set search_path='' as $$
 select coalesce((select c.is_synthetic and c.mode='AI' and c.status='open' and not t.review_hold
  and (p_revision is null or c.revision=p_revision)
  and not exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null)
  and not exists(select 1 from public.rc_optouts o where o.account_id=t.account_id and o.business_number=t.business_number and o.customer_number=t.customer_number)
 from public.conversations c join public.rc_threads t on t.conversation_id=c.id
 where c.id=p_id and t.account_id='100001' and t.extension_id='200001'),false);
$$;

create function public.figa_rc_sms_prepare(p_message_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.rc_observations%rowtype; j public.rc_sms_jobs%rowtype;
begin
 select * into m from public.rc_observations where account_id='100001' and extension_id='200001' and message_id=p_message_id and direction='Inbound' and actor='customer';
 if not found then raise exception 'Fictional inbound observation required'; end if;
 perform 1 from public.conversations where id=m.conversation_id and is_synthetic for update;
 if not found then raise exception 'Synthetic conversation required'; end if;
 insert into public.rc_sms_jobs(inbound_id,conversation_id) values(m.message_id,m.conversation_id) on conflict(inbound_id) do nothing;
 select * into j from public.rc_sms_jobs where inbound_id=m.message_id for update;
 -- A message that arrives while staff own the thread, the thread is closed or
 -- blocked, or the customer opted out is terminal. Returning the thread to AI
 -- later must never auto-answer messages staff already handled.
 if j.status in ('new','generated') and not public.figa_rc_sms_allowed(m.conversation_id) then
  update public.rc_sms_jobs set status='suppressed',updated_at=now() where id=j.id returning * into j;
 end if;
 return jsonb_build_object('id',j.id,'conversationId',j.conversation_id,'messageId',j.client_message_id,'status',j.status);
end $$;

create function public.figa_rc_sms_begin(p_id uuid,p_message_id uuid,p_message text,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; j public.rc_sms_jobs%rowtype; v jsonb;
begin
 select * into c from public.conversations where id=p_id and is_synthetic for update;
 if not found then return jsonb_build_object('kind','not_found'); end if;
 select * into j from public.rc_sms_jobs where conversation_id=p_id and client_message_id=p_message_id;
 if not found or not exists(select 1 from public.rc_observations where account_id='100001' and extension_id='200001' and message_id=j.inbound_id and content=p_message and actor='customer') then raise exception 'Invalid SMS turn'; end if;
 if not public.figa_rc_sms_allowed(p_id) then
  update public.rc_sms_jobs set status='suppressed' where id=j.id and status in ('new','generated');
  return jsonb_build_object('kind','controlled','response',jsonb_build_object('mode','LOCAL_DEVELOPMENT_DRY_RUN','conversationType',c.classification,'assistantResponse','','state',public.figa_snapshot(p_id)->'state','collectedInformation',c.state->'collected','humanAttentionNeeded',true,'humanAttentionReasons',jsonb_build_array('SMS conversation requires staff review.'),'complete',false,'engine',jsonb_build_object('requested','ai','used','none')));
 end if;
 -- Internal channel bridge: reuse the existing atomic turn transaction without
 -- issuing browser credentials or retaining an extended browser access window.
 update public.conversations set access_expires_at=now()+interval '1 minute' where id=p_id;
 v:=public.figa_begin_turn(p_id,c.access_token_hash,p_message_id,p_message,p_request_hash);
 update public.conversations set access_expires_at=c.access_expires_at where id=p_id;
 return v;
end $$;

create function public.figa_rc_sms_finish(p_id uuid,p_message_id uuid,p_lease_token uuid,p_revision integer,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; j public.rc_sms_jobs%rowtype; v jsonb;
begin
 select * into c from public.conversations where id=p_id and is_synthetic for update;
 if not found then raise exception 'Synthetic conversation required'; end if;
 select * into j from public.rc_sms_jobs where conversation_id=p_id and client_message_id=p_message_id;
 if not found or j.status<>'new' then raise exception 'SMS turn unavailable'; end if;
 update public.conversations set access_expires_at=now()+interval '1 minute' where id=p_id;
 v:=public.figa_finish_turn(p_id,c.access_token_hash,p_message_id,p_lease_token,p_revision,p_response);
 update public.conversations set access_expires_at=c.access_expires_at where id=p_id;
 update public.rc_sms_jobs set status=case when coalesce(v->>'assistantResponse','')='' then 'suppressed' else 'generated' end,
  expected_revision=(v#>>'{persistence,revision}')::integer,updated_at=now() where id=j.id;
 return v;
end $$;

create function public.figa_rc_sms_claim(p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.rc_sms_jobs%rowtype; c public.conversations%rowtype; m public.rc_observations%rowtype; v jsonb;
begin
 select * into j from public.rc_sms_jobs where id=p_job;
 if not found then return null; end if;
 select * into c from public.conversations where id=j.conversation_id and is_synthetic for update;
 select * into j from public.rc_sms_jobs where id=p_job for update;
 if j.status<>'generated' then return null; end if;
 if not public.figa_rc_sms_allowed(c.id,j.expected_revision) then update public.rc_sms_jobs set status='suppressed',updated_at=now() where id=j.id; return null; end if;
 select response into v from public.messages where conversation_id=c.id and client_message_id=j.client_message_id and direction='inbound';
 if coalesce(v->>'assistantResponse','')='' then update public.rc_sms_jobs set status='suppressed' where id=j.id; return null; end if;
 select * into m from public.rc_observations where account_id='100001' and extension_id='200001' and message_id=j.inbound_id;
 update public.rc_sms_jobs set status='sending',updated_at=now() where id=j.id;
 return jsonb_build_object('revision',j.expected_revision,'payload',jsonb_build_object('from',m.business_number,'to',m.customer_number,'text',v->>'assistantResponse'));
end $$;

create function public.figa_rc_sms_recheck(p_job uuid) returns boolean
language sql security definer set search_path='' as $$
 select coalesce((select status='sending' and public.figa_rc_sms_allowed(conversation_id,expected_revision) from public.rc_sms_jobs where id=p_job),false);
$$;

create function public.figa_rc_sms_complete(p_job uuid,p_kind text,p_external text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.rc_sms_jobs%rowtype;
begin
 if p_kind not in ('accepted','suppressed','failed','uncertain') or p_kind is null then raise exception 'Invalid SMS result'; end if;
 if (p_kind='accepted') is distinct from (p_external is not null) then raise exception 'Invalid SMS correlation'; end if;
 select * into j from public.rc_sms_jobs where id=p_job for update;
 if not found or j.status<>'sending' then return; end if;
 if p_kind='accepted' then
  if p_external is null or p_external !~ '^3\d{5}$' then raise exception 'Fictional message ID required'; end if;
  insert into public.rc_origins(account_id,extension_id,message_id,actor) values('100001','200001',p_external,'chatbot');
 end if;
 update public.rc_sms_jobs set status=p_kind,external_message_id=p_external,updated_at=now() where id=p_job;
end $$;

create function public.figa_rc_sms_pending() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value order by created_at,id),'[]'::jsonb) from (
  select j.id,j.created_at,jsonb_build_object('id',m.message_id,'accountId',m.account_id,'extensionId',m.extension_id,
   'businessNumber',m.business_number,'customerNumber',m.customer_number,'direction',m.direction,'text',m.content,'messageStatus',m.message_status,
   'modifiedAt',to_char(timezone('UTC',m.modified_at),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'optOut',false) as value
  from public.rc_sms_jobs j join public.rc_observations m on m.message_id=j.inbound_id and m.account_id='100001' and m.extension_id='200001'
  where j.status in ('new','generated') and public.figa_rc_sms_allowed(j.conversation_id)
  order by j.created_at,j.id limit 10
 ) queued;
$$;

revoke all on function public.figa_rc_sms_allowed(uuid,integer),public.figa_rc_sms_prepare(text),public.figa_rc_sms_begin(uuid,uuid,text,text),public.figa_rc_sms_finish(uuid,uuid,uuid,integer,jsonb),public.figa_rc_sms_claim(uuid),public.figa_rc_sms_recheck(uuid),public.figa_rc_sms_complete(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.figa_rc_sms_prepare(text),public.figa_rc_sms_begin(uuid,uuid,text,text),public.figa_rc_sms_finish(uuid,uuid,uuid,integer,jsonb),public.figa_rc_sms_claim(uuid),public.figa_rc_sms_recheck(uuid),public.figa_rc_sms_complete(uuid,text,text) to service_role;
revoke all on function public.figa_rc_sms_pending() from public,anon,authenticated,service_role;
grant execute on function public.figa_rc_sms_pending() to service_role;
commit;
