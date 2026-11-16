// Local prototype: optional synthetic AI/development storage; Telegram remains opt-in.
import { HybridEngine } from './ai/engine';
import { aiConfiguration, type AIEnvironment } from './ai/config';
import { InputError, parseRequest } from './validation';
import { renderUI } from './ui';
import { databaseConfiguration } from './database/config';
import { SupabaseRepository } from './database/supabase';
import { COOKIE_NAME, digest, newAccessToken, readAccessToken, PersistentChatService, PersistenceError, safeState } from './database/service';
import type { ConversationRepository, DatabaseEnvironment } from './database/types';
import { isUUID } from './validation';
import { StaffBot } from './telegram/bot';
import { SupabaseStaffRepository } from './telegram/repository';
import { BotAPITransport } from './telegram/transport';
import { telegramWebhook } from './telegram/ingress';
import type { TelegramEnvironment } from './telegram/types';
import type { OfflineRingCentralReceiver } from './ringcentral/receiver';
import type { RingCentralEnvironment } from './ringcentral/policy';
import { RingCentralEventError } from './ringcentral/events';
import { type RingCentralIncomingPoller } from './ringcentral/polling';
import { scheduledMonitoring, scheduledStaff, type MonitoringEnvironment } from './ringcentral/polling-runtime';
import { productionStaffBot, type ProductionEnvironment } from './production/runtime';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
async function readJSON(request: Request, limit = 32768): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new PersistenceError(415, 'Use application/json.');
  if (!request.body) throw new PersistenceError(400, 'A JSON body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new PersistenceError(413, 'Request body exceeds the allowed size.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function createWorker(repositoryOverride?: ConversationRepository, ringCentralOffline?: OfflineRingCentralReceiver, ringCentralPoller?: Pick<RingCentralIncomingPoller, 'poll'>) { return {
  async scheduled(_controller, env: AIEnvironment & DatabaseEnvironment & TelegramEnvironment & RingCentralEnvironment & MonitoringEnvironment & { TELEGRAM_POLLING_ENABLED?: string }) {
    // Independent passes: a RingCentral failure never blocks staff commands such as /pause, and vice versa.
    const results = await Promise.allSettled([scheduledStaff(env), scheduledMonitoring(env, ringCentralPoller)]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  },
  async fetch(request, env: AIEnvironment & DatabaseEnvironment & TelegramEnvironment & RingCentralEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const config = aiConfiguration(env);
    const dbConfig = databaseConfiguration(env);
    // Production: the public workers.dev address answers ONLY the secret-protected Telegram webhook.
    if ((env as ProductionEnvironment).FIGA_PUBLIC_WEBHOOK_ONLY === 'true' && path !== '/telegram/webhook') return json({ error: 'Not found.' }, 404);
    if (path === '/ringcentral/webhook') return json({ error: 'RingCentral live ingress is disabled.' }, 404);
    if (path === '/ringcentral/offline') {
      if (!local || env.RINGCENTRAL_OFFLINE_ENABLED !== 'true' || !ringCentralOffline) return json({ error: 'Offline receiver disabled.' }, 404);
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Cross-origin writes are not allowed.' }, 403);
      try { return json(await ringCentralOffline.receive(await readJSON(request) as Parameters<OfflineRingCentralReceiver['receive']>[0])); }
      catch (error) { return json({ error: 'Fictional event rejected or offline persistence unavailable.' }, error instanceof PersistenceError ? error.status : error instanceof InputError || error instanceof RingCentralEventError || error instanceof SyntaxError ? 400 : 503); }
    }
    if(path==='/telegram/webhook') return telegramWebhook(request,env,()=> {
      // Production staff bot on the production database when configured; otherwise the development bot.
      const production=productionStaffBot(env as ProductionEnvironment);
      if(production)return production.bot;
      if(!dbConfig.configured || env.TELEGRAM_LIVE_ENABLED!=='true')throw new Error('Staff integration disabled.');
      return new StaffBot(new SupabaseStaffRepository(env),new BotAPITransport(env));
    });
    const database = { enabled: local && dbConfig.enabled, configured: local && dbConfig.configured, syntheticDataOnly: true };
    const repository = () => {
      if (!local || !dbConfig.configured) throw new PersistenceError(503, 'Persistence is disabled or not configured for an isolated development project.');
      return repositoryOverride ?? new SupabaseRepository(env);
    };
    const ai = { available: local && config.available, provider: config.available ? config.provider : null, model: config.model, syntheticDataOnly: true, freeTierConfirmed: config.freeTierConfirmed, syntheticTestLimit: config.syntheticTestLimit };
    if (path === '/' && request.method === 'GET') {
      if (request.headers.get('Accept')?.includes('text/html')) {
        if(!local)return json({error:'Local interface only.'},404);
        return new Response(renderUI(), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
      }
      return json({ application: 'FIGA Hybrid AI Assistant', status: 'ok', mode: 'LOCAL_DEVELOPMENT_DRY_RUN', interface: '/', chat: '/chat', externalServicesConnected: ai.available, messagingConnected: false, databaseConnected: false, ai, database });
    }
    if (path === '/health' && request.method === 'GET') return json({ status: 'ok', mode: 'LOCAL_DEVELOPMENT_DRY_RUN', engine: 'deterministic', externalServicesConnected: ai.available, messagingConnected: false, databaseConnected: false, ai, database });
    if (request.method === 'POST' && request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Cross-origin writes are not allowed.' }, 403);
    if (path === '/conversations' && request.method === 'POST') {
      try {
        const repo = repository();
        // This endpoint accepts only a tiny explicit consent body, never contact details.
        const body = await readJSON(request,256) as { syntheticData?: boolean };
        if (!body || body.syntheticData !== true) return json({ error: 'Fictional-data confirmation is required.' }, 400);
        const token = newAccessToken();
        const snapshot = await repo.create(await digest(token));
        return Response.json({ ...snapshot, state: safeState(snapshot) }, { status: 201, headers: { ...headers,
          'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${url.protocol === 'https:' ? '; Secure' : ''}` } });
      } catch (error) {
        if (error instanceof PersistenceError) return json({ error: error.message }, error.status);
        return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : 'Persistence unavailable. No conversation access was issued.' }, error instanceof SyntaxError ? 400 : 503);
      }
    }
    const conversationMatch = path.match(/^\/conversations\/([^/]+)$/);
    if (conversationMatch && request.method === 'GET') {
      const token = readAccessToken(request);
      if (!token || !isUUID(conversationMatch[1])) return json({ error: 'Conversation not found.' }, 404);
      try {
        const snapshot = await repository().restore(conversationMatch[1], await digest(token));
        return snapshot ? json({ ...snapshot, state: safeState(snapshot) }) : json({ error: 'Conversation not found.' }, 404);
      } catch { return json({ error: 'Persistence unavailable. Retry later; the saved conversation remains authoritative.' }, 503); }
    }
    if (path === '/chat' && request.method === 'POST') {
      try {
        const input = parseRequest(await readJSON(request));
        // Host gating is defense in depth for this local prototype, not production authentication.
        const engine = new HybridEngine(local ? env : { CONVERSATION_CONTROL: env.CONVERSATION_CONTROL, AI_GLOBAL_PAUSED: env.AI_GLOBAL_PAUSED }, undefined,
          diagnostic => console.warn('figa_ai_failure', diagnostic),
          timing => console.info('figa_ai_timing', timing));
        if (input.conversationId) {
          const token = readAccessToken(request);
          if (!token) return json({ error: 'Conversation not found.' }, 404);
          return json(await new PersistentChatService(repository(), engine).respond(input, token));
        }
        return json(await engine.respond(input));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof InputError) return json({ error: error instanceof InputError ? error.message : 'Invalid JSON.' }, 400);
        if (error instanceof PersistenceError) return json({ error: error.message }, error.status);
        if (dbConfig.enabled) return json({ error: 'Persistence unavailable. Retry with the same message ID. No new automated reply was delivered.' }, 503);
        return json({ error: 'Unable to process this message.' }, 500);
      }
    }
    if (['/', '/health', '/chat','/conversations'].includes(path) || conversationMatch) return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: path === '/chat' || path === '/conversations' ? 'POST' : 'GET' } });
    return json({ error: 'Not found.' }, 404);
  },
} satisfies ExportedHandler<Env>; }
export default createWorker();
