# Phase 7A: offline receive-only RingCentral SMS

Phase 7B now prepares gated OAuth/HTTPS integration separately. See
[PHASE7B_RINGCENTRAL_AUTH.md](PHASE7B_RINGCENTRAL_AUTH.md) for its mock-only verification
and the live authorization prerequisites. The Phase 7A fixture client below remains
mock-only; the Phase 7B live connection gate remains false.

Status: implemented locally; no RingCentral connection, subscriptions, SMS, deployment,
remote SQL migration, credential access, or live message/contact reads performed.
All example numbers use fictional NANPA 555-01xx numbers. No FIGA service policy is
inferred from these examples. Existing live Gemma ledgers are unrelated and untouched.

## Safety revision: authored fixtures and mock-only one-message client

`syntheticData: true` and the `is_synthetic` column are not proof of fictional
provenance. The receiver now accepts only the reviewed catalog in
`src/ringcentral/fixture-policy.ts`: account `100001`, extensions `200001`/`200002`,
subscription `fictional-subscription`, business numbers `+15035550100`/`+15035550101`,
customer numbers in the reserved `+150355501xx` fixture range, six-digit fixture
message IDs beginning with `3`, and exact authored text. Nonempty attachments are
rejected. Adding text requires a code review, never copying material from live
messages. Additional fields such as caller names are not persisted.

The **unapplied** `20261115000100_ringcentral_receive_only.sql` migration was revised
to enforce the fictional account, extensions, numbers, IDs and text independently
in SQL. Unknown observation fields (including attachments or a caller-added
`is_synthetic`) are rejected before writes. Table constraints add another boundary.
Older migrations are unchanged. Only ephemeral local databases were migrated.
The fixture `SupabaseRingCentralRepository` accepts no environment credentials and
cannot make network RPCs; local tests override its RPC with PGlite. Consequently,
this adapter cannot become a real-data receiver merely by applying the migration,
asserting a flag, or supplying service credentials. Keep these restrictions when
later adding a separate, explicitly authorized real-data path and retention policy.

`src/ringcentral/read-only-test.ts` is a separate, disabled-by-default **mock-only**
client. It imports no persistence, OAuth, environment, SDK or filesystem code and has
no live transport or live enable flag. `mockEnabled` enables injected mock responses
only. It never accepts or loads live tokens; the request carries a fixed fictional
test token. Only module-created declarative fictional HTTP capabilities are accepted; arbitrary
executors (including wrapped `fetch`) are rejected. See
[PHASE7B_RINGCENTRAL_AUTH.md](PHASE7B_RINGCENTRAL_AUTH.md) for the offline credential
boundary and paired identity hashes. Run tests with the offline guard as an
additional boundary against external Node connections.

The mock protocol enforces:

* One explicit approval: exact HTTPS platform origin, numeric account/extension/
  message IDs (no `~`, path fragments, queries or history endpoint), purpose,
  direction, expected fictional subject SHA-256 and a future expiry within one hour.
* Exactly `ReadMessages` in approval metadata; extra scopes are rejected. For a
  future live test this metadata must also be supported by independently verified
  app/user/token grants; this mock does not claim to inspect a real token.
* Fixed `GET /restapi/v1.0/account/ACCOUNT/extension/EXTENSION/message-store/MESSAGE`,
  no request body or query, manual redirects, HTTP 200, `application/json`, at most
  16 KiB streamed bytes, and a five-second application deadline. These are project
  safety bounds, not claims about RingCentral platform limits.
* One durable reservation **before** transport dispatch, a per-instance concurrent
  execution fence, no retries on errors/timeouts/redirects, and no second resource
  fetch. The filesystem ledger used in offline tests refuses reuse across client
  instances and restarts; do not replace it with a fresh ledger after a failure.
* Exact returned message ID, SMS type, direction, optional resource URI and expected
  subject hash. Recordings, fax and non-text attachments are rejected. Text attachment
  metadata may be inspected but no attachment URL is followed. No read/unread change
  is requested. Results contain verification metadata only; no message text, phone
  numbers, headers, tokens, attachment URLs or raw bodies are logged or saved.

The future live test must remain separate from synthetic persistence. Do not pass
an API response into the fixture receiver, create a synthetic contact/conversation
for it, or save raw responses/phone numbers to a ledger. A live test needs a new
explicit authorization and separately reviewed live transport/credential injection;
this task provides **no command that can run it** and changes no environment flags.

Non-secret prerequisites for that later authorization:

1. Approved platform origin (`https://platform.ringcentral.com` or the explicitly
   selected devtest origin), exact numeric account ID, extension ID and **one**
   message ID. Obtain the ID out of band; do not enumerate existing FIGA messages.
2. Operator confirmation that the selected SMS contains only controlled fictional
   content, plus its expected direction and subject SHA-256 computed locally from
   the known fictional text. Do not paste customer SMS text or credentials into chat.
3. Approval expiry/time window, one HTTP resource attempt, five-second deadline,
   16 KiB bound, safe metadata-only reporting and no persistence. No automatic retry
   or token refresh during the one-message run.
4. Independent confirmation that the app/user/token grant permits **only
   `ReadMessages`**, scoped to the authorized extension, and that any exposed
   credentials have been rotated. Scope/account evidence must omit secret values.
   Arrange fresh credential injection via an approved isolated secret mechanism;
   do not load existing `.dev.vars*`/`.env*` files or reuse exposed tokens. Authentication
   provisioning/token exchange, if needed, requires separate approval; the single
   GET budget is not permission to make additional API calls.
5. A unique exclusive ledger path tied to this authorization, confirmed unused;
   preserve all previous ledgers. Approve the reviewed live transport activation
   separately; keep subscriptions, webhook ingress, SMS sends, deployments and all
   remote migrations disabled. No migration is required to read one approved SMS.

Remaining blockers are intentional: no live connection is enabled (Phase 7B
prepares OAuth protocol simulation only); no exact real test tuple/grant evidence has been provided; and no
real-data storage policy is authorized. The test fixture flag alone cannot remove
these blockers.

## Implemented behavior

`src/ringcentral/events.ts` validates the notification envelope against an explicit
account, extension, subscription, and list of owned SMS numbers. IDs are strings
(unsafe JavaScript numeric IDs are rejected). Direction, type, recipients, text,
status, dates and any message resource URI are checked. Attachments and URIs are
never fetched. Display names and arbitrary actor/user fields confer no authority.
Unknown scopes, missing text, unsupported/group recipients and malformed events
are rejected, with generic errors and no body logging. This is intentionally a
single-recipient, text-SMS subset, not full MMS, group messaging, A2P or fax support.

Two documented formats are handled:

* `/restapi/v1.0/account/{accountId}/extension/{extensionId}/message-store/instant?type=SMS`
  supplies an inbound SMS record in `body` (including `id`, `from`, `to`, `subject`,
  `direction`, `messageStatus`, and creation/modification times).
* `/restapi/v1.0/account/{accountId}/extension/{extensionId}/message-store?type=SMS`
  reports `changes` with counts, not full SMS records. The adapter returns
  `needs_message_store` until separately supplied fixture message-store records
  are available. It never invents messages from counts. The general event supports
  inbound/outbound filtering; the instant event is used only for inbound.

Sources: [instant event](https://developers.ringcentral.com/guide/notifications/event-filters/instant-message),
[message-store event](https://developers.ringcentral.com/guide/notifications/event-filters/message),
[message-store record format](https://developers.ringcentral.com/guide/messaging/message-store/working-with-message-store).

`OfflineRingCentralReceiver` requires the authored fixture catalog above,
`syntheticData: true` and an injected local repository.
The local HTTP fixture path `/ringcentral/offline` additionally requires localhost,
`RINGCENTRAL_OFFLINE_ENABLED=true`, and an explicitly injected receiver. The default
Worker injects none. The offline flag defaults to disabled and was not added to
existing environment files. `/ringcentral/webhook` always returns 404, even with
offline opt-in. No OAuth, subscription management, polling or SMS transport exists.

## Durable mapping, deduplication and origin

The review-only migration `20261115000100_ringcentral_receive_only.sql` was applied
only to ephemeral PostgreSQL in tests. It adds five RLS-protected, service-RPC-only
tables: `rc_threads`, `rc_observations`, `rc_receipts`, `rc_origins`, `rc_optouts`.
All remain synthetic-only. A production data policy/schema review is required
before accepting real personal information; this migration is not authorization
to modify remote Supabase.

The existing contacts/conversations tables are reused. A thread is mapped by
account + extension + owned business number + external customer number. RingCentral
`conversationId` alone, an extension ID alone, or a caller-supplied FIGA ID cannot
select a conversation. A closed or blocked thread stays closed/blocked. No chat
access token is issued for these mappings. Raw observations live in `rc_observations`;
they do not enter the AI/chat transcript, intake projections, or Telegram queue.

`figa_rc_observe` serializes an extension, validates batches, and commits event
receipts/mappings/observations together. Envelope UUID redelivery is deduplicated;
the scoped RingCentral message ID prevents duplicates across different event UUIDs
and subscription overlaps. Conflicting identities/content are rejected. Newer
message status observations update the existing record; older status updates do
not replace newer status. A new observation increments conversation revision to
invalidate stale application work. Retry with the same event, not a new invented
message ID. Failed persistence must remain retryable; an aggregate event is not
marked complete merely because its counts were received.

| Observation | Attribution and behavior |
|---|---|
| Inbound to a configured FIGA number, from one external number | Customer observation; no inference or reply |
| Outbound with trusted scoped message-ID correlation to chatbot delivery | Chatbot observation; no staff takeover |
| Outbound with trusted scoped message-ID correlation to a verified, active staff roster entry with takeover permission | Staff observation; sets review hold |
| Other outbound, including shared-extension messages or display names claiming to be staff | Unknown; sets review hold, never guessed to be staff |

There is no runtime API to write origin proofs, clear a hold, or clear an opt-out.
Tests seed proofs only inside local SQL. A future trusted origin registry must
bind the API-returned external message ID to a confirmed sender and account/extension;
customer webhook fields, matching text, and `ownerId` must never create proofs.
The shared extension does not identify an individual employee. Human action outside
an attributable staff interface will remain unknown. Unknown-to-known reconciliation
and hold clearing require an explicitly authorized process; late chatbot correlation
must not silently clear a hold already raised.

Verified staff observations do not assign HUMAN ownership or release another owner.
Future AI ingress must check the review hold before invoking the engine. Any actual
staff ownership transition must reuse existing permission/revision/active-owner
transaction rules. Existing Telegram ownership, HUMAN mode and closed/blocked status
remain authoritative. Another employee's observed reply cannot replace the owner.

## Opt-outs, pause and future delivery

Inbound STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT (also a limited polite
form) creates a sticky opt-out for account + business number + customer number.
It therefore survives later messages and extension changes. START does not clear
consent. No confirmation SMS is sent. Carrier/RingCentral opt-out behavior is
independent; this local safeguard does not replace provider-side consent controls.
Unrecognized natural-language opt-outs need staff review before enabling delivery.

`AI_GLOBAL_PAUSED` defaults to false/unset. When explicitly true, the existing engine
returns no assistant text and invokes neither inference nor deterministic replies.
It does not change conversation ownership/status. No existing flag values were changed.

`figa_rc_delivery_snapshot` reads current mode/status/revision, active ownership,
review hold, and opt-out state. `futureDeliveryBlockers` checks these plus global
pause and expected revision. It ALWAYS includes `phase7a_receive_only`: nothing
in this phase can authorize SMS. A future sender must re-read this authoritative
snapshot and the current global pause immediately before delivery, after generation
and after any queue wait/retry. Fail closed on lookup failure. Add an outbound
idempotency/correlation ledger and a final revision/control fence before introducing
any SMS transport. SQL and an external HTTP send cannot form one atomic transaction:
ownership/STOP races, uncertain delivery, provider opt-outs, and reconciliation
must be designed and tested before lifting the receive-only gate. Never retry an
uncertain send automatically. The present module has no sending function to call.

## Webhook verification (protocol implemented offline, live route disabled)

For later approved webhook setup, RingCentral sends a POST with `Validation-Token`.
Return HTTP 200 promptly with exactly that header value echoed; the setup response
must arrive within 3000 milliseconds. Use a public HTTPS endpoint with TLS 1.2+.
The pure `webhookProtocol` helper separates this setup challenge from ingestion:
an echoed challenge never authorizes storing a notification.

For event delivery, explicitly configure `deliveryMode.verificationToken` and
require matching `Verification-Token` on every notification. This is a shared secret,
not a cryptographic body signature; TLS, secret storage/rotation, account/extension/
subscription allowlists, payload limits, deduplication and monitoring remain required.
Reject unauthorized events before parsing/storing their bodies. Never log tokens,
headers, raw bodies, phone numbers, message text or customer data. Store authorized
events durably before acknowledging; perform hydration asynchronously with a durable
retry cursor/outbox after that receiver is separately implemented. Do not run AI in
the webhook acknowledgement path. The current offline route does not pretend to be
a deployable live webhook service.

Sources: [webhook setup](https://developers.ringcentral.com/guide/notifications/webhooks/creating-webhooks),
[event verification](https://developers.ringcentral.com/guide/notifications/webhooks/receiving).

## Exact prerequisites for a first read-only connection

1. Obtain a separate explicit authorization defining the tenant, extension, owned
   test SMS number, test customer number, permitted endpoint, time window, record
   limit, and retention. Initially allow only an explicitly identified fictional
   test record. No broad history, contact reads, account modifications or SMS sends.
2. Use an approved app and authorized user for that extension. The app scope for
   message-store reads is **`ReadMessages`**. Do not grant `SMS`, `EditMessages`,
   contact, call, routing, account-management or coworker access permissions.
   App scopes and the authenticating user's permissions must both permit the read.
3. Authorize through supported OAuth: authorization-code flow for an approved user
   (with securely stored refresh token), or JWT flow only for a preauthorized server
   app/user. JWT credentials are exchanged at `/restapi/oauth/token` for access
   tokens; do not use a JWT as a resource API bearer token. Keep client credentials,
   JWT/refresh/access tokens in an approved secret store, never fixtures/dev logs.
   Use the correct authorized production or test platform host; never mix tenants.
4. The first read-only operation can be GET
   `/restapi/v1.0/account/{accountId}/extension/{extensionId}/message-store/{messageId}`
   for the one approved fictional message ID. Do not mark it read, edit/delete it,
   download attachments, enumerate contacts or list existing FIGA messages.
   The isolated read client above is mock-only; a live authentication/transport
   activation still requires separate approval. Authentication token exchange is not permission to mutate business
   configuration. If no approved message ID exists, stop; arrange the fixture under
   separate authorization rather than searching existing messages.
5. A later webhook trial is a separate action, not a read-only API connection:
   creating/renewing/deleting a subscription changes remote configuration and needs
   explicit approval. It additionally requires **`SubscriptionWebhook`** (developer
   console label: Webhook Subscriptions), `ReadMessages`, an approved HTTPS receiver,
   verification secret, known subscription ID, and renewal/expiry monitoring.
   Proposed filters, not created by this task:

   ```json
   {
     "eventFilters": [
       "/restapi/v1.0/account/ACCOUNT/extension/EXTENSION/message-store/instant?type=SMS",
       "/restapi/v1.0/account/ACCOUNT/extension/EXTENSION/message-store?type=SMS&direction=Outbound"
     ],
     "expiresIn": 3600,
     "deliveryMode": {
       "transportType": "WebHook",
       "address": "https://APPROVED-HOST/ringcentral/webhook",
       "verificationToken": "SECRET-FROM-APPROVED-STORE"
     }
   }
   ```

   The proposed expiry is one hour; approve it explicitly and inspect the returned subscription;
   plan renewal rather than assuming indefinite delivery. Outbound change events
   require bounded, authorized message-store hydration, pagination, overlapping
   checkpoints and reconciliation so duplicates/out-of-order notifications do not
   lose staff observations. No such live hydration is performed here.
6. Keep outbound delivery hard-disabled, global pause enabled for the live receive
   trial, and all generated replies unsent. First verify inbound capture, STOP,
   outbound attribution/unknown holds, redelivery, and existing staff ownership.
   Do not lift the send gate as part of a read-only test.

Sources: [permissions/scopes](https://developers.ringcentral.com/guide/basics/permissions),
[message endpoint](https://developers.ringcentral.com/api-reference/Message-Store/readMessage),
[OAuth authorization code](https://developers.ringcentral.com/guide/authentication/quick-start),
[JWT authentication](https://developers.ringcentral.com/guide/authentication/jwt-flow),
[subscription API](https://developers.ringcentral.com/api-reference/Subscriptions/createSubscription).

## Offline verification

Run tests with the existing `scripts/offline-guard.mjs` preload and
`vitest.offline.config.mts`. The guard excludes application secret files and external
sockets. `test/ringcentral.spec.ts` uses fictional event fixtures;
`database-tests/ringcentral-receive.test.mjs` runs actual migrations/RPCs in ephemeral
PGlite. All network and AI calls are tripwires. Parallel fixture requests exercise
independent conversation mapping; PGlite is one local connection, not a production
multi-connection concurrency/load test. Before live ingress, review/apply migrations
only to the separately authorized environment and test true PostgreSQL contention,
crash recovery and webhook acknowledgement/hydration durability.

```powershell
node --import ./scripts/offline-guard.mjs node_modules/vitest/vitest.mjs run --config vitest.offline.config.mts test/ringcentral.spec.ts --silent
node --import ./scripts/offline-guard.mjs --test database-tests/ringcentral-receive.test.mjs
node --import ./scripts/offline-guard.mjs node_modules/vitest/vitest.mjs run --config vitest.offline.config.mts test/ringcentral-read-only.spec.ts --silent
node --import ./scripts/offline-guard.mjs --test database-tests/ringcentral-read-ledger.test.mjs
```
