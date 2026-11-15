import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'] },
  plugins: [cloudflareTest({
    remoteBindings: false,
    // Dedicated directory has no secret files or remote bindings. Use the preload
    // guard as well; do not use the default secret-loading development config.
    wrangler: { configPath: './test/offline/wrangler.json' },
    miniflare: { bindings: { AI_ENABLED: 'false', AI_PROVIDER: 'workers-ai', AI_ALLOW_SYNTHETIC_REQUESTS: 'false', AI_FREE_TIER_CONFIRMED: 'false', SUPABASE_ENABLED: 'false', CONVERSATION_CONTROL: 'active' } },
  })],
});
