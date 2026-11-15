import { databaseConfiguration } from './config';
export type DatabaseConfigurator<E> = (env: E) => { configured: boolean; url?: string; key?: string };
import type { BeginTurn, ConversationRepository, ConversationSnapshot, DatabaseEnvironment, FinishTurn, TurnInput } from './types';
import type { ChatResponse } from '../types';

/** httpStatus is a number only (never a response body), for operator diagnostics. */
export class DatabaseError extends Error { constructor(readonly httpStatus: number | null = null, readonly code: string | null = null) { super('Database operation unavailable.'); } }
export class SupabaseRepository<E extends object = DatabaseEnvironment> implements ConversationRepository {
  constructor(private readonly env: E, private readonly transport: typeof fetch = fetch,
    private readonly configure: DatabaseConfigurator<E> = databaseConfiguration as unknown as DatabaseConfigurator<E>) {}
  protected async rpc<T>(name: string, parameters: unknown): Promise<T> {
    const config = this.configure(this.env);
    if (!config.configured || !config.url || !config.key) throw new DatabaseError();
    try {
      // Workers' native fetch requires the global receiver, not this repository.
      const response = await this.transport.call(globalThis, `${config.url}/rest/v1/rpc/${name}`, {
        // Workers supports manual redirects; reject their non-2xx responses below.
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
        // Modern secret keys are not JWTs; never send them as Bearer tokens.
        headers: { apikey: config.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
      });
      if (!response.ok) {
        // Keep only PostgREST's short error code (e.g. 42501, PGRST202), never the message/body.
        let code: string | null = null;
        try { const v = JSON.parse((await response.text()).slice(0, 4096)); if (typeof v?.code === 'string' && /^[A-Z0-9]{3,10}$/.test(v.code)) code = v.code; } catch { /* no code */ }
        throw new DatabaseError(response.status, code);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DatabaseError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) { await reader.cancel(); throw new DatabaseError(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) { throw error instanceof DatabaseError ? error : new DatabaseError(); } // No provider bodies, credentials, or message logs.
  }
  create(tokenHash: string) { return this.rpc<ConversationSnapshot>('figa_create_conversation', { p_token_hash: tokenHash }); }
  restore(id: string, tokenHash: string) { return this.rpc<ConversationSnapshot | null>('figa_restore_conversation', { p_id: id, p_token_hash: tokenHash }); }
  begin(input: TurnInput) { return this.rpc<BeginTurn>('figa_begin_turn', { p_id: input.conversationId, p_token_hash: input.tokenHash, p_message_id: input.messageId, p_message: input.message, p_request_hash: input.requestHash }); }
  finish(input: FinishTurn) { return this.rpc<ChatResponse>('figa_finish_turn', { p_id: input.conversationId, p_token_hash: input.tokenHash, p_message_id: input.messageId, p_lease_token: input.leaseToken, p_revision: input.revision, p_response: input.response }); }
}
