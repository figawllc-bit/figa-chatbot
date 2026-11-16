import { POLLING_OWNER_ID, RINGCENTRAL_POLLING_LIVE_ENABLED, pollingControls, scheduledPolling, type RingCentralIncomingPoller, type PollingEnvironment } from './polling';
import type { RuntimeCredentialProvider } from './oauth-read-session';
import type { RingCentralMonitor } from './polling-durable';

const KEY = 'ringcentral-incoming:' + POLLING_OWNER_ID;
export interface MonitoringEnvironment extends PollingEnvironment {
  RINGCENTRAL_MONITOR?: DurableObjectNamespace<RingCentralMonitor>;
  // Cloudflare secrets, never vars, files, request input or logs.
  RINGCENTRAL_CLIENT_ID?: string;
  RINGCENTRAL_CLIENT_SECRET?: string;
  RINGCENTRAL_JWT?: string;
  RINGCENTRAL_POLLING_APPROVAL_JSON?: string;
  /** Operator action: set to a NEW value (e.g. a date) after reviewing an authentication block; clears it once. */
  RINGCENTRAL_AUTH_REVIEW_CLEARED?: string;
  RINGCENTRAL_MONITORING_SECURITY_APPROVED?: string;
  /** 'true' when the polling app holds exactly Read Messages + SMS (one app for reading and replying). */
  RINGCENTRAL_APP_HAS_SMS?: string;
}

export function monitoringCredentials(env: MonitoringEnvironment): RuntimeCredentialProvider {
  return async () => {
    // Check BEFORE touching secret bindings; env alone cannot enable live access.
    if (!RINGCENTRAL_POLLING_LIVE_ENABLED || !pollingControls(env).enabled || pollingControls(env).paused || env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true')
      throw new Error('Monitoring disabled.');
    const clientId = env.RINGCENTRAL_CLIENT_ID, clientSecret = env.RINGCENTRAL_CLIENT_SECRET, jwt = env.RINGCENTRAL_JWT;
    if (!clientId || !clientSecret || !jwt) throw new Error('Monitoring credentials unavailable.');
    return { kind: 'jwt', clientId, clientSecret, jwt, host: 'https://platform.ringcentral.com', accountId: '~', extensionId: POLLING_OWNER_ID,
      appPermissions: env.RINGCENTRAL_APP_HAS_SMS === 'true' ? ['ReadMessages', 'SMS'] as const : ['ReadMessages'] as const }; // Provider assertion; OAuth scope/owner remain independently checked.
  };
}

/** Telegram staff pass from the scheduled job; inert unless TELEGRAM_POLLING_ENABLED and the DO binding exist. */
export async function scheduledStaff(env: MonitoringEnvironment & { TELEGRAM_POLLING_ENABLED?: string }): Promise<void> {
  // Check the switch before touching any binding.
  if (env.TELEGRAM_POLLING_ENABLED !== 'true' || !env.RINGCENTRAL_MONITOR) return;
  const report = await env.RINGCENTRAL_MONITOR.get(env.RINGCENTRAL_MONITOR.idFromName(KEY)).staff();
  // Status and count only: no message text, IDs, tokens or Telegram bodies.
  console.info('figa_staff_pass', { status: report.status, processed: report.processed, webhook: report.webhook ?? null, results: report.results ?? null, failure: report.failure ?? null, httpStatus: report.httpStatus ?? null, code: report.code ?? null, keyCheck: report.keyCheck ?? null, ...(report.bot !== undefined ? { bot: report.bot, webhookSet: report.webhookSet, smsApp: report.smsApp } : {}) });
}
export async function scheduledMonitoring(env: MonitoringEnvironment, override?: Pick<RingCentralIncomingPoller, 'poll'>): Promise<void> {
  // No public HTTP route, no alarms, no Cron registration, no retry wrapper.
  await scheduledPolling(env, override ?? { poll: async () => {
    if (!env.RINGCENTRAL_MONITOR || env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true') throw new Error('Monitoring unavailable.');
    const stub = env.RINGCENTRAL_MONITOR.get(env.RINGCENTRAL_MONITOR.idFromName(KEY));
    const report = await stub.poll();
    // Counts and categories only: no message text, phone numbers, IDs or tokens.
    console.info('figa_rc_poll', { status: report.status, newMessages: report.newMessages, duplicates: report.duplicates, excluded: report.excluded,
      errors: report.errors, errorCategory: report.errorCategory ?? null, httpStatus: report.httpStatus ?? null, oauthErrorCode: report.oauthErrorCode ?? null });
    return report;
  } });
}
