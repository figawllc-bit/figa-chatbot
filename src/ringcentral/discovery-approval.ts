import { ReadOnlyTestError } from './read-only-test';

export const RINGCENTRAL_SMS_DISCOVERY_ENABLED = false;
export const DISCOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export interface SmsDiscoveryApproval {
  operation: 'sms_discovery'; approvalId: string;
  host: 'https://platform.ringcentral.com';
  accountId: string; extensionId: string;
  expectedOwnerId?: string;
  permissions: readonly ['ReadMessages']; expiresAt: string;
  dateFrom: string; dateTo: string;
  authorizedJwtIdentityConfirmed: true;
  independentReadMessagesOnlyEvidence: string;
}
export const numericRingCentralId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,63}$/.test(id);
const reference = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/.test(v);
const canonicalDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
// Fixed reason codes only: never include authorization values or customer data.
export function smsDiscoveryApprovalIssues(value: SmsDiscoveryApproval): string[] {
  let a: SmsDiscoveryApproval;
  try { a = structuredClone(value); } catch { return ['approval_uncloneable']; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['approval_shape_invalid'];
  const issues: string[] = [], now = Date.now();
  if (Object.keys(a).filter(k => k !== 'expectedOwnerId').sort().join(',') !== 'accountId,approvalId,authorizedJwtIdentityConfirmed,dateFrom,dateTo,expiresAt,extensionId,host,independentReadMessagesOnlyEvidence,operation,permissions') issues.push('field_set_invalid');
  if (a.expectedOwnerId !== undefined && (!numericRingCentralId(a.expectedOwnerId) || (a.extensionId !== '~' && a.extensionId !== a.expectedOwnerId))) issues.push('owner_pin_invalid');
  if (a.operation !== 'sms_discovery') issues.push('operation_invalid');
  if (!reference(a.approvalId)) issues.push('approval_id_invalid');
  if (!reference(a.independentReadMessagesOnlyEvidence)) issues.push('identity_evidence_invalid');
  if (a.authorizedJwtIdentityConfirmed !== true) issues.push('jwt_identity_unconfirmed');
  if (a.host !== 'https://platform.ringcentral.com') issues.push('host_invalid');
  if (![a.accountId, a.extensionId].every(id => id === '~' || numericRingCentralId(id))) issues.push('account_or_extension_invalid');
  if (!Array.isArray(a.permissions) || a.permissions.length !== 1 || a.permissions[0] !== 'ReadMessages') issues.push('permissions_invalid');
  if (!canonicalDate(a.expiresAt)) issues.push('expiry_format_invalid');
  else {
    if (Date.parse(a.expiresAt) <= now) issues.push('approval_expired');
    if (Date.parse(a.expiresAt) > now + 3600000) issues.push('expiry_too_distant');
  }
  if (!canonicalDate(a.dateFrom) || !canonicalDate(a.dateTo)) issues.push('window_format_invalid');
  else {
    if (Date.parse(a.dateTo) - Date.parse(a.dateFrom) !== DISCOVERY_WINDOW_MS) issues.push('window_not_seven_days');
    if (Date.parse(a.dateTo) > now) issues.push('window_in_future');
    if (now - Date.parse(a.dateTo) > 300000) issues.push('window_stale');
  }
  return issues;
}
export function validateSmsDiscoveryApproval(value: SmsDiscoveryApproval): SmsDiscoveryApproval {
  let a: SmsDiscoveryApproval;
  try { a = structuredClone(value); } catch { throw new ReadOnlyTestError('approval_invalid'); }
  if (smsDiscoveryApprovalIssues(a).length) throw new ReadOnlyTestError('approval_invalid');
  return a;
}
export function smsDiscoveryUrl(a: SmsDiscoveryApproval): string {
  const query = new URLSearchParams({ messageType: 'SMS', direction: 'Inbound', perPage: '1', page: '1', dateFrom: a.dateFrom, dateTo: a.dateTo });
  return `${a.host}/restapi/v1.0/account/${a.accountId}/extension/${a.extensionId}/message-store?${query}`;
}
