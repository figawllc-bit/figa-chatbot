import { ReadOnlyTestError, validateSingleMessageApproval, type SingleMessageApproval } from './read-only-test';
import { RINGCENTRAL_SMS_DISCOVERY_ENABLED, smsDiscoveryUrl, validateSmsDiscoveryApproval, numericRingCentralId, type SmsDiscoveryApproval } from './discovery-approval';

// Separate authorization + reviewed activation are still required. No env flag,
// public HTTP request or injected credentials can turn this on in Phase 7B.
export const RINGCENTRAL_LIVE_CONNECTION_ENABLED = false;
export type ConnectionMode = 'offline' | 'live';
export type HttpsExecutor = (request: Request) => Promise<Response>;
// Only module-created, data-driven simulators may execute in offline mode.
// Equality with fetch cannot detect closures, bound functions or SDK wrappers.
const offlineExecutors = new WeakSet<HttpsExecutor>();
const liveMessageExecutors = new WeakSet<HttpsExecutor>();
export function isAuthorizedLiveMessageExecutor(value: unknown): value is HttpsExecutor {
  return RINGCENTRAL_LIVE_CONNECTION_ENABLED && typeof value === 'function' && liveMessageExecutors.has(value as HttpsExecutor);
}
export function isOfflineExecutor(value: unknown): value is HttpsExecutor {
  return typeof value === 'function' && offlineExecutors.has(value as HttpsExecutor);
}
export interface OfflineHttpStep {
  body?: string; status?: number; headers?: Record<string, string>;
  delayMs?: number; failure?: boolean; stalledBody?: boolean;
}
export interface OfflineRequestAudit { method: string; path: string; redirect: Request['redirect']; authorizationScheme: string; grantType: string | null; formKeys: string[] }
export function createOfflineHttp(serializedSteps: string): { executor: HttpsExecutor; audit: () => OfflineRequestAudit[] } {
  return offlineHttp(serializedSteps, 2);
}
// Separate fixture simulator for ONE polling cycle: one OAuth + three list pages.
// Existing one-shot clients retain their original two-response simulator cap.
export function createOfflinePollingHttp(serializedSteps: string): { executor: HttpsExecutor; audit: () => OfflineRequestAudit[] } {
  return offlineHttp(serializedSteps, 4);
}
function offlineHttp(serializedSteps: string, maximum: number): { executor: HttpsExecutor; audit: () => OfflineRequestAudit[] } {
  // JSON-only input: no callbacks, getters, response streams or request handlers.
  if (typeof serializedSteps !== 'string') throw new ReadOnlyTestError('disabled');
  let steps: OfflineHttpStep[];
  try { steps = JSON.parse(serializedSteps); } catch { throw new ReadOnlyTestError('disabled'); }
  if (!Array.isArray(steps) || steps.length > maximum || steps.some(s => !s || typeof s !== 'object' || Array.isArray(s) ||
    Object.keys(s).some(k => !['body', 'status', 'headers', 'delayMs', 'failure', 'stalledBody'].includes(k)) ||
    (s.body !== undefined && typeof s.body !== 'string') || (s.status !== undefined && (!Number.isInteger(s.status) || s.status < 200 || s.status > 599)) ||
    (s.delayMs !== undefined && (!Number.isFinite(s.delayMs) || s.delayMs < 0 || s.delayMs > 60000)) ||
    (s.failure !== undefined && typeof s.failure !== 'boolean') || (s.stalledBody !== undefined && typeof s.stalledBody !== 'boolean') ||
    (s.headers !== undefined && (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers) || Object.values(s.headers).some(v => typeof v !== 'string'))))) throw new ReadOnlyTestError('disabled');
  const records: OfflineRequestAudit[] = [];
  let index = 0;
  const executor: HttpsExecutor = async request => {
    const step = steps[index++];
    if (!step) throw new ReadOnlyTestError('budget_unavailable');
    const form = request.method === 'POST' ? new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())) : undefined;
    records.push({ method: request.method, path: new URL(request.url).pathname, redirect: request.redirect,
      authorizationScheme: request.headers.get('Authorization')?.split(' ')[0] ?? '',
      grantType: form?.get('grant_type') ?? null, formKeys: form ? [...form.keys()].sort() : [] });
    if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
    if (step.failure) throw new ReadOnlyTestError('transport');
    const body = step.stalledBody ? new ReadableStream<Uint8Array>() : step.body ?? null;
    return new Response(body, { status: step.status ?? 200, headers: step.headers ?? { 'Content-Type': 'application/json' } });
  };
  Object.freeze(executor);
  offlineExecutors.add(executor);
  return { executor, audit: () => structuredClone(records) };
}
export function requireConnectionMode(mode: ConnectionMode | undefined, executor?: HttpsExecutor): void {
  if (!executor || (mode !== 'offline' && mode !== 'live') || (mode === 'live' && !RINGCENTRAL_LIVE_CONNECTION_ENABLED) || (mode === 'offline' && !isOfflineExecutor(executor))) throw new ReadOnlyTestError('disabled');
}
// Native HTTPS integration boundary, tested only with injected HTTP mocks.
// Never supplies fetch implicitly, follows redirects, refreshes or retries.
export class PinnedRingCentralTransport {
  #approval: SingleMessageApproval | SmsDiscoveryApproval;
  #mode: ConnectionMode;
  #executor: HttpsExecutor;
  #oauth = 0;
  #reads = 0;
  #discoveryOwner?: string;
  #discoveries = 0;
  constructor(approval: SingleMessageApproval | SmsDiscoveryApproval, mode: ConnectionMode, executor: HttpsExecutor) {
    requireConnectionMode(mode, executor);
    if ('operation' in approval) {
      if (mode === 'live' && !RINGCENTRAL_SMS_DISCOVERY_ENABLED) throw new ReadOnlyTestError('disabled');
      this.#approval = validateSmsDiscoveryApproval(approval);
    } else this.#approval = validateSingleMessageApproval(approval);
    this.#mode = mode; this.#executor = executor;
  }
  get attempts() { return { oauth: this.#oauth, message: this.#reads }; }
  get discoveryAttempts() { return this.#discoveries; }
  bindDiscoveryOwner(owner: string): void {
    if ('operation' in this.#approval && this.#mode === 'live' && !this.#approval.expectedOwnerId) throw new ReadOnlyTestError('owner_unverified');
    if ('operation' in this.#approval && this.#approval.expectedOwnerId && this.#approval.expectedOwnerId !== owner) throw new ReadOnlyTestError('owner_mismatch');
    if (!('operation' in this.#approval) || !numericRingCentralId(owner) || this.#discoveryOwner !== undefined ||
      (this.#approval.extensionId !== '~' && this.#approval.extensionId !== owner)) throw new ReadOnlyTestError('owner_mismatch');
    this.#discoveryOwner = owner;
  }
  authenticatedMessageExecutor(grant: { accessToken: string; expiresAt: number }): HttpsExecutor {
    requireConnectionMode(this.#mode, this.#executor);
    const { accessToken, expiresAt } = grant; // Snapshot: later mutation cannot replace the checked token.
    if (this.#mode === 'offline' && !['fictional-runtime-access-token', 'fictional-issued-access-token'].includes(accessToken)) throw new ReadOnlyTestError('credentials_invalid');
    const executor: HttpsExecutor = async request => {
      if (expiresAt <= Date.now() + 5000) throw new ReadOnlyTestError('token_expired');
      const headers = new Headers(request.headers); headers.set('Authorization', 'Bearer ' + accessToken);
      return this.#send(new Request(request, { headers }), 'message');
    };
    Object.freeze(executor);
    if (this.#mode === 'offline') offlineExecutors.add(executor);
    else liveMessageExecutors.add(executor);
    return executor;
  }
  async send(request: Request, kind: 'oauth' | 'message' | 'discovery'): Promise<Response> {
    return this.#send(request, kind);
  }
  async #send(request: Request, kind: 'oauth' | 'message' | 'discovery'): Promise<Response> {
    requireConnectionMode(this.#mode, this.#executor);
    const a = this.#approval;
    if (Date.parse(a.expiresAt) <= Date.now()) throw new ReadOnlyTestError('approval_invalid');
    const discovery = 'operation' in a;
    if (discovery && this.#mode === 'live' && !RINGCENTRAL_SMS_DISCOVERY_ENABLED) throw new ReadOnlyTestError('disabled');
    if (kind === 'discovery' && (!discovery || !this.#discoveryOwner)) throw new ReadOnlyTestError('owner_mismatch');
    if (discovery) validateSmsDiscoveryApproval(a);
    const expected = kind === 'oauth' ? a.host + '/restapi/oauth/token' : discovery ? smsDiscoveryUrl(a) : `${a.host}/restapi/v1.0/account/${a.accountId}/extension/${a.extensionId}/message-store/${a.messageId}`;
    if (!['oauth', discovery ? 'discovery' : 'message'].includes(kind) || request.url !== expected || request.redirect !== 'manual' || request.headers.get('Accept') !== 'application/json' ||
        request.headers.has('X-HTTP-Method-Override') || request.headers.has('X-Method-Override') ||
        request.method !== (kind === 'oauth' ? 'POST' : 'GET') || request.signal.aborted ||
        (kind !== 'oauth' && (request.body !== null || !request.headers.get('Authorization')?.startsWith('Bearer '))) ||
        (kind === 'oauth' && (request.headers.get('Content-Type') !== 'application/x-www-form-urlencoded' || !request.headers.get('Authorization')?.startsWith('Basic ')))) throw new ReadOnlyTestError('approval_invalid');
    if ((kind === 'oauth' ? this.#oauth : this.#reads) >= 1) throw new ReadOnlyTestError('budget_unavailable');
    if (kind === 'oauth') this.#oauth++; else { this.#reads++; if (kind === 'discovery') this.#discoveries++; }
    try {
      const response = await this.#executor(request);
      if ((response.status >= 300 && response.status < 400) || response.redirected || (response.url && response.url !== expected)) {
        void response.body?.cancel().catch(() => {}); throw new ReadOnlyTestError('redirect', response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ReadOnlyTestError) throw error;
      throw new ReadOnlyTestError('transport');
    }
  }
}
