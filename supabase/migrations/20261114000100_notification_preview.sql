-- REVIEW REQUIRED: new functions only. Do not apply remotely without approval.
begin;

-- Read-only: no claims, acknowledgements, update dedupe rows or conversation writes.
create function public.figa_telegram_preview(p_actor bigint,p_chat bigint,p_notification uuid default null,p_conversation uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; v_items jsonb;
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions);
  if not found then return jsonb_build_object('kind','denied'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'conversation',public.figa_staff_summary(x.conversation_id),
    'deliveryState',case when x.delivered_at is not null then 'delivered' when x.lease_expires_at>now() then 'leased' else 'pending' end) order by x.created_at desc,x.id),'[]'::jsonb)
  into v_items from (
    select n.*,d.delivered_at,d.lease_expires_at from public.telegram_notifications n
    join public.conversations c on c.id=n.conversation_id and c.is_synthetic
    left join public.telegram_deliveries d on d.notification_id=n.id and d.staff_user_id=s.staff_user_id
    where (p_notification is null or n.id=p_notification) and (p_conversation is null or n.conversation_id=p_conversation)
    order by n.created_at desc,n.id limit 20
  ) x;
  return jsonb_build_object('kind','ok','notifications',v_items);
end $$;

-- One explicit notification, same table/lease protocol as the existing dispatcher.
create function public.figa_telegram_claim_one(p_actor bigint,p_chat bigint,p_notification uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.staff_roster%rowtype; v_lease uuid := gen_random_uuid();
begin
  select * into s from public.staff_roster where telegram_user_id=p_actor and telegram_chat_id=p_chat and active and 'view'=any(permissions) for share;
  if not found then return jsonb_build_object('kind','denied'); end if;
  if not exists(select 1 from public.telegram_notifications n join public.conversations c on c.id=n.conversation_id where n.id=p_notification and c.is_synthetic) then return jsonb_build_object('kind','unavailable'); end if;
  insert into public.telegram_deliveries(notification_id,staff_user_id,lease_token,lease_expires_at)
    values(p_notification,s.staff_user_id,v_lease,now()+interval '60 seconds')
    on conflict(notification_id,staff_user_id) do update set lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at
    where public.telegram_deliveries.delivered_at is null and public.telegram_deliveries.lease_expires_at<=now();
  if not found then return jsonb_build_object('kind','unavailable'); end if;
  return jsonb_build_object('kind','claimed','claim',jsonb_build_object('id',p_notification,'leaseToken',v_lease));
end $$;
revoke all on function public.figa_telegram_preview(bigint,bigint,uuid,uuid),public.figa_telegram_claim_one(bigint,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.figa_telegram_preview(bigint,bigint,uuid,uuid),public.figa_telegram_claim_one(bigint,bigint,uuid) to service_role;
commit;
