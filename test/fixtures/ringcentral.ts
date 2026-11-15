import type { RingCentralScope } from '../../src/ringcentral/events';
// NANPA fictional 555-01xx numbers; no credentials or live identifiers.
export const scope: RingCentralScope = { accountId: '100001', extensionId: '200001', subscriptionId: 'fictional-subscription', businessNumbers: ['+15035550100', '+15035550101'] };
export function message(id = '300001', direction = 'Inbound', subject = 'Fictional group home staffing inquiry', customer = '+15035550110', business = scope.businessNumbers[0]) {
  return { id, type: 'SMS', direction, subject, from: { phoneNumber: direction === 'Inbound' ? customer : business }, to: [{ phoneNumber: direction === 'Inbound' ? business : customer }], messageStatus: direction === 'Inbound' ? 'Received' : 'Sent', creationTime: '2026-11-15T12:00:00.000Z', lastModifiedTime: '2026-11-15T12:00:00.000Z' };
}
export function instant(body = message(), uuid = 'fictional-event-1') {
  return { uuid, event: `/restapi/v1.0/account/${scope.accountId}/extension/${scope.extensionId}/message-store/instant?type=SMS`, subscriptionId: scope.subscriptionId, ownerId: scope.extensionId, timestamp: '2026-11-15T12:00:01.000Z', body };
}
export function summary(uuid = 'fictional-summary-1') {
  return { ...instant(message(), uuid), event: `/restapi/v1.0/account/${scope.accountId}/extension/${scope.extensionId}/message-store?type=SMS`, body: { accountId: scope.accountId, extensionId: scope.extensionId, lastUpdated: '2026-11-15T12:00:01.000Z', changes: [{ type: 'SMS', newCount: 1, updatedCount: 0 }] } };
}
