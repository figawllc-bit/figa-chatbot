-- OFFLINE ONLY. Separate approval required before any remote migration.
-- Global bot mode, switched by approved staff from Telegram:
--   away    = staff unavailable; the bot answers texts automatically
--   on_duty = staff are answering; the bot stays silent and alerts staff
--   paused  = everything off; the bot never generates or sends a reply
-- Defaults to paused, so a fresh database can never start texting by itself.
-- Per-conversation Take Over / Return to AI / Resolve are unchanged and still apply.
begin;
create table public.figa_bot_mode (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'paused' check (mode in ('away','on_duty','paused')),
  revision integer not null default 0 check (revision>=0),
  updated_by uuid references public.staff_roster(staff_user_id),
  updated_at timestamptz not null default now()
);
insert into public.figa_bot_mode default values;
alter table public.figa_bot_mode enable row level security;
revoke all on table public.figa_bot_mode from public,anon,authenticated,service_role;

alter table public.staff_roster drop constraint staff_roster_permissions_check;
alter table public.staff_roster add constraint staff_roster_permissions_check
  check (permissions <@ array['view','takeover','resolve','return_ai','bot_mode']::text[] and array_position(permissions,null) is null);
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check
  check (kind in ('provider','caregiver','urgent','status','message'));

create function public.figa_bot_ai_enabled() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select mode='away' from public.figa_bot_mode where singleton),false);
$$;

-- Same rule as before, plus the global mode. This single gate is used before
-- inference, when claiming a reply, and again immediately before the SMS POST.
create or replace function public.figa_rc_sms_allowed(p_id uuid,p_revision integer default null) returns boolean
language sql security definer set search_path='' as $$
 select public.figa_bot_ai_enabled() and coalesce((select c.is_synthetic and c.mode='AI' and c.status='open' and not t.review_hold
  and (p_revision is null or c.revision=p_revision)
  and not exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null)
  and not exists(select 1 from public.rc_optouts o where o.account_id=t.account_id and o.business_number=t.business_number and o.customer_number=t.customer_number)
 from public.conversations c join public.rc_threads t on t.conversation_id=c.id
 where c.id=p_id and t.account_id='100001' and t.extension_id='200001'),false);
$$;

create or replace function public.figa_rc_sms_prepare(p_message_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.rc_observations%rowtype; j public.rc_sms_jobs%rowtype; v_count integer;
begin
 select * into m from public.rc_observations where account_id='100001' and extension_id='200001' and message_id=p_message_id and direction='Inbound' and actor='customer';
 if not found then raise exception 'Fictional inbound observation required'; end if;
 perform 1 from public.conversations where id=m.conversation_id and is_synthetic for update;
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

-- p_mode null = status only (needs 'view'); setting a mode needs 'bot_mode'.
create function public.figa_telegram_mode(p_update_id bigint,p_actor bigint,p_chat bigint,p_mode text,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; b public.figa_bot_mode%rowtype; v_hash text; v_kind text := 'ok';
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  if p_mode is not null and (p_mode not in ('away','on_duty','paused') or not ('bot_mode'=any(s.permissions))) then return jsonb_build_object('kind','denied'); end if;
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
  select * into b from public.figa_bot_mode where singleton;
  return jsonb_build_object('kind',v_kind,'mode',b.mode,'canChange','bot_mode'=any(s.permissions));
end $$;

revoke all on function public.figa_bot_ai_enabled(),public.figa_telegram_mode(bigint,bigint,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_mode(bigint,bigint,bigint,text,text) to service_role;
revoke all on function public.figa_rc_sms_allowed(uuid,integer),public.figa_rc_sms_prepare(text) from public,anon,authenticated,service_role;
grant execute on function public.figa_rc_sms_prepare(text) to service_role;
commit;
