import { exchangeReadOnlyJwt, type ReadGrant, type RuntimeCredentialProvider } from './oauth-read-session';
import { isOfflineCredentialProvider } from './offline-credentials';
import { isOfflineExecutor, type HttpsExecutor } from './secure-transport';
import { ReadOnlyTestError, READ_DEADLINE_MS } from './read-only-test';
import { numericRingCentralId } from './discovery-approval';
import type { OfflineRingCentralReceiver } from './receiver';
import { assertFixtureScope, assertFixtureMessages } from './fixture-policy';
import { adaptRingCentral, type RingCentralScope } from './events';

export const RINGCENTRAL_POLLING_LIVE_ENABLED = false;
export const POLLING_OWNER_ID = '3322425015';
const HOST = 'https://platform.ringcentral.com';
const PAGE_SIZE = 20, MAX_PAGES = 3, OVERLAP_MS = 120000, SETTLE_MS = 10000, MAX_WINDOW_MS = 604800000;
const RESPONSE_LIMIT = 65536, MAX_SEEN = 4096;
export interface PollControls { enabled: boolean; paused: boolean; intervalSeconds?: number }
// A NEW recurring approval, never a discovery authorization or one-shot ledger.
export interface PollingApproval { operation: 'receive_only_polling'; ownerId: typeof POLLING_OWNER_ID; host: typeof HOST; permissions: readonly ['ReadMessages']; expiresAt: string; productionMetadataStoreApproved: true }
export interface PollState {
  version: 1; baselineAt: string; completedThrough: string; lastAttemptAt: string;
  lastSuccessfulCheck: string | null; notBefore: string | null; authBlocked: boolean; seen: { hash: string; createdAt: string }[];
}
// Implementations MUST serialize the entire callback across instances/restarts.
// save() is durable before resolving. No customer records or credentials enter it.
export interface PollingStateStore {
  exclusive<T>(key: string, work: (state: PollState | null, save: (next: PollState) => Promise<void>) => Promise<T>): Promise<T>;
}
export interface PollReport {
  status: 'disabled' | 'paused' | 'not_due' | 'baseline' | 'ok' | 'backlog' | 'error';
  newMessages: number; duplicates: number; excluded: number; errors: number;
  lastSuccessfulCheck: string | null; errorCategory?: string; httpStatus?: number; oauthErrorCode?: string;
}
type Options = {
  mode: 'offline' | 'live'; store: PollingStateStore; credentials: RuntimeCredentialProvider; http: HttpsExecutor;
  controls: () => PollControls; approval?: PollingApproval;
  fixture?: { scope: RingCentralScope; receiver?: OfflineRingCentralReceiver; processor?: { process(message: import('./events').SmsObservation): Promise<void>; drain?(): Promise<void> } };
};
const iso = (n: number) => new Date(n).toISOString();
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && iso(Date.parse(v)) === v;
function fail(category: string): never { throw new PollFailure(category); }
class PollFailure extends Error { constructor(readonly category: string) { super('Receive-only polling stopped.'); } }
async function hashId(owner: string, id: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`figa-rc-poll:${owner}:${id}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function validatePollState(s: PollState): void {
  if (!s || Object.keys(s).sort().join(',') !== 'authBlocked,baselineAt,completedThrough,lastAttemptAt,lastSuccessfulCheck,notBefore,seen,version' || s.version !== 1 ||
    !timestamp(s.baselineAt) || !timestamp(s.completedThrough) || !timestamp(s.lastAttemptAt) ||
    (s.lastSuccessfulCheck !== null && (!timestamp(s.lastSuccessfulCheck) || Date.parse(s.lastSuccessfulCheck) > Date.parse(s.lastAttemptAt))) || (s.notBefore !== null && !timestamp(s.notBefore)) || typeof s.authBlocked !== 'boolean' || Date.parse(s.completedThrough) < Date.parse(s.baselineAt) || Date.parse(s.completedThrough) > Date.parse(s.lastAttemptAt) ||
    !Array.isArray(s.seen) || s.seen.length > MAX_SEEN ||
    s.seen.some(x => !x || Object.keys(x).sort().join(',') !== 'createdAt,hash' || typeof x.hash !== 'string' || !/^[a-f0-9]{64}$/.test(x.hash) || !timestamp(x.createdAt) || Date.parse(x.createdAt) > Date.parse(s.lastAttemptAt)) ||
    new Set(s.seen.map(x => x.hash)).size !== s.seen.length) fail('checkpoint_invalid');
}

export class RingCentralIncomingPoller {
  #grant?: ReadGrant;
  constructor(private readonly o: Options) {}
  #guard(): void {
    if (this.o.mode !== 'offline' && this.o.mode !== 'live') fail('disabled');
    const controls = this.o.controls();
    if (!controls.enabled) fail('disabled');
    if (controls.paused) fail('paused');
    if (this.o.mode === 'live') {
      if (!RINGCENTRAL_POLLING_LIVE_ENABLED) fail('disabled');
      const a = this.o.approval;
      if (!a || a.operation !== 'receive_only_polling' || a.host !== HOST || a.ownerId !== POLLING_OWNER_ID ||
        a.productionMetadataStoreApproved !== true || JSON.stringify(a.permissions) !== '["ReadMessages"]' || !timestamp(a.expiresAt) || Date.parse(a.expiresAt) <= Date.now()) fail('approval_invalid');
      if (this.o.fixture) fail('disabled');
    } else {
      if (!this.o.fixture || !isOfflineExecutor(this.o.http) || !isOfflineCredentialProvider(this.o.credentials)) fail('disabled');
      assertFixtureScope(this.o.fixture.scope);
      if (this.o.fixture.scope.extensionId !== '200001') fail('owner_mismatch');
    }
  }
  #owner(): string { return this.o.mode === 'offline' ? '200001' : POLLING_OWNER_ID; }
  async #authenticate(send: (r: Request, kind: 'oauth') => Promise<Response>): Promise<ReadGrant> {
    this.#guard();
    if (this.#grant && this.#grant.expiresAt > Date.now() + READ_DEADLINE_MS) return this.#grant;
    this.#grant = undefined;
    const c = await this.o.credentials();
    this.#guard();
    if (c.kind !== 'jwt' || c.host !== HOST || c.extensionId !== this.#owner() ||
      (this.o.mode === 'offline' ? c.accountId !== '100001' : c.accountId !== '~') || JSON.stringify(c.appPermissions) !== '["ReadMessages"]') fail('credentials_invalid');
    let reserved = false;
    const grant = await exchangeReadOnlyJwt(c, { host: HOST, extensionId: this.#owner() }, { send }, { authorizedMaximum: 1, async reserve() { if (reserved) fail('budget_unavailable'); reserved = true; } });
    if (this.o.mode === 'offline' && grant.accessToken !== 'fictional-issued-access-token') fail('credentials_invalid');
    this.#guard(); this.#grant = grant; return grant;
  }
  async #page(url: string, grant: ReadGrant, send: (r: Request, kind: 'list') => Promise<Response>): Promise<Record<string, unknown>> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, body: ReadableStream<Uint8Array> | null | undefined;
    try {
      const operation = (async () => {
        this.#guard();
        if (grant.expiresAt <= Date.now() + READ_DEADLINE_MS) fail('token_expired');
        const response = await send(new Request(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', Authorization: 'Bearer ' + grant.accessToken } }), 'list');
        body = response.body;
        if (!active) { void response.body?.cancel().catch(() => {}); fail('timeout'); }
        if (response.status === 401) this.#grant = undefined; // Next scheduled cycle may authenticate; never retry this cycle.
        if (response.status !== 200) throw new ReadOnlyTestError('http_status', response.status);
        if (response.headers.get('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'application/json') fail('response_format');
        const length = response.headers.get('Content-Length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) fail('response_size');
        reader = response.body?.getReader(); if (!reader) fail('response_format');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const part = await reader.read(); if (!active) fail('timeout');
          if (part.done) break; size += part.value.length; if (size > RESPONSE_LIMIT) fail('response_size'); chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { fail('response_format'); }
        if (!active || !value || typeof value !== 'object' || Array.isArray(value)) fail('response_format');
        return value as Record<string, unknown>;
      })();
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => { active = false; controller.abort(); void reader?.cancel().catch(() => {}); reject(new PollFailure('timeout')); }, READ_DEADLINE_MS); })]);
    } finally { active = false; if (timer !== undefined) clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); else void body?.cancel().catch(() => {}); }
  }
  async poll(): Promise<PollReport> {
    const report: PollReport = { status: 'error', newMessages: 0, duplicates: 0, excluded: 0, errors: 0, lastSuccessfulCheck: null };
    try {
      this.#guard();
      const interval = this.o.controls().intervalSeconds ?? 120;
      if (!Number.isInteger(interval) || interval < 120 || interval > 3600) fail('interval_invalid');
      return await this.o.store.exclusive('ringcentral-incoming:' + this.#owner(), async (loaded, save) => {
        this.#guard(); const now = Date.now();
        if (!loaded) {
          const initial: PollState = { version: 1, baselineAt: iso(now), completedThrough: iso(now), lastAttemptAt: iso(now), lastSuccessfulCheck: null, notBefore: null, authBlocked: false, seen: [] };
          await save(initial); report.status = 'baseline'; return report; // Never enumerate old messages on first start.
        }
        validatePollState(loaded); const state = structuredClone(loaded); report.lastSuccessfulCheck = state.lastSuccessfulCheck;
        if (state.authBlocked) fail('authentication_review_required');
        if (now < Date.parse(state.lastAttemptAt)) fail('clock_regression');
        if (now - Date.parse(state.lastAttemptAt) < interval * 1000 || state.notBefore !== null && now < Date.parse(state.notBefore)) { report.status = 'not_due'; return report; }
        state.lastAttemptAt = iso(now); await save(state); // Recovery retains the same uncompleted window after errors.
        const from = Math.max(Date.parse(state.baselineAt), Date.parse(state.completedThrough) - OVERLAP_MS), to = now - SETTLE_MS;
        if (to < from) fail('clock_regression');
        if (to - from > MAX_WINDOW_MS) fail('backfill_approval_required');
        let posts = 0, gets = 0, backoff: string | null = null, blockAuth = false;
        const allowedLists = new Set<string>();
        const send = async (request: Request, kind: 'oauth' | 'list') => {
          this.#guard();
          const oauth = kind === 'oauth';
          if (request.redirect !== 'manual' || request.signal.aborted || request.headers.get('Accept') !== 'application/json' ||
            request.headers.has('X-HTTP-Method-Override') || request.headers.has('X-Method-Override') ||
            (oauth ? request.method !== 'POST' || request.url !== HOST + '/restapi/oauth/token' || posts >= 1 || request.headers.get('Content-Type') !== 'application/x-www-form-urlencoded' || !request.headers.get('Authorization')?.startsWith('Basic ')
              : request.method !== 'GET' || request.body !== null || !allowedLists.delete(request.url) || gets >= MAX_PAGES || !request.headers.get('Authorization')?.startsWith('Bearer '))) fail('request_rejected');
          if (oauth) posts++; else gets++;
          let response: Response; try { response = await this.o.http(request); } catch { fail('transport'); }
          // A mock/network executor may ignore AbortSignal. A late response is
          // never permitted to change persistent backoff, ownership or checkpoints.
          if (request.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('timeout'); }
          if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== request.url) { void response.body?.cancel().catch(() => {}); fail('redirect'); }
          if (response.status === 429) {
            const retry = response.headers.get('Retry-After');
            const until = retry && /^\d{1,8}$/.test(retry) ? Date.now() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
            backoff = iso(Math.max(Date.now() + interval * 1000, Number.isFinite(until) ? until : Date.now() + 900000));
          }
          if (oauth && [401, 403].includes(response.status)) blockAuth = true;
          return response;
        };
        let grant: ReadGrant;
        try { grant = await this.#authenticate(send); }
        catch (error) {
          if ((error instanceof ReadOnlyTestError || error instanceof PollFailure) && ['scope_rejected', 'owner_mismatch', 'credentials_invalid'].includes(error.category)) blockAuth = true;
          // Persist only AFTER the bounded request has settled, while the store
          // lock is still held. No storage work runs inside an HTTP timeout race.
          if (blockAuth || backoff) { state.authBlocked = blockAuth; state.notBefore = backoff; await save(state); }
          throw error;
        }
        if (this.o.mode === 'offline') await this.o.fixture?.processor?.drain?.();
        const seen = new Set(state.seen.map(x => x.hash));
        for (let page = 1; page <= MAX_PAGES; page++) {
          const query = new URLSearchParams({ messageType: 'SMS', direction: 'Inbound', perPage: String(PAGE_SIZE), page: String(page), dateFrom: iso(from), dateTo: iso(to) });
          const account = this.o.mode === 'offline' ? '100001' : '~';
          const url = `${HOST}/restapi/v1.0/account/${account}/extension/${this.#owner()}/message-store?${query}`;
          allowedLists.add(url);
          let result: Record<string, unknown>;
          try { result = await this.#page(url, grant, send); }
          catch (error) { if (backoff) { state.notBefore = backoff; await save(state); } throw error; }
          if (!Array.isArray(result.records) || result.records.length > PAGE_SIZE) fail('response_format');
          const paging = result.paging as { page?: unknown; perPage?: unknown; totalPages?: unknown } | undefined;
          if (paging !== undefined && (!paging || typeof paging !== 'object' || Array.isArray(paging) || paging.page !== page || paging.perPage !== PAGE_SIZE ||
            paging.totalPages !== undefined && (!Number.isSafeInteger(paging.totalPages) || Number(paging.totalPages) < page && !(paging.totalPages === 0 && page === 1 && result.records.length === 0)))) fail('response_format');
          for (const raw of result.records) {
            this.#guard();
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('response_format');
            const r = raw as Record<string, unknown>;
            if (r.type !== 'SMS' || r.direction !== 'Inbound' || (r.attachments !== undefined && (!Array.isArray(r.attachments) || r.attachments.length > 0))) { report.excluded++; continue; }
            const id = typeof r.id === 'number' && Number.isSafeInteger(r.id) ? String(r.id) : r.id;
            if (!numericRingCentralId(id) || typeof r.creationTime !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(r.creationTime) || !Number.isFinite(Date.parse(r.creationTime))) fail('record_invalid');
            const created = Date.parse(r.creationTime);
            if (created <= Date.parse(state.baselineAt)) { report.excluded++; continue; }
            if (created < from || created > to) fail('record_outside_window');
            if (r.uri !== undefined) {
              const match = typeof r.uri === 'string' && /^https:\/\/platform\.ringcentral\.com\/restapi\/v1\.0\/account\/([1-9]\d{0,63})\/extension\/([1-9]\d{0,63})\/message-store\/([1-9]\d{0,63})$/.exec(r.uri);
              if (!match || match[2] !== this.#owner() || match[3] !== id || account !== '~' && match[1] !== account) fail('owner_mismatch');
            }
            if (r.ownerId !== undefined && String(r.ownerId) !== this.#owner()) fail('owner_mismatch');
            const scope = this.o.fixture?.scope;
            const fixtureEvent = scope ? { uuid: 'poll-' + id, subscriptionId: scope.subscriptionId, ownerId: scope.extensionId, timestamp: iso(now), event: `/restapi/v1.0/account/${scope.accountId}/extension/${scope.extensionId}/message-store/instant?type=SMS&direction=Inbound`, body: raw } : undefined;
            if (this.o.mode === 'offline') {
              const adapted = adaptRingCentral(fixtureEvent, scope!);
              if (adapted.kind !== 'messages') fail('record_invalid');
              assertFixtureMessages(adapted.messages);
            }
            const hash = await hashId(this.#owner(), id);
            if (seen.has(hash)) { report.duplicates++; continue; }
            if (state.seen.length >= MAX_SEEN) fail('dedup_capacity');
            // The live branch has NO content sink. Only authored fixtures can
            // enter the existing intake repository, which independently validates them.
            let intakeDuplicate = false;
            if (this.o.mode === 'offline' && this.o.fixture?.receiver) {
              const received = await this.o.fixture.receiver.receive({ syntheticData: true, event: fixtureEvent });
              if (received.kind === 'conflict') fail('intake_conflict');
              if (received.kind !== 'observed' && received.kind !== 'duplicate') fail('intake_incomplete');
              intakeDuplicate = received.kind === 'duplicate';
            }
            if (this.o.mode === 'offline' && this.o.fixture?.processor) {
              const adapted = adaptRingCentral(fixtureEvent, scope!);
              if (adapted.kind !== 'messages') fail('record_invalid');
              await this.o.fixture.processor.process(adapted.messages[0]);
            }
            this.#guard(); state.seen.push({ hash, createdAt: iso(created) }); seen.add(hash); await save(state);
            if (intakeDuplicate) report.duplicates++; else report.newMessages++;
          }
          const more = typeof paging?.totalPages === 'number' ? paging.totalPages > page : result.records.length === PAGE_SIZE;
          if (more) { if (page === MAX_PAGES) { report.status = 'backlog'; return report; } continue; }
          this.#guard(); state.completedThrough = iso(to); state.lastSuccessfulCheck = iso(now); state.notBefore = null;
          // Prune only IDs older than the NEXT overlapping scan; never on failed/incomplete scans.
          state.seen = state.seen.filter(x => Date.parse(x.createdAt) >= to - OVERLAP_MS);
          await save(state); report.status = 'ok'; report.lastSuccessfulCheck = state.lastSuccessfulCheck; return report;
        }
        fail('pagination_invalid');
      });
    } catch (error) {
      const category = error instanceof PollFailure || error instanceof ReadOnlyTestError ? error.category : 'polling_failed';
      report.status = category === 'disabled' || category === 'paused' ? category : 'error'; report.errors = report.status === 'error' ? 1 : 0;
      report.errorCategory = category;
      if (error instanceof ReadOnlyTestError) {
        if (error.httpStatus !== null) report.httpStatus = error.httpStatus;
        if (error.oauthErrorCode) report.oauthErrorCode = error.oauthErrorCode;
      }
      return report;
    }
  }
}

export interface PollingEnvironment { RINGCENTRAL_POLLING_ENABLED?: string; RINGCENTRAL_POLLING_PAUSED?: string; RINGCENTRAL_POLL_INTERVAL_SECONDS?: string; AI_GLOBAL_PAUSED?: string }
export function pollingControls(env: PollingEnvironment): PollControls {
  return { enabled: env.RINGCENTRAL_POLLING_ENABLED === 'true', paused: env.RINGCENTRAL_POLLING_PAUSED === 'true' || env.AI_GLOBAL_PAUSED === 'true', intervalSeconds: env.RINGCENTRAL_POLL_INTERVAL_SECONDS === undefined ? 120 : Number(env.RINGCENTRAL_POLL_INTERVAL_SECONDS) };
}
export async function scheduledPolling(env: PollingEnvironment, poller?: Pick<RingCentralIncomingPoller, 'poll'>): Promise<void> {
  // No default client, credentials, storage, logger or native fetch is constructed.
  if (!RINGCENTRAL_POLLING_LIVE_ENABLED || !pollingControls(env).enabled || pollingControls(env).paused || !poller) return;
  await poller.poll();
}
