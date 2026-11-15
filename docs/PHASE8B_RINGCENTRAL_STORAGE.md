# Phase 8B — durable read-only monitoring (disabled)

Implemented in `src/ringcentral/polling-durable.ts` and `polling-runtime.ts`. `src/index.ts` now routes scheduled events to the `RINGCENTRAL_MONITOR` Durable Object namespace, using only `ringcentral-incoming:3322425015` as the singleton name. `src/worker.ts` exports the Cloudflare-only Durable Object class and existing handler; the original handler module remains importable by offline Node/SQL tools. No HTTP route can trigger monitoring. No Cron, alarms, automatic retries, or deployment were added.

## Storage and concurrency

The prepared namespace uses a SQLite-backed Durable Object (Wrangler migration `v1-ringcentral-monitor`). This is a local configuration change, **not an applied remote migration**. `DurablePollingStore` runs the entire existing polling callback inside `blockConcurrencyWhile`, including external awaits. Concurrent scheduled events cannot read an obsolete checkpoint or interleave writes. Each awaited storage `put` durably replaces the checkpoint with validated metadata. A process restart reloads the committed checkpoint and deduplication hashes; unfinished windows are scanned again using existing overlap/deduplication rules.

Only timestamps, version, auth hold, backoff, and SHA-256 message fingerprints are accepted. Extra properties are rejected before writing. No message text, numbers, raw message IDs, credentials, OAuth grants, or API bodies are persisted. Fingerprints remain pseudonymous metadata requiring a retention/security review; this is not authorization to process PHI.

An ordinary callback failure releases the lock without rolling back earlier completed saves; abandoned save callbacks are fenced. Durable Object resets discard in-flight execution. Cloudflare's `blockConcurrencyWhile` has a 30-second timeout and resets the object on timeout. The existing polling cycle permits at most one five-second OAuth request and three five-second page requests (20 seconds of request deadlines); storage/runtime overhead can still cause reset. Restart preserves completed saves, and no retry wrapper was added. The existing bounded-page backlog and overlap limitations still apply; this is not a guarantee of lossless history enumeration.

## Secret bindings and rollout gates

The runtime provider consumes these **Cloudflare secret bindings only**, lazily after the live and security gates pass:

- `RINGCENTRAL_CLIENT_ID`
- `RINGCENTRAL_CLIENT_SECRET`
- `RINGCENTRAL_JWT`

Do not put values in `vars`, source, command arguments, test fixtures, local secret files, or logs. No secrets were read or uploaded in this phase. A separately authorized operator may provision them through the Cloudflare dashboard's encrypted secret controls; provisioning/deployment is outside this task. OAuth still independently verifies `ReadMessages` scope and owner `3322425015`; provider permission metadata is only an assertion.

Before activation, all of the following remain required:

1. Security/privacy review and any necessary contractual/BAA arrangements for RingCentral and Cloudflare processing, including transient API responses and metadata retention. `RINGCENTRAL_MONITORING_SECURITY_APPROVED=true` records that review; it is not a substitute for it.
2. A **new recurring monitoring authorization**, not a retired discovery approval. Its JSON is supplied as `RINGCENTRAL_POLLING_APPROVAL_JSON`, with `operation: "receive_only_polling"`, `ownerId: "3322425015"`, `host: "https://platform.ringcentral.com"`, `permissions: ["ReadMessages"]`, a canonical future UTC `expiresAt`, and `productionMetadataStoreApproved: true`.
3. Approved secret provisioning and an operator-reviewed deployment applying the prepared DO binding/migration. Other Wrangler environments do not inherit DO bindings; they require separate deliberate configuration if ever used for monitoring.
4. Separate approval to change the existing source gate `RINGCENTRAL_POLLING_LIVE_ENABLED` (still **false**), set `RINGCENTRAL_POLLING_ENABLED=true`, and configure Cron (none configured). A suggested later interval is two minutes. Existing polling pause and `AI_GLOBAL_PAUSED` remain authoritative. Changing deployed pause flags requires the normal approved Cloudflare configuration rollout; no claim of instantaneous remote revocation is made.
5. A controlled read-only verification and operator procedures for authentication holds, rate limits, backlog, reporting, and expired approvals. Reports contain only safe counts/categories/timestamps; there is deliberately no automatic logging, forwarding, or monitoring dashboard in this phase.

On startup, monitoring establishes a baseline without listing historical messages. Tokens are cached only in the DO's memory and are reauthenticated after expiry or eviction. The existing polling engine retains bounded pagination, redirect rejection, response-size limits, deadlines, rate-limit backoff, global pause checks, incoming-SMS filters, and pinned production host/owner. Real SMS contents have **no sink** to Supabase, Telegram, Gemma, or logs. Sending and message/account mutations remain unavailable.

## Offline verification

Use `scripts/offline-guard.mjs` and `vitest.offline.config.mts`, which exclude secret files and remote bindings. `test/ringcentral-durable.spec.ts` exercises the real local SQLite-backed Durable Object adapter, actual eviction/restart, concurrent updates, abandoned saves, failure recovery, forbidden payloads/owners, backoff/auth retention, synthetic polling/deduplication across eviction, disabled secret access, and scheduled singleton routing with no retries. Existing Phase 8A tests continue to cover transport/auth/error and intake behavior.

Verified locally: **344 unit/integration tests across eight Vitest files**, **all nine relevant offline SQL/ledger test files**, and both application/test TypeScript checks passed. Wrangler binding types were regenerated under the offline secret/network guard. No live API requests, credential access, remote migrations, deployment, or Cron activation occurred.

Changed files: `src/worker.ts`, `src/index.ts`, `src/ringcentral/polling.ts`, `src/ringcentral/polling-runtime.ts`, `src/ringcentral/polling-durable.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `test/offline/wrangler.json`, `test/ringcentral-durable.spec.ts`, and this guide.

Sources: [Cloudflare Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
