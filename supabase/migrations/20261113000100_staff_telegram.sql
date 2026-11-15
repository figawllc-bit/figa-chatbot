-- Phase 4: REVIEW ONLY. Do not apply remotely without approval.
begin;

-- Provision only by a trusted operator AFTER verifying FIGA identity and Telegram
-- ownership out of band. An auth.users row or Telegram username is not verification.
create table public.staff_roster (
  staff_user_id uuid primary key references auth.users(id) on delete restrict,
  telegram_user_id bigint not null unique check (telegram_user_id between 1 and 4503599627370495),
  telegram_chat_id bigint not null unique check (telegram_chat_id=telegram_user_id),
  active boolean not null default false,
  permissions text[] not null default array['view']::text[],
  verified_at timestamptz not null,
  verified_by uuid not null references auth.users(id) on delete restrict,
  check (permissions <@ array['view','takeover','resolve','return_ai']::text[] and array_position(permissions,null) is null)
);
create table public.telegram_updates (
  update_id bigint primary key check (update_id>=0),
  staff_user_id uuid not null references public.staff_roster(staff_user_id),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result_kind text not null default 'processing',
  created_at timestamptz not null default now()
);
create table public.telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  kind text not null check (kind in ('provider','caregiver','urgent','status')),
  revision integer not null check (revision>=0),
  created_at timestamptz not null default now(),
  unique(conversation_id,kind,revision)
);
create index telegram_notifications_time_idx on public.telegram_notifications(created_at,id);
create table public.telegram_deliveries (
  notification_id uuid not null references public.telegram_notifications(id) on delete restrict,
  staff_user_id uuid not null references public.staff_roster(staff_user_id) on delete restrict,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  delivered_at timestamptz,
  primary key(notification_id,staff_user_id)
);
alter table public.conversation_events drop constraint conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check
  check (event_type in ('created','turn_received','turn_completed','reply_suppressed','human_assigned','resolved','returned_to_ai'));

create function public.figa_queue_staff_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_urgent boolean; v_old_urgent boolean;
begin
  if not new.is_synthetic then return new; end if;
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
create trigger figa_staff_notifications after update on public.conversations
for each row execute function public.figa_queue_staff_notification();

-- Never return transcripts, contact identities, notes, experience or medical details.
-- The bot applies a second strict display allowlist before constructing plain text.
create function public.figa_staff_summary(p_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'type',c.classification,'status',c.status,'mode',c.mode,'revision',c.revision,
    'details',jsonb_build_object('city',c.state#>'{collected,city}','state',c.state#>'{collected,state}',
      'position',c.state#>'{collected,position}','count',c.state#>'{collected,count}',
      'date',c.state#>'{collected,date}','shift',c.state#>'{collected,shift}',
      'availabilityReceived',c.state#>'{collected,availability}' is not null),
    'urgent',c.classification='provider' and (coalesce(c.state#>>'{collected,urgency}','') ~* '(urgent|asap|immediate)' or lower(coalesce(c.state#>>'{collected,date}',''))='tonight'))
  from public.conversations c where c.id=p_id and c.is_synthetic;
$$;

-- Harden and retire the legacy service-role entry point. Only the verified
-- Telegram action transaction below can invoke it on behalf of staff.
create or replace function public.figa_assign_human(p_id uuid,p_staff_user_id uuid,p_expected_revision integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype;
begin
  perform 1 from public.staff_roster where staff_user_id=p_staff_user_id and active
    and permissions @> array['view','takeover']::text[] for share;
  if not found then return false; end if;
  select * into c from public.conversations where id=p_id for update;
  if not found or c.revision is distinct from p_expected_revision or c.status<>'open' or c.mode<>'AI' then return false; end if;
  if exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null) then return false; end if;
  insert into public.staff_assignments(conversation_id,staff_user_id,telegram_staff_id)
    select p_id,p_staff_user_id,telegram_user_id::text from public.staff_roster where staff_user_id=p_staff_user_id;
  update public.conversations set mode='HUMAN',human_attention_needed=true,revision=revision+1,updated_at=now() where id=p_id;
  insert into public.conversation_events(conversation_id,event_type,actor_type,actor_user_id) values(p_id,'human_assigned','staff',p_staff_user_id);
  return true;
end $$;

-- p_actor/p_chat MUST originate from an authenticated Telegram update (verified
-- webhook secret or trusted polling transport), never a browser or callback data.
create function public.figa_telegram_process(p_update_id bigint,p_actor bigint,p_chat bigint,p_action text,p_id uuid,p_revision integer,p_request_hash text) returns jsonb
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
      from (select id from public.conversations where is_synthetic order by updated_at desc,id limit 10) x;
    v_kind := 'ok';
  else
    select * into c from public.conversations where id=p_id and is_synthetic for update;
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

create function public.figa_telegram_pending(p_actor bigint,p_chat bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; n public.telegram_notifications%rowtype; v_lease uuid; v_items jsonb := '[]'::jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  for n in select q.* from public.telegram_notifications q where not exists(select 1 from public.telegram_deliveries d where d.notification_id=q.id and d.staff_user_id=s.staff_user_id and (d.delivered_at is not null or d.lease_expires_at>now())) order by q.created_at,q.id limit 20 loop
    v_lease := gen_random_uuid();
    insert into public.telegram_deliveries(notification_id,staff_user_id,lease_token,lease_expires_at)
      values(n.id,s.staff_user_id,v_lease,now()+interval '60 seconds')
      on conflict(notification_id,staff_user_id) do update set lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at
      where public.telegram_deliveries.delivered_at is null and public.telegram_deliveries.lease_expires_at<=now();
    if found then v_items := v_items||jsonb_build_array(jsonb_build_object('id',n.id,'leaseToken',v_lease)); end if;
  end loop;
  return jsonb_build_object('kind','ok','notifications',v_items);
end $$;
create function public.figa_telegram_summary(p_actor bigint,p_chat bigint,p_id uuid,p_revision integer) returns jsonb
language sql security definer set search_path='' as $$
  select public.figa_staff_summary(c.id) from public.conversations c
  where c.id=p_id and c.is_synthetic and c.revision=p_revision and exists(
    select 1 from public.staff_roster s where s.telegram_user_id=p_actor and s.telegram_chat_id=p_chat and s.active and 'view'=any(s.permissions));
$$;
create function public.figa_telegram_notification(p_actor bigint,p_chat bigint,p_notification uuid,p_lease uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('id',n.id,'kind',n.kind,'conversation',public.figa_staff_summary(n.conversation_id))
  from public.staff_roster s join public.telegram_deliveries d on d.staff_user_id=s.staff_user_id
  join public.telegram_notifications n on n.id=d.notification_id
  where s.telegram_user_id=p_actor and s.telegram_chat_id=p_chat and s.active and 'view'=any(s.permissions)
    and n.id=p_notification and d.lease_token=p_lease and d.lease_expires_at>now() and d.delivered_at is null;
$$;
create function public.figa_telegram_ack(p_actor bigint,p_chat bigint,p_notification uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return false; end if;
  update public.telegram_deliveries set delivered_at=now() where notification_id=p_notification and staff_user_id=s.staff_user_id
    and lease_token=p_lease and lease_expires_at>now() and delivered_at is null;
  return found;
end $$;
create function public.figa_telegram_recipients() returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('actor',telegram_user_id,'chat',telegram_chat_id)),'[]'::jsonb)
  from (select telegram_user_id,telegram_chat_id from public.staff_roster where active and 'view'=any(permissions) order by staff_user_id limit 20) s;
$$;

do $$ declare t text; begin
  foreach t in array array['staff_roster','telegram_updates','telegram_notifications','telegram_deliveries'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;
revoke all on function public.figa_assign_human(uuid,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.figa_telegram_recipients() from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_recipients() to service_role;
revoke all on function public.figa_queue_staff_notification(),public.figa_staff_summary(uuid),public.figa_telegram_process(bigint,bigint,bigint,text,uuid,integer,text),public.figa_telegram_summary(bigint,bigint,uuid,integer),public.figa_telegram_pending(bigint,bigint),public.figa_telegram_notification(bigint,bigint,uuid,uuid),public.figa_telegram_ack(bigint,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_process(bigint,bigint,bigint,text,uuid,integer,text),public.figa_telegram_summary(bigint,bigint,uuid,integer),public.figa_telegram_pending(bigint,bigint),public.figa_telegram_notification(bigint,bigint,uuid,uuid),public.figa_telegram_ack(bigint,bigint,uuid,uuid) to service_role;
commit;
