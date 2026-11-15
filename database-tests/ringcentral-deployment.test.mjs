import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('disabled deployment pins the Worker entrypoint, SQLite migration, Cron and required secret names', async () => {
  const raw = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', raw);
  assert.equal(error, undefined);
  assert.equal(config.main, 'src/worker.ts');
  assert.deepEqual(config.triggers.crons, []);
  assert.deepEqual(config.env['workers-ai'].triggers.crons, []);
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'RINGCENTRAL_MONITOR', class_name: 'RingCentralMonitor' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1-ringcentral-monitor', new_sqlite_classes: ['RingCentralMonitor'] }]);
  assert.deepEqual(config.secrets.required, ['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET', 'RINGCENTRAL_JWT']);
  for (const name of config.secrets.required) assert.equal(Object.hasOwn(config.vars, name), false);
  assert.equal(config.vars.RINGCENTRAL_POLLING_ENABLED, 'false');
  assert.equal(config.vars.RINGCENTRAL_POLLING_PAUSED, 'true');
  assert.equal(config.vars.RINGCENTRAL_MONITORING_SECURITY_APPROVED, 'false');
  const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /export \{ default \} from '\.\/index'/);
  assert.match(worker, /export \{ RingCentralMonitor \}/);
  const poller = await readFile(new URL('../src/ringcentral/polling.ts', import.meta.url), 'utf8');
  assert.match(poller, /RINGCENTRAL_POLLING_LIVE_ENABLED = false/);
  const policy = await readFile(new URL('../src/ringcentral/policy.ts', import.meta.url), 'utf8');
  assert.match(policy, /phase7a_receive_only/);
});
