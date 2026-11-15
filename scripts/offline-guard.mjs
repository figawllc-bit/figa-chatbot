// Preload for offline verification: no application secrets or external sockets.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'NODE_OPTIONS']);
for (const key of Object.keys(process.env)) if (!allowed.has(key.toUpperCase())) delete process.env[key];
Object.assign(process.env, { WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_WRITE_LOGS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CI: 'true' });
function guard(path) {
  if (typeof path === 'number') return;
  const name = basename(path instanceof URL ? fileURLToPath(path) : String(path));
  if (/^(?:\.dev\.vars(?:\.|$)|\.env(?:\.|$))/.test(name)) {
    const error = new Error('Secret files excluded from offline verification'); error.code = 'ENOENT'; throw error;
  }
}
for (const key of ['readFileSync', 'openSync']) {
  const original = fs[key]; fs[key] = function(path, ...args) { guard(path); return original.call(this, path, ...args); };
}
for (const key of ['readFile', 'open']) {
  const original = fs[key]; fs[key] = function(path, ...args) {
    try { guard(path); } catch (error) { const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; } throw error; }
    return original.call(this, path, ...args);
  };
  const promiseOriginal = fsp[key]; fsp[key] = async function(path, ...args) { guard(path); return promiseOriginal.call(this, path, ...args); };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = typeof first === 'object' && first ? first.host ?? first.hostname : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('External sockets forbidden in offline verification');
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
