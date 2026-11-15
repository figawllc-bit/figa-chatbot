import { RingCentralReadOnlySession, createOfflineCredentials, createOfflineHttp, type RuntimeCredentialProvider } from './oauth-read-session';
import { RINGCENTRAL_LIVE_CONNECTION_ENABLED, type HttpsExecutor } from './secure-transport';
import { ReadOnlyTestError, validateSingleMessageApproval, type SingleMessageApproval, type SingleAttemptLedger } from './read-only-test';

// Preparation only. No CLI option or environment flag can enable either gate.
export const ONE_TIME_RINGCENTRAL_RUNNER_ENABLED = false;
export function requireOneTimeLiveAuthorization(): void {
  if (!ONE_TIME_RINGCENTRAL_RUNNER_ENABLED || !RINGCENTRAL_LIVE_CONNECTION_ENABLED) throw new ReadOnlyTestError('disabled');
}
export interface OneTimeReadApproval {
  approvalId: string;
  message: SingleMessageApproval;
  appName: 'FIGA Chatbot Read-Only';
  privateProductionJwtAppConfirmed: true;
  independentReadMessagesOnlyEvidence: string;
  authorizedExtensionConfirmed: true;
  fictionalMessageConfirmed: true;
  authorizedRequests: readonly ['oauth_token', 'one_sms_get'];
}
export function validateOneTimeReadApproval(value: OneTimeReadApproval): OneTimeReadApproval {
  let a: OneTimeReadApproval;
  try { a = structuredClone(value); } catch { throw new ReadOnlyTestError('approval_invalid'); }
  if (!a || Object.keys(a).sort().join(',') !== 'appName,approvalId,authorizedExtensionConfirmed,authorizedRequests,fictionalMessageConfirmed,independentReadMessagesOnlyEvidence,message,privateProductionJwtAppConfirmed' ||
      typeof a.approvalId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/.test(a.approvalId) || a.appName !== 'FIGA Chatbot Read-Only' ||
      a.privateProductionJwtAppConfirmed !== true || a.authorizedExtensionConfirmed !== true || a.fictionalMessageConfirmed !== true ||
      typeof a.independentReadMessagesOnlyEvidence !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/.test(a.independentReadMessagesOnlyEvidence) ||
      !Array.isArray(a.authorizedRequests) || a.authorizedRequests.length !== 2 || a.authorizedRequests[0] !== 'oauth_token' || a.authorizedRequests[1] !== 'one_sms_get') throw new ReadOnlyTestError('approval_invalid');
  a.message = validateSingleMessageApproval(a.message);
  if (a.message.host !== 'https://platform.ringcentral.com' || !a.message.expectedFromSha256 || !a.message.expectedToSha256) throw new ReadOnlyTestError('approval_invalid');
  return a;
}
// Same orchestration and production approval requirements; no supplied callbacks
// for credentials or HTTP. The fixed fixture identities remain 100001 / 200001.
export function prepareOfflineOneTimeRead(approval: OneTimeReadApproval, serializedResponses: string, read: SingleAttemptLedger, oauth: SingleAttemptLedger) {
  const a = validateOneTimeReadApproval(approval);
  const http = createOfflineHttp(serializedResponses);
  const session = new RingCentralReadOnlySession({ mode: 'offline', approval: a.message }, createOfflineCredentials('jwt', undefined, 'production'), http.executor, read, oauth);
  return { session, audit: http.audit };
}
export function prepareLiveOneTimeRead(approval: OneTimeReadApproval, credentials: RuntimeCredentialProvider, http: HttpsExecutor, read: SingleAttemptLedger, oauth: SingleAttemptLedger) {
  requireOneTimeLiveAuthorization(); // Before validation, secrets, ledgers or HTTP.
  const a = validateOneTimeReadApproval(approval);
  const jwtOnly: RuntimeCredentialProvider = async () => {
    const value = await credentials();
    if (value.kind !== 'jwt') throw new ReadOnlyTestError('credentials_invalid');
    return value;
  };
  return new RingCentralReadOnlySession({ mode: 'live', approval: a.message }, jwtOnly, http, read, oauth);
}
