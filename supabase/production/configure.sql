-- Run ONCE on the SEPARATE production Supabase project (never the development project),
-- after all files in supabase/migrations/ are applied and BEFORE any conversation exists.
-- Requires FIGA's privacy/contract approval for real customer data on this stack.
-- The database refuses this change if it already holds conversations, if any value is a
-- development fixture, and it can never be switched back to development afterwards.
--
-- Fill in the placeholders, then run in the production project's SQL editor:
--   <ACCOUNT_ID>     numeric RingCentral account ID (as in message-store URIs; also the Worker var RINGCENTRAL_ACCOUNT_ID)
--   <SENDER_NUMBER>  the approved, SMS-enabled, registered E.164 number, e.g. +15035551234
--                    (also the Worker var RINGCENTRAL_SMS_FROM_NUMBER)
-- Extension owner 3322425015 is FIGA's extension 101 (the only extension the bot answers).
begin;
update public.figa_deployment
   set kind = 'production',
       rc_account_id = '<ACCOUNT_ID>',
       rc_extension_ids = array['3322425015'],
       rc_business_numbers = array['<SENDER_NUMBER>'];
-- The bot starts PAUSED. Staff switch it with /status, /auto, /away, /onduty in Telegram.
select kind, rc_account_id, rc_extension_ids, rc_business_numbers from public.figa_deployment;
select mode, office_hours from public.figa_bot_mode;
commit;
-- Then add staff to public.staff_roster (verified Telegram IDs) and grant 'bot_mode'
-- only to the people who should switch the bot.
