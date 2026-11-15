import { PinnedRingCentralTransport, requireConnectionMode, type ConnectionMode, type HttpsExecutor } from './secure-transport';
import { isOfflineCredentialProvider } from './offline-credentials';
export { createOfflineCredentials } from './offline-credentials';
export { createOfflineHttp } from './secure-transport';
import { SingleMessageReadOnlyTestClient, ReadOnlyTestError, validateSingleMessageApproval, READ_DEADLINE_MS, READ_LIMIT_BYTES, type SingleMessageApproval, type SingleAttemptLedger } from './read-only-test';

interface CredentialBinding {
  host: SingleMessageApproval['host']; accountId: string; extensionId: string;
  // Provider assertion only, never independent evidence of actual app permissions.
  appPermissions: readonly ['ReadMessages'] | readonly ['ReadMessages', 'SMS'];
}
export type InjectedRingCentralCredentials = CredentialBinding & (
  { kind: 'jwt'; clientId: string; clientSecret: string; jwt: string } |
  { kind: 'access_token'; accessToken: string; tokenType: string; scope: string; ownerId: string; expiresAt: string }
);
export type RuntimeCredentialProvider = () => Promise<InjectedRingCentralCredentials>;
export interface ReadGrant { accessToken: string; expiresAt: number; ownerId: string }
interface OAuthReadTarget { host: SingleMessageApproval['host']; extensionId: string; allowAuthenticatedOwnerAlias?: true }
// Shared JWT exchange; each caller still supplies its own pinned, bounded transport.
export interface OAuthTokenTransport { send(request: Request, kind: 'oauth'): Promise<Response> }
const printable = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);
function onlyReadMessages(value: unknown): boolean { return typeof value === 'string' && value.trim() === 'ReadMessages'; }
function validateGrant(token: unknown, tokenType: unknown, scope: unknown, owner: unknown, expiresAt: number, a: OAuthReadTarget, sending = false): ReadGrant {
  if (!(sending ? typeof scope === 'string' && scope.trim().split(/\s+/).sort().join(' ') === 'ReadMessages SMS' : onlyReadMessages(scope))) {
    // Permission NAMES only (e.g. 'ReadAccounts SMS'), so an operator can fix the app's permissions.
    const names = typeof scope === 'string' ? scope.trim().split(/\s+/).filter(n => /^[A-Za-z]{2,40}$/.test(n)).sort().slice(0, 30).join(' ') : '';
    throw Object.assign(new ReadOnlyTestError('scope_rejected'), { grantedScope: names });
  }
  if (typeof owner !== 'string' || !/^[1-9]\d{0,63}$/.test(owner) || (owner !== a.extensionId && !(a.extensionId === '~' && a.allowAuthenticatedOwnerAlias === true))) throw new ReadOnlyTestError('owner_mismatch');
  if (!printable(token, 8192) || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') throw new ReadOnlyTestError('credentials_invalid');
  // Enough lifetime for the whole bounded read; never refresh automatically.
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + READ_DEADLINE_MS) throw new ReadOnlyTestError('token_expired');
  return { accessToken: token, expiresAt, ownerId: owner };
}
export async function exchangeReadOnlyJwt(credentials: Extract<InjectedRingCentralCredentials, { kind: 'jwt' }>, a: OAuthReadTarget, transport: OAuthTokenTransport, budget?: SingleAttemptLedger): Promise<ReadGrant> {
  return exchangeJwt(credentials, a, transport, budget, false);
}
export interface SmsGrant extends ReadGrant { readonly smsScopeVerified: true }
const smsGrants = new WeakSet<SmsGrant>();
export function isVerifiedSmsGrant(value: SmsGrant): boolean { return smsGrants.has(value); }
// A separate exchange policy; the existing ReadMessages-only client remains strict.
export async function exchangeSmsJwt(credentials: Omit<Extract<InjectedRingCentralCredentials, { kind: 'jwt' }>, 'appPermissions'> & { appPermissions: readonly ['ReadMessages', 'SMS'] }, a: OAuthReadTarget, transport: OAuthTokenTransport, budget: SingleAttemptLedger): Promise<SmsGrant> {
  if (JSON.stringify(credentials.appPermissions) !== '["ReadMessages","SMS"]') throw new ReadOnlyTestError('scope_rejected');
  const grant: SmsGrant = Object.freeze({ ...await exchangeJwt(credentials, a, transport, budget, true), smsScopeVerified: true });
  smsGrants.add(grant); return grant;
}
async function exchangeJwt(credentials: Pick<Extract<InjectedRingCentralCredentials, { kind: 'jwt' }>, 'clientId' | 'clientSecret' | 'jwt'>, a: OAuthReadTarget, transport: OAuthTokenTransport, budget: SingleAttemptLedger | undefined, sending: boolean): Promise<ReadGrant> {
  if (!printable(credentials.clientId, 256) || credentials.clientId.includes(':') || !printable(credentials.clientSecret, 512) || !printable(credentials.jwt, 8192) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credentials.jwt)) throw new ReadOnlyTestError('credentials_invalid');
  if (!budget || budget.authorizedMaximum !== 1) throw new ReadOnlyTestError('budget_unavailable');
  try { await budget.reserve(0); } catch { throw new ReadOnlyTestError('budget_unavailable'); }
  const controller = new AbortController(), started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, body: ReadableStream<Uint8Array> | null | undefined, active = true;
  try {
    const operation = (async () => {
      const request = new Request(a.host + '/restapi/oauth/token', { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(credentials.clientId + ':' + credentials.clientSecret) },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: credentials.jwt }).toString() });
      const response = await transport.send(request, 'oauth'); body = response.body;
      if (!active) { void body?.cancel().catch(() => {}); throw new ReadOnlyTestError('timeout'); }
      const failed = response.status !== 200;
      // Error bodies are transient and use the SAME size/deadline bounds as grants.
      // Malformed/HTML/oversized errors preserve HTTP status, never body text.
      const invalid = (category: 'response_format' | 'response_size') => new ReadOnlyTestError(failed ? 'http_status' : category, failed ? response.status : null);
      if (response.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'application/json') throw invalid('response_format');
      const declared = response.headers.get('Content-Length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > READ_LIMIT_BYTES)) throw invalid('response_size');
      reader = body?.getReader(); if (!reader) throw invalid('response_format');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await reader.read(); if (!active) throw new ReadOnlyTestError('timeout');
        if (part.done) break; size += part.value.length;
        if (size > READ_LIMIT_BYTES) throw invalid('response_size'); chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
      catch { throw invalid('response_format'); }
      if (!active) throw new ReadOnlyTestError('timeout');
      if (failed) {
        // Support both OAuth top-level codes and the documented errors envelope.
        // Only the first error code is considered; no descriptions or raw body survive.
        const candidate = value && typeof value === 'object' && !Array.isArray(value)
          ? value.errorCode ?? (Array.isArray(value.errors) ? value.errors[0]?.errorCode : null) : null;
        throw new ReadOnlyTestError('http_status', response.status, candidate);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) <= 0 || Number(value.expires_in) > 86400) throw new ReadOnlyTestError('response_format');
      // Ignore and discard any refresh token. owner_id binds the extension; the
      // account binding is operator-verified and the resource URL is pinned.
      return validateGrant(value.access_token, value.token_type, value.scope, value.owner_id, started + Number(value.expires_in) * 1000, a, sending);
    })();
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      active = false; controller.abort(); void reader?.cancel().catch(() => {}); reject(new ReadOnlyTestError('timeout'));
    }, READ_DEADLINE_MS); });
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof ReadOnlyTestError) throw error;
    throw new ReadOnlyTestError('transport');
  } finally {
    active = false; if (timer !== undefined) clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {}); else void body?.cancel().catch(() => {});
  }
}

export class RingCentralReadOnlySession {
  #options: { mode?: ConnectionMode; approval?: SingleMessageApproval };
  #inject?: RuntimeCredentialProvider;
  #executor?: HttpsExecutor;
  #readBudget?: SingleAttemptLedger;
  #oauthBudget?: SingleAttemptLedger;
  #started = false;
  #attempts = { oauth: 0, message: 0 };
  constructor(options: { mode?: ConnectionMode; approval?: SingleMessageApproval } = {}, inject?: RuntimeCredentialProvider, executor?: HttpsExecutor, readBudget?: SingleAttemptLedger, oauthBudget?: SingleAttemptLedger) {
    this.#options = options; this.#inject = inject; this.#executor = executor; this.#readBudget = readBudget; this.#oauthBudget = oauthBudget;
  }
  get attempts() { return { ...this.#attempts }; }
  async read() {
    // This check precedes both credential injection and any ledger/network access.
    requireConnectionMode(this.#options.mode, this.#executor);
    const a = validateSingleMessageApproval(this.#options.approval);
    if (this.#started || !this.#readBudget || this.#readBudget.authorizedMaximum !== 1) throw new ReadOnlyTestError('budget_unavailable');
    if (this.#options.mode === 'offline' && !isOfflineCredentialProvider(this.#inject)) throw new ReadOnlyTestError('credentials_invalid');
    if (!this.#inject) throw new ReadOnlyTestError('credentials_invalid');
    this.#started = true;
    // Reserve the whole workflow before secrets or OAuth, not only before GET.
    // A restart cannot spend another OAuth request on an already-used read run.
    try { await this.#readBudget.reserve(0); } catch { this.#inject = undefined; throw new ReadOnlyTestError('budget_unavailable'); }
    const transport = new PinnedRingCentralTransport(a, this.#options.mode!, this.#executor!);
    let grant: ReadGrant | undefined;
    try {
      let credentials: InjectedRingCentralCredentials;
      try { credentials = structuredClone(await this.#inject()); } catch { throw new ReadOnlyTestError('credentials_invalid'); }
      if (!credentials || credentials.host !== a.host || credentials.accountId !== a.accountId || credentials.extensionId !== a.extensionId) throw new ReadOnlyTestError('credentials_invalid');
      if (!Array.isArray(credentials.appPermissions) || credentials.appPermissions.length !== 1 || credentials.appPermissions[0] !== 'ReadMessages') throw new ReadOnlyTestError('scope_rejected');
      if (credentials.kind === 'jwt') grant = await exchangeReadOnlyJwt(credentials, a, transport, this.#oauthBudget);
      else if (credentials.kind === 'access_token') grant = validateGrant(credentials.accessToken, credentials.tokenType, credentials.scope, credentials.ownerId, typeof credentials.expiresAt === 'string' ? Date.parse(credentials.expiresAt) : NaN, a);
      else throw new ReadOnlyTestError('credentials_invalid');
      const authenticated = transport.authenticatedMessageExecutor(grant);
      // Reuse the tested Phase 7A GET deadline, bounds, ledger and exact SMS/hash
      // validator. Its placeholder header is replaced only at this boundary.
      let claimed = false;
      const reservedBudget: SingleAttemptLedger = { authorizedMaximum: 1, reserve: async index => {
        if (index !== 0 || claimed) throw new ReadOnlyTestError('budget_unavailable');
        claimed = true;
      } };
      const result = await new SingleMessageReadOnlyTestClient({ mockEnabled: true, approval: a }, authenticated, reservedBudget).read();
      return { ...result, mode: this.#options.mode === 'live' ? 'authorized_read_only' as const : 'offline_simulation' as const,
        scopeEvidence: this.#options.mode === 'offline' ? 'fictional_fixture' as const : credentials.kind === 'jwt' ? 'issuer_response' as const : 'provider_assertion' as const,
        applicationPermissionsIndependentlyVerified: false as const };
    } catch (error) {
      if (error instanceof ReadOnlyTestError) throw error;
      throw new ReadOnlyTestError('transport');
    } finally {
      this.#attempts = transport.attempts;
      grant = undefined; this.#inject = undefined;
    }
  }
}
