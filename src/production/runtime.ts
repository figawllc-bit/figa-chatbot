// Production wiring for real customer SMS. Every piece is inert until ALL of:
//  - the reviewed source constants below (and in polling.ts / sms-sender.ts) are flipped in code review,
//  - FIGA's privacy/contract approval is recorded (FIGA_PRIVACY_APPROVED),
//  - a SEPARATE production Supabase project is configured, and
//  - the RingCentral/Telegram credentials are provisioned as Cloudflare secrets.
// productionReadiness() names what is missing (never values) so go-live is a checklist.
import { RINGCENTRAL_POLLING_LIVE_ENABLED, RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED, POLLING_OWNER_ID, pollingControls } from '../ringcentral/polling';
import type { MonitoringEnvironment } from '../ringcentral/polling-runtime';
import { RINGCENTRAL_SMS_DELIVERY_ENABLED, RingCentralSmsSender } from '../ringcentral/sms-sender';
import { exchangeSmsJwt, type SmsGrant } from '../ringcentral/oauth-read-session';
import { ReadOnlyTestError } from '../ringcentral/read-only-test';
import { SmsWorkflow, productionSmsRepository } from '../ringcentral/sms-workflow';
import type { RingCentralScope } from '../ringcentral/events';
import { productionDatabaseConfiguration, type ProductionDatabaseEnvironment } from '../database/config';
import { HybridEngine } from '../ai/engine';
import { aiConfiguration, type AIEnvironment } from '../ai/config';
import { StaffBot } from '../telegram/bot';
import { SupabaseStaffRepository } from '../telegram/repository';
import { BotAPITransport } from '../telegram/transport';
import type { TelegramEnvironment } from '../telegram/types';

export { RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED };
const HOST = 'https://platform.ringcentral.com' as const;

export interface ProductionEnvironment extends MonitoringEnvironment, AIEnvironment, ProductionDatabaseEnvironment, TelegramEnvironment {
  /** FIGA's privacy/contract approval for real customer data on this stack. */
  FIGA_PRIVACY_APPROVED?: string;
  /** Numeric RingCentral account ID; must equal figa_deployment.rc_account_id. */
  RINGCENTRAL_ACCOUNT_ID?: string;
  /** Comma-separated approved, SMS-enabled, registered E.164 numbers on extension 101. The bot answers
   *  texts to any of them and replies from the number the customer texted. Must match figa_deployment. */
  RINGCENTRAL_SMS_NUMBERS?: string;
  RINGCENTRAL_SMS_SENDING_ENABLED?: string;
  // Separate RingCentral app with exactly SMS + ReadMessages (the read-only app stays unchanged).
  RINGCENTRAL_SMS_CLIENT_ID?: string;
  RINGCENTRAL_SMS_CLIENT_SECRET?: string;
  RINGCENTRAL_SMS_JWT?: string;
  /** Poll Telegram getUpdates from the scheduled job (no public webhook URL needed). */
  TELEGRAM_POLLING_ENABLED?: string;
}

export interface ProductionReadiness {
  /** Reading real texts and generating/saving replies. */
  processing: string[];
  /** Actually sending replies by SMS (in addition to processing). */
  sending: string[];
  /** Gemma on real texts (otherwise the rule-based engine answers). */
  ai: string[];
  /** Staff alerts and Telegram commands. */
  telegram: string[];
}
const e164 = /^\+[1-9]\d{7,14}$/;
/** The configured texting numbers, or [] if the setting is missing or any entry is malformed. */
export function smsNumbers(env: ProductionEnvironment): string[] {
  const list = (env.RINGCENTRAL_SMS_NUMBERS ?? '').split(',').map(n => n.trim()).filter(Boolean);
  return list.length >= 1 && list.length <= 5 && list.every(n => e164.test(n)) && new Set(list).size === list.length ? list : [];
}
const has = (v?: string) => typeof v === 'string' && v.length > 0;
export function productionReadiness(env: ProductionEnvironment): ProductionReadiness {
  const processing: string[] = [], sending: string[] = [], ai: string[] = [], telegram: string[] = [];
  if (!RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED) processing.push('code: RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED is false');
  if (!RINGCENTRAL_POLLING_LIVE_ENABLED) processing.push('code: RINGCENTRAL_POLLING_LIVE_ENABLED is false');
  if (env.FIGA_PRIVACY_APPROVED !== 'true') processing.push('approval: FIGA_PRIVACY_APPROVED');
  if (env.RINGCENTRAL_MONITORING_SECURITY_APPROVED !== 'true') processing.push('approval: RINGCENTRAL_MONITORING_SECURITY_APPROVED');
  if (!has(env.RINGCENTRAL_POLLING_APPROVAL_JSON)) processing.push('approval: RINGCENTRAL_POLLING_APPROVAL_JSON');
  const controls = pollingControls(env);
  if (!controls.enabled) processing.push('var: RINGCENTRAL_POLLING_ENABLED');
  if (controls.paused) processing.push('var: RINGCENTRAL_POLLING_PAUSED / AI_GLOBAL_PAUSED is on');
  for (const name of ['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET', 'RINGCENTRAL_JWT'] as const) if (!has(env[name])) processing.push('secret: ' + name);
  if (!/^[1-9]\d{0,63}$/.test(env.RINGCENTRAL_ACCOUNT_ID ?? '')) processing.push('var: RINGCENTRAL_ACCOUNT_ID');
  if (!smsNumbers(env).length) processing.push('var: RINGCENTRAL_SMS_NUMBERS');
  if (!productionDatabaseConfiguration(env).configured) processing.push('secret/var: SUPABASE_PRODUCTION_* (separate production project)');
  if (!RINGCENTRAL_SMS_DELIVERY_ENABLED) sending.push('code: RINGCENTRAL_SMS_DELIVERY_ENABLED is false');
  if (env.RINGCENTRAL_SMS_SENDING_ENABLED !== 'true') sending.push('var: RINGCENTRAL_SMS_SENDING_ENABLED');
  for (const name of ['RINGCENTRAL_SMS_CLIENT_ID', 'RINGCENTRAL_SMS_CLIENT_SECRET', 'RINGCENTRAL_SMS_JWT'] as const) if (!has(env[name])) sending.push('secret: ' + name);
  const aiConfig = aiConfiguration(env);
  if (env.AI_PRODUCTION_DATA_APPROVED !== 'true') ai.push('approval: AI_PRODUCTION_DATA_APPROVED');
  if (!aiConfig.configured) ai.push('binding/var: AI binding, AI_ENABLED, AI_PROVIDER=workers-ai');
  if (env.TELEGRAM_STAFF_ENABLED !== 'true') telegram.push('var: TELEGRAM_STAFF_ENABLED');
  if (env.TELEGRAM_LIVE_ENABLED !== 'true') telegram.push('var: TELEGRAM_LIVE_ENABLED');
  if (env.TELEGRAM_POLLING_ENABLED !== 'true') telegram.push('var: TELEGRAM_POLLING_ENABLED');
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN ?? '')) telegram.push('secret: TELEGRAM_BOT_TOKEN (rotate first)');
  if (!productionDatabaseConfiguration(env).configured) telegram.push('secret/var: SUPABASE_PRODUCTION_* (separate production project)');
  return { processing, sending: [...processing, ...sending], ai, telegram };
}

/** The extension/number the bot answers on. Must match the production database's deployment profile. */
export function productionScope(env: ProductionEnvironment): RingCentralScope {
  return { accountId: env.RINGCENTRAL_ACCOUNT_ID ?? '', extensionId: POLLING_OWNER_ID, subscriptionId: 'figa-polling', businessNumbers: smsNumbers(env) };
}

/** One SMS-app grant per isolate, reused until shortly before expiry (RingCentral auth calls are rate limited). */
function cachedSmsGrant(env: ProductionEnvironment, http: typeof fetch): () => Promise<SmsGrant> {
  let grant: SmsGrant | undefined;
  return async () => {
    if (grant && grant.expiresAt > Date.now() + 60000) return grant;
    grant = undefined;
    if (!has(env.RINGCENTRAL_SMS_CLIENT_ID) || !has(env.RINGCENTRAL_SMS_CLIENT_SECRET) || !has(env.RINGCENTRAL_SMS_JWT)) throw new Error('SMS credentials unavailable.');
    grant = await exchangeSmsJwt({ kind: 'jwt', clientId: env.RINGCENTRAL_SMS_CLIENT_ID!, clientSecret: env.RINGCENTRAL_SMS_CLIENT_SECRET!, jwt: env.RINGCENTRAL_SMS_JWT!,
      host: HOST, accountId: '~', extensionId: POLLING_OWNER_ID, appPermissions: ['ReadMessages', 'SMS'] },
      { host: HOST, extensionId: POLLING_OWNER_ID }, { send: request => http(request) }, { authorizedMaximum: 1, async reserve() {} });
    return grant;
  };
}

/** Signs in with the SMS app only (never sends). Returns 'ok', 'missing' or the failure category. */
export async function verifySmsApp(env: ProductionEnvironment, http: typeof fetch = workerFetch): Promise<string> {
  if (!has(env.RINGCENTRAL_SMS_CLIENT_ID) || !has(env.RINGCENTRAL_SMS_CLIENT_SECRET) || !has(env.RINGCENTRAL_SMS_JWT)) return 'missing';
  // Comparisons only (true/false), never values: catches the read-only app's credentials stored by mistake.
  const same = `sameClientAsReadOnly=${env.RINGCENTRAL_SMS_CLIENT_ID === env.RINGCENTRAL_CLIENT_ID} sameJwtAsReadOnly=${env.RINGCENTRAL_SMS_JWT === env.RINGCENTRAL_JWT}`;
  try { await cachedSmsGrant(env, http)(); return 'ok'; }
  catch (error) {
    if (!(error instanceof ReadOnlyTestError)) return 'sign_in_failed';
    const granted = (error as ReadOnlyTestError & { grantedScope?: string }).grantedScope;
    return error.category + (granted !== undefined ? ` (granted: ${granted || 'none'}; ${same})` : error.httpStatus ? ` (HTTP ${error.httpStatus}${error.oauthErrorCode ? ' ' + error.oauthErrorCode : ''}; ${same})` : ` (${same})`);
  }
}

/** The live workflow, or null while anything required for processing is missing. Sending has its own gates in the sender. */
/**
 * fetch with BOTH arguments forwarded. Database and Telegram clients call transport(url, init);
 * a one-argument wrapper would silently drop the method, headers (API key) and body.
 */
export const workerFetch: typeof fetch = (input, init) => fetch(input, init);

export function productionWorkflow(env: ProductionEnvironment, http: typeof fetch = workerFetch): SmsWorkflow | null {
  if (productionReadiness(env).processing.length) return null;
  const controls = () => ({ paused: pollingControls(env).paused, sendingEnabled: env.RINGCENTRAL_SMS_SENDING_ENABLED === 'true' });
  const sender = new RingCentralSmsSender({ mode: 'live', grant: cachedSmsGrant(env, http), http, sender: smsNumbers(env),
    enabled: () => controls().sendingEnabled && !controls().paused, privacyApproved: () => env.FIGA_PRIVACY_APPROVED === 'true' });
  // Diagnostics carry categories only, never message text.
  const engine = new HybridEngine(env, undefined, diagnostic => console.warn('figa_ai_failure', diagnostic));
  return new SmsWorkflow(productionSmsRepository(env, http), engine, sender, controls);
}

/** Staff bot on the production database with the real Telegram API, or null while not ready. */
export function productionStaffBot(env: ProductionEnvironment, http: typeof fetch = workerFetch) {
  if (productionReadiness(env).telegram.length) return null;
  const transport = new BotAPITransport(env, http);
  return { bot: new StaffBot(new SupabaseStaffRepository(env, http, productionDatabaseConfiguration), transport), transport };
}
