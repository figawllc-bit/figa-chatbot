# Receive-only deployment checklist

The default `wrangler.jsonc` is the deployment target: `figa-chatbot`, `src/worker.ts`, SQLite DO namespace `RINGCENTRAL_MONITOR`, migration `v1-ringcentral-monitor`. The `workers-ai` environment remains a separate local AI configuration, not the monitoring deployment target. Both explicitly set `triggers.crons: []`. Source live gate is false, polling is disabled and paused, security approval defaults false. No deployment or live requests were made.

Required encrypted secret bindings are declared with Wrangler `secrets.required`: `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET`, `RINGCENTRAL_JWT`. No credential values are in `vars`. This verifies configuration **only**; presence and encryption of actual remote bindings cannot be confirmed without separately authorized Cloudflare inspection/provisioning. Wrangler validates required secrets during a real deploy; an offline dry run does not prove they are provisioned.

## Exact commands

PowerShell, project root. Offline bundle validation (safe now, no upload or credentials):

```powershell
node --import ./scripts/offline-guard.mjs node_modules/wrangler/bin/wrangler.js deploy --dry-run --config ./wrangler.jsonc --env= --outdir .wrangler/deployment-readiness
```

**Only after separate production-deployment approval**, target-account verification, and secret provisioning, deploy the disabled artifact:

```powershell
npx --no-install wrangler deploy --config ./wrangler.jsonc --env=
```

Use an operator-controlled terminal/Cloudflare dashboard for encrypted secret provisioning. Do not paste secrets into chat, files, arguments, or Git. Dashboard secret changes and `wrangler secret put` can deploy a new version: they require that same separate approval. No provisioning command was executed here. Do not deploy the `.wrangler` test artifacts or use the secret-stripping offline guard for a real authenticated deployment.

## Short rollout checklist

1. Confirm target Cloudflare account, Worker and migration history. No remote history was inspected; if the target has existing DO migrations, preserve them and reconcile this pending tag before deployment. Never delete, rename or recreate the monitoring namespace to reset checkpoints.
2. Confirm security/privacy review, metadata retention policy, and necessary contractual/BAA arrangements for transient RingCentral data and Cloudflare hosting. Do not process real messages until approved.
3. Provision/verify the three encrypted secrets for the dedicated ReadMessages-only app. OAuth must still independently verify scope and owner `3322425015`. A new recurring monitoring approval with expiry is required; old one-shot approvals do not apply.
4. Deploy the disabled configuration only after approval; confirm Cron is empty, polling stays disabled, and the SQLite binding/migration is applied. This step does **not** enable monitoring.
5. Separately authorize controlled receive-only monitoring: review the source live-gate change, recurring approval JSON, `RINGCENTRAL_MONITORING_SECURITY_APPROVED=true`, `RINGCENTRAL_POLLING_ENABLED=true`, `RINGCENTRAL_POLLING_PAUSED=false`, and a chosen Cron interval. None were enabled here. Keep all delivery/mutation paths disabled.
6. Check the initial baseline, then safe counts/checkpoint progress. No real content, telephone numbers or IDs belong in logs, AI, Telegram, or development Supabase. Current live poller has no content sink; only approved metadata is stored. Do not enable request-body/response-body capture or add a debug logger. Scheduled reports currently have no external logging/forwarding sink.

## Pause and rollback

Emergency configuration rollback: restore `RINGCENTRAL_POLLING_ENABLED=false`, `RINGCENTRAL_POLLING_PAUSED=true`, security approval false, source gate false, and `triggers.crons: []`, then deploy that reviewed disabled configuration using the same deployment command. An existing global AI pause is also honored. Configuration rollout is not instantaneous; in-flight requests may finish, but existing pause checks fence subsequent processing. Retain the DO binding, migration and stored checkpoint. This stops monitoring without undoing durable state; do not roll back to a pre-DO version or delete migrations/storage. Restart after separate authorization continues from the checkpoint, with overlap deduplication. A gap exceeding seven days stops for explicit backfill review.

Offline verification uses synthetic SMS, mocked HTTP, actual local DO storage/RPC, and eviction recovery. The scheduler's closed source gate is simulated only inside the integration test; deployed code remains closed. Tests cover full scheduled routing, baseline, detection, pause, disable/rollback, restart and duplicate suppression. Existing transport tests cover auth expiry, owner/scope checks, rate limiting and errors. No live mailbox, contracts, credentials, Cloudflare account state or operational production rollback was verified by these tests.

Results: **345 targeted Vitest tests passed**, **all 10 relevant offline SQL/ledger/configuration test files passed**, both TypeScript checks passed, and the exact default-environment Wrangler dry-run above bundled successfully. Binding types were regenerated. No production deployment, credential access, RingCentral requests, Cron activation, or external delivery occurred.

References: [Wrangler configuration and explicit empty Cron](https://developers.cloudflare.com/workers/wrangler/configuration/), [required encrypted secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
