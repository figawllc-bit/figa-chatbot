-- OPERATOR REVIEW ONLY. Run manually in the isolated development project's SQL
-- Editor AFTER explicit approval for view, takeover, resolve AND return_ai.
-- This is NOT a migration and is never executed by the application/test runner.
begin;
do $$
declare s public.staff_roster%rowtype;
begin
  select * into s from public.staff_roster
    where telegram_user_id=7646333318 and telegram_chat_id=7646333318
      and active and verified_at is not null and verified_by is not null
      and 'view'=any(permissions) for update;
  if not found then raise exception 'Existing active verified development tester not found; no permissions changed'; end if;
  update public.staff_roster set permissions=array['view','takeover','resolve','return_ai']
    where staff_user_id=s.staff_user_id;
end $$;
select telegram_user_id,active,permissions from public.staff_roster where telegram_user_id=7646333318;
commit;
