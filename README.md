# FIGA local chatbot prototype

## Offline AI failure diagnosis

Internal `figa_ai_failure` records contain only an allowlisted error type,
failure category/stage, numeric Cloudflare code/HTTP status when available, and
whether the local binding was invoked. They never include exception messages,
headers, prompts, transcripts, or response bodies. The HTTP response retains generic
fallback wording and existing public engine reasons. The isolated AI harness saves
the same sanitized diagnostics alongside its fictional test results.

An offline reproduction confirmed that a Node `AbortSignal` cannot cross the
Miniflare/getPlatformProxy RPC boundary (`DevalueError`). The Node-only harness now
strips that signal from RPC arguments; native Worker cancellation is unchanged.
Local timeouts remain enforced, but cannot cancel an already-dispatched remote
request through that wrapper. The old two-attempt ledger is preserved. It did not
capture its exceptions, so historical authentication/quota/server outcomes remain
unproven. No live inference was used to diagnose or verify this correction.

Run guarded offline checks without loading development secrets:

```powershell
node --import ./scripts/offline-guard.mjs scripts/diagnose-ai-proxy.mjs
node --import ./scripts/offline-guard.mjs node_modules/vitest/vitest.mjs run --config vitest.offline.config.mts
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit -p test/tsconfig.json
```

The test config has no remote bindings. The preload removes credentials, rejects
secret-file reads, and forbids external sockets while allowing local test IPC.
After explicit approval for **one** live test, the AI-only launcher supports
`--run-one-provider` (or `--run-one-caregiver`) with an exclusive one-attempt ledger,
the existing model/schema, no non-Cloudflare credentials, and no retries. Do not
run either live option without new approval. A binding attempt does not itself
prove Cloudflare-side model execution; inspect the sanitized category and require
a valid model response before declaring success.

## Phase 6: FIGA knowledge and conversation behavior

The approved service description is that FIGA Staffing connects adult foster home
and group home providers with caregivers seeking employment opportunities.
`src/knowledge.ts` is the editable knowledge base: approved FAQs, services, intake
procedures, business rules, and escalation rules have explicit approval provenance.
Only approved entries enter replies and the Gemma extraction prompt. The separate
`approvalNeeded` list records unknown company details without proposing values.
Do not add company facts without FIGA approval. FAQ schema indices follow the
approved list automatically; the model extracts quoted facts, never final prose.

Providers supply name, home type, city/state, position, requested start date,
shift, and caregiver count. Organization, urgency, and notes can be supplied but
do not block completion. Caregivers supply name, preferred city/state, position,
availability, shift, and professional experience; application status is optional.
The assistant asks one question at a time, remembers supplied answers, accepts
corrections, and flags urgent timing and completed intake for staff review.
It makes no staffing, hiring, fee, or response-time promises. Staff follow-up
requires a separately approved operational path; local replies do not claim a send.

`homeType` is saved in the existing `conversations.state.collected` JSON through
the existing transaction RPCs. Existing provider and caregiver projection columns
continue to work; there is no schema migration or new infrastructure. Existing
saved intakes without a home type are asked for that missing detail on continuation.
HUMAN ownership and closed status remain authoritative, with empty automated replies.

Safe verification (no live Gemma calls or messaging):

```powershell
npm.cmd run test:run -- test/phase6.spec.ts test/index.spec.ts test/ai.spec.ts test/persistence.spec.ts
node --test database-tests/phase6-persistence.test.mjs database-tests/human-suppression.test.mjs
npm.cmd run typecheck
```

The Phase 6 suite includes 10 provider and 10 caregiver multi-turn HTTP scenarios,
mocked Gemma extraction, approval guards, medical/credential refusal, and control
suppression. SQL integration tests use ephemeral local PostgreSQL and reject all
network/model attempts. They do not establish live model extraction quality or
modify the remote Telegram test conversation.

Permission-aware Telegram takeover controls and a single-update local polling
runner are prepared. `npm.cmd run telegram:poll -- --dry-run` is offline by
default. See [controlled takeover approval and test steps](supabase/CONTROLLED_TAKEOVER.md).
No staff permissions, live flags or remote migrations are changed automatically.

For one selected staffing notification, use `npm.cmd run telegram:notification:test -- --dry-run`.
This is read-only and requires the new, pending preview/claim migration. See
[notification test instructions](supabase/NOTIFICATION_TEST.md). No real notification
is sent without `--send --notification-id <UUID>`; Telegram application flags stay disabled.

Phase 4 now includes a simulated Telegram staff bot, verified staff roster,
transactional takeover/resolve/return actions and a queued notification flow.
Run `npm.cmd run demo:telegram` for a fully offline demonstration, or append
`-- --interactive` for a fictional staff console. See
[staff setup and security](supabase/STAFF_TELEGRAM.md). The new migration is
pending approval; no external Telegram transport or hosted schema change is enabled.

Phase 3 persistence supports an isolated synthetic-data Supabase development
project. Setup and security requirements are in [supabase/README.md](supabase/README.md).
Saved conversations use a server-issued HttpOnly access cookie and authoritative
database state. Credentials stay in ignored local configuration.

Local development / dry run only. Provider and caregiver intake, approved prototype
FAQs, and local review flags. Deterministic by default; optional Cloudflare Workers
AI uses exactly `@cf/google/gemma-4-26b-a4b-it`. No OpenAI API calls or API keys.
No RingCentral, SMS, Telegram, production databases, or live human takeover.

## Offline development and tests

```powershell
cd 'C:\Users\Plan B\figa-chatbot'
npm.cmd run dev -- --ip 127.0.0.1 --port 8787
npm.cmd run typecheck
npm.cmd run test:run
# Workers AI and conversation safety tests only:
npm.cmd run test:run -- test/ai.spec.ts
```

Open http://127.0.0.1:8787/ for chat, collected details, classification, review
indicators, reset, and complete fictional provider/caregiver demos. The default
Wrangler environment has no remote bindings. AI remains unavailable there.
Stateless chats live in page memory. Saved chats restore from the isolated database.

Tests use injected mock `AI.run()` bindings and synthetic data, including mocked
quota exhaustion. They do not authenticate or run remote inference. Test flags
remain disabled even if a developer enables AI in their own local configuration.

## Optional live Gemma preview, without deployment

Workers AI models run on Cloudflare, even with a local Worker. A live test sends
synthetic messages, collected details, and bounded history to Cloudflare and uses
account quota. Never use real customer, resident, medical, or personal data.
Start the integrated local session with:

```powershell
npm.cmd run dev:ai
```

This command selects the remote Workers AI binding while explicitly loading
`.dev.vars` for **both AI settings and the existing Supabase credentials**.
Wrangler normally replaces `.dev.vars` with `.dev.vars.workers-ai` when the
named environment is selected; those files are not merged. The explicit
`--env-file .dev.vars` avoids maintaining a second copy of the database secret.
The old `.dev.vars.workers-ai` file is not used by this command.

The current local AI settings are `AI_ENABLED=true`, `AI_PROVIDER=workers-ai`,
`AI_ALLOW_SYNTHETIC_REQUESTS=true`, `AI_FREE_TIER_CONFIRMED=false`,
`AI_SYNTHETIC_TEST_CALLS=2`, and `AI_TIMEOUT_MS=15000`. Keep the existing
`SUPABASE_*` settings in the same ignored file; never print or commit its contents.
This bounded smoke-test configuration allows at most two model attempts per
server isolate, including failures. Restarting resets that local budget; it is
not an account-wide spending cap. Further attempts fall back deterministically.
Only set `AI_FREE_TIER_CONFIRMED=true` after verifying the Workers Free plan and
remaining quota yourself. No billing or subscription changes are performed.

Open http://127.0.0.1:8787/, select **Workers AI / Gemma**, check the fictional-data
confirmation and **Save fictional conversation** before sending a message. The
response indicator distinguishes Cloudflare Gemma 4, deterministic fallback,
and intentional local replies such as greetings. Refresh restores a saved chat
using its original browser cookie. Select AI and confirm fictional data again
before continuing after a refresh. API requests still default to deterministic.
Greetings do not invoke the model, collect names, or add staff review flags.

The Worker executes locally; only model inference and explicitly configured
isolated database operations use remote services. `npm.cmd run dev` uses no
remote AI binding, but still loads the database settings from `.dev.vars`.

Try `I need two caregivers tomorrow night in Salem.` Supply a fictional name
and organization, then try `Make that three, in Portland instead.` Collected
values stay user-reported and unverified; relative dates require clarification.
No state is inferred from a city. Nothing is submitted or confirmed.

Workers Free includes a daily allocation; exceeding it produces account-limit
error `3036`. On Workers Paid, usage above the allocation may be billed instead
of rejected. This application cannot enforce an account-wide free-spend ceiling.
Monitor your account quota before enabling live inference. It never upgrades
plans or retries inference automatically. Quota, capacity, timeout, permission,
and model failures all return a deterministic response with preserved context.
The UI shows safe reasons such as `ai_quota_exhausted`, `ai_rate_limited`, and
`ai_failed`; raw provider errors and conversation contents are not logged.

## API and state

- `GET /`: JSON status; browsers accepting `text/html` receive the interface.
- `GET /health`: status plus safe AI availability, provider, and model metadata.
- `POST /chat`: JSON `{ "message": "I need a caregiver tomorrow." }`.

Pass the returned `state` unchanged in subsequent requests. Optional live AI
requests additionally require `"engine": "ai", "syntheticData": true`.

```powershell
$first = Invoke-RestMethod http://127.0.0.1:8787/chat -Method Post -ContentType 'application/json' -Body '{"message":"I need a caregiver tomorrow."}'
$body = @{ message = 'My name is Alex Morgan from Example Care.'; state = $first.state } | ConvertTo-Json -Depth 10
Invoke-RestMethod http://127.0.0.1:8787/chat -Method Post -ContentType 'application/json' -Body $body
```

Responses retain `conversationType`, `assistantResponse`, `collectedInformation`,
`state`, `humanAttentionNeeded`, `humanAttentionReasons`, `complete`, and `mode`.
`engine.used` reports `deterministic`, `workers-ai`, or `none`. Every collected
value has `informationStatus: user_reported_unverified`. Review flags are local;
no notifications are sent. Correct deterministic details using `field: value`.

## Safety, modules, and limitations

`src/ai/workers-ai.ts` calls `env.AI.run()` with strict JSON schema, no tools,
reasoning disabled, non-streaming output, `store: false`, and a 1024-token output
cap. `src/ai/prompt.ts` holds provider-neutral extraction instructions.
`src/ai/extraction.ts` validates exact evidence quotes from the current message.
`src/ai/engine.ts` owns policy, state changes, approved answers, and fallback.
`src/engine.ts` remains the deterministic engine. The UI and API are in
`src/ui.ts` and `src/index.ts`; `src/safety.ts` guards both engines.

Only exact user quotes can become new AI-collected values; numbers are normalized
locally. No generated prose is shown as a FIGA policy or promise. Carried state
retains up to six messages of 1000 characters for compatibility, but inference
sends only the latest three messages of at most 300 characters each and clips
each collected field to 200 characters. The original carried fields are preserved.
Requests allow at most 2000 message characters and a 32 KiB body; generated
content is checked against a 64 KiB cap. Timeouts default to eight seconds and
can be configured within 1–15 seconds. A timeout requests cancellation, though
remote work may already have consumed quota.

Sensitive-input and override guards run before inference. Blocked and
`human_takeover` state prevents both engines from running. The server setting
`CONVERSATION_CONTROL` can enforce either control regardless of client state.
Existing review flags survive AI turns; no live takeover integration is added.

Fictional-data attestation and heuristic sensitive-data detection cannot prove
that text has no real personal data. Client state is unsigned and untrusted.
Semantic extraction can be wrong even when quotes are grounded. All details
need staff review, and no approved FIGA business FAQs have yet been supplied.
Live model availability, account plan, and free quota are not verified by mocked
tests or by the `AI_FREE_TIER_CONFIRMED` setting. The next step is an operator-
verified free account and a live synthetic evaluation. A successful `/health`
response means configuration is ready, not that inference succeeded. A response
with `engine.used=workers-ai` from the real preview verifies live inference;
`deterministic` means fallback was used. Also inspect the collected values and
follow-ups; inference success alone does not prove correct extraction.

Verification on 2026-11-12: Wrangler authenticated successfully. The existing
OAuth login could not read billing subscriptions (HTTP 403), and the browser
dashboard required sign-in. The selected model's Free-plan eligibility was
confirmed from official documentation; account plan and remaining quota were
not independently verified, so `AI_FREE_TIER_CONFIRMED` remains false.

Using the explicitly authorized two-attempt synthetic test allowance, **two real
Gemma calls succeeded from the UI at `127.0.0.1:8787`**:

- `I need two caregivers tomorrow night in Salem.` returned `engine.used=workers-ai`,
  count `2`, date `tomorrow`, shift `night`, and city `Salem`. It asked for name
  and organization without promising availability (about 10.4 seconds).
- `My name is Alex Morgan from Example Care.` also returned `workers-ai`, retained
  the previous details, collected the fictional contact/organization, and asked
  for the missing state (about 6 seconds).
- A third message, `Make that three caregivers instead.`, made no inference call:
  it returned `deterministic` / `ai_test_budget_exhausted`, preserved context,
  and corrected the count to `3` (about 9 milliseconds).

TypeScript checks and all **100 tests** passed, including the original 30 tests.
No applications were deployed, no existing Workers were accessed, no account
settings or billing plans were changed, and no new API token was created. Remote
activity was limited to authentication/read-only subscription checks, Wrangler's
temporary AI binding connection, and the two synthetic model calls. The local
server remains running; its two-call test budget is exhausted. For sustained
testing, verify the account plan/quota rather than repeatedly restarting the
smoke-test budget. Later work includes staff-approved business content. Do not
deploy this prototype.

After changing bindings, regenerate types:
`npm.cmd run cf-typegen -- --env workers-ai`.
Old OpenAI settings in an existing `.dev.vars` are ignored by the application;
the environment-specific file prevents those old defaults from overriding the
new preview settings. No application AI secret is needed; Wrangler manages
Cloudflare authentication. Do not commit local authentication or dev-vars files.

Official references:
[Gemma model and schemas](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/),
[local Workers AI development](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/#4-develop-locally-with-wrangler),
[limits](https://developers.cloudflare.com/workers-ai/platform/limits/),
[pricing and free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[error codes](https://developers.cloudflare.com/workers-ai/platform/errors/).
