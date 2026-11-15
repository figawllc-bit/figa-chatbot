import { describe, expect, it, vi } from 'vitest';
import { createWorker } from '../src/index';
import { DeterministicEngine } from '../src/engine';
import { databaseConfiguration } from '../src/database/config';
import { PersistentChatService, COOKIE_NAME, digest, newAccessToken, PersistenceError } from '../src/database/service';
import { DatabaseError, SupabaseRepository } from '../src/database/supabase';
import type { ConversationRepository, ConversationSnapshot, BeginTurn, FinishTurn, StoredMessage } from '../src/database/types';
import type { ChatResponse } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const env = { SUPABASE_ENABLED: 'true', SUPABASE_ISOLATED_DEV_CONFIRMED: 'true', SUPABASE_PROJECT_REF: 'figadevtest', SUPABASE_URL: 'https://figadevtest.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_inert_test_fixture', AI_ENABLED: 'false' };
const makeSnapshot = (): ConversationSnapshot => ({ id: crypto.randomUUID(), status: 'open', mode: 'AI', revision: 0, humanAttentionNeeded: false, state: { version: 1, type: 'unknown', collected: {}, awaiting: null, humanAttentionReasons: [] }, messages: [] });
function fixture() {
  const snapshot = makeSnapshot();
  let accessHash = '';
  const cache = new Map<string, { hash: string; response: ChatResponse }>();
  const repository = {
    create: vi.fn<ConversationRepository['create']>().mockImplementation(async hash => { accessHash = hash; return structuredClone(snapshot); }),
    restore: vi.fn<ConversationRepository['restore']>().mockImplementation(async (id, hash) => id === snapshot.id && hash === accessHash ? structuredClone(snapshot) : null),
    begin: vi.fn<ConversationRepository['begin']>().mockImplementation(async input => {
      if (input.conversationId !== snapshot.id || input.tokenHash !== accessHash) return { kind: 'not_found' };
      const cached = cache.get(input.messageId);
      if (cached) return cached.hash === input.requestHash ? { kind: 'duplicate', response: structuredClone(cached.response) } : { kind: 'conflict' };
      return { kind: 'ready', conversation: structuredClone(snapshot), leaseToken: crypto.randomUUID() };
    }),
    finish: vi.fn<ConversationRepository['finish']>().mockImplementation(async input => {
      snapshot.state = structuredClone(input.response.state); snapshot.revision++; snapshot.humanAttentionNeeded = input.response.humanAttentionNeeded;
      const message = (direction: StoredMessage['direction'], content: string): StoredMessage => ({ id: crypto.randomUUID(), clientMessageId: input.messageId, direction, senderType: direction === 'inbound' ? 'customer' : 'assistant', content, createdAt: new Date().toISOString() });
      snapshot.messages.push(message('inbound',input.message));
      if (input.response.assistantResponse) snapshot.messages.push(message('outbound',input.response.assistantResponse));
      const response = { ...structuredClone(input.response), persistence: { conversationId: snapshot.id, messageId: input.messageId, revision: snapshot.revision, saved: true as const } };
      cache.set(input.messageId,{ hash: input.requestHash, response });
      return response;
    }),
  };
  const worker = createWorker(repository);
  const request = (path: string, body?: unknown, cookie?: string, extraHeaders: Record<string,string> = {}) => worker.fetch(new IncomingRequest('http://localhost'+path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),env);
  async function start() { const response = await request('/conversations',{syntheticData:true}); expect(response.status).toBe(201); return { cookie: response.headers.get('Set-Cookie')!.split(';')[0], snapshot: await response.json<ConversationSnapshot>(), response }; }
  return { repository, snapshot, request, start, worker };
}

describe('Persistent HTTP conversations', () => {
  it('combines Gemma extraction with persistence, restore, and a subsequent correction', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const message='I need two caregivers tomorrow night in Salem.';
    const run=vi.fn().mockResolvedValue({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({intent:'provider',intentEvidence:message,ambiguous:false,needsHumanReview:false,faqIndex:-1,updates:[{field:'city',quote:'Salem'},{field:'count',quote:'two'},{field:'date',quote:'tomorrow'},{field:'shift',quote:'night'}]})}}]});
    const response=await f.worker.fetch(new IncomingRequest('http://localhost/chat',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({message,engine:'ai',syntheticData:true,conversationId:snapshot.id,messageId:crypto.randomUUID()})}),{...env,AI_ENABLED:'true',AI_PROVIDER:'workers-ai',AI_ALLOW_SYNTHETIC_REQUESTS:'true',AI_FREE_TIER_CONFIRMED:'true',AI:{run}});
    expect(response.status).toBe(200);
    const result=await response.json<ChatResponse>();
    expect(result.engine?.used).toBe('workers-ai'); expect(result.persistence?.saved).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const restored=await (await f.request('/conversations/'+snapshot.id,undefined,cookie)).json<ConversationSnapshot>();
    expect(restored.state.collected).toMatchObject({count:'2',city:'Salem',date:'tomorrow',shift:'night'});
    expect(restored.messages).toHaveLength(2);
    const corrected=await (await f.request('/chat',{message:'count: 3',syntheticData:true,conversationId:snapshot.id,messageId:crypto.randomUUID()},cookie)).json<ChatResponse>();
    expect(corrected.collectedInformation).toMatchObject({count:'3',city:'Salem'});
  });
  it('issues a random HttpOnly capability cookie without exposing keys or hashes', async () => {
    const f = fixture(); const { response, cookie, snapshot } = await f.start();
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(cookie).toMatch(/^figa_conversation_access=[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain(env.SUPABASE_SECRET_KEY);
    expect(JSON.stringify(snapshot)).not.toContain(cookie.split('=')[1]);
    expect(f.repository.create.mock.calls[0][0]).toBe(await digest(cookie.split('=')[1]));
  });
  it('saves/restores provider context and applies corrections without trusting browser state', async () => {
    const f = fixture(); const { cookie, snapshot } = await f.start();
    const first = await f.request('/chat',{message:'I need two caregivers tomorrow night in Salem.',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},cookie);
    expect(first.status).toBe(200);
    const r = await first.json<ChatResponse>(); expect(r.persistence?.saved).toBe(true);
    const restored = await (await f.request('/conversations/'+snapshot.id,undefined,cookie)).json<ConversationSnapshot>();
    expect(restored.state.collected).toMatchObject({count:'2',city:'Salem',date:'tomorrow'});
    expect(restored.messages).toHaveLength(2);
    const corrected = await (await f.request('/chat',{message:'Make that three caregivers instead.',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true,state:{version:1,type:'caregiver',collected:{city:'Injected'},awaiting:null,humanAttentionReasons:[]}},cookie)).json<ChatResponse>();
    expect(corrected.collectedInformation).toMatchObject({count:'3',city:'Salem'});
    expect(corrected.conversationType).toBe('provider');
  });
  it('persists caregiver intake across turns', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    for(const message of ['I am looking for a CNA job.','My name is Sam Example.','I am in Salem, OR.']) {
      expect((await f.request('/chat',{message,conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},cookie)).status).toBe(200);
    }
    const restored=await (await f.request('/conversations/'+snapshot.id,undefined,cookie)).json<ConversationSnapshot>();
    expect(restored.state.type).toBe('caregiver');
    expect(restored.state.collected).toMatchObject({position:'CNA',name:'Sam Example',city:'Salem',state:'OR'});
  });
  it('does not generate or store a duplicate turn twice', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const body={message:'I need a caregiver tomorrow.',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true};
    const first=await (await f.request('/chat',body,cookie)).json();
    const duplicate=await (await f.request('/chat',body,cookie)).json();
    expect(duplicate).toEqual(first);
    expect(f.repository.finish).toHaveBeenCalledOnce();
    expect(f.snapshot.messages).toHaveLength(2);
    expect((await f.request('/chat',{...body,message:'Changed input'},cookie)).status).toBe(409);
  });
  it('denies ID-only access, wrong cookies, and access to a different conversation', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    expect((await f.request('/conversations/'+snapshot.id)).status).toBe(404);
    expect(f.repository.restore).not.toHaveBeenCalled();
    expect((await f.request('/conversations/'+snapshot.id,undefined,`${COOKIE_NAME}=${'b'.repeat(64)}`)).status).toBe(404);
    expect((await f.request('/conversations/'+crypto.randomUUID(),undefined,cookie)).status).toBe(404);
    expect((await f.request('/chat',{message:'Hello',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true})).status).toBe(404);
  });
  it('rejects cross-origin mutation and fictional-data consent omissions', async () => {
    const f=fixture();
    expect((await f.request('/conversations',{syntheticData:true},undefined,{Origin:'https://attacker.example'})).status).toBe(403);
    expect((await f.request('/conversations',{})).status).toBe(400);
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('rejects sensitive content before saving or calling an engine', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const r=await f.request('/chat',{message:'Resident diagnosis: dementia',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},cookie);
    expect(r.status).toBe(422); expect(f.repository.begin).not.toHaveBeenCalled();
  });
  it('requires stable message IDs and synthetic consent on every persistent message', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    expect((await f.request('/chat',{message:'Hello',conversationId:snapshot.id,syntheticData:true},cookie)).status).toBe(400);
    expect((await f.request('/chat',{message:'Hello',conversationId:snapshot.id,messageId:crypto.randomUUID()},cookie)).status).toBe(400);
    expect(f.repository.begin).not.toHaveBeenCalled();
  });
  it('does not expose staff-management endpoints', async () => {
    const f=fixture(); expect((await f.request('/staff/assign',{conversationId:crypto.randomUUID()})).status).toBe(404);
  });
  it('bounds creation bodies and rejects malformed JSON without issuing access', async () => {
    const f=fixture();
    const response=await f.worker.fetch(new IncomingRequest('http://localhost/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(257)}),env);
    expect(response.status).toBe(413);
    const invalid=await f.worker.fetch(new IncomingRequest('http://localhost/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}),env);
    expect(invalid.status).toBe(400);
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('fails closed on restore/begin/finish outages but keeps separate stateless chat working', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    f.repository.restore.mockRejectedValue(new DatabaseError());
    expect((await f.request('/conversations/'+snapshot.id,undefined,cookie)).status).toBe(503);
    f.repository.begin.mockRejectedValueOnce(new DatabaseError());
    const body={message:'I need a caregiver tomorrow.',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true};
    expect((await f.request('/chat',body,cookie)).status).toBe(503);
    expect(f.repository.finish).not.toHaveBeenCalled();
    f.repository.finish.mockRejectedValueOnce(new DatabaseError());
    const failed=await f.request('/chat',body,cookie);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('What is your name?');
    const stateless=await f.request('/chat',{message:'Hello'});
    expect(stateless.status).toBe(200); expect((await stateless.json<ChatResponse>()).engine?.used).toBe('deterministic');
  });
  it('does not connect when disabled or misconfigured', async () => {
    const f=fixture();
    const r=await f.worker.fetch(new IncomingRequest('http://localhost/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"syntheticData":true}'}),{...env,SUPABASE_ENABLED:'false'});
    expect(r.status).toBe(503); expect(f.repository.create).not.toHaveBeenCalled();
  });
});

describe('Backend ownership and in-flight replies', () => {
  it('returns controlled database results without invoking an engine or finishing a lease', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const state={...snapshot.state,control:'human_takeover' as const};
    const response:ChatResponse={mode:'LOCAL_DEVELOPMENT_DRY_RUN',conversationType:'unknown',assistantResponse:'',state,collectedInformation:{},humanAttentionNeeded:true,humanAttentionReasons:[],complete:false,engine:{requested:'deterministic',used:'none',reason:'conversation_control'}};
    f.repository.begin.mockResolvedValue({kind:'controlled',response});
    const engine={respond:vi.fn()};
    const result=await new PersistentChatService(f.repository,engine).respond({message:'Fictional follow-up',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true,engine:'ai'},cookie.split('=')[1]);
    expect(result).toEqual(response); expect(engine.respond).not.toHaveBeenCalled(); expect(f.repository.finish).not.toHaveBeenCalled();
  });
  it.each(['0','-1','10001','999999999999999999999','1.5','unknown'])('validates engine count %s before calling the repository', async count => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const generated=await new DeterministicEngine().respond({message:'I need two caregivers in Salem.'});
    generated.state.collected.count=count; generated.complete=true;
    const result=await new PersistentChatService(f.repository,{respond:vi.fn().mockResolvedValue(generated)}).respond({message:'Fictional request',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},cookie.split('=')[1]);
    expect(result.state.collected.count).toBeUndefined(); expect(result.state.collected.city).toBe('Salem');
    expect(result.state.awaiting).toBe('count'); expect(result.complete).toBe(false);
    expect(f.repository.finish.mock.calls[0][0].response.assistantResponse).toContain('1 to 10,000');
  });
  it.each(['0','-2','10001','1.5'])('clarifies natural-language count %s without saving it', async count => {
    const result=await new DeterministicEngine().respond({message:`I need ${count} caregivers in Salem.`});
    expect(result.state.collected.count).toBeUndefined(); expect(result.state.awaiting).toBe('count');
    expect(result.assistantResponse).toContain('1 to 10,000');
  });
  it.each(['HUMAN','BLOCKED'] as const)('does not invoke either engine in %s mode', async mode => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    if(mode==='HUMAN') f.snapshot.mode='HUMAN'; else f.snapshot.status='blocked';
    const engine={respond:vi.fn().mockRejectedValue(new Error('Engine must not run'))};
    const service=new PersistentChatService(f.repository,engine);
    const r=await service.respond({message:'I need a caregiver.',conversationId:snapshot.id,messageId:crypto.randomUUID(),engine:'ai',syntheticData:true,state:{...snapshot.state,control:'active'}},cookie.split('=')[1]);
    expect(engine.respond).not.toHaveBeenCalled(); expect(r.assistantResponse).toBe(''); expect(r.engine?.used).toBe('none');
  });
  it('delivers the SQL rechecked result, not a generated reply suppressed during takeover', async () => {
    const f=fixture(); const {cookie,snapshot}=await f.start();
    const engine=new DeterministicEngine();
    f.repository.finish.mockImplementation(async input=>({...input.response,assistantResponse:'',engine:{requested:'ai',used:'none',reason:'conversation_control'},humanAttentionNeeded:true}));
    const r=await new PersistentChatService(f.repository,engine).respond({message:'I need a caregiver.',conversationId:snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},cookie.split('=')[1]);
    expect(r.assistantResponse).toBe(''); expect(r.engine?.used).toBe('none');
  });
  it('does not invoke an engine when a lease is busy or access is denied', async () => {
    for(const kind of ['busy','conflict','not_found'] as const) {
      const f=fixture(); f.repository.begin.mockResolvedValue({kind});
      const engine={respond:vi.fn()};
      await expect(new PersistentChatService(f.repository,engine).respond({message:'Hello',conversationId:f.snapshot.id,messageId:crypto.randomUUID(),syntheticData:true},newAccessToken())).rejects.toBeInstanceOf(PersistenceError);
      expect(engine.respond).not.toHaveBeenCalled();
    }
  });
});

describe('Supabase transport and configuration', () => {
  it('calls fetch without a repository receiver, as required by native Workers fetch', async () => {
    const snapshot=makeSnapshot();
    const transport=vi.fn<typeof fetch>().mockImplementation(function(this:unknown) {
      if(this!==globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json(snapshot));
    });
    expect(await new SupabaseRepository(env,transport).create('a'.repeat(64))).toEqual(snapshot);
  });
  it.each([{}, {...env,SUPABASE_ISOLATED_DEV_CONFIRMED:'false'}, {...env,SUPABASE_SECRET_KEY:'sb_publishable_fixture'}, {...env,SUPABASE_URL:'https://otherproject.supabase.co'}, {...env,SUPABASE_URL:'http://figadevtest.supabase.co'}, {...env,SUPABASE_URL:'https://figadevtest.supabase.co/path'}])('rejects unsafe/unconfirmed configuration %j', async config => {
    const transport=vi.fn<typeof fetch>();
    expect(databaseConfiguration(config).configured).toBe(false);
    await expect(new SupabaseRepository(config,transport).create('a'.repeat(64))).rejects.toBeInstanceOf(DatabaseError);
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses modern apikey header only, fixed RPC routes and bounded request time', async () => {
    const snapshot=makeSnapshot(); const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json(snapshot));
    const result=await new SupabaseRepository(env,transport).create('a'.repeat(64));
    expect(result).toEqual(snapshot);
    const [url,options]=transport.mock.calls[0];
    expect(url).toBe('https://figadevtest.supabase.co/rest/v1/rpc/figa_create_conversation');
    expect(options?.headers).toMatchObject({apikey:env.SUPABASE_SECRET_KEY});
    expect((options?.headers as Record<string,string>).Authorization).toBeUndefined();
    expect(options?.redirect).toBe('manual'); expect(options?.signal).toBeDefined();
  });
  it.each([301,302,307,308,401,429,500])('does not follow redirects, retry, or leak provider errors on HTTP %s', async status => {
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('private database error',{status}));
    await expect(new SupabaseRepository(env,transport).restore(crypto.randomUUID(),'a'.repeat(64))).rejects.toThrow('Database operation unavailable.');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects malformed and oversized database responses', async () => {
    for(const body of ['{','x'.repeat(262145)]) {
      const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(new SupabaseRepository(env,transport).create('a'.repeat(64))).rejects.toBeInstanceOf(DatabaseError);
    }
  });
});
