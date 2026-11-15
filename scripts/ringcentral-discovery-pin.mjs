import { createHash } from 'node:crypto';

const fail = () => { throw new Error('authorization_pin_check_failed'); };
const pattern = name => new RegExp(`^export const ${name}_DISCOVERY_APPROVAL_SHA256 = '([a-f0-9]*)';(?=\\r?$)`, 'gm');
function declaration(source, name) {
  if (!['REVIEWED', 'AUTHORIZED'].includes(name) || typeof source !== 'string') fail();
  const matches = [...source.matchAll(pattern(name))];
  if (matches.length !== 1 || !/^(?:[a-f0-9]{64})?$/.test(matches[0][1])) fail();
  return matches[0][1];
}

export function readDiscoveryPins(source) {
  return { reviewed: declaration(source, 'REVIEWED'), authorized: declaration(source, 'AUTHORIZED') };
}

export function replaceDiscoveryPin(source, name, expected, replacement) {
  readDiscoveryPins(source);
  if (declaration(source, name) !== expected || typeof replacement !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(replacement)) fail();
  return source.replace(pattern(name), () => `export const ${name}_DISCOVERY_APPROVAL_SHA256 = '${replacement}';`);
}

export function discoveryApprovalDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) fail();
  // Hash exact UTF-8 bytes without BOM, serialization or newline normalization.
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail(); }
  if (decoded.startsWith('\uFEFF')) fail();
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyDiscoveryApprovalPin(bytes, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || discoveryApprovalDigest(bytes) !== expected) fail();
}
