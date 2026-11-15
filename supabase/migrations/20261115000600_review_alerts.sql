-- OFFLINE ONLY. Separate approval required before any remote migration.
-- Staff were alerted only on first classification, urgency and mode/status changes.
-- A later escalation (human requested, sensitive details, opt-out, review flag) set
-- human_attention_needed silently. Queue a 'review' alert when it turns on, unless
-- another alert for this conversation was already queued in the same transaction.
begin;
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check
  check (kind in ('provider','caregiver','urgent','status','message','hand_reply','review'));

create function public.figa_queue_review_notification() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.human_attention_needed and not old.human_attention_needed and public.figa_row_allowed(new.is_synthetic)
     and not exists(select 1 from public.telegram_notifications where conversation_id=new.id and created_at=now()) then
    insert into public.telegram_notifications(conversation_id,kind,revision) values(new.id,'review',new.revision) on conflict do nothing;
  end if;
  return new;
end $$;
-- Named to fire after figa_staff_notifications (triggers run in name order).
create trigger figa_zz_review_notification after update of human_attention_needed on public.conversations
for each row execute function public.figa_queue_review_notification();
revoke all on function public.figa_queue_review_notification() from public,anon,authenticated,service_role;
commit;
