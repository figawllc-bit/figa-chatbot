# Phase 8A — receive-only incoming-SMS polling

Implemented and verified offline. **Live polling, Cron registration, SMS delivery,
and deployment remain disabled.** No live RingCentral requests or credential reads
were made in this phase. Existing one-time authorizations are not used by polling.

## Implemented files

- `src/ringcentral/polling.ts`: polling engine, recurring-approval type, metadata
  checkpoint contract, owner/endpoint restrictions, safe reports, and scheduled gate.
- `src/index.ts`: scheduled handler prepared alongside the existing fetch handler.
  It does not construct any client, credential provider, repository, or HTTP transport.
- `src/ringcentral/policy.ts`: optional polling enable/pause/interval environment types.
- `src/ringcentral/oauth-read-session.ts`: existing JWT exchange accepts a narrow
  token-transport interface so polling can reuse the verified request/response logic.
  Basic authentication, JWT assertion, scope/owner checks, error sanitization and
  five-second OAuth deadline are unchanged.
- `src/ringcentral/secure-transport.ts`: separate registered JSON-only polling HTTP
  simulator, capped at four responses. The old one-shot simulator still caps at two;
  old one-shot clients retain their own one-request-per-operation limits.
- `test/ringcentral-polling.spec.ts`: 33 polling cases.
- `database-tests/ringcentral-polling.test.mjs`: synthetic SQL intake, checkpoint
  interruption, disk-backed database close/reopen, duplicate recovery and STOP tests.

## Poll behavior

The future live profile pins production `https://platform.ringcentral.com`, account
`~`, and **extension/expected OAuth owner `3322425015` (operator-confirmed 101)**.
No extension enumeration, alternate owner, or extension 102 fallback is available.
Only `ReadMessages` is accepted. Provider metadata is an assertion; the actual
OAuth grant must independently match the scope, Bearer type, owner and lifetime.

The first cycle writes a baseline without authenticating or listing history.
Records at or before the baseline are excluded from new-message detection.
Subsequent scans end ten seconds behind the current UTC time and overlap the last
completed checkpoint by two minutes. The interval defaults to 120 seconds and is
configurable from 120 through 3600 seconds. These are application safety settings,
not claims about platform quotas.

Each cycle can authenticate at most once if no usable cached token exists, and can
perform at most three GETs of twenty records each. The list path is the pinned
extension's `/message-store`, with exactly `messageType=SMS`, `direction=Inbound`,
`perPage=20`, bounded `page`, and explicit `dateFrom`/`dateTo`. Redirects, endpoint
changes, method overrides, other verbs and navigation URLs are rejected. No
attachments are fetched. Outbound records, voicemail, MMS and records containing
attachments are excluded even if incorrectly returned by the list endpoint.

The list deadline is five seconds per request; the streamed JSON cap is 64 KiB.
OAuth retains its existing 16 KiB bound. Invalid timestamps, conflicting owner/URI
identity, malformed envelopes, oversized bodies and unexpected responses fail
closed. Timed-out operations cannot process records or mutate state later, even
when a simulated transport ignores AbortSignal.

Only successful complete scans advance `completedThrough` and `lastSuccessfulCheck`.
Pagination overflow returns `backlog` and holds the checkpoint. Subsequent cycles
replay from page one with the same uncompleted lower bound; scans never silently
skip overflow pages. A catch-up gap above seven days requires a separately reviewed
backfill. A maximum of 4096 retained dedup hashes is enforced without silently
evicting IDs from an uncompleted window.

An HTTP 429 persists Retry-After backoff (or a conservative fifteen-minute fallback)
across restarts. No failed request is retried inside a cycle. A rejected cached
API token is discarded; a later scheduled cycle may perform one new authentication.
OAuth 401/403, bad credentials, or owner/scope mismatch persist an authentication
hold requiring operator review, rather than repeating bad login attempts. Tokens
are cached only in the poller instance, never persisted in checkpoint storage.

## Storage, privacy and existing intake

`PollingStateStore.exclusive()` must serialize the complete callback across all
instances, while each awaited `save()` must durably persist its snapshot. The
production implementation must include locking/fencing and crash recovery. An
in-memory map or an eventually consistent unlocked store is not sufficient.
No production store or bindings are configured by this phase.

Checkpoint data is restricted to version, baseline/completed/attempt/success times,
backoff time, authentication-hold flag, and SHA-256 message-ID fingerprints with
creation times. Fingerprints are pseudonymous metadata, not proof of anonymity.
There are no message bodies, phone numbers, names, raw message IDs, credentials or
tokens in checkpoint state or reports. Production metadata storage and retention
still require approval; the synthetic development Supabase project is not a
permitted destination for production records or metadata.

Offline mode accepts only the registered data-driven HTTP simulator and registered
fictional credential provider. It verifies the authored fixture catalog before
intake and uses fictional account `100001`/extension `200001`, never the real
mailbox. Fixture events reuse `OfflineRingCentralReceiver` and its existing SQL
transactions, event IDs, deduplication and opt-out behavior. A receiver duplicate
after a checkpoint interruption is counted as a duplicate; conflicts stop processing.
No separate chatbot workflow or AI call is introduced.

The future live branch has **no receiver/content sink** and rejects any fixture
receiver option. It can detect metadata only. It cannot forward real SMS content
to development Supabase, Gemma, Telegram or logs. Existing fixture-only intake
restrictions were not relaxed. STOP continues to be tested through synthetic
intake; live content processing/consent integration would need a separate design
and approval before any future customer communications. SMS delivery remains
unconditionally blocked by `phase7a_receive_only`.

`poll()` returns a sanitized report containing status, new/duplicate/excluded/error
counts, last successful check, and optional fixed error category/HTTP status/OAuth
numeric code. A null last-check value means that no successful check is known to
that invocation (including when a gate prevents opening state). Reports contain no
customer information. The scheduled path does not currently log or forward them.

## Disabled scheduled configuration

`RINGCENTRAL_POLLING_LIVE_ENABLED` is false in source. `RINGCENTRAL_POLLING_ENABLED`
defaults false. Both the scheduler gate and the poller guard enforce disablement
before credentials, storage or HTTP. No runtime-only flag can override the source
gate. `RINGCENTRAL_POLLING_PAUSED=true` or `AI_GLOBAL_PAUSED=true` stops polling;
controls are checked again before requests, processing and checkpoint completion.

No Cron entry was added to `wrangler.jsonc`, no bindings changed, and no deployment
or remote migration was performed. After separate approval, a two-minute Cron
would be `*/2 * * * *` (UTC). The interval guard and state lock are still required
because triggers and worker instances can overlap. An injected task is accepted
by the prepared handler; the default Worker intentionally has no live task wired.

## Actual verification

- **337 unit tests passed** across Worker routes and all RingCentral test files,
  including all 33 new polling tests.
- **All nine offline RingCentral SQL/ledger test files passed.** The new SQL test
  has four scenarios plus its enclosing test, using a temporary disk-backed PGlite
  database. It closes/reopens the database to prove checkpoint recovery and verifies
  no duplicate SQL observation after an interrupted checkpoint save.
- Both application and test TypeScript checks passed.
- Synthetic SQL checks confirm STOP persists, no public chat reply is created,
  no staff assignment is added, and Telegram notification counts remain zero.
- All test HTTP is fictional; external networking and secret-file reads are blocked.

```powershell
node --import ./scripts/offline-guard.mjs node_modules/vitest/vitest.mjs run --config vitest.offline.config.mts test/index.spec.ts test/ringcentral --silent
node --import ./scripts/offline-guard.mjs --test database-tests/ringcentral-*.test.mjs
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit -p test/tsconfig.json
```

## Required before approved monitoring

1. Approve a NEW time-limited `receive_only_polling` authorization for owner
   `3322425015`, ReadMessages only, the interval and bounded scan budget. Never
   reuse a retired discovery authorization or its execution ledger.
2. Wire and review a durable, fenced metadata-only production checkpoint store
   outside the synthetic development database. Test multi-instance and crash
   behavior of that concrete adapter; the local SQL fixture is not a production adapter.
3. Wire the existing credential-provider interface to approved Cloudflare secret
   storage/bindings in an isolated read-only monitoring environment. No credentials
   belong in source, flags, ordinary files, command arguments or logs. Preserve
   actual OAuth owner/scope verification. No new RingCentral permission is needed.
4. Approve report access, metadata retention, auth-hold recovery, backfill handling,
   and observed indexing-latency tolerance. Offset pagination is not a snapshot;
   deletion/reordering and records indexed later than the overlapping window can
   cause gaps. Overflow deliberately holds progress rather than broadening access.
5. Review default Worker task wiring, then separately approve changing the polling
   source gate, enabling the environment switch, adding the Cron and deployment.
   All of these remain undone in this phase. Keep outgoing SMS and all mutation
   paths disabled regardless of polling approval.

Sources reviewed: [Workers scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[RingCentral Message Store](https://developers.ringcentral.com/guide/messaging/message-store/working-with-message-store),
[Message Store API](https://developers.ringcentral.com/api-reference/Message-Store/listMessages),
and [PGlite filesystems](https://pglite.dev/docs/filesystems).
