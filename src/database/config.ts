import type { DatabaseEnvironment } from './types';

export function databaseConfiguration(env: DatabaseEnvironment) {
  const enabled = env.SUPABASE_ENABLED === 'true';
  let url: URL | undefined;
  try { url = new URL(env.SUPABASE_URL ?? ''); } catch { /* Unconfigured by default. */ }
  const configured = enabled && env.SUPABASE_ISOLATED_DEV_CONFIRMED === 'true' &&
    /^[a-z0-9]{8,30}$/.test(env.SUPABASE_PROJECT_REF ?? '') &&
    url?.protocol === 'https:' && url.hostname === `${env.SUPABASE_PROJECT_REF}.supabase.co` &&
    url.pathname === '/' && !url.port && !url.search && !url.hash && !url.username && !url.password &&
    /^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SECRET_KEY ?? '');
  return { enabled, configured: !!configured, url: configured ? url!.origin : undefined };
}
