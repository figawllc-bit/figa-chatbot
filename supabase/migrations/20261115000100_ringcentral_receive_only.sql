-- OFFLINE REVIEW ONLY. Do not apply to remote Supabase without authorization.
begin;
-- Deliberately fixed fictional catalog, independently enforced below the adapter.
-- No caller flag, default column value, or service credential can authorize real
-- customer material through this development RPC. Never seed this from live data.
create function public.figa_rc_fixture_text(p_text text) returns boolean
language sql immutable set search_path='' as $$
  select p_text = any(array[
    'Fictional group home staffing inquiry','Fictional provider inquiry',
    'Changed fictional content','Fictional outbound observation',
    'Fictional chatbot observation','Fictional claimed staff reply',
    'Fictional inquiry on another business line','Fictional independent inquiry',
    'Fictional direct RPC invalid batch','Fictional staffing inquiry',
    'STOP','START',' stop ','STOPALL','Unsubscribe','CANCEL','END','QUIT','please stop','stop please!'
  ]::text[]);
$$;
revoke all on function public.figa_rc_fixture_text(text) from public,anon,authenticated,service_role;
create table public.rc_threads (
  account_id text not null check(account_id='100001'), extension_id text not null check(extension_id in ('200001','200002')),
  business_number text not null check(business_number in ('+15035550100','+15035550101')), customer_number text not null check(customer_number ~ '^\+150355501\d{2}$'),
  conversation_id uuid not null unique references public.conversations(id), review_hold boolean not null default false,
  is_synthetic boolean not null default true check(is_synthetic),
  primary key(account_id,extension_id,business_number,customer_number)
);
create table public.rc_optouts (
  account_id text not null check(account_id='100001'), business_number text not null check(business_number in ('+15035550100','+15035550101')),
  customer_number text not null check(customer_number ~ '^\+150355501\d{2}$'),
  created_at timestamptz not null default now(), is_synthetic boolean not null default true check(is_synthetic),
  primary key(account_id,business_number,customer_number)
);
-- Trusted correlation only. No webhook field is allowed to create these proofs.
-- Phase 7A has no RPC to register origins or clear holds/opt-outs.
create table public.rc_origins (
  account_id text not null check(account_id='100001'), extension_id text not null check(extension_id in ('200001','200002')), message_id text not null check(message_id ~ '^3\d{5}$'),
  actor text not null check(actor in ('staff','chatbot')), staff_user_id uuid references auth.users(id),
  is_synthetic boolean not null default true check(is_synthetic),
  check((actor='staff')=(staff_user_id is not null)), primary key(account_id,extension_id,message_id)
);
create table public.rc_observations (
  account_id text not null check(account_id='100001'), extension_id text not null check(extension_id in ('200001','200002')), message_id text not null check(message_id ~ '^3\d{5}$'),
  conversation_id uuid not null references public.conversations(id), direction text not null check(direction in ('Inbound','Outbound')),
  actor text not null check(actor in ('customer','staff','chatbot','unknown')), content text not null check(public.figa_rc_fixture_text(content)),
  message_status text not null, modified_at timestamptz not null,
  business_number text not null check(business_number in ('+15035550100','+15035550101')), customer_number text not null check(customer_number ~ '^\+150355501\d{2}$'),
  is_synthetic boolean not null default true check(is_synthetic), primary key(account_id,extension_id,message_id)
);
create table public.rc_receipts (
  event_id text primary key, request_hash text not null, result jsonb not null,
  is_synthetic boolean not null default true check(is_synthetic)
);
alter table public.rc_threads enable row level security;
alter table public.rc_optouts enable row level security;
alter table public.rc_origins enable row level security;
alter table public.rc_observations enable row level security;
alter table public.rc_receipts enable row level security;
revoke all on public.rc_threads,public.rc_optouts,public.rc_origins,public.rc_observations,public.rc_receipts from public,anon,authenticated,service_role;

create function public.figa_rc_observe(p_event_id text,p_hash text,p_messages jsonb) returns jsonb
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
    if m->>'accountId' is distinct from '100001' or coalesce(m->>'extensionId','') not in ('200001','200002') or
      coalesce(m->>'id','') !~ '^3\d{5}$' or coalesce(m->>'businessNumber','') not in ('+15035550100','+15035550101') or
      coalesce(m->>'customerNumber','') !~ '^\+150355501\d{2}$' or public.figa_rc_fixture_text(m->>'text') is distinct from true or
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
    if not exists(select 1 from public.conversations where id=t.conversation_id and is_synthetic) then raise exception 'Synthetic fixture required'; end if;
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
create function public.figa_rc_delivery_snapshot(p_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('conversation',jsonb_build_object('mode',public.figa_snapshot(c.id)->>'mode','status',c.status,'revision',c.revision),
    'activeStaffOwner',exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null),
    'reviewHold',t.review_hold,'optedOut',exists(select 1 from public.rc_optouts o where o.account_id=t.account_id and o.business_number=t.business_number and o.customer_number=t.customer_number))
  from public.rc_threads t join public.conversations c on c.id=t.conversation_id where c.id=p_id and c.is_synthetic;
$$;
revoke all on function public.figa_rc_observe(text,text,jsonb),public.figa_rc_delivery_snapshot(uuid) from public,anon,authenticated,service_role;
grant execute on function public.figa_rc_observe(text,text,jsonb),public.figa_rc_delivery_snapshot(uuid) to service_role;
commit;
