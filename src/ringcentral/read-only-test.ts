// Isolated mock-only client. No fetch default, credential loader, OAuth exchange,
// persistence import, CLI, Worker route, or live transport is supplied.
import { isOfflineExecutor, isAuthorizedLiveMessageExecutor } from './secure-transport';
export { createOfflineHttp } from './secure-transport';
export const READ_LIMIT_BYTES = 16384;
export const READ_DEADLINE_MS = 5000;
export interface SingleMessageApproval {
  host: 'https://platform.ringcentral.com' | 'https://platform.devtest.ringcentral.com';
  accountId: string; extensionId: string; messageId: string;
  permissions: readonly ['ReadMessages'];
  purpose: 'fictional_sms_verification'; expiresAt: string;
  expectedDirection: 'Inbound' | 'Outbound'; expectedSubjectSha256: string;
  expectedFromSha256?: string; expectedToSha256?: string;
}
export interface SingleAttemptLedger { readonly authorizedMaximum: 1; reserve(index: 0): Promise<void> }
export type MockReadTransport = (request: Request) => Promise<Response>;
export type ReadFailure = 'disabled' | 'approval_invalid' | 'budget_unavailable' | 'timeout' | 'transport' | 'redirect' | 'http_status' | 'response_size' | 'response_format' | 'message_mismatch' | 'credentials_invalid' | 'scope_rejected' | 'owner_mismatch' | 'owner_unverified' | 'token_expired';
export class ReadOnlyTestError extends Error {
  readonly oauthErrorCode: string | null;
  constructor(readonly category: ReadFailure, readonly httpStatus: number | null = null, oauthErrorCode: unknown = null) {
    super('Isolated read-only SMS test failed.');
    this.oauthErrorCode = typeof oauthErrorCode === 'string' && /^(?:OAU|CMN)-\d{3}$/.test(oauthErrorCode) ? oauthErrorCode : null;
  }
}
export function validateSingleMessageApproval(value: SingleMessageApproval | undefined): SingleMessageApproval {
  let a: SingleMessageApproval | undefined;
  try { a = value ? structuredClone(value) : undefined; } catch { throw new ReadOnlyTestError('approval_invalid'); }
  const keys = a ? Object.keys(a).filter(k => !['expectedFromSha256', 'expectedToSha256'].includes(k)).sort().join(',') : '';
  if (!a || keys !== 'accountId,expectedDirection,expectedSubjectSha256,expiresAt,extensionId,host,messageId,permissions,purpose' ||
      ((a.expectedFromSha256 !== undefined || a.expectedToSha256 !== undefined) && ![a.expectedFromSha256, a.expectedToSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) ||
      !['https://platform.ringcentral.com', 'https://platform.devtest.ringcentral.com'].includes(a.host) ||
      ![a.accountId, a.extensionId, a.messageId].every(id => typeof id === 'string' && /^[1-9]\d{0,63}$/.test(id)) ||
      a.purpose !== 'fictional_sms_verification' || !Array.isArray(a.permissions) || a.permissions.length !== 1 || a.permissions[0] !== 'ReadMessages' ||
      !['Inbound', 'Outbound'].includes(a.expectedDirection) || typeof a.expectedSubjectSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.expectedSubjectSha256) ||
      typeof a.expiresAt !== 'string' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= Date.now() || Date.parse(a.expiresAt) > Date.now() + 3600000) throw new ReadOnlyTestError('approval_invalid');
  return a;
}
async function subjectHash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export class SingleMessageReadOnlyTestClient {
  private used = false;
  constructor(private readonly options: { mockEnabled?: boolean; approval?: SingleMessageApproval } = {}, private readonly transport?: MockReadTransport, private readonly ledger?: SingleAttemptLedger) {}
  async read(): Promise<{ mode: 'mock_only'; messageId: string; type: 'SMS'; direction: 'Inbound' | 'Outbound'; expectedTextMatched: true; expectedIdentitiesMatched: boolean; bytesRead: number }> {
    // An opt-in enables MOCK execution only. There is no real-API enable flag.
    if (this.options.mockEnabled !== true || (!isOfflineExecutor(this.transport) && !isAuthorizedLiveMessageExecutor(this.transport))) throw new ReadOnlyTestError('disabled');
    const a = validateSingleMessageApproval(this.options.approval);
    if (this.used || !this.ledger || this.ledger.authorizedMaximum !== 1) throw new ReadOnlyTestError('budget_unavailable');
    this.used = true; // Synchronous fence rejects concurrent calls, including failures.
    try { await this.ledger.reserve(0); } catch { throw new ReadOnlyTestError('budget_unavailable'); }
    // Approval may expire while waiting for durable reservation.
    if (Date.parse(a.expiresAt) <= Date.now()) throw new ReadOnlyTestError('approval_invalid');
    const path = `/restapi/v1.0/account/${a.accountId}/extension/${a.extensionId}/message-store/${a.messageId}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    let active = true;
    try {
      const operation = (async () => {
        // Fixed fake credential prevents this mock client from loading/using live
        // tokens. A future authorized live harness requires separate activation.
        const response = await this.transport!(new Request(a.host + path, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: 'Bearer fictional-offline-token' } }));
        body = response.body;
        if (!active) { void response.body?.cancel().catch(() => {}); throw new ReadOnlyTestError('timeout'); }
        if (response.status >= 300 && response.status < 400) throw new ReadOnlyTestError('redirect', response.status);
        if (response.redirected || (response.url && response.url !== a.host + path)) throw new ReadOnlyTestError('redirect');
        if (response.status !== 200) throw new ReadOnlyTestError('http_status', response.status);
        if (response.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'application/json') throw new ReadOnlyTestError('response_format');
        const declared = response.headers.get('Content-Length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > READ_LIMIT_BYTES)) throw new ReadOnlyTestError('response_size');
        reader = response.body?.getReader();
        if (!reader) throw new ReadOnlyTestError('response_format');
        let size = 0; const chunks: Uint8Array[] = [];
        while (true) {
          const part = await reader.read();
          if (!active) throw new ReadOnlyTestError('timeout');
          if (part.done) break;
          size += part.value.length;
          if (size > READ_LIMIT_BYTES) throw new ReadOnlyTestError('response_size');
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let m: Record<string, unknown>;
        try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
        catch { throw new ReadOnlyTestError('response_format'); }
        if (!m || typeof m !== 'object' || Array.isArray(m) || m.type !== 'SMS' || String(m.id) !== a.messageId ||
            (typeof m.id === 'number' && !Number.isSafeInteger(m.id)) || m.direction !== a.expectedDirection || typeof m.subject !== 'string' ||
            (m.uri !== undefined && m.uri !== a.host + path) ||
            (m.attachments !== undefined && (!Array.isArray(m.attachments) || m.attachments.some(item => !item || typeof item !== 'object' || item.type !== 'Text' || item.contentType !== 'text/plain')))) throw new ReadOnlyTestError('message_mismatch');
        if (await subjectHash(m.subject) !== a.expectedSubjectSha256 || !active) throw new ReadOnlyTestError('message_mismatch');
        if (a.expectedFromSha256 !== undefined) {
          const from = (m.from as { phoneNumber?: unknown } | undefined)?.phoneNumber;
          const to = Array.isArray(m.to) && m.to.length === 1 ? m.to[0]?.phoneNumber : undefined;
          if (typeof from !== 'string' || typeof to !== 'string' || !/^\+[1-9]\d{1,14}$/.test(from) || !/^\+[1-9]\d{1,14}$/.test(to) ||
            await subjectHash(from) !== a.expectedFromSha256 || await subjectHash(to) !== a.expectedToSha256 || !active) throw new ReadOnlyTestError('message_mismatch');
        }
        // Return only non-content verification metadata; never raw bodies, phone
        // numbers, subjects, attachment links, headers, recording data or tokens.
        return { mode: 'mock_only' as const, messageId: a.messageId, type: 'SMS' as const, direction: a.expectedDirection, expectedTextMatched: true as const, expectedIdentitiesMatched: a.expectedFromSha256 !== undefined, bytesRead: size };
      })();
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        active = false; controller.abort(); void reader?.cancel().catch(() => {});
        reject(new ReadOnlyTestError('timeout'));
      }, READ_DEADLINE_MS); });
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof ReadOnlyTestError) throw error;
      throw new ReadOnlyTestError('transport');
    } finally {
      active = false; if (timer !== undefined) clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else void body?.cancel().catch(() => {});
    }
  }
}
