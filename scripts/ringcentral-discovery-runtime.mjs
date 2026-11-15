import { replaceDiscoveryPin, verifyDiscoveryApprovalPin } from './ringcentral-discovery-pin.mjs';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// EMPTY: no live execution is authorized. After separate review, pin only the
// SHA-256 of ONE exact time-limited approval file, never a general enable flag.
export const REVIEWED_DISCOVERY_APPROVAL_SHA256 = '94de7753b42444f3ff121afc049eb06791d88e79cd8daff453b4fc9648992c56';
export const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';
let consumed = false;
export const hasPinnedDiscoveryAuthorization = () => !consumed && /^[a-f0-9]{64}$/.test(AUTHORIZED_DISCOVERY_APPROVAL_SHA256) && AUTHORIZED_DISCOVERY_APPROVAL_SHA256 === REVIEWED_DISCOVERY_APPROVAL_SHA256;

export function requirePinnedDiscoveryAuthorization(serializedApproval) {
  if (!hasPinnedDiscoveryAuthorization() || typeof serializedApproval !== 'string') throw new Error('disabled');
  verifyDiscoveryApprovalPin(Buffer.from(serializedApproval, 'utf8'), AUTHORIZED_DISCOVERY_APPROVAL_SHA256);
}

export async function revokePinnedDiscoveryAuthorization() {
  if (consumed || !hasPinnedDiscoveryAuthorization()) return;
  consumed = true;
  const handle = await open(new URL(import.meta.url), 'r+');
  try {
    const source = await handle.readFile('utf8');
    const revoked = replaceDiscoveryPin(source, 'AUTHORIZED', AUTHORIZED_DISCOVERY_APPROVAL_SHA256, '');
    await handle.write(revoked, 0, 'utf8');
    await handle.truncate(Buffer.byteLength(revoked));
    await handle.sync();
  } finally { await handle.close(); }
}

export async function loadPinnedDiscoveryRuntime(root, serializedApproval) {
  requirePinnedDiscoveryAuthorization(serializedApproval); // Before compilation or any HTTP.
  // The CLI has already claimed the exclusive approval directory. Revoke the
  // on-disk pin before credential entry: only this process retains the lease.
  await revokePinnedDiscoveryAuthorization();
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler'))('esbuild');
  const gates = new Map([
    ['secure-transport.ts', 'RINGCENTRAL_LIVE_CONNECTION_ENABLED'],
    ['discovery-approval.ts', 'RINGCENTRAL_SMS_DISCOVERY_ENABLED'],
  ]);
  const built = await build({ entryPoints: [join(root, 'src/ringcentral/sms-discovery.ts')], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent',
    plugins: [{ name: 'isolated-one-approval-discovery', setup(build) {
      for (const [file, gate] of gates) {
        const path = join(root, 'src/ringcentral', file);
        build.onLoad({ filter: new RegExp(file.replace('.', '[.]') + '$') }, async args => {
          if (args.path !== path) throw new Error('disabled');
          const contents = await readFile(path, 'utf8'), literal = `export const ${gate} = false;`;
          if (contents.split(literal).length !== 2) throw new Error('disabled');
          // Only this in-memory CLI bundle is armed. Source/Worker flags stay false.
          return { contents: contents.replace(literal, `export const ${gate} = true;`), loader: 'ts' };
        });
      }
    } }] });
  if (Object.keys(built.metafile.inputs).some(path => /(?:src\/index|src\/ai\/|database\/|supabase|telegram|ringcentral\/receiver)/i.test(path.replaceAll('\\', '/')))) throw new Error('disabled');
  const runtime = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
  runtime.validateSmsDiscoveryApproval(JSON.parse(serializedApproval));
  return runtime;
}
