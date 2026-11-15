import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ['test/**/*.spec.ts'] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Default environment has no remote AI binding; tests inject mock run() methods.
			miniflare: { bindings: { AI_ENABLED: "false", AI_PROVIDER: "workers-ai", AI_ALLOW_SYNTHETIC_REQUESTS: "false", AI_FREE_TIER_CONFIRMED: "false", SUPABASE_ENABLED: "false", CONVERSATION_CONTROL: "active" } },
		}),
	],
});
