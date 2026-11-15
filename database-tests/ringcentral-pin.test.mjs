import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscoveryPins, replaceDiscoveryPin, discoveryApprovalDigest, verifyDiscoveryApprovalPin } from '../scripts/ringcentral-discovery-pin.mjs';

const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const source = `export const REVIEWED_DISCOVERY_APPROVAL_SHA256 = '${hash}';\nexport const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';\nconst revocationText = "export const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';";\n`;
for (const newline of ['\n', '\r\n']) {
  test(`pin editing targets only the declaration with ${JSON.stringify(newline)} newlines`, () => {
    const input = source.replaceAll('\n', newline);
    assert.equal(input.split("export const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';").length - 1, 2);
    const reviewed = replaceDiscoveryPin(input, 'REVIEWED', hash, other);
    const armed = replaceDiscoveryPin(reviewed, 'AUTHORIZED', '', other);
    assert.deepEqual(readDiscoveryPins(armed), { reviewed: other, authorized: other });
    assert.ok(armed.includes(`const revocationText = "export const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';";`));
    assert.equal(replaceDiscoveryPin(armed, 'AUTHORIZED', other, ''), reviewed);
    assert.equal(readDiscoveryPins(reviewed).authorized, '');
  });
}

test('missing, duplicate, malformed and unexpected pin declarations fail closed', () => {
  for (const input of [source.replace('export const AUTHORIZED', 'const AUTHORIZED'), source + "export const AUTHORIZED_DISCOVERY_APPROVAL_SHA256 = '';\n", source.replace(hash, 'abc')]) {
    assert.throws(() => readDiscoveryPins(input), { message: 'authorization_pin_check_failed' });
  }
  assert.throws(() => replaceDiscoveryPin(source, 'AUTHORIZED', other, hash));
  assert.throws(() => replaceDiscoveryPin(source, 'REVIEWED', hash, 'invalid'));
  assert.throws(() => replaceDiscoveryPin(source, 'UNKNOWN', '', hash));
});

const bytes = Buffer.from(JSON.stringify({ approvalId: 'fictional-pin-001', dateTo: '2026-11-15T09:00:00.000Z' }, null, 2) + '\n');
test('raw UTF-8 file bytes verify without JSON serialization', () => {
  const pin = discoveryApprovalDigest(bytes);
  verifyDiscoveryApprovalPin(bytes, pin);
  verifyDiscoveryApprovalPin(new Uint8Array(bytes), pin);
  assert.throws(() => verifyDiscoveryApprovalPin(bytes, other));
});
for (const [name, altered] of [
  ['line endings', Buffer.from(bytes.toString().replaceAll('\n', '\r\n'))],
  ['JSON reserialization', Buffer.from(JSON.stringify(JSON.parse(bytes)))],
  ['approval ID', Buffer.from(bytes.toString().replace('fictional-pin-001', 'fictional-pin-002'))],
  ['timestamp', Buffer.from(bytes.toString().replace('09:00:00', '09:00:01'))],
  ['trailing whitespace', Buffer.concat([bytes, Buffer.from(' ')])],
]) {
  test(`pin rejects changed ${name}`, () => assert.throws(() => verifyDiscoveryApprovalPin(altered, discoveryApprovalDigest(bytes)), { message: 'authorization_pin_check_failed' }));
}
test('BOM, invalid UTF-8 and UTF-16 are rejected even with matching raw checksums', () => {
  for (const invalid of [Buffer.concat([Buffer.from([239, 187, 191]), bytes]), Buffer.from([255, 254, 0]), Buffer.from(bytes.toString(), 'utf16le')]) {
    // UTF-16 without BOM can be valid UTF-8 containing NUL, but cannot be JSON.
    assert.throws(() => { discoveryApprovalDigest(invalid); JSON.parse(invalid); });
  }
});
