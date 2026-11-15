// Finds the values the production bot needs, using the READ-ONLY RingCentral app.
// You type Client ID, Client Secret and JWT into hidden prompts; nothing is saved.
// One token request + one message-list request (last 30 days, SMS only), then the
// token is revoked. Prints ONLY: account ID, extension ID, granted permissions and
// FIGA's own business numbers seen on texts. Never message text or customer numbers.
// Usage (interactive terminal only): node scripts/ringcentral-account-info.mjs
import { promptJwtCredentials } from './ringcentral-terminal-input.mjs';

const HOST = 'https://platform.ringcentral.com';
if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('Run this in an interactive terminal.'); process.exit(1); }
console.log('Enter the READ-ONLY app credentials (FIGA Chatbot Read-Only). Input is hidden.');
const c = await promptJwtCredentials({}, undefined);
const basic = 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
let token;
try {
  const r = await fetch(`${HOST}/restapi/oauth/token`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: c.jwt }) });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || !v.access_token) { console.error(`Sign-in failed (HTTP ${r.status}${typeof v.error === 'string' ? ', ' + v.error : ''}). Check the three values.`); process.exit(1); }
  token = v.access_token;
  console.log(`Signed in. Extension ID: ${v.owner_id}   Permissions: ${v.scope}`);
  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  const q = new URLSearchParams({ messageType: 'SMS', perPage: '100', dateFrom: from });
  const m = await fetch(`${HOST}/restapi/v1.0/account/~/extension/~/message-store?${q}`, { redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!m.ok) { console.error(`Reading the message list failed (HTTP ${m.status}).`); process.exit(1); }
  const records = (await m.json()).records ?? [];
  const accounts = new Set(), business = new Map();
  for (const r of records) {
    const id = /\/account\/(\d+)\/extension\//.exec(String(r.uri ?? ''))?.[1]; if (id) accounts.add(id);
    const own = r.direction === 'Inbound' ? r.to?.[0]?.phoneNumber : r.from?.phoneNumber;
    if (typeof own === 'string' && /^\+\d{8,15}$/.test(own)) business.set(own, (business.get(own) ?? 0) + 1);
  }
  console.log(`\nRingCentral account ID: ${[...accounts].join(', ') || '(no SMS in the last 30 days - send one test text to the number and run again)'}`);
  console.log('FIGA texting number(s) on this extension (texts in the last 30 days):');
  for (const [n, k] of [...business].sort((a, b) => b[1] - a[1])) console.log(`  ${n}   (${k} texts)`);
  console.log(`\nTexts checked: ${records.length}. No message text or customer numbers were printed.`);
} finally {
  if (token) await fetch(`${HOST}/restapi/oauth/revoke`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).catch(() => {});
}
