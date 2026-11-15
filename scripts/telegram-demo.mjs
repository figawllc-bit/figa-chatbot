// Reuse Wrangler's installed development bundler; no runtime dependency or secrets.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler'));
const { build }=wranglerRequire('esbuild');
const outfile=resolve('.wrangler/telegram-demo.mjs');
await build({entryPoints:['src/telegram/demo.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent'});
await import(pathToFileURL(outfile).href);
