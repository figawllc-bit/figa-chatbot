-- OFFLINE ONLY. Separate approval required before any remote migration.
-- Deployment profile: the SAME migrations serve two physically separate databases.
--   development (default): unchanged behaviour - fictional fixtures only
--     (is_synthetic rows, fixture account/extension/numbers/texts).
--   production: real RingCentral identifiers configured below, real (non-synthetic)
--     rows only. Fixture rows are rejected there, and real rows are rejected here.
-- A database is switched to production ONCE, while it holds no conversations, with
-- supabase/production/configure.sql. The development project must never be switched.
begin;

create table public.figa_deployment (
  singleton boolean primary key default true check (singleton),
  kind text not null default 'development' check (kind in ('development','production')),
  rc_account_id text not null default '100001' check (rc_account_id ~ '^[1-9]\d{0,63}$'),
  rc_extension_ids text[] not null default array['200001','200002'] check (cardinality(rc_extension_ids) between 1 and 5),
  rc_business_numbers text[] not null default array['+15035550100','+15035550101'] check (cardinality(rc_business_numbers) between 1 and 20),
  updated_at timestamptz not null default now()
);
insert into public.figa_deployment default values;
alter table public.figa_deployment enable row level security;
revoke all on table public.figa_deployment from public,anon,authenticated,service_role;

create function public.figa_deployment_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op<>'UPDATE' then raise exception 'Deployment profile is a single fixed row'; end if;
  if (new.kind<>old.kind or new.rc_account_id<>old.rc_account_id) and exists(select 1 from public.conversations) then
    raise exception 'Deployment profile is fixed once conversations exist';
  end if;
  if old.kind='production' and new.kind<>'production' then raise exception 'A production database cannot become development'; end if;
  if new.kind='production' and (new.rc_account_id='100001' or new.rc_extension_ids && array['200001','200002']
      or new.rc_business_numbers && array['+15035550100','+15035550101']
      or exists(select 1 from unnest(new.rc_extension_ids) e where e !~ '^[1-9]\d{0,63}$')
      or exists(select 1 from unnest(new.rc_business_numbers) n where n !~ '^\+[1-9]\d{7,14}$')) then
    raise exception 'Production requires real RingCentral identifiers';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger figa_deployment_guard before insert or update or delete on public.figa_deployment
for each row execute function public.figa_deployment_guard();

create function public.figa_is_development() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select kind='development' from public.figa_deployment where singleton),true);
$$;
-- Development accepts only synthetic rows; production accepts only real rows.
create function public.figa_row_allowed(p_is_synthetic boolean) returns boolean
language sql stable security definer set search_path='' as $$
  select case when public.figa_is_development() then coalesce(p_is_synthetic,false) else not coalesce(p_is_synthetic,true) end;
$$;
create function public.figa_rc_account() returns text
language sql stable security definer set search_path='' as $$ select rc_account_id from public.figa_deployment where singleton; $$;
create function public.figa_rc_extensions() returns text[]
language sql stable security definer set search_path='' as $$ select rc_extension_ids from public.figa_deployment where singleton; $$;
-- The extension whose texts the bot answers (fixture 200001; FIGA extension 101 in production).
create function public.figa_rc_extension() returns text
language sql stable security definer set search_path='' as $$ select rc_extension_ids[1] from public.figa_deployment where singleton; $$;
create function public.figa_rc_business_numbers() returns text[]
language sql stable security definer set search_path='' as $$ select rc_business_numbers from public.figa_deployment where singleton; $$;
create function public.figa_rc_customer_pattern() returns text
language sql stable security definer set search_path='' as $$
  select case when public.figa_is_development() then '^\+150355501\d{2}$' else '^\+[1-9]\d{7,14}$' end;
$$;
create function public.figa_rc_message_id_pattern() returns text
language sql stable security definer set search_path='' as $$
  select case when public.figa_is_development() then '^3\d{5}$' else '^[1-9]\d{0,63}$' end;
$$;
create function public.figa_rc_text_ok(p_text text) returns boolean
language sql stable security definer set search_path='' as $$
  select case when public.figa_is_development() then public.figa_rc_fixture_text(p_text)
    else p_text is not null and char_length(p_text) between 1 and 2000 end;
$$;

-- New rows are labelled by the profile, never by callers.
do $$ declare t text; begin
  foreach t in array array['contacts','conversations','rc_threads','rc_optouts','rc_origins','rc_observations','rc_receipts'] loop
    execute format('alter table public.%I alter column is_synthetic set default public.figa_is_development()',t);
  end loop;
end $$;

-- Replace fixture-literal table rules with profile-aware ones.
do $$ declare r record; begin
  for r in select conrelid::regclass::text as t, conname from pg_constraint
    where contype='c' and connamespace='public'::regnamespace
      and conrelid::regclass::text in ('contacts','conversations','rc_threads','rc_optouts','rc_origins','rc_observations','rc_receipts','rc_sms_jobs')
      and pg_get_constraintdef(oid) ~ '(is_synthetic|100001|200001|15035550|figa_rc_fixture_text|\^3)'
  loop
    execute format('alter table public.%s drop constraint %I',r.t,r.conname);
  end loop;
end $$;
do $$ declare t text; begin
  foreach t in array array['contacts','conversations','rc_threads','rc_optouts','rc_origins','rc_observations','rc_receipts'] loop
    execute format('alter table public.%I add constraint %I check (public.figa_row_allowed(is_synthetic))',t,t||'_is_synthetic_check');
  end loop;
  foreach t in array array['rc_threads','rc_optouts','rc_origins','rc_observations'] loop
    execute format('alter table public.%I add constraint %I check (account_id=public.figa_rc_account())',t,t||'_account_id_check');
  end loop;
  foreach t in array array['rc_threads','rc_origins','rc_observations'] loop
    execute format('alter table public.%I add constraint %I check (extension_id=any(public.figa_rc_extensions()))',t,t||'_extension_id_check');
  end loop;
  foreach t in array array['rc_threads','rc_optouts','rc_observations'] loop
    execute format('alter table public.%I add constraint %I check (business_number=any(public.figa_rc_business_numbers()))',t,t||'_business_number_check');
    execute format('alter table public.%I add constraint %I check (customer_number ~ public.figa_rc_customer_pattern())',t,t||'_customer_number_check');
  end loop;
  foreach t in array array['rc_origins','rc_observations'] loop
    execute format('alter table public.%I add constraint %I check (message_id ~ public.figa_rc_message_id_pattern())',t,t||'_message_id_check');
  end loop;
end $$;
alter table public.rc_observations add constraint rc_observations_content_check check (public.figa_rc_text_ok(content));
alter table public.rc_sms_jobs add constraint rc_sms_jobs_inbound_id_check check (inbound_id ~ public.figa_rc_message_id_pattern());

-- Existing functions, regenerated with fixture literals replaced by profile lookups.
-- Bodies are otherwise identical to their latest definitions (named per function).
-- figa_queue_staff_notification: latest definition from 20261113000100_staff_telegram.sql
create or replace function public.figa_queue_staff_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_urgent boolean; v_old_urgent boolean;
begin
  if not public.figa_row_allowed(new.is_synthetic) then return new; end if;
  if new.classification in ('provider','caregiver') and old.classification is distinct from new.classification then
    insert into public.telegram_notifications(conversation_id,kind,revision) values(new.id,new.classification,new.revision) on conflict do nothing;
  end if;
  v_urgent := new.classification='provider' and (coalesce(new.state#>>'{collected,urgency}','') ~* '(urgent|asap|immediate)' or lower(coalesce(new.state#>>'{collected,date}',''))='tonight');
  v_old_urgent := old.classification='provider' and (coalesce(old.state#>>'{collected,urgency}','') ~* '(urgent|asap|immediate)' or lower(coalesce(old.state#>>'{collected,date}',''))='tonight');
  if v_urgent and not v_old_urgent then
    insert into public.telegram_notifications(conversation_id,kind,revision) values(new.id,'urgent',new.revision) on conflict do nothing;
  end if;
  if old.status is distinct from new.status or old.mode is distinct from new.mode then
    insert into public.telegram_notifications(conversation_id,kind,revision) values(new.id,'status',new.revision) on conflict do nothing;
  end if;
  return new;
end $$;

-- figa_rc_delivery_snapshot: latest definition from 20261115000100_ringcentral_receive_only.sql
create or replace function public.figa_rc_delivery_snapshot(p_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('conversation',jsonb_build_object('mode',public.figa_snapshot(c.id)->>'mode','status',c.status,'revision',c.revision),
    'activeStaffOwner',exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null),
    'reviewHold',t.review_hold,'optedOut',exists(select 1 from public.rc_optouts o where o.account_id=t.account_id and o.business_number=t.business_number and o.customer_number=t.customer_number))
  from public.rc_threads t join public.conversations c on c.id=t.conversation_id where c.id=p_id and public.figa_row_allowed(c.is_synthetic);
$$;

-- figa_rc_observe: latest definition from 20261115000100_ringcentral_receive_only.sql
create or replace function public.figa_rc_observe(p_event_id text,p_hash text,p_messages jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb; old public.rc_observations%rowtype; prior public.rc_receipts%rowtype; t public.rc_threads%rowtype;
  v_account text; v_extension text; v_contact uuid; v_conversation uuid; v_actor text; v_hold boolean; v_optout boolean;
  v_results jsonb := '[]'::jsonb; v_result jsonb; v_seen text[] := '{}';
begin
  if p_event_id is null or char_length(p_event_id) not between 1 and 300 or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or
    jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages) not between 1 and 50 then raise exception 'Invalid observation batch'; end if;
  v_account := p_messages->0->>'accountId'; v_extension := p_messages->0->>'extensionId';
  if v_account is null or v_extension is null or v_account !~ '^\d{1,64}$' or v_extension !~ '^\d{1,64}$' then raise exception 'Invalid scope'; end if;
  -- Serialize one shared extension; unique constraints remain the final safeguard.
  perform pg_catalog.pg_advisory_xact_lock(74071,pg_catalog.hashtext(v_account||':'||v_extension));
  select * into prior from public.rc_receipts where event_id=p_event_id;
  if found then
    if prior.request_hash<>p_hash then return jsonb_build_object('kind','conflict'); end if;
    return jsonb_build_object('kind','duplicate');
  end if;
  -- Validate the entire batch before writes so one malformed record rolls back all.
  for m in select value from jsonb_array_elements(p_messages) loop
    if m->>'accountId' is distinct from public.figa_rc_account() or coalesce(m->>'extensionId','') not in (select unnest(public.figa_rc_extensions())) or
      coalesce(m->>'id','') !~ public.figa_rc_message_id_pattern() or coalesce(m->>'businessNumber','') not in (select unnest(public.figa_rc_business_numbers())) or
      coalesce(m->>'customerNumber','') !~ public.figa_rc_customer_pattern() or public.figa_rc_text_ok(m->>'text') is distinct from true or
      (m - array['accountId','extensionId','id','businessNumber','customerNumber','direction','text','messageStatus','modifiedAt','optOut']::text[]) <> '{}'::jsonb
      then raise exception 'Authored fictional fixtures required'; end if;
    if (m->>'id')=any(v_seen) then raise exception 'Duplicate message ID in batch'; end if;
    v_seen:=array_append(v_seen,m->>'id');
    if m->>'accountId' is distinct from v_account or m->>'extensionId' is distinct from v_extension or
      coalesce(m->>'id','') !~ '^\d{1,64}$' or coalesce(m->>'businessNumber','') !~ '^\+[1-9]\d{7,14}$' or
      coalesce(m->>'customerNumber','') !~ '^\+[1-9]\d{7,14}$' or m->>'businessNumber'=m->>'customerNumber' or
      coalesce(m->>'direction','') not in ('Inbound','Outbound') or char_length(coalesce(m->>'text','')) not between 1 and 2000 or
      coalesce(m->>'messageStatus','') not in ('Received','Queued','Sent','Delivered','SendingFailed','DeliveryFailed') or
      jsonb_typeof(m->'optOut') is distinct from 'boolean' or m->>'modifiedAt' is null then raise exception 'Invalid SMS observation'; end if;
    perform (m->>'modifiedAt')::timestamptz;
    select * into old from public.rc_observations where account_id=v_account and extension_id=v_extension and message_id=m->>'id';
    if found and (old.content<>m->>'text' or old.direction<>m->>'direction' or old.business_number<>m->>'businessNumber' or old.customer_number<>m->>'customerNumber') then return jsonb_build_object('kind','conflict'); end if;
  end loop;
  for m in select value from jsonb_array_elements(p_messages) loop
    select * into t from public.rc_threads where account_id=v_account and extension_id=v_extension and business_number=m->>'businessNumber' and customer_number=m->>'customerNumber';
    if not found then
      insert into public.contacts(external_channel,external_contact_id) values('ringcentral',v_account||':'||v_extension||':'||(m->>'businessNumber')||':'||(m->>'customerNumber')) returning id into v_contact;
      insert into public.conversations(contact_id,access_token_hash) values(v_contact,repeat('0',64)) returning id into v_conversation;
      -- No browser token is issued; observations cannot authorize chat access.
      update public.conversations set access_expires_at=now() where id=v_conversation;
      insert into public.rc_threads(account_id,extension_id,business_number,customer_number,conversation_id) values(v_account,v_extension,m->>'businessNumber',m->>'customerNumber',v_conversation) returning * into t;
    end if;
    if not exists(select 1 from public.conversations where id=t.conversation_id and public.figa_row_allowed(is_synthetic)) then raise exception 'Synthetic fixture required'; end if;
    v_actor := 'unknown';
    if m->>'direction'='Inbound' then v_actor:='customer';
    else
      select o.actor into v_actor from public.rc_origins o where o.account_id=v_account and o.extension_id=v_extension and o.message_id=m->>'id' and
        (o.actor='chatbot' or exists(select 1 from public.staff_roster s where s.staff_user_id=o.staff_user_id and s.active and 'takeover'=any(s.permissions)));
      v_actor:=coalesce(v_actor,'unknown');
    end if;
    v_hold := m->>'direction'='Outbound' and v_actor in ('staff','unknown');
    -- Opt-outs are independently derived, never accepted solely from a boolean.
    v_optout := m->>'direction'='Inbound' and trim(m->>'text') ~* '^(please\s+)?(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)(\s+please)?[.!]?$';
    if v_optout then
      insert into public.rc_optouts(account_id,business_number,customer_number) values(v_account,m->>'businessNumber',m->>'customerNumber') on conflict do nothing;
      if found then update public.conversations set human_attention_needed=true,revision=revision+1 where id in
        (select conversation_id from public.rc_threads where account_id=v_account and business_number=m->>'businessNumber' and customer_number=m->>'customerNumber');
      end if;
    end if;
    update public.rc_threads set review_hold=review_hold or v_hold where conversation_id=t.conversation_id returning * into t;
    select * into old from public.rc_observations where account_id=v_account and extension_id=v_extension and message_id=m->>'id';
    if not found then
      insert into public.rc_observations(account_id,extension_id,message_id,conversation_id,direction,actor,content,message_status,modified_at,business_number,customer_number)
        values(v_account,v_extension,m->>'id',t.conversation_id,m->>'direction',v_actor,m->>'text',m->>'messageStatus',(m->>'modifiedAt')::timestamptz,m->>'businessNumber',m->>'customerNumber');
      update public.conversations set revision=revision+1,human_attention_needed=human_attention_needed or v_hold where id=t.conversation_id;
    elsif (m->>'modifiedAt')::timestamptz>old.modified_at then
      update public.rc_observations set message_status=m->>'messageStatus',modified_at=(m->>'modifiedAt')::timestamptz where account_id=v_account and extension_id=v_extension and message_id=m->>'id';
    end if;
    v_results:=v_results||jsonb_build_array(jsonb_build_object('conversationId',t.conversation_id,'actor',v_actor,'reviewHold',t.review_hold,'optOut',exists(select 1 from public.rc_optouts where account_id=v_account and business_number=m->>'businessNumber' and customer_number=m->>'customerNumber')));
  end loop;
  v_result:=jsonb_build_object('kind','observed','observations',v_results);
  insert into public.rc_receipts(event_id,request_hash,result) values(p_event_id,p_hash,v_result);
  return v_result;
end $$;

-- figa_rc_sms_allowed: latest definition from 20261115000300_bot_mode.sql
create or replace function public.figa_rc_sms_allowed(p_id uuid,p_revision integer default null) returns boolean
language sql security definer set search_path='' as $$
 select public.figa_bot_ai_enabled() and coalesce((select public.figa_row_allowed(c.is_synthetic) and c.mode='AI' and c.status='open' and not t.review_hold
  and (p_revision is null or c.revision=p_revision)
  and not exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null)
  and not exists(select 1 from public.rc_optouts o where o.account_id=t.account_id and o.business_number=t.business_number and o.customer_number=t.customer_number)
 from public.conversations c join public.rc_threads t on t.conversation_id=c.id
 where c.id=p_id and t.account_id=public.figa_rc_account() and t.extension_id=public.figa_rc_extension()),false);
$$;

-- figa_rc_sms_begin: latest definition from 20261115000200_ringcentral_sms_workflow.sql
create or replace function public.figa_rc_sms_begin(p_id uuid,p_message_id uuid,p_message text,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; j public.rc_sms_jobs%rowtype; v jsonb;
begin
 select * into c from public.conversations where id=p_id and public.figa_row_allowed(is_synthetic) for update;
 if not found then return jsonb_build_object('kind','not_found'); end if;
 select * into j from public.rc_sms_jobs where conversation_id=p_id and client_message_id=p_message_id;
 if not found or not exists(select 1 from public.rc_observations where account_id=public.figa_rc_account() and extension_id=public.figa_rc_extension() and message_id=j.inbound_id and content=p_message and actor='customer') then raise exception 'Invalid SMS turn'; end if;
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

-- figa_rc_sms_claim: latest definition from 20261115000200_ringcentral_sms_workflow.sql
create or replace function public.figa_rc_sms_claim(p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.rc_sms_jobs%rowtype; c public.conversations%rowtype; m public.rc_observations%rowtype; v jsonb;
begin
 select * into j from public.rc_sms_jobs where id=p_job;
 if not found then return null; end if;
 select * into c from public.conversations where id=j.conversation_id and public.figa_row_allowed(is_synthetic) for update;
 select * into j from public.rc_sms_jobs where id=p_job for update;
 if j.status<>'generated' then return null; end if;
 if not public.figa_rc_sms_allowed(c.id,j.expected_revision) then update public.rc_sms_jobs set status='suppressed',updated_at=now() where id=j.id; return null; end if;
 select response into v from public.messages where conversation_id=c.id and client_message_id=j.client_message_id and direction='inbound';
 if coalesce(v->>'assistantResponse','')='' then update public.rc_sms_jobs set status='suppressed' where id=j.id; return null; end if;
 select * into m from public.rc_observations where account_id=public.figa_rc_account() and extension_id=public.figa_rc_extension() and message_id=j.inbound_id;
 update public.rc_sms_jobs set status='sending',updated_at=now() where id=j.id;
 return jsonb_build_object('revision',j.expected_revision,'payload',jsonb_build_object('from',m.business_number,'to',m.customer_number,'text',v->>'assistantResponse'));
end $$;

-- figa_rc_sms_complete: latest definition from 20261115000200_ringcentral_sms_workflow.sql
create or replace function public.figa_rc_sms_complete(p_job uuid,p_kind text,p_external text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.rc_sms_jobs%rowtype;
begin
 if p_kind not in ('accepted','suppressed','failed','uncertain') or p_kind is null then raise exception 'Invalid SMS result'; end if;
 if (p_kind='accepted') is distinct from (p_external is not null) then raise exception 'Invalid SMS correlation'; end if;
 select * into j from public.rc_sms_jobs where id=p_job for update;
 if not found or j.status<>'sending' then return; end if;
 if p_kind='accepted' then
  if p_external is null or p_external !~ public.figa_rc_message_id_pattern() then raise exception 'Fictional message ID required'; end if;
  insert into public.rc_origins(account_id,extension_id,message_id,actor) values(public.figa_rc_account(),public.figa_rc_extension(),p_external,'chatbot');
 end if;
 update public.rc_sms_jobs set status=p_kind,external_message_id=p_external,updated_at=now() where id=p_job;
end $$;

-- figa_rc_sms_finish: latest definition from 20261115000200_ringcentral_sms_workflow.sql
create or replace function public.figa_rc_sms_finish(p_id uuid,p_message_id uuid,p_lease_token uuid,p_revision integer,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; j public.rc_sms_jobs%rowtype; v jsonb;
begin
 select * into c from public.conversations where id=p_id and public.figa_row_allowed(is_synthetic) for update;
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

-- figa_rc_sms_pending: latest definition from 20261115000200_ringcentral_sms_workflow.sql
create or replace function public.figa_rc_sms_pending() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value order by created_at,id),'[]'::jsonb) from (
  select j.id,j.created_at,jsonb_build_object('id',m.message_id,'accountId',m.account_id,'extensionId',m.extension_id,
   'businessNumber',m.business_number,'customerNumber',m.customer_number,'direction',m.direction,'text',m.content,'messageStatus',m.message_status,
   'modifiedAt',to_char(timezone('UTC',m.modified_at),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'optOut',false) as value
  from public.rc_sms_jobs j join public.rc_observations m on m.message_id=j.inbound_id and m.account_id=public.figa_rc_account() and m.extension_id=public.figa_rc_extension()
  where j.status in ('new','generated') and public.figa_rc_sms_allowed(j.conversation_id)
  order by j.created_at,j.id limit 10
 ) queued;
$$;

-- figa_rc_sms_prepare: latest definition from 20261115000300_bot_mode.sql
create or replace function public.figa_rc_sms_prepare(p_message_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.rc_observations%rowtype; j public.rc_sms_jobs%rowtype; v_count integer;
begin
 select * into m from public.rc_observations where account_id=public.figa_rc_account() and extension_id=public.figa_rc_extension() and message_id=p_message_id and direction='Inbound' and actor='customer';
 if not found then raise exception 'Fictional inbound observation required'; end if;
 perform 1 from public.conversations where id=m.conversation_id and public.figa_row_allowed(is_synthetic) for update;
 if not found then raise exception 'Synthetic conversation required'; end if;
 insert into public.rc_sms_jobs(inbound_id,conversation_id) values(m.message_id,m.conversation_id) on conflict(inbound_id) do nothing;
 select * into j from public.rc_sms_jobs where inbound_id=m.message_id for update;
 -- A message that arrives while staff own the thread, the bot is On Duty or
 -- Paused, the thread is closed/blocked, or the customer opted out is terminal.
 -- Switching back to Away / Return to AI never auto-answers it later.
 if j.status in ('new','generated') and not public.figa_rc_sms_allowed(m.conversation_id) then
  update public.rc_sms_jobs set status='suppressed',updated_at=now() where id=j.id returning * into j;
  -- Bot is off globally: alert staff once per inbound text (no content in Telegram).
  if not public.figa_bot_ai_enabled() then
   select count(*) into v_count from public.rc_sms_jobs where conversation_id=m.conversation_id;
   insert into public.telegram_notifications(conversation_id,kind,revision) values(m.conversation_id,'message',v_count) on conflict do nothing;
  end if;
 end if;
 return jsonb_build_object('id',j.id,'conversationId',j.conversation_id,'messageId',j.client_message_id,'status',j.status);
end $$;

-- figa_staff_summary: latest definition from 20261113000100_staff_telegram.sql
create or replace function public.figa_staff_summary(p_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'type',c.classification,'status',c.status,'mode',c.mode,'revision',c.revision,
    'details',jsonb_build_object('city',c.state#>'{collected,city}','state',c.state#>'{collected,state}',
      'position',c.state#>'{collected,position}','count',c.state#>'{collected,count}',
      'date',c.state#>'{collected,date}','shift',c.state#>'{collected,shift}',
      'availabilityReceived',c.state#>'{collected,availability}' is not null),
    'urgent',c.classification='provider' and (coalesce(c.state#>>'{collected,urgency}','') ~* '(urgent|asap|immediate)' or lower(coalesce(c.state#>>'{collected,date}',''))='tonight'))
  from public.conversations c where c.id=p_id and public.figa_row_allowed(c.is_synthetic);
$$;

-- figa_telegram_claim_one: latest definition from 20261114000100_notification_preview.sql
create or replace function public.figa_telegram_claim_one(p_actor bigint,p_chat bigint,p_notification uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; v_lease uuid := gen_random_uuid();
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  if not exists(select 1 from public.telegram_notifications n join public.conversations c on c.id=n.conversation_id where n.id=p_notification and public.figa_row_allowed(c.is_synthetic)) then return jsonb_build_object('kind','unavailable'); end if;
  insert into public.telegram_deliveries(notification_id,staff_user_id,lease_token,lease_expires_at)
    values(p_notification,s.staff_user_id,v_lease,now()+interval '60 seconds')
    on conflict(notification_id,staff_user_id) do update set lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at
    where public.telegram_deliveries.delivered_at is null and public.telegram_deliveries.lease_expires_at<=now();
  if not found then return jsonb_build_object('kind','unavailable'); end if;
  return jsonb_build_object('kind','claimed','claim',jsonb_build_object('id',p_notification,'leaseToken',v_lease));
end $$;

-- figa_telegram_controls: latest definition from 20261114000200_staff_controls.sql
create or replace function public.figa_telegram_controls(p_actor bigint,p_chat bigint,p_id uuid,p_revision integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; c public.conversations%rowtype; v_owner uuid; v_actions jsonb := '["summary"]'::jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions);
  if not found then return null; end if;
  select * into c from public.conversations where id=p_id and public.figa_row_allowed(is_synthetic);
  if not found or (p_revision is not null and c.revision<>p_revision) then return null; end if;
  select staff_user_id into v_owner from public.staff_assignments where conversation_id=p_id and released_at is null;
  if c.status='open' then
    if c.mode='AI' and v_owner is null and 'takeover'=any(s.permissions) then v_actions:=v_actions||'"takeover"'::jsonb; end if;
    if c.mode='HUMAN' and v_owner=s.staff_user_id then
      if 'resolve'=any(s.permissions) then v_actions:=v_actions||'"resolve"'::jsonb; end if;
      if 'return_ai'=any(s.permissions) then v_actions:=v_actions||'"return_ai"'::jsonb; end if;
    end if;
  end if;
  return jsonb_build_object('actions',v_actions,'summary',public.figa_staff_summary(p_id));
end $$;

-- figa_telegram_preview: latest definition from 20261114000100_notification_preview.sql
create or replace function public.figa_telegram_preview(p_actor bigint,p_chat bigint,p_notification uuid default null,p_conversation uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; v_items jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions);
  if not found then return jsonb_build_object('kind','denied'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'conversation',public.figa_staff_summary(x.conversation_id),
    'deliveryState',case when x.delivered_at is not null then 'delivered' when x.lease_expires_at>now() then 'leased' else 'pending' end) order by x.created_at desc,x.id),'[]'::jsonb)
  into v_items from (
    select n.*,d.delivered_at,d.lease_expires_at from public.telegram_notifications n
    join public.conversations c on c.id=n.conversation_id and public.figa_row_allowed(c.is_synthetic)
    left join public.telegram_deliveries d on d.notification_id=n.id and d.staff_user_id=s.staff_user_id
    where (p_notification is null or n.id=p_notification) and (p_conversation is null or n.conversation_id=p_conversation)
    order by n.created_at desc,n.id limit 20
  ) x;
  return jsonb_build_object('kind','ok','notifications',v_items);
end $$;

-- figa_telegram_process: latest definition from 20261113000100_staff_telegram.sql
create or replace function public.figa_telegram_process(p_update_id bigint,p_actor bigint,p_chat bigint,p_action text,p_id uuid,p_revision integer,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; c public.conversations%rowtype; v_hash text; v_owner uuid; v_kind text; v_items jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  if p_action not in ('inbox','summary','takeover','resolve','return_ai') or p_action is null then return jsonb_build_object('kind','denied'); end if;
  if p_action in ('takeover','resolve','return_ai') and not (p_action=any(s.permissions)) then return jsonb_build_object('kind','denied'); end if;
  if p_update_id is null or p_update_id<0 or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid update'; end if;
  -- Unique INSERT waits on competing retries and rolls back with the entire action.
  insert into public.telegram_updates(update_id,staff_user_id,request_hash) values(p_update_id,s.staff_user_id,p_request_hash) on conflict do nothing;
  if not found then
    select request_hash into v_hash from public.telegram_updates where update_id=p_update_id and staff_user_id=s.staff_user_id;
    return jsonb_build_object('kind',case when v_hash=p_request_hash then 'duplicate' else 'conflict' end);
  end if;
  if p_action='inbox' then
    select coalesce(jsonb_agg(public.figa_staff_summary(x.id)),'[]'::jsonb) into v_items
      from (select id from public.conversations where public.figa_row_allowed(is_synthetic) order by updated_at desc,id limit 10) x;
    v_kind := 'ok';
  else
    select * into c from public.conversations where id=p_id and public.figa_row_allowed(is_synthetic) for update;
    if not found then v_kind := 'unavailable';
    elsif (p_action<>'summary' or p_revision is not null) and c.revision is distinct from p_revision then v_kind := 'stale';
    elsif p_action='summary' then v_kind := 'ok';
    elsif c.status<>'open' then v_kind := 'unavailable';
    elsif p_action='takeover' then
      if public.figa_assign_human(p_id,s.staff_user_id,p_revision) then v_kind := 'applied'; else v_kind := 'stale'; end if;
    else
      select staff_user_id into v_owner from public.staff_assignments where conversation_id=p_id and released_at is null;
      if c.mode<>'HUMAN' or v_owner is distinct from s.staff_user_id then v_kind := 'denied';
      else
        update public.staff_assignments set released_at=now() where conversation_id=p_id and released_at is null;
        update public.conversations set mode=case when p_action='return_ai' then 'AI' else 'HUMAN' end,
          status=case when p_action='resolve' then 'closed' else 'open' end,
          state=state||jsonb_build_object('control',case when p_action='resolve' then 'blocked' else 'active' end),
          human_attention_needed=false,revision=revision+1,updated_at=now() where id=p_id;
        insert into public.conversation_events(conversation_id,event_type,actor_type,actor_user_id)
          values(p_id,case when p_action='resolve' then 'resolved' else 'returned_to_ai' end,'staff',s.staff_user_id);
        v_kind := 'applied';
      end if;
    end if;
    if v_kind in ('ok','applied') then v_items := jsonb_build_array(public.figa_staff_summary(p_id)); end if;
  end if;
  update public.telegram_updates set result_kind=v_kind where update_id=p_update_id;
  return jsonb_build_object('kind',v_kind,'conversations',coalesce(v_items,'[]'::jsonb));
end $$;

-- figa_telegram_summary: latest definition from 20261113000100_staff_telegram.sql
create or replace function public.figa_telegram_summary(p_actor bigint,p_chat bigint,p_id uuid,p_revision integer) returns jsonb
language sql security definer set search_path='' as $$
  select public.figa_staff_summary(c.id) from public.conversations c
  where c.id=p_id and public.figa_row_allowed(c.is_synthetic) and c.revision=p_revision and exists(
    select 1 from public.staff_roster s where s.telegram_user_id=p_actor and s.telegram_chat_id=p_chat and s.active and 'view'=any(s.permissions));
$$;

revoke all on function public.figa_deployment_guard(),public.figa_is_development(),public.figa_row_allowed(boolean),
  public.figa_rc_account(),public.figa_rc_extensions(),public.figa_rc_extension(),public.figa_rc_business_numbers(),
  public.figa_rc_customer_pattern(),public.figa_rc_message_id_pattern(),public.figa_rc_text_ok(text) from public,anon,authenticated,service_role;
commit;
