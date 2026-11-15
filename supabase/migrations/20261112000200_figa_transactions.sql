begin;

-- Internal helper. No token hash, leases, external IDs, or staff identities leave this snapshot.
create function public.figa_snapshot(p_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('id',c.id,'status',c.status,'mode',case when a.active then 'HUMAN' else c.mode end,'revision',c.revision,'humanAttentionNeeded',c.human_attention_needed or a.active or c.mode='HUMAN' or c.status<>'open',
    'state',c.state || jsonb_build_object('control',case when c.status <> 'open' then 'blocked' when c.mode = 'HUMAN' or a.active then 'human_takeover' else 'active' end),
    'messages',coalesce((select jsonb_agg(m.item order by m.created_at,m.id) from
      (select id,created_at,jsonb_build_object('id',id,'clientMessageId',client_message_id,'direction',direction,'senderType',sender_type,'content',content,'createdAt',created_at) item
       from public.messages where conversation_id = c.id order by created_at desc,id desc limit 50) m),'[]'::jsonb))
  from public.conversations c cross join lateral (select exists(select 1 from public.staff_assignments where conversation_id=c.id and released_at is null) as active) a where c.id = p_id;
$$;

create function public.figa_create_conversation(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_contact uuid; v_id uuid;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_token_hash is null then raise exception 'Invalid access hash'; end if;
  insert into public.contacts default values returning id into v_contact;
  insert into public.conversations(contact_id,access_token_hash) values(v_contact,p_token_hash) returning id into v_id;
  insert into public.conversation_events(conversation_id,event_type,actor_type) values(v_id,'created','system');
  return public.figa_snapshot(v_id);
end $$;

create function public.figa_restore_conversation(p_id uuid,p_token_hash text) returns jsonb
language sql security definer set search_path = '' as $$
  select public.figa_snapshot(c.id) from public.conversations c
  where c.id = p_id and c.access_token_hash = p_token_hash and c.access_expires_at > now();
$$;

create function public.figa_begin_turn(p_id uuid,p_token_hash text,p_message_id uuid,p_message text,p_request_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype; m public.messages%rowtype; v_lease uuid; v_controlled boolean; v_response jsonb; v_state jsonb;
begin
  select * into c from public.conversations where id = p_id and access_token_hash = p_token_hash and access_expires_at > now() for update;
  if not found then return jsonb_build_object('kind','not_found'); end if;
  if char_length(p_message) not between 1 and 2000 or p_message is null or p_message_id is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid message'; end if;
  select * into m from public.messages where conversation_id=p_id and client_message_id=p_message_id and direction='inbound';
  if found then
    if m.request_hash <> p_request_hash then return jsonb_build_object('kind','conflict'); end if;
    if m.response is not null then
      -- A duplicate must never replay old AI prose after an authoritative takeover/block.
      if c.mode='HUMAN' or c.status<>'open' or exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null) then
        return jsonb_build_object('kind','duplicate','response',m.response || jsonb_build_object('assistantResponse','','engine',jsonb_build_object('requested','deterministic','used','none','reason','conversation_control'),'state',public.figa_snapshot(p_id)->'state','collectedInformation',c.state->'collected','humanAttentionNeeded',true,'humanAttentionReasons',jsonb_build_array('Conversation is controlled by staff.'),'complete',false));
      end if;
      return jsonb_build_object('kind','duplicate','response',m.response);
    end if;
  end if;
  v_controlled := c.mode='HUMAN' or c.status<>'open' or exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null);
  -- Staff-controlled inbound messages remain recordable even during an older AI lease.
  if not v_controlled and c.pending_message_id is not null and c.lease_expires_at > now() then return jsonb_build_object('kind','busy'); end if;
  v_lease := gen_random_uuid();
  if m.id is null then
    insert into public.messages(conversation_id,client_message_id,direction,sender_type,content,request_hash) values(p_id,p_message_id,'inbound','customer',p_message,p_request_hash);
    insert into public.conversation_events(conversation_id,event_type,actor_type,metadata) values(p_id,'turn_received','customer',jsonb_build_object('messageId',p_message_id));
  end if;
  -- Active assignments are authoritative even if a future buggy client fails to set mode.
  if exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null) then
    update public.conversations set mode='HUMAN' where id=p_id;
  end if;
  if v_controlled then
    v_state := public.figa_snapshot(p_id)->'state';
    v_response := jsonb_build_object('mode','LOCAL_DEVELOPMENT_DRY_RUN','conversationType',c.classification,'assistantResponse','','state',v_state,'collectedInformation',v_state->'collected','humanAttentionNeeded',true,'humanAttentionReasons',jsonb_build_array('Conversation is controlled by staff.'),'complete',false,'informationStatus','user_reported_unverified','engine',jsonb_build_object('requested','deterministic','used','none','reason','conversation_control'),'persistence',jsonb_build_object('conversationId',p_id,'messageId',p_message_id,'revision',c.revision+1,'saved',true));
    update public.messages set response=v_response where conversation_id=p_id and client_message_id=p_message_id and direction='inbound';
    -- Preserve any earlier lease: its completion must still pass the finish-time race checks.
    update public.conversations set state=v_state,human_attention_needed=true,revision=revision+1,last_message_at=now(),updated_at=now() where id=p_id;
    insert into public.conversation_events(conversation_id,event_type,actor_type,metadata) values(p_id,'reply_suppressed','system',jsonb_build_object('messageId',p_message_id,'revision',c.revision+1));
    return jsonb_build_object('kind','controlled','response',v_response);
  end if;
  update public.conversations set pending_message_id=p_message_id,pending_lease_token=v_lease,lease_expires_at=now()+interval '60 seconds',last_message_at=now() where id=p_id;
  return jsonb_build_object('kind','ready','conversation',public.figa_snapshot(p_id),'leaseToken',v_lease);
end $$;

create function public.figa_finish_turn(p_id uuid,p_token_hash text,p_message_id uuid,p_lease_token uuid,p_revision integer,p_response jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype; v_response jsonb; v_state jsonb; v_fields jsonb; v_type text; v_control text; v_suppressed boolean; v_count integer;
begin
  select * into c from public.conversations where id=p_id and access_token_hash=p_token_hash and access_expires_at > now() for update;
  if not found then raise exception 'Conversation not found'; end if;
  if c.pending_message_id is distinct from p_message_id or c.pending_lease_token is distinct from p_lease_token or c.lease_expires_at <= now() then raise exception 'Stale turn lease'; end if;
  v_suppressed := c.status<>'open' or c.mode='HUMAN' or c.revision is distinct from p_revision or exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null);
  v_control := case when c.status<>'open' then 'blocked' when v_suppressed then 'human_takeover' else 'active' end;
  if v_suppressed then
    v_state := c.state || jsonb_build_object('control',v_control);
    v_response := jsonb_build_object('mode','LOCAL_DEVELOPMENT_DRY_RUN','conversationType',c.classification,'assistantResponse','','state',v_state,'collectedInformation',v_state->'collected','humanAttentionNeeded',true,'humanAttentionReasons',jsonb_build_array('Conversation is controlled by staff.'),'complete',false,'informationStatus','user_reported_unverified','engine',jsonb_build_object('requested',coalesce(p_response#>>'{engine,requested}','deterministic'),'used','none','reason','conversation_control'));
  else
    v_state := p_response->'state';
    v_type := v_state->>'type';
    if jsonb_typeof(v_state) <> 'object' or v_state->>'version' is distinct from '1' or v_type not in ('unknown','provider','caregiver','general') or v_type is null or jsonb_typeof(v_state->'collected') is distinct from 'object' or jsonb_typeof(v_state->'humanAttentionReasons') is distinct from 'array' then raise exception 'Invalid engine state'; end if;
    if char_length(coalesce(p_response->>'assistantResponse','')) > 4000 then raise exception 'Reply too long'; end if;
    v_state := v_state || jsonb_build_object('control','active');
    v_fields := v_state->'collected';
    -- Validate before casting/inserting. The table constraint remains a final safeguard.
    if v_type='provider' and v_fields ? 'count' then
      if jsonb_typeof(v_fields->'count')='string' and v_fields->>'count' ~ '^[0-9]{1,5}$' then
        v_count := (v_fields->>'count')::integer;
      elsif jsonb_typeof(v_fields->'count')='number' and v_fields->>'count' ~ '^[0-9]{1,5}(\.0+)?$' then
        -- JSON numbers such as 2 or 2.0 are accepted, without rounding fractions.
        -- Bound digits before casting so huge numeric inputs cannot overflow integer.
        v_count := (v_fields->>'count')::numeric::integer;
      end if;
      if v_count not between 1 and 10000 then v_count := null; end if;
      if v_count is null then
        v_fields := v_fields - 'count';
        v_state := v_state || jsonb_build_object('collected',v_fields,'awaiting','count');
        p_response := p_response || jsonb_build_object('assistantResponse','How many caregivers do you need? Please provide a whole number from 1 to 10,000.','complete',false);
      else
        v_fields := v_fields || jsonb_build_object('count',v_count::text);
        v_state := v_state || jsonb_build_object('collected',v_fields);
      end if;
    end if;
    v_response := p_response || jsonb_build_object('state',v_state,'collectedInformation',v_fields,'informationStatus','user_reported_unverified');
    update public.contacts set contact_type=v_type,name=v_fields->>'name',organization=v_fields->>'organization',city=v_fields->>'city',state=v_fields->>'state',updated_at=now() where id=c.contact_id;
    update public.provider_requests set is_active=false,updated_at=now() where conversation_id=p_id;
    update public.caregiver_leads set is_active=false,updated_at=now() where conversation_id=p_id;
    if v_type='provider' then
      insert into public.provider_requests(conversation_id,position,city,state,requested_date_text,shift,caregiver_count,urgency,notes)
      values(p_id,v_fields->>'position',v_fields->>'city',v_fields->>'state',v_fields->>'date',v_fields->>'shift',v_count,v_fields->>'urgency',v_fields->>'notes')
      on conflict(conversation_id) do update set position=excluded.position,city=excluded.city,state=excluded.state,requested_date_text=excluded.requested_date_text,shift=excluded.shift,caregiver_count=excluded.caregiver_count,urgency=excluded.urgency,notes=excluded.notes,is_active=true,updated_at=now();
    elsif v_type='caregiver' then
      insert into public.caregiver_leads(conversation_id,preferred_position,city,state,availability,preferred_shift,experience,application_status)
      values(p_id,v_fields->>'position',v_fields->>'city',v_fields->>'state',v_fields->>'availability',v_fields->>'shift',v_fields->>'experience',v_fields->>'applicationStatus')
      on conflict(conversation_id) do update set preferred_position=excluded.preferred_position,city=excluded.city,state=excluded.state,availability=excluded.availability,preferred_shift=excluded.preferred_shift,experience=excluded.experience,application_status=excluded.application_status,is_active=true,updated_at=now();
    end if;
  end if;
  if not v_suppressed and coalesce(v_response->>'assistantResponse','') <> '' then
    insert into public.messages(conversation_id,client_message_id,direction,sender_type,content) values(p_id,p_message_id,'outbound','assistant',v_response->>'assistantResponse');
  end if;
  v_response := v_response || jsonb_build_object('persistence',jsonb_build_object('conversationId',p_id,'messageId',p_message_id,'revision',c.revision+1,'saved',true));
  update public.messages set response=v_response where conversation_id=p_id and client_message_id=p_message_id and direction='inbound';
  update public.conversations set state=v_state,classification=v_state->>'type',human_attention_needed=v_suppressed or coalesce((v_response->>'humanAttentionNeeded')::boolean,false),revision=revision+1,pending_message_id=null,pending_lease_token=null,lease_expires_at=null,updated_at=now() where id=p_id;
  insert into public.conversation_events(conversation_id,event_type,actor_type,metadata) values(p_id,case when v_suppressed then 'reply_suppressed' else 'turn_completed' end,'system',jsonb_build_object('messageId',p_message_id,'revision',c.revision+1));
  return v_response;
end $$;

-- Privileged internal primitive, NOT staff authorization. The auth.users FK proves only
-- identity existence. Before any HTTP exposure, a trusted backend must authenticate the
-- caller, verify active FIGA staff membership/role and conversation scope, and derive
-- p_staff_user_id from that verified identity (never a browser-supplied user ID).
-- Service credentials alone do not establish staff authorization. No staff endpoint exists.
create function public.figa_assign_human(p_id uuid,p_staff_user_id uuid,p_expected_revision integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  select * into c from public.conversations where id=p_id for update;
  if not found or c.revision is distinct from p_expected_revision or p_staff_user_id is null then return false; end if;
  if exists(select 1 from public.staff_assignments where conversation_id=p_id and released_at is null) then return false; end if;
  insert into public.staff_assignments(conversation_id,staff_user_id) values(p_id,p_staff_user_id);
  update public.conversations set mode='HUMAN',human_attention_needed=true,revision=revision+1,updated_at=now() where id=p_id;
  insert into public.conversation_events(conversation_id,event_type,actor_type,actor_user_id) values(p_id,'human_assigned','staff',p_staff_user_id);
  return true;
end $$;

revoke all on function public.figa_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.figa_create_conversation(text) from public,anon,authenticated,service_role;
revoke all on function public.figa_restore_conversation(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.figa_begin_turn(uuid,text,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.figa_finish_turn(uuid,text,uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.figa_assign_human(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.figa_create_conversation(text),public.figa_restore_conversation(uuid,text),public.figa_begin_turn(uuid,text,uuid,text,text),public.figa_finish_turn(uuid,text,uuid,uuid,integer,jsonb),public.figa_assign_human(uuid,uuid,integer) to service_role;
commit;
