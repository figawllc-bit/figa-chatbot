-- Add ONE verified FIGA staff member to the production bot. Run in the production
-- project's SQL Editor. Before running, a trusted operator must verify the person's
-- FIGA role and Telegram account ownership out of band (never trust a username alone).
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user (their work email).
--    Copy the new user's UUID into <STAFF_AUTH_UUID>.
-- 2. <TELEGRAM_USER_ID>: their numeric Telegram ID (for example from @userinfobot),
--    confirmed by the person themselves. They must also open a private chat with the
--    FIGA bot and press Start, or Telegram will not deliver alerts to them.
-- 3. <VERIFIED_BY_AUTH_UUID>: the Auth UUID of the operator who verified them
--    (use the same UUID for the very first staff member).
-- 4. Permissions: pick the minimum needed.
--      view       - see /status, /inbox, alerts            (everyone)
--      takeover   - Take Over a conversation
--      resolve    - Resolve a conversation they own
--      return_ai  - Return a conversation they own to the AI
--      bot_mode   - switch Away / On Duty / Pause all / Auto and set office hours
begin;
insert into public.staff_roster(staff_user_id, telegram_user_id, telegram_chat_id, active, permissions, verified_at, verified_by)
values ('<STAFF_AUTH_UUID>', <TELEGRAM_USER_ID>, <TELEGRAM_USER_ID>, true,
        array['view','takeover','resolve','return_ai','bot_mode'], now(), '<VERIFIED_BY_AUTH_UUID>');
select telegram_user_id, active, permissions from public.staff_roster where staff_user_id = '<STAFF_AUTH_UUID>';
commit;
-- To remove someone later: update public.staff_roster set active=false where staff_user_id='<STAFF_AUTH_UUID>';
