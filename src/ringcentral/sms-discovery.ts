import { exchangeReadOnlyJwt, type RuntimeCredentialProvider, type ReadGrant } from './oauth-read-session';
import { isOfflineCredentialProvider } from './offline-credentials';
import { PinnedRingCentralTransport, requireConnectionMode, RINGCENTRAL_LIVE_CONNECTION_ENABLED, type ConnectionMode, type HttpsExecutor } from './secure-transport';
import { RINGCENTRAL_SMS_DISCOVERY_ENABLED, validateSmsDiscoveryApproval, smsDiscoveryUrl, numericRingCentralId, type SmsDiscoveryApproval } from './discovery-approval';
import { ReadOnlyTestError, READ_DEADLINE_MS, READ_LIMIT_BYTES, type SingleAttemptLedger } from './read-only-test';

export { RINGCENTRAL_SMS_DISCOVERY_ENABLED, validateSmsDiscoveryApproval, smsDiscoveryApprovalIssues, type SmsDiscoveryApproval } from './discovery-approval';
export type SmsDiscoveryResult = { status: 'selected'; messageId: string; direction: 'Inbound' } | { status: 'no_matching_sms'; messageId: null; direction: null };
export function requireLiveSmsDiscovery(): void {
  if (!RINGCENTRAL_SMS_DISCOVERY_ENABLED || !RINGCENTRAL_LIVE_CONNECTION_ENABLED) throw new ReadOnlyTestError('disabled');
}
// No logger, receiver, database, model, SDK, CLI or native fetch dependency.
export class RingCentralSmsDiscoverySession {
  #options: { mode?: ConnectionMode; approval?: SmsDiscoveryApproval };
  #inject?: RuntimeCredentialProvider;
  #executor?: HttpsExecutor;
  #workflow?: SingleAttemptLedger;
  #oauth?: SingleAttemptLedger;
  #started = false;
  #disposed = false;
  #attempts = { oauth: 0, discovery: 0 };
  #authenticationVerified = false;
  constructor(options: { mode?: ConnectionMode; approval?: SmsDiscoveryApproval } = {}, inject?: RuntimeCredentialProvider, executor?: HttpsExecutor, workflow?: SingleAttemptLedger, oauth?: SingleAttemptLedger) {
    this.#options = options; this.#inject = inject; this.#executor = executor; this.#workflow = workflow; this.#oauth = oauth;
  }
  get attempts() { return { ...this.#attempts }; }
  get authenticationVerified() { return this.#authenticationVerified; }
  dispose(): void { this.#disposed = true; this.#inject = undefined; this.#executor = undefined; }
  async discover(): Promise<SmsDiscoveryResult> {
    if (this.#disposed) throw new ReadOnlyTestError('disabled');
    requireConnectionMode(this.#options.mode, this.#executor);
    if (this.#options.mode === 'live') requireLiveSmsDiscovery();
    const a = validateSmsDiscoveryApproval(this.#options.approval!);
    if (this.#started || !this.#workflow || this.#workflow.authorizedMaximum !== 1) throw new ReadOnlyTestError('budget_unavailable');
    if (!this.#inject || (this.#options.mode === 'offline' && !isOfflineCredentialProvider(this.#inject))) throw new ReadOnlyTestError('credentials_invalid');
    this.#started = true;
    try { await this.#workflow.reserve(0); } catch { this.#inject = undefined; throw new ReadOnlyTestError('budget_unavailable'); }
    const transport = new PinnedRingCentralTransport(a, this.#options.mode!, this.#executor!);
    let grant: ReadGrant | undefined;
    try {
      let credentials;
      try { credentials = structuredClone(await this.#inject()); } catch { throw new ReadOnlyTestError('credentials_invalid'); }
      if (!credentials || credentials.kind !== 'jwt' || credentials.host !== a.host ||
        ![credentials.accountId, credentials.extensionId].every(id => id === '~' || numericRingCentralId(id)) ||
        (a.accountId !== '~' && credentials.accountId !== a.accountId) || (a.extensionId !== '~' && credentials.extensionId !== a.extensionId)) throw new ReadOnlyTestError('credentials_invalid');
      if (!Array.isArray(credentials.appPermissions) || credentials.appPermissions.length !== 1 || credentials.appPermissions[0] !== 'ReadMessages') throw new ReadOnlyTestError('scope_rejected');
      // Binding metadata is an operator/provider assertion. The issuer's actual
      // scope and numeric owner_id are checked by the shared JWT exchange.
      grant = await exchangeReadOnlyJwt(credentials, { host: a.host, extensionId: a.extensionId, allowAuthenticatedOwnerAlias: true }, transport, this.#oauth);
      if (this.#disposed) throw new ReadOnlyTestError('disabled');
      if (this.#options.mode === 'live' && !a.expectedOwnerId) throw new ReadOnlyTestError('owner_unverified');
      if (a.expectedOwnerId && a.expectedOwnerId !== grant.ownerId) throw new ReadOnlyTestError('owner_mismatch');
      if (numericRingCentralId(credentials.extensionId) && grant.ownerId !== credentials.extensionId) throw new ReadOnlyTestError('owner_mismatch');
      if (this.#options.mode === 'offline' && grant.accessToken !== 'fictional-issued-access-token') throw new ReadOnlyTestError('credentials_invalid');
      transport.bindDiscoveryOwner(grant.ownerId);
      this.#authenticationVerified = true;
      const accountId = a.accountId === '~' && numericRingCentralId(credentials.accountId) ? credentials.accountId : a.accountId;
      return await this.#list(a, grant, transport, accountId);
    } catch (error) {
      if (error instanceof ReadOnlyTestError) throw error;
      throw new ReadOnlyTestError('transport');
    } finally {
      this.#attempts = { oauth: transport.attempts.oauth, discovery: transport.discoveryAttempts };
      grant = undefined; this.#inject = undefined;
    }
  }
  async #list(a: SmsDiscoveryApproval, grant: ReadGrant, transport: PinnedRingCentralTransport, accountId: string): Promise<SmsDiscoveryResult> {
    const controller = new AbortController();
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, body: ReadableStream<Uint8Array> | null | undefined;
    try {
      const operation = (async (): Promise<SmsDiscoveryResult> => {
        if (grant.expiresAt <= Date.now() + READ_DEADLINE_MS) throw new ReadOnlyTestError('token_expired');
        const url = smsDiscoveryUrl(a);
        const response = await transport.send(new Request(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + grant.accessToken } }), 'discovery');
        body = response.body;
        if (!active) { void body?.cancel().catch(() => {}); throw new ReadOnlyTestError('timeout'); }
        if (response.status !== 200) throw new ReadOnlyTestError('http_status', response.status);
        if (response.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'application/json') throw new ReadOnlyTestError('response_format');
        const declared = response.headers.get('Content-Length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > READ_LIMIT_BYTES)) throw new ReadOnlyTestError('response_size');
        reader = body?.getReader(); if (!reader) throw new ReadOnlyTestError('response_format');
        let size = 0; const chunks: Uint8Array[] = [];
        while (true) {
          const part = await reader.read(); if (!active) throw new ReadOnlyTestError('timeout');
          if (part.done) break;
          size += part.value.length;
          if (size > READ_LIMIT_BYTES) throw new ReadOnlyTestError('response_size');
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
        catch { throw new ReadOnlyTestError('response_format'); }
        if (!active) throw new ReadOnlyTestError('timeout');
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.records) || value.records.length > 1 ||
          (value.paging !== undefined && (!value.paging || typeof value.paging !== 'object' || Array.isArray(value.paging) ||
            (value.paging.page !== undefined && value.paging.page !== 1) || (value.paging.perPage !== undefined && value.paging.perPage !== 1)))) throw new ReadOnlyTestError('response_format');
        // Do not follow navigation, parse customer fields, render content or save
        // any raw record. This method returns a freshly constructed allowlist.
        if (value.records.length === 0) return { status: 'no_matching_sms', messageId: null, direction: null };
        const record = value.records[0];
        if (!record || typeof record !== 'object' || Array.isArray(record) || record.type !== 'SMS' || record.direction !== 'Inbound' ||
          !(numericRingCentralId(record.id) || (typeof record.id === 'number' && Number.isSafeInteger(record.id) && record.id > 0)) ||
          typeof record.creationTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(record.creationTime) || !Number.isFinite(Date.parse(record.creationTime)) ||
          Date.parse(record.creationTime) < Date.parse(a.dateFrom) || Date.parse(record.creationTime) > Date.parse(a.dateTo)) throw new ReadOnlyTestError('message_mismatch');
        if (record.uri !== undefined) {
          if (typeof record.uri !== 'string') throw new ReadOnlyTestError('message_mismatch');
          const match = /^https:\/\/platform\.ringcentral\.com\/restapi\/v1\.0\/account\/([1-9]\d{0,63})\/extension\/([1-9]\d{0,63})\/message-store\/([1-9]\d{0,63})$/.exec(record.uri);
          if (!match || (accountId !== '~' && match[1] !== accountId) || match[2] !== grant.ownerId || match[3] !== String(record.id)) throw new ReadOnlyTestError('message_mismatch');
        }
        return { status: 'selected', messageId: String(record.id), direction: 'Inbound' };
      })();
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        active = false; controller.abort(); void reader?.cancel().catch(() => {}); reject(new ReadOnlyTestError('timeout'));
      }, READ_DEADLINE_MS); });
      return await Promise.race([operation, deadline]);
    } finally {
      active = false; if (timer !== undefined) clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => {}); else void body?.cancel().catch(() => {});
    }
  }
}
