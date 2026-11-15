export interface RingCentralScope { accountId: string; extensionId: string; subscriptionId: string; businessNumbers: string[] }
export interface SmsObservation {
  id: string; accountId: string; extensionId: string; businessNumber: string; customerNumber: string;
  direction: 'Inbound' | 'Outbound'; text: string; messageStatus: string; modifiedAt: string; optOut: boolean;
}
export type AdaptedEvent = { kind: 'messages'; eventId: string; messages: SmsObservation[] }
  | { kind: 'needs_message_store'; eventId: string };
export class RingCentralEventError extends Error { constructor() { super('Invalid or unsupported RingCentral fixture.'); } }
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RingCentralEventError();
  return v as Record<string, unknown>;
};
const text = (v: unknown, maximum: number): string => {
  if (typeof v !== 'string' || !v.length || v.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new RingCentralEventError();
  return v;
};
const id = (v: unknown) => {
  const value = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : text(v, 64);
  if (!/^\d{1,64}$/.test(value)) throw new RingCentralEventError();
  return value;
};
const date = (v: unknown) => {
  const value = text(v, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new RingCentralEventError();
  return new Date(value).toISOString();
};
const phone = (v: unknown) => {
  const value = text(v, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new RingCentralEventError();
  return value;
};
export function isOptOut(message: string) {
  // Conservative local suppression; START never restores consent automatically.
  return /^(?:please\s+)?(?:stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)(?:\s+please)?[.!]?$/i.test(message.trim());
}
function record(value: unknown, scope: RingCentralScope): SmsObservation {
  const m = object(value);
  if (m.type !== 'SMS' || !['Inbound', 'Outbound'].includes(String(m.direction)) || !Array.isArray(m.to) || m.to.length !== 1) throw new RingCentralEventError();
  const from = phone(object(m.from).phoneNumber), to = phone(object(m.to[0]).phoneNumber);
  const inbound = m.direction === 'Inbound';
  const businessNumber = inbound ? to : from, customerNumber = inbound ? from : to;
  if (!scope.businessNumbers.includes(businessNumber) || scope.businessNumbers.includes(customerNumber)) throw new RingCentralEventError();
  if (m.uri !== undefined) {
    let uri: URL;
    try { uri = new URL(text(m.uri, 512)); } catch { throw new RingCentralEventError(); }
    const expected = `/restapi/v1.0/account/${scope.accountId}/extension/${scope.extensionId}/message-store/${id(m.id)}`;
    if (!['platform.ringcentral.com', 'platform.devtest.ringcentral.com'].includes(uri.hostname) || uri.protocol !== 'https:' || uri.pathname !== expected || uri.username || uri.password || uri.search || uri.hash) throw new RingCentralEventError();
  }
  const content = typeof m.subject === 'string' && m.subject.length <= 2000 ? m.subject : undefined;
  if (content === undefined || !content.trim()) throw new RingCentralEventError(); // Attachments are never downloaded.
  text(content, 2000);
  const status = text(m.messageStatus, 32);
  if (!(inbound ? ['Received'] : ['Queued', 'Sent', 'Delivered', 'SendingFailed', 'DeliveryFailed']).includes(status)) throw new RingCentralEventError();
  return { id: id(m.id), accountId: scope.accountId, extensionId: scope.extensionId, businessNumber, customerNumber,
    direction: inbound ? 'Inbound' : 'Outbound', text: content, messageStatus: status, modifiedAt: date(m.lastModifiedTime ?? m.creationTime), optOut: inbound && isOptOut(content) };
}
export function adaptRingCentral(value: unknown, scope: RingCentralScope, messageStoreRecords?: unknown[]): AdaptedEvent {
  if (messageStoreRecords !== undefined && !Array.isArray(messageStoreRecords)) throw new RingCentralEventError();
  id(scope.accountId); id(scope.extensionId);
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(text(scope.subscriptionId, 64))) throw new RingCentralEventError();
  if (!scope.businessNumbers.length || scope.businessNumbers.length > 20) throw new RingCentralEventError();
  scope.businessNumbers.forEach(phone);
  const envelope = object(value);
  const eventId = text(envelope.uuid, 64);
  if (!/^[a-zA-Z0-9-]+$/.test(eventId) || envelope.subscriptionId !== scope.subscriptionId || id(envelope.ownerId) !== scope.extensionId) throw new RingCentralEventError();
  date(envelope.timestamp);
  const path = text(envelope.event, 300);
  const match = path.match(/^\/restapi\/v1\.0\/account\/(~|\d+)\/extension\/(~|\d+)\/message-store(\/instant)?(?:\?([^#]*))?$/);
  if (!match || (match[1] !== '~' && match[1] !== scope.accountId) || (match[2] !== '~' && match[2] !== scope.extensionId)) throw new RingCentralEventError();
  const query = new URLSearchParams(match[4]);
  if ([...query.keys()].some(k => !['type', 'direction'].includes(k)) || query.getAll('type').length > 1 || query.getAll('direction').length > 1 ||
      (query.has('type') && query.get('type') !== 'SMS') || (query.has('direction') && !['Inbound', 'Outbound'].includes(query.get('direction')!))) throw new RingCentralEventError();
  const body = object(envelope.body);
  if (match[3]) {
    if (messageStoreRecords !== undefined || body.direction !== 'Inbound' || query.get('direction') === 'Outbound') throw new RingCentralEventError();
    return { kind: 'messages', eventId, messages: [record(body, scope)] };
  }
  if ((body.accountId !== undefined && id(body.accountId) !== scope.accountId) || (body.extensionId !== undefined && id(body.extensionId) !== scope.extensionId) || !Array.isArray(body.changes) || body.changes.length > 20) throw new RingCentralEventError();
  date(body.lastUpdated);
  for (const change of body.changes) {
    const c = object(change);
    if (!['SMS', 'Pager', 'Fax', 'Voicemail', 'VoiceMail'].includes(String(c.type))) throw new RingCentralEventError();
    for (const key of ['newCount', 'updatedCount']) if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0)) throw new RingCentralEventError();
  }
  if (!body.changes.some(c => object(c).type === 'SMS')) throw new RingCentralEventError();
  if (messageStoreRecords === undefined) return { kind: 'needs_message_store', eventId };
  if (!messageStoreRecords.length || messageStoreRecords.length > 50) throw new RingCentralEventError();
  const messages = messageStoreRecords.map(m => record(m, scope));
  if (new Set(messages.map(m => m.id)).size !== messages.length) throw new RingCentralEventError();
  if (query.has('direction') && messages.some(m => m.direction !== query.get('direction'))) throw new RingCentralEventError();
  return { kind: 'messages', eventId, messages };
}
