-- Pending review/approval. No staff permissions are modified by this migration.
begin;
create function public.figa_telegram_controls(p_actor bigint,p_chat bigint,p_id uuid,p_revision integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; c public.conversations%rowtype; v_owner uuid; v_actions jsonb := '["summary"]'::jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions);
  if not found then return null; end if;
  select * into c from public.conversations where id=p_id and is_synthetic;
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
revoke all on function public.figa_telegram_controls(bigint,bigint,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_controls(bigint,bigint,uuid,integer) to service_role;
commit;
