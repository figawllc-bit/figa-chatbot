import { isOfflineExecutor, type HttpsExecutor } from './secure-transport';
import { isVerifiedSmsGrant, type SmsGrant } from './oauth-read-session';
import { POLLING_OWNER_ID } from './polling';

// Sending approved by FIGA on 2026-11-15. Env switches, privacy approval, bot mode, opt-outs and staff
// ownership are still checked right before every SMS POST.
export const RINGCENTRAL_SMS_DELIVERY_ENABLED = true;
export interface SmsPayload { from: string; to: string; text: string }
export type SmsResult = { kind: 'accepted'; messageId: string } | { kind: 'suppressed' | 'uncertain' | 'failed'; category: string; httpStatus?: number };
export interface SmsSender { send(payload: SmsPayload, authorize: () => Promise<boolean>): Promise<SmsResult> }
export class RingCentralSmsSender implements SmsSender {
  constructor(private readonly options: { mode: 'offline' | 'live'; grant: () => Promise<SmsGrant>; http: HttpsExecutor; sender: string | readonly string[]; enabled: () => boolean; privacyApproved: () => boolean }) {}
  async send(p: SmsPayload, authorize: () => Promise<boolean>): Promise<SmsResult> {
    const o = this.options;
    // No env switch or injected executor can override the source live gate.
    if (o.mode !== 'offline' && (o.mode !== 'live' || !RINGCENTRAL_SMS_DELIVERY_ENABLED || !o.enabled() || !o.privacyApproved())) return { kind: 'suppressed', category: 'sending_disabled' };
    if (o.mode === 'offline' && (!isOfflineExecutor(o.http) || !/^\+150355501(?:00|01)$/.test(p.from) || !/^\+150355501\d{2}$/.test(p.to))) return { kind: 'suppressed', category: 'fixture_required' };
    if (![o.sender].flat().includes(p.from) || p.from === p.to || !/^\+[1-9]\d{7,14}$/.test(p.from) || !/^\+[1-9]\d{7,14}$/.test(p.to) || !p.text.trim() || p.text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p.text)) return { kind: 'failed', category: 'invalid_payload' };
    let invoked = false;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const grant = await o.grant();
      const owner = o.mode === 'offline' ? '200001' : POLLING_OWNER_ID;
      if (!isVerifiedSmsGrant(grant) || grant.ownerId !== owner || grant.expiresAt <= Date.now() + 5000 || o.mode === 'offline' && grant.accessToken !== 'fictional-issued-access-token') return { kind: 'failed', category: 'grant_rejected' };
      // Re-read authoritative opt-out, ownership, revision and pause immediately
      // before HTTP, including after authentication. No auto-retry, ever.
      if (!await authorize() || !o.enabled() || o.mode === 'live' && !o.privacyApproved()) return { kind: 'suppressed', category: 'delivery_recheck' };
      const operation = (async (): Promise<SmsResult> => {
        invoked = true;
        const url = `https://platform.ringcentral.com/restapi/v1.0/account/~/extension/${owner}/sms`;
        const response = await o.http(new Request(url, {
          method: 'POST', redirect: 'manual', signal: abort.signal,
          headers: { Authorization: 'Bearer ' + grant.accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: { phoneNumber: p.from }, to: [{ phoneNumber: p.to }], text: p.text })
        }));
        if (abort.signal.aborted) { void response.body?.cancel(); return { kind: 'uncertain', category: 'timeout' }; }
        if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url) { void response.body?.cancel(); return { kind: 'uncertain', category: 'redirect_rejected' }; }
        if (![200, 201].includes(response.status)) { void response.body?.cancel(); return { kind: response.status >= 500 ? 'uncertain' : 'failed', category: response.status === 429 ? 'rate_limited' : 'http_status', httpStatus: response.status }; }
        if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') { void response.body?.cancel(); return { kind: 'uncertain', category: 'response_format' }; }
        reader = response.body?.getReader(); if (!reader) return { kind: 'uncertain', category: 'response_format' };
        const chunks: Uint8Array[] = []; let n = 0;
        for (;;) { const part = await reader.read(); if (abort.signal.aborted) throw Error(); if (part.done) break; n += part.value.length; if (n > 16384) throw Error(); chunks.push(part.value); }
        const bytes = new Uint8Array(n); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
        const v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        const id = String(v?.id ?? '');
        if (!/^[1-9]\d{0,63}$/.test(id) || v.type !== 'SMS' || v.direction !== 'Outbound' || !['Queued', 'Sent', 'Delivered'].includes(v.messageStatus)) return { kind: 'uncertain', category: 'response_format' };
        return { kind: 'accepted', messageId: id }; // Accepted by API, not proof of delivery.
      })();
      return await Promise.race([operation, new Promise<SmsResult>(resolve => { timer = setTimeout(() => { abort.abort(); void reader?.cancel(); resolve({ kind: 'uncertain', category: 'timeout' }); }, 5000); })]);
    } catch { return { kind: invoked ? 'uncertain' : 'failed', category: invoked ? 'transport_or_response' : 'authentication_failed' }; }
    finally { if (timer !== undefined) clearTimeout(timer); abort.abort(); void reader?.cancel().catch(() => {}); }
  }
}
