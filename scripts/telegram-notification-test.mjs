import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const require=createRequire(import.meta.url);
  const {build}=createRequire(require.resolve('wrangler'))('esbuild');
  const outfile=resolve('.wrangler/telegram-notification-test.mjs');
  await build({entryPoints:['src/telegram/notification-test-cli.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
  await import(pathToFileURL(outfile).href);
}catch{console.error('Notification test could not start. No automatic retry was made.');process.exitCode=1;}
