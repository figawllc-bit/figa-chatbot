import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler'))('esbuild');
  const outfile=resolve('.wrangler/telegram-poll.mjs');
  await build({entryPoints:['src/telegram/polling-cli.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
  await import(pathToFileURL(outfile).href);
}catch{console.error('Controlled polling runner could not start. No automatic retry was started.');process.exitCode=1;}
