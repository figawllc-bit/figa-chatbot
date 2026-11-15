# Phase 4 staff assistant: local simulation only

The new `20261113000100_staff_telegram.sql` is **not applied remotely**. The two
previous migrations are already applied and have not been modified. This phase
adds `staff_roster`, `telegram_updates`, `telegram_notifications`, and
`telegram_deliveries`, all with RLS and no public or direct service-role table
privileges. Only narrow server-side RPCs are granted to the service role.

## Run the working demonstration

```powershell
npm.cmd run demo:telegram
# Optional interactive fictional staff console:
npm.cmd run demo:telegram -- --interactive
npm.cmd run typecheck
npm.cmd run test:run
npm.cmd run test:database
```

The demonstration uses ephemeral PGlite PostgreSQL, all three migration files,
the existing deterministic conversation engine, and a simulated Telegram transport.
It does not read `.dev.vars`, access the hosted database, call AI, or contact
Telegram. It prints safe notifications and button labels for a fictional provider
and caregiver. Its automatic run verifies denied access, takeover, duplicate
retries, suppression of a pending reply, stale buttons, return to AI and resolve.
The interactive console accepts `takeover`, `summary`, `return`, `resolve`,
`unauthorized`, and `quit`. Telegram messages remain simulated in both modes.

## Authorization and ownership

### One-shot connection check (no feature-flag changes)

```powershell
npm.cmd run telegram:test -- --dry-run
# Only after reviewing the dry run and approving one real test notification:
npm.cmd run telegram:test -- --send
```

No option defaults to dry run. The script loads the bot token only at runtime
from `.dev.vars.workers-ai`, and isolated database settings from `.dev.vars`.
All Telegram application flags must remain false. A narrow test capability in
the existing Bot API transport permits `getMe` and, with `--send`, one fixed
message only. It does not enable polling, webhooks, notifications or action buttons.

`getMe` must identify `@figa_staff_assistant_bot`. The existing read-only
`figa_telegram_recipients` RPC must include user/private chat `7646333318`, which
proves active roster membership with `view` permission. The script never changes
permissions, processes staff updates, claims notifications or reads conversations.
No database migration is needed. The bounded roster RPC returns up to 20 active
view recipients; a recipient outside that batch fails closed.

The only permitted message text is:
`FIGA Staff Assistant test: Telegram connection successful.`

Before sending, an exclusive local `.wrangler/telegram-connection-test.attempt.json`
record is written and synced. Any prior attempt, including a timeout or uncertain
failure, blocks another send. Never delete this record or retry automatically;
inspect Telegram manually if an outcome is uncertain. This is a local one-shot
guard, not a distributed guarantee across different workspaces or machines.
The recipient must have already started the private bot chat; `getMe` and roster
validation cannot guarantee Telegram will permit delivery. No secret is included
in output, the generated bundle, the attempt record, or command-line arguments.

- A trusted operator must verify FIGA employment/role and Telegram account
  ownership out of band before provisioning a roster row. Record the verified
  Supabase Auth user UUID, Telegram numeric user ID, verification time and the
  verifying operator's Auth UUID. Never enroll someone based on a Telegram
  username, `/start`, a browser ID, or a button's claimed identity.
- The roster defaults inactive. Set active and grant the minimum explicit
  permissions: `view`, `takeover`, `resolve`, `return_ai`. Only verified private
  chats are accepted; the chat ID must equal the bound Telegram user ID.
  Groups, channels, bots and mismatched chat IDs are rejected.
- Every RPC rechecks active status and permissions. Summary/notification reads
  are rechecked immediately before sending. No roster-management HTTP endpoint,
  public staff assignment endpoint, or mock-update HTTP endpoint exists.
- Telegram action data contains only action, conversation UUID and expected
  revision. Actor identity comes from the authenticated update envelope, never
  from callback data. The webhook secret or a trusted polling transport is the
  ingress trust boundary; SQL arguments alone do not prove Telegram identity.
- Takeover locks the conversation, checks its current revision/status, and
  creates one active owner. The legacy `figa_assign_human` service-role grant is
  revoked and its internal implementation also requires an active permitted
  roster member. All external staff actions use `figa_telegram_process`.
- Resolve/return require both the specific permission and current ownership.
  Resolve closes the conversation and releases the assignment. Closed or blocked
  conversations cannot be reopened by these buttons. Returning an open HUMAN
  conversation to AI is explicit; no inactivity timer changes ownership.
- Existing AI turn leases are preserved during staff actions. The existing
  finish transaction rechecks mode, status, assignment and revision. A reply
  started before takeover remains suppressed even if staff later return to AI.
  An outstanding lease can temporarily delay the next AI turn until completion
  or its existing 60-second expiry. Missing/invalid revisions fail closed.

## Delivery and privacy

Database triggers enqueue initial provider/caregiver notifications, urgent
staffing alerts and mode/status changes. `StaffBot.dispatch()` drains a bounded
batch to active authorized private chats. Per-recipient expiring delivery leases
prevent concurrent dispatch and acknowledgements prevent normal resend.
The simulator explicitly dispatches; the prepared poller dispatches after each
successful pass. No live scheduler or external delivery is activated.

Telegram update IDs, normalized request hashes, ownership changes and audits are
committed in one transaction. Repeated updates cannot repeat an action; changed
retries conflict. Duplicate callbacks do not resend summaries, but can resume
pending notification delivery. Expired callback acknowledgements do not block
committed status notifications.

Notifications omit customer names, organizations, contact details, notes,
experience and transcripts. Only approved-shaped staffing fields and status are
formatted as plain text, with sensitive-pattern screening, no parse mode, link
previews disabled and protected content. Unknown details are omitted. Relative
dates remain explicitly unconfirmed. Never send PHI or actual customer data.

## Later controlled connection — do not activate yet

1. Review/approve the **new** migration, then apply only that migration to the
   existing isolated synthetic development database. Do not reapply or edit the
   first two migrations. No migration command is run by this implementation.
2. Create a separate development bot using official BotFather. Verify fictional
   test staff accounts out of band; provision their Auth identities and roster
   rows through an authenticated operator session. No application provisioning
   endpoint is provided. Start with one private test recipient.
3. Store `TELEGRAM_BOT_TOKEN` and a randomly generated 32–256 character
   `[A-Za-z0-9_-]` `TELEGRAM_WEBHOOK_SECRET` only in ignored local secrets. Keep
   all `TELEGRAM_*_ENABLED` settings false until explicit controlled activation.
   Existing Supabase credentials stay server-side and unchanged.
4. After approval, set `TELEGRAM_STAFF_ENABLED=true` and
   `TELEGRAM_LIVE_ENABLED=true` only for the controlled development adapter.
   `BotAPITransport` calls official `sendMessage`, `answerCallbackQuery`, and
   bounded `getUpdates` methods. It rejects redirects and never automatically
   retries errors or logs token-bearing URLs. No real transport was tested here.
5. Initially use a single local caller of `TelegramPoller.once(offset)` with
   `BotAPITransport` and `SupabaseStaffRepository`. Checkpoint the returned offset
   only after success; do not run multiple pollers or advance it after a failure.
   A production polling runner/offset store is not activated or provisioned.
6. For eventual deployment, use an approved HTTPS endpoint at
   `/telegram/webhook`, set `TELEGRAM_WEBHOOK_ENABLED=true`, and register that URL
   with Telegram using the same `secret_token`. The handler verifies HTTPS,
   constant-time hashed secret comparison, method/content type and body size
   before processing. Do not expose the conversation lab publicly. No webhook
   registration, tunnel, deployment or polling activation has been performed.
   Polling and a registered webhook are mutually exclusive.

## Remaining operational limits

This is one FIGA roster and one bot, with a bounded dispatch batch of 20 staff
and 20 notifications per recipient. It is not a multi-tenant staff administration
system. A disabled owner's conversations stay HUMAN until a trusted operator
remediates ownership; no unreviewed supervisor override or silent auto-release
exists. No customer messaging or staff-to-customer reply delivery is connected.

Takeover suppresses AI completions that have not yet committed through the final
database check. A response already committed or in transit cannot be recalled.
Any future customer transport must also enforce ownership/revision at its final
delivery boundary; no such external customer transport is enabled here.

Telegram's send API cannot atomically commit with PostgreSQL. A crash after send
but before acknowledgement can duplicate a **notification** after lease expiry;
database actions remain idempotent. Durable scheduling, polling checkpoints,
retention, alerting, full hosted multi-session concurrency tests, and operational
access review remain before production. Local PostgreSQL tests exercise actual
SQL constraints/transactions; PGlite has a serialized local execution model.
Heuristics and synthetic-data declarations cannot establish that arbitrary
user-entered location fields contain no personal information. Real-data use
requires a separate privacy review and stricter approved intake controls.

References: [Telegram Bot API](https://core.telegram.org/bots/api),
[Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/).
