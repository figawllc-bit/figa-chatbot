// Read-only go-live checklist for the production Worker. Prints NAMES only:
// code locks (from source), switches (from wrangler.jsonc env.production) and which
// secrets exist on Cloudflare (`wrangler secret list` returns names, never values).
// Usage: npm run preflight            (add --offline to skip the Cloudflare secret lookup)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const lock = (file, name) => new RegExp(`export const ${name} = (true|false);`).exec(read(file))?.[1] ?? 'missing';
const locks = {
  RINGCENTRAL_POLLING_LIVE_ENABLED: lock('src/ringcentral/polling.ts', 'RINGCENTRAL_POLLING_LIVE_ENABLED'),
  RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED: lock('src/ringcentral/polling.ts', 'RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED'),
  RINGCENTRAL_SMS_DELIVERY_ENABLED: lock('src/ringcentral/sms-sender.ts', 'RINGCENTRAL_SMS_DELIVERY_ENABLED'),
};
const config = JSON.parse(read('wrangler.jsonc').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
const vars = config.env?.production?.vars ?? {};
const secrets = ['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET', 'RINGCENTRAL_JWT', 'RINGCENTRAL_POLLING_APPROVAL_JSON',
  'RINGCENTRAL_SMS_CLIENT_ID', 'RINGCENTRAL_SMS_CLIENT_SECRET', 'RINGCENTRAL_SMS_JWT', 'SUPABASE_PRODUCTION_SECRET_KEY', 'TELEGRAM_BOT_TOKEN'];

let present = null;
if (!process.argv.includes('--offline')) {
  try {
    const wrangler = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
    const out = execFileSync(process.execPath, [fileURLToPath(wrangler), 'secret', 'list', '--env', 'production', '--format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
    present = new Set(JSON.parse(out.slice(out.indexOf('['))).map(s => s.name));
  } catch { present = null; }
}
const mark = ok => (ok ? '  [ok]  ' : '  [--]  ');
console.log('FIGA production preflight (names only; no values are read or printed)\n');
console.log('Reviewed code locks (flip only in a reviewed commit, in this order):');
for (const [name, value] of Object.entries(locks)) console.log(mark(value === 'true') + `${name} = ${value}`);
console.log('\nSwitches in wrangler.jsonc env.production (approvals and staged go-live):');
for (const name of ['FIGA_PRIVACY_APPROVED', 'RINGCENTRAL_MONITORING_SECURITY_APPROVED', 'RINGCENTRAL_POLLING_ENABLED', 'SUPABASE_PRODUCTION_ENABLED',
  'TELEGRAM_STAFF_ENABLED', 'TELEGRAM_LIVE_ENABLED', 'TELEGRAM_POLLING_ENABLED', 'AI_ENABLED', 'AI_PRODUCTION_DATA_APPROVED', 'RINGCENTRAL_SMS_SENDING_ENABLED'])
  console.log(mark(vars[name] === 'true') + `${name} = ${vars[name] ?? '(unset)'}`);
for (const name of ['RINGCENTRAL_POLLING_PAUSED', 'AI_GLOBAL_PAUSED']) console.log(mark(vars[name] === 'false') + `${name} = ${vars[name] ?? '(unset)'}  (emergency stop; must be false to run)`);
for (const name of ['RINGCENTRAL_ACCOUNT_ID', 'RINGCENTRAL_SMS_NUMBERS', 'SUPABASE_PRODUCTION_PROJECT_REF', 'SUPABASE_PRODUCTION_URL'])
  console.log(mark(Boolean(vars[name])) + `${name} ${vars[name] ? 'set' : 'empty'}`);
console.log('\nCloudflare secrets for env production:');
if (!present) console.log('  (not checked: run `npx wrangler login`, or remove --offline)');
else for (const name of secrets) console.log(mark(present.has(name)) + name);
console.log('\nAlso required outside this repo: FIGA privacy/BAA decision, rotated Telegram token, RingCentral SMS app (SMS + ReadMessages),');
console.log('10DLC/toll-free registration of the sender number, separate production Supabase project with migrations + supabase/production/configure.sql.');
