import type { ChatRequest, ChatResponse, ConversationEngine } from '../types';
import type { ConversationRepository, ConversationSnapshot } from './types';
import { hasSensitiveInput } from '../safety';
import { validateProviderCount } from '../count';

export class PersistenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const COOKIE_NAME = 'figa_conversation_access';
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2,'0')).join('');
}
export function newAccessToken() { return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join(''); }
export function readAccessToken(request: Request): string | undefined {
  const token = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function safeState(snapshot: ConversationSnapshot) {
  const state = structuredClone(snapshot.state);
  // Never trust a stored model field for ownership: authoritative SQL columns win.
  state.control = snapshot.status !== 'open' ? 'blocked' : snapshot.mode === 'HUMAN' ? 'human_takeover' : 'active';
  return state;
}
export class PersistentChatService {
  constructor(private readonly repository: ConversationRepository, private readonly engine: ConversationEngine) {}
  async respond(input: ChatRequest, token: string): Promise<ChatResponse> {
    const production = input.productionData === true && input.syntheticData !== true;
    if (input.syntheticData !== true && !production) throw new PersistenceError(400, 'Persistent testing requires fictional-data confirmation.');
    // Development storage refuses sensitive text. A production SMS has already been received, so
    // it is stored and routed to staff (the engine never sends it to AI) instead of failing forever.
    if (!production && hasSensitiveInput({ message: input.message })) throw new PersistenceError(422, 'Sensitive information is not accepted for storage.');
    if (!input.conversationId || !input.messageId) throw new PersistenceError(400, 'conversationId and messageId are required for persistent messages.');
    const turn = { conversationId: input.conversationId, messageId: input.messageId, message: input.message,
      tokenHash: await digest(token), requestHash: await digest(JSON.stringify([input.message, input.engine ?? 'deterministic'])) };
    const started = await this.repository.begin(turn);
    if (started.kind === 'not_found') throw new PersistenceError(404, 'Conversation not found.');
    if (started.kind === 'busy') throw new PersistenceError(409, 'A turn is already processing. Retry the same message ID shortly.');
    if (started.kind === 'conflict') throw new PersistenceError(409, 'That message ID was already used for a different request.');
    if (started.kind === 'duplicate' || started.kind === 'controlled') return started.response;
    if (started.kind !== 'ready') throw new Error('Invalid database result.');
    const state = safeState(started.conversation);
    let response: ChatResponse;
    if (state.control !== 'active') {
      response = { mode: 'LOCAL_DEVELOPMENT_DRY_RUN', conversationType: state.type, assistantResponse: '',
        state, collectedInformation: state.collected, humanAttentionNeeded: true,
        humanAttentionReasons: [...new Set([...state.humanAttentionReasons, 'Conversation is controlled by staff.'])],
        complete: false, engine: { requested: input.engine ?? 'deterministic', used: 'none', reason: 'conversation_control' }, informationStatus: 'user_reported_unverified' };
    } else {
      // Browser state is deliberately ignored for persistent conversations.
      response = validateProviderCount(await this.engine.respond(production
        ? { message: input.message, state, engine: input.engine, productionData: true }
        : { message: input.message, state, engine: input.engine, syntheticData: true }));
    }
    // SQL rechecks mode, revision, active assignment and lease atomically before saving a reply.
    return this.repository.finish({ ...turn, leaseToken: started.leaseToken, revision: started.conversation.revision, response });
  }
}
