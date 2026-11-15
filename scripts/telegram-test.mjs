// Bundle code only: secrets are read later at runtime, never embedded in output.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const require=createRequire(import.meta.url);
  const {build}=createRequire(require.resolve('wrangler'))('esbuild');
  const outfile=resolve('.wrangler/telegram-test.mjs');
  await build({entryPoints:['src/telegram/connection-test-cli.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
  await import(pathToFileURL(outfile).href);
} catch {
  console.error('Telegram test could not start. No automatic retry was made. Check the local installation and test-attempt record.');
  process.exitCode=1;
}
