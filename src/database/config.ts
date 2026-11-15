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
  return { enabled, configured: !!configured, url: configured ? url!.origin : undefined, key: configured ? env.SUPABASE_SECRET_KEY : undefined };
}
/** A SEPARATE production project for real customer data. Never the isolated development project. */
export interface ProductionDatabaseEnvironment {
  SUPABASE_PRODUCTION_ENABLED?: string;
  SUPABASE_PRODUCTION_PROJECT_REF?: string;
  SUPABASE_PRODUCTION_URL?: string;
  SUPABASE_PRODUCTION_SECRET_KEY?: string;
  // The development project's ref; production must differ from it.
  SUPABASE_PROJECT_REF?: string;
}
export function productionDatabaseConfiguration(env: ProductionDatabaseEnvironment) {
  const enabled = env.SUPABASE_PRODUCTION_ENABLED === 'true';
  let url: URL | undefined;
  try { url = new URL(env.SUPABASE_PRODUCTION_URL ?? ''); } catch { /* Unconfigured by default. */ }
  const ref = env.SUPABASE_PRODUCTION_PROJECT_REF ?? '';
  const configured = enabled && /^[a-z0-9]{8,30}$/.test(ref) && ref !== env.SUPABASE_PROJECT_REF &&
    url?.protocol === 'https:' && url.hostname === `${ref}.supabase.co` &&
    url.pathname === '/' && !url.port && !url.search && !url.hash && !url.username && !url.password &&
    /^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PRODUCTION_SECRET_KEY ?? '');
  return { enabled, configured: !!configured, url: configured ? url!.origin : undefined, key: configured ? env.SUPABASE_PRODUCTION_SECRET_KEY : undefined };
}
