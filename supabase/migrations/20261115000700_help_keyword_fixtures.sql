-- OFFLINE ONLY. Separate approval required before any remote migration.
-- Adds the HELP / INFO keywords to the fixed development fixture catalogue so the
-- SMS HELP auto-reply can be tested end to end. Production (deployment profile)
-- does not use this catalogue. Same list as before plus 'HELP' and 'INFO'.
begin;
create or replace function public.figa_rc_fixture_text(p_text text) returns boolean
language sql immutable set search_path='' as $$
  select p_text = any(array[
    'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.',
    'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.',
    'Fictional group home staffing inquiry','Fictional provider inquiry',
    'Changed fictional content','Fictional outbound observation',
    'Fictional chatbot observation','Fictional claimed staff reply',
    'Fictional inquiry on another business line','Fictional independent inquiry',
    'Fictional direct RPC invalid batch','Fictional staffing inquiry',
    'STOP','START',' stop ','STOPALL','Unsubscribe','CANCEL','END','QUIT','please stop','stop please!',
    'HELP','INFO'
  ]::text[]);
$$;
revoke all on function public.figa_rc_fixture_text(text) from public,anon,authenticated,service_role;
commit;
