import { fields, type ChatRequest, type ConversationState } from './types';
export class InputError extends Error {}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function parseRequest(value: unknown): ChatRequest {
  if (!object(value) || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2000)
    throw new InputError('message must be a nonempty string of at most 2000 characters.');
  if (value.engine !== undefined && value.engine !== 'ai' && value.engine !== 'deterministic') throw new InputError('Invalid engine selection.');
  if (value.syntheticData !== undefined && typeof value.syntheticData !== 'boolean') throw new InputError('syntheticData must be a boolean.');
  if (value.conversationId !== undefined && !isUUID(value.conversationId) || value.messageId !== undefined && !isUUID(value.messageId)) throw new InputError('Invalid conversation or message ID.');
  let state: ConversationState | undefined;
  if (value.state !== undefined) {
    const s = value.state;
    if (!object(s) || s.version !== 1 || !['unknown', 'provider', 'caregiver', 'general'].includes(String(s.type)) ||
        !object(s.collected) || !(s.awaiting === null || fields.includes(s.awaiting as never)) ||
        !Array.isArray(s.humanAttentionReasons) || s.humanAttentionReasons.length > 10 ||
        s.humanAttentionReasons.some(r => typeof r !== 'string' || r.length > 200))
      throw new InputError('Invalid conversation state; reset the conversation.');
    const collected: ConversationState['collected'] = {};
    for (const [key, entry] of Object.entries(s.collected)) {
      if (!fields.includes(key as never) || typeof entry !== 'string' || !entry.trim() || entry.length > 2000)
        throw new InputError('Invalid collected information.');
      collected[key as keyof typeof collected] = entry;
    }
    if (s.control !== undefined && !['active', 'blocked', 'human_takeover'].includes(String(s.control))) throw new InputError('Invalid conversation control.');
    if (s.history !== undefined && (!Array.isArray(s.history) || s.history.length > 6 || s.history.some(m => typeof m !== 'string' || m.length > 1000))) throw new InputError('Invalid bounded conversation history.');
    state = { version: 1, type: s.type as ConversationState['type'], collected, awaiting: s.awaiting as ConversationState['awaiting'], humanAttentionReasons: [...s.humanAttentionReasons],
      ...(s.control !== undefined ? { control: s.control as ConversationState['control'] } : {}),
      ...(s.history !== undefined ? { history: [...s.history as string[]] } : {}) };
  }
  return { message: value.message.trim(), state, engine: value.engine as ChatRequest['engine'], syntheticData: value.syntheticData as boolean | undefined,
    conversationId: value.conversationId as string | undefined, messageId: value.messageId as string | undefined };
}
