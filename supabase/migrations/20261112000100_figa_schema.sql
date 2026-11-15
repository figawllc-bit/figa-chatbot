-- REVIEW ONLY: apply exclusively to a new, isolated development project after approval.
begin;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  contact_type text not null default 'unknown' check (contact_type in ('unknown','provider','caregiver','general')),
  name text, organization text, city text, state text,
  external_channel text check (external_channel in ('ringcentral','local')),
  external_contact_id text,
  is_synthetic boolean not null default true check (is_synthetic),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (external_channel, external_contact_id),
  check ((external_channel is null) = (external_contact_id is null))
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  access_token_hash text not null check (access_token_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz not null default (now() + interval '7 days'),
  status text not null default 'open' check (status in ('open','blocked','closed')),
  mode text not null default 'AI' check (mode in ('AI','HUMAN')),
  classification text not null default 'unknown' check (classification in ('unknown','provider','caregiver','general')),
  state jsonb not null default '{"version":1,"type":"unknown","collected":{},"awaiting":null,"humanAttentionReasons":[]}',
  human_attention_needed boolean not null default false,
  revision integer not null default 0 check (revision >= 0),
  pending_message_id uuid, pending_lease_token uuid, lease_expires_at timestamptz,
  is_synthetic boolean not null default true check (is_synthetic),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_message_at timestamptz,
  check (jsonb_typeof(state) = 'object' and state->>'version' = '1' and jsonb_typeof(state->'collected') = 'object'),
  check ((pending_message_id is null and pending_lease_token is null and lease_expires_at is null)
      or (pending_message_id is not null and pending_lease_token is not null and lease_expires_at is not null))
);
create index conversations_contact_idx on public.conversations(contact_id);
create index conversations_followup_idx on public.conversations(updated_at) where human_attention_needed;
create index conversations_work_queue_idx on public.conversations(mode, status, updated_at);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  client_message_id uuid not null,
  direction text not null check (direction in ('inbound','outbound')),
  sender_type text not null check (sender_type in ('customer','assistant','staff','system')),
  content text not null check (char_length(content) between 1 and 4000),
  request_hash text check (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb,
  channel text not null default 'local' check (channel in ('local','ringcentral','telegram')),
  external_message_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id, direction),
  check ((direction = 'inbound' and sender_type = 'customer') or (direction = 'outbound' and sender_type <> 'customer'))
);
create unique index messages_external_dedupe_idx on public.messages(channel, external_message_id) where external_message_id is not null;
create index messages_conversation_time_idx on public.messages(conversation_id, created_at, id);

create table public.provider_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete restrict,
  position text, city text, state text, requested_date_text text, shift text,
  -- Unknown counts remain NULL. The turn RPC validates input before this final constraint.
  caregiver_count integer check (caregiver_count between 1 and 10000), urgency text, notes text,
  information_status text not null default 'user_reported_unverified' check (information_status = 'user_reported_unverified'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index provider_requests_location_idx on public.provider_requests(state,city) where is_active;

create table public.caregiver_leads (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete restrict,
  preferred_position text, city text, state text, availability text, preferred_shift text, experience text, application_status text,
  information_status text not null default 'user_reported_unverified' check (information_status = 'user_reported_unverified'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index caregiver_leads_location_idx on public.caregiver_leads(state,city) where is_active;

create table public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  staff_user_id uuid not null references auth.users(id) on delete restrict,
  telegram_staff_id text,
  assigned_at timestamptz not null default now(), released_at timestamptz,
  check (released_at is null or released_at >= assigned_at)
);
create unique index staff_assignments_one_owner_idx on public.staff_assignments(conversation_id) where released_at is null;
create index staff_assignments_staff_idx on public.staff_assignments(staff_user_id) where released_at is null;
create index staff_assignments_history_idx on public.staff_assignments(conversation_id,assigned_at);

create table public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  event_type text not null check (event_type in ('created','turn_received','turn_completed','reply_suppressed','human_assigned')),
  actor_type text not null check (actor_type in ('system','customer','staff')),
  actor_user_id uuid references auth.users(id) on delete restrict,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index conversation_events_time_idx on public.conversation_events(conversation_id,created_at,id);

-- Default deny: no public policies, no public grants, no direct service-role table access.
-- Narrow SECURITY DEFINER RPCs in the next migration provide the only app access.
do $$
declare t text;
begin
  foreach t in array array['contacts','conversations','messages','provider_requests','caregiver_leads','staff_assignments','conversation_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
commit;
