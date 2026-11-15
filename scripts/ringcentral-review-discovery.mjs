// Offline-only review/verification. There is deliberately no live-activation option.
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readDiscoveryPins, replaceDiscoveryPin, discoveryApprovalDigest, verifyDiscoveryApprovalPin } from './ringcentral-discovery-pin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let stage = 'arguments';
try {
  const [mode, flag, input, ...extra] = process.argv.slice(2);
  if (!['--review', '--verify'].includes(mode) || flag !== '--approval' || !input || extra.length) throw Error('invalid_arguments');
  stage = 'approval_file';
  const path = resolve(input), allowed = await realpath(join(root, '.wrangler'));
  if (!(await realpath(path)).startsWith(allowed + sep) || !basename(path).endsWith('.authorization.json') || (await stat(path)).size > 8192) throw Error('approval_invalid');
  const bytes = await readFile(path), digest = discoveryApprovalDigest(bytes), approval = JSON.parse(bytes);
  if (mode === '--review') {
    stage = 'validator_bundle';
    const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
    const built = await build({ entryPoints: [join(root, 'src/ringcentral/discovery-approval.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    const { validateSmsDiscoveryApproval } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
    stage = 'approval_validation';
    validateSmsDiscoveryApproval(approval);
  }
  // --verify checks file integrity, not time validity or execution permission.
  // Full schema, freshness and budget checks remain mandatory in the runner.
  if (basename(path) !== approval.approvalId + '.authorization.json' || approval.expectedOwnerId !== '3322425015' || approval.extensionId !== '3322425015' || approval.host !== 'https://platform.ringcentral.com' || approval.operation !== 'sms_discovery' || JSON.stringify(approval.permissions) !== '["ReadMessages"]') throw Error('approval_invalid');
  // Retired or previously claimed approvals can never be reviewed again.
  try { await stat(join(root, '.wrangler/ringcentral-read-only', approval.approvalId)); throw Error('budget_unavailable'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  stage = 'reviewed_pin';
  const runtimePath = join(root, 'scripts/ringcentral-discovery-runtime.mjs');
  let source = await readFile(runtimePath, 'utf8');
  const pins = readDiscoveryPins(source);
  if (pins.authorized !== '') throw Error('disabled');
  const checksumPath = path.replace(/\.json$/, '.sha256');
  if (mode === '--review') {
    // Exclusive sidecar creation and exact declaration replacement; no live pin.
    await writeFile(checksumPath, digest + '\n', { flag: 'wx' });
    source = replaceDiscoveryPin(source, 'REVIEWED', pins.reviewed, digest);
    await writeFile(runtimePath, source);
  }
  verifyDiscoveryApprovalPin(await readFile(path), readDiscoveryPins(await readFile(runtimePath, 'utf8')).reviewed);
  if ((await readFile(checksumPath, 'utf8')).trim() !== digest) throw Error('authorization_pin_check_failed');
  console.log(JSON.stringify({ status: 'reviewed_pin_verified', approvalValidation: mode === '--review' ? 'validated' : 'not_run', approvalId: approval.approvalId, sha256: digest, expiresAt: approval.expiresAt, expectedOwnerId: approval.expectedOwnerId, requests: 0, credentialsRead: false, liveEnabled: false }));
} catch (error) {
  const allowed = ['disabled', 'approval_invalid', 'budget_unavailable', 'authorization_pin_check_failed', 'invalid_arguments'];
  const category = error?.category ?? error?.message;
  console.log(JSON.stringify({ status: 'stopped', category: allowed.includes(category) ? category : 'review_failed', failureStage: stage, systemCode: ['EPERM', 'EACCES', 'ENOENT', 'EEXIST'].includes(error?.code) ? error.code : null, requests: 0, credentialsRead: false, liveEnabled: false }));
  process.exitCode = 1;
}
