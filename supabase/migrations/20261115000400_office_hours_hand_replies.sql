-- OFFLINE ONLY. Separate approval required before any remote migration.
-- 1. Office hours: new bot mode 'auto' = On Duty during office hours, Away otherwise.
--    away / on_duty / paused remain manual settings that stay until changed.
-- 2. Hand replies: an outgoing text the bot did not send already places a review
--    hold (figa_rc_observe). Staff are now alerted, and Return to AI / Resolve
--    clears the hold so the conversation can really be handed back.
begin;

-- Office hours: {"1":["08:00","17:00"],...} keyed by ISO weekday (1=Mon..7=Sun).
create function public.figa_valid_office_hours(p_hours jsonb) returns boolean
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_hours) is distinct from 'object' then false else not exists(
    select 1 from jsonb_each(p_hours) e
    where case
      when e.key not in ('1','2','3','4','5','6','7') or jsonb_typeof(e.value)<>'array' then true
      when jsonb_array_length(e.value)<>2 then true
      when coalesce(e.value->>0,'') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(e.value->>1,'') !~ '^(([01]\d|2[0-3]):[0-5]\d|24:00)$' then true
      else (e.value->>0)::time >= (e.value->>1)::time end) end;
$$;

alter table public.figa_bot_mode drop constraint figa_bot_mode_mode_check;
alter table public.figa_bot_mode add constraint figa_bot_mode_mode_check check (mode in ('auto','away','on_duty','paused'));
-- Default office hours are a placeholder (Mon-Fri 08:00-17:00 Pacific) until staff set real ones with /sethours.
alter table public.figa_bot_mode add column office_hours jsonb not null
  default '{"1":["08:00","17:00"],"2":["08:00","17:00"],"3":["08:00","17:00"],"4":["08:00","17:00"],"5":["08:00","17:00"]}'::jsonb
  check (public.figa_valid_office_hours(office_hours));
alter table public.figa_bot_mode add column timezone text not null default 'America/Los_Angeles' check (timezone='America/Los_Angeles');

create function public.figa_in_office_hours(p_hours jsonb,p_timezone text,p_at timestamptz) returns boolean
language sql stable set search_path='' as $$
  select coalesce((select local::time >= (w->>0)::time and (w->>1='24:00' or local::time < (w->>1)::time)
    from (select p_at at time zone p_timezone as local) l,
         lateral (select p_hours->(extract(isodow from l.local)::int::text) as w) x where w is not null),false);
$$;

-- What the bot is actually doing right now: away, on_duty or paused.
create function public.figa_bot_effective_mode(p_at timestamptz default now()) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select case when b.mode<>'auto' then b.mode
      when public.figa_in_office_hours(b.office_hours,b.timezone,p_at) then 'on_duty' else 'away' end
    from public.figa_bot_mode b where b.singleton),'paused');
$$;
create or replace function public.figa_bot_ai_enabled() returns boolean
language sql stable security definer set search_path='' as $$
  select public.figa_bot_effective_mode()='away';
$$;

create function public.figa_bot_mode_status(p_can_change boolean,p_kind text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('kind',p_kind,'mode',b.mode,'effective',public.figa_bot_effective_mode(),'hours',b.office_hours,'timezone',b.timezone,'canChange',p_can_change)
  from public.figa_bot_mode b where b.singleton;
$$;

-- Same contract as before, now also accepting 'auto' and returning the effective mode and hours.
create or replace function public.figa_telegram_mode(p_update_id bigint,p_actor bigint,p_chat bigint,p_mode text,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; b public.figa_bot_mode%rowtype; v_hash text; v_kind text := 'ok';
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  if p_mode is not null and (p_mode not in ('auto','away','on_duty','paused') or not ('bot_mode'=any(s.permissions))) then return jsonb_build_object('kind','denied'); end if;
  if p_update_id is null or p_update_id<0 or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid update'; end if;
  insert into public.telegram_updates(update_id,staff_user_id,request_hash) values(p_update_id,s.staff_user_id,p_request_hash) on conflict do nothing;
  if not found then
    select request_hash into v_hash from public.telegram_updates where update_id=p_update_id and staff_user_id=s.staff_user_id;
    v_kind := case when v_hash=p_request_hash then 'duplicate' else 'conflict' end;
  else
    select * into b from public.figa_bot_mode where singleton for update;
    if p_mode is not null and p_mode<>b.mode then
      update public.figa_bot_mode set mode=p_mode,revision=revision+1,updated_by=s.staff_user_id,updated_at=now() where singleton;
      v_kind := 'applied';
    end if;
    update public.telegram_updates set result_kind=v_kind where update_id=p_update_id;
  end if;
  return public.figa_bot_mode_status('bot_mode'=any(s.permissions),v_kind);
end $$;

create function public.figa_telegram_hours(p_update_id bigint,p_actor bigint,p_chat bigint,p_hours jsonb,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; b public.figa_bot_mode%rowtype; v_hash text; v_kind text := 'ok';
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'bot_mode'=any(permissions) for share;
  if not found or p_hours is null or not public.figa_valid_office_hours(p_hours) then return jsonb_build_object('kind','denied'); end if;
  if p_update_id is null or p_update_id<0 or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid update'; end if;
  insert into public.telegram_updates(update_id,staff_user_id,request_hash) values(p_update_id,s.staff_user_id,p_request_hash) on conflict do nothing;
  if not found then
    select request_hash into v_hash from public.telegram_updates where update_id=p_update_id and staff_user_id=s.staff_user_id;
    v_kind := case when v_hash=p_request_hash then 'duplicate' else 'conflict' end;
  else
    select * into b from public.figa_bot_mode where singleton for update;
    if b.office_hours is distinct from p_hours then
      update public.figa_bot_mode set office_hours=p_hours,revision=revision+1,updated_by=s.staff_user_id,updated_at=now() where singleton;
      v_kind := 'applied';
    end if;
    update public.telegram_updates set result_kind=v_kind where update_id=p_update_id;
  end if;
  return public.figa_bot_mode_status(true,v_kind);
end $$;

-- Hand replies: alert staff when a hold is placed; clear it when staff hand the thread back.
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check
  check (kind in ('provider','caregiver','urgent','status','message','hand_reply'));

create function public.figa_rc_hold_notification() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.review_hold and not old.review_hold then
    insert into public.telegram_notifications(conversation_id,kind,revision)
      select new.conversation_id,'hand_reply',c.revision from public.conversations c where c.id=new.conversation_id on conflict do nothing;
  end if;
  return new;
end $$;
create trigger figa_rc_hold_notification after update of review_hold on public.rc_threads
for each row execute function public.figa_rc_hold_notification();

create function public.figa_rc_clear_hold() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.event_type in ('returned_to_ai','resolved') then
    update public.rc_threads set review_hold=false where conversation_id=new.conversation_id and review_hold;
  end if;
  return new;
end $$;
create trigger figa_rc_clear_hold after insert on public.conversation_events
for each row execute function public.figa_rc_clear_hold();

revoke all on function public.figa_valid_office_hours(jsonb),public.figa_in_office_hours(jsonb,text,timestamptz),public.figa_bot_effective_mode(timestamptz),
  public.figa_bot_ai_enabled(),public.figa_bot_mode_status(boolean,text),public.figa_rc_hold_notification(),public.figa_rc_clear_hold(),
  public.figa_telegram_mode(bigint,bigint,bigint,text,text),public.figa_telegram_hours(bigint,bigint,bigint,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_mode(bigint,bigint,bigint,text,text),public.figa_telegram_hours(bigint,bigint,bigint,jsonb,text) to service_role;
commit;
