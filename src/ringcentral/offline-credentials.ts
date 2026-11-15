import type { InjectedRingCentralCredentials, RuntimeCredentialProvider } from './oauth-read-session';
import { ReadOnlyTestError } from './read-only-test';

const providers = new WeakSet<RuntimeCredentialProvider>();
export function isOfflineCredentialProvider(value: unknown): value is RuntimeCredentialProvider {
  return typeof value === 'function' && providers.has(value as RuntimeCredentialProvider);
}
export type OfflineCredentialFault = 'expired' | 'short_lived' | 'scope' | 'legacy_scope' | 'owner' | 'account' | 'host' | 'type' | 'header' | 'app_permissions';
// No caller-supplied secret values, environment reads or callback execution.
export function createOfflineCredentials(kind: 'jwt' | 'access_token', fault?: OfflineCredentialFault, platform: 'devtest' | 'production' = 'devtest'): RuntimeCredentialProvider {
  if (!['devtest', 'production'].includes(platform)) throw new ReadOnlyTestError('credentials_invalid');
  if (!['jwt', 'access_token'].includes(kind) || (fault !== undefined && !['expired', 'short_lived', 'scope', 'legacy_scope', 'owner', 'account', 'host', 'type', 'header', 'app_permissions'].includes(fault))) throw new ReadOnlyTestError('credentials_invalid');
  const binding = { host: platform === 'production' ? 'https://platform.ringcentral.com' as const : 'https://platform.devtest.ringcentral.com' as const, accountId: '100001', extensionId: '200001', appPermissions: ['ReadMessages'] as const };
  const credentials: InjectedRingCentralCredentials = kind === 'jwt'
    ? { ...binding, kind, clientId: 'fictional-client', clientSecret: 'fictional-secret', jwt: 'fictional.header.signature' }
    : { ...binding, kind, accessToken: 'fictional-runtime-access-token', tokenType: 'Bearer', scope: 'ReadMessages', ownerId: '200001', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const faults: Record<OfflineCredentialFault, object> = {
    expired: { expiresAt: '2000-01-01T00:00:00Z' }, short_lived: { expiresAt: new Date(Date.now() + 1000).toISOString() },
    scope: { scope: 'ReadMessages SMS' }, legacy_scope: { scope: 'Messages' }, owner: { ownerId: '200002' }, account: { accountId: '100002' },
    host: { host: 'https://platform.ringcentral.com' }, type: { tokenType: 'Basic' }, header: { accessToken: 'fictional\r\nheader' }, app_permissions: { appPermissions: ['ReadMessages', 'SMS'] },
  };
  if (fault) Object.assign(credentials, faults[fault]);
  const provider = async () => structuredClone(credentials);
  Object.freeze(provider);
  providers.add(provider);
  return provider;
}
