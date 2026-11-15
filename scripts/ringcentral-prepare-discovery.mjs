// Offline preparation only. Does not authorize execution, prompt, or use HTTP.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readDiscoveryPins } from './ringcentral-discovery-pin.mjs';

export function createDiscoveryApproval(now = Date.now(), uuid = randomUUID()) {
  if (!Number.isSafeInteger(now) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)) throw Error('approval_invalid');
  return {
    operation: 'sms_discovery', approvalId: 'figa-discovery-' + uuid,
    host: 'https://platform.ringcentral.com', accountId: '~', extensionId: '3322425015', expectedOwnerId: '3322425015',
    permissions: ['ReadMessages'], expiresAt: new Date(now + 20 * 60000).toISOString(),
    dateFrom: new Date(now - 604800000).toISOString(), dateTo: new Date(now).toISOString(),
    authorizedJwtIdentityConfirmed: true,
    independentReadMessagesOnlyEvidence: 'operator-admin-portal-ext101-3322425015',
  };
}

export async function writeDiscoveryApproval(directory, approval) {
  if (!/^figa-discovery-[a-f0-9-]{36}$/.test(approval.approvalId)) throw Error('approval_invalid');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, approval.approvalId + '.authorization.json');
  await writeFile(path, JSON.stringify(approval, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--create') throw Error('invalid_arguments');
    const pins = readDiscoveryPins(await readFile(join(root, 'scripts/ringcentral-discovery-runtime.mjs'), 'utf8'));
    if (pins.authorized !== '') throw Error('disabled');
    for (const [file, gate] of [['secure-transport.ts', 'RINGCENTRAL_LIVE_CONNECTION_ENABLED'], ['discovery-approval.ts', 'RINGCENTRAL_SMS_DISCOVERY_ENABLED'], ['one-time-runner.ts', 'ONE_TIME_RINGCENTRAL_RUNNER_ENABLED']]) {
      const source = await readFile(join(root, 'src/ringcentral', file), 'utf8');
      if ([...source.matchAll(new RegExp(`^export const ${gate} = false;(?=\\r?$)`, 'gm'))].length !== 1) throw Error('disabled');
    }
    // Validate with the same implementation used by the real runner, before writing.
    const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
    const built = await build({ entryPoints: [join(root, 'src/ringcentral/discovery-approval.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    const { validateSmsDiscoveryApproval } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
    const approval = validateSmsDiscoveryApproval(createDiscoveryApproval());
    const approvalPath = await writeDiscoveryApproval(join(root, '.wrangler'), approval);
    console.log(JSON.stringify({ status: 'approval_created_review_required', approvalPath, approvalId: approval.approvalId, expiresAt: approval.expiresAt, freshnessCutoff: new Date(Date.parse(approval.dateTo) + 300000).toISOString(), expectedOwnerId: approval.expectedOwnerId, requests: 0, credentialsRead: false, liveEnabled: false }));
  } catch (error) {
    const category = error?.category ?? error?.message;
    console.log(JSON.stringify({ status: 'stopped', category: ['disabled', 'invalid_arguments', 'approval_invalid', 'authorization_pin_check_failed'].includes(category) ? category : 'preparation_failed', requests: 0, credentialsRead: false, liveEnabled: false }));
    process.exitCode = 1;
  }
}
