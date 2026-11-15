# Controlled staffing notification test

The first three migrations are applied. **Do not modify them.**
The new `20261114000100_notification_preview.sql` is pending review/approval and
has not been applied remotely. It adds two service-role-only functions and no
tables or staff permission grants:

- `figa_telegram_preview`: read-only inspection and safe summary projection;
- `figa_telegram_claim_one`: claim exactly one explicit notification using the
  existing delivery lease table, authorization checks, and expiry rules.

The original `figa_telegram_pending` RPC acquires leases. The dry-run command
deliberately never calls it, even as a fallback if preview is unavailable.

## Inspect existing notifications first

```powershell
npm.cmd run telegram:notification:test -- --dry-run
```

This reads the ignored token/configuration, checks `getMe`, confirms that
`7646333318` is an active authorized private-chat view recipient, and previews
up to 20 recent queue entries. It does not process Telegram updates, reserve
delivery leases, acknowledge messages, create conversations, alter permissions,
or write database records. If the preview function is missing, it fails closed.
Other recipients are never printed or selected for delivery.

## Create fictional data separately, after preview is available

After approval/application of the new migration, inspect the existing queue
before adding a fixture. Start the existing local chatbot, choose deterministic
mode, confirm fictional data, and select saving to the isolated database before
chatting. Send:

`I need three caregivers for a night shift in Salem, Oregon.`

This is the explicit **write/setup step**, separate from dry run. The existing
chat API persists the provider intake and the existing trigger queues its
notification. No API change or automatic Telegram dispatch is enabled. Use only
fictional data; do not enter names, contact details, transcripts or PHI.

Rerun preview to obtain the notification ID, then inspect that exact entry:

```powershell
npm.cmd run telegram:notification:test -- --dry-run --notification-id <NOTIFICATION_UUID>
```

Optionally add `--conversation-id <CONVERSATION_UUID>`. Without a selected ID,
the command is inventory-only and `readyForSending` remains false. Only a pending,
authorized, explicitly selected notification can be ready for delivery.

## One approved send — do not execute before approval

```powershell
npm.cmd run telegram:notification:test -- --send --notification-id <NOTIFICATION_UUID>
```

The command verifies bot identity/authorization again, exclusively reserves a
local attempt file for that notification, claims only that ID, rechecks the
claimed notification authorization, formats through the existing staffing
summary allowlist, sends at most one message, and acknowledges through the
existing RPC. Only user/private chat `7646333318` is supported. No action buttons
are included for this view-only test. No polling, webhook, continuous dispatcher,
staff permission change, feature-flag change or paid-broadcast option is enabled.

The safe message includes request type/status and approved-shaped city/state,
position, count, date and shift where present. Names, organizations, contact
information, notes, experience and transcripts are omitted; sensitive patterns
and arbitrary free-text schedule values are excluded by the existing formatter.

`.wrangler/notification-test-attempts/<NOTIFICATION_UUID>.json` blocks another
local attempt even after failure or SQL lease expiry. Do not delete it or retry
automatically after an uncertain outcome. Already-delivered or leased rows are
rejected by the database. As with the existing dispatcher, a Telegram send and a
database acknowledgement cannot be committed atomically. A local guard is not a
distributed guarantee against other machines or a separately activated sender.

## Verification

`database-tests/notification-flow.test.mjs` exercises the actual Worker chat API,
all four migrations in ephemeral PGlite, queued provider details, unauthorized
exclusion, single-ID claims, deduplication, safe previews and mocked delivery.
It runs dry run inside a PostgreSQL **READ ONLY** transaction and compares hashes
of every database table before and after. It does not access the hosted database
or Telegram. Run it via `npm.cmd run test:database`.

The hosted dry-run attempt verified the bot and roster, but could not inspect
the queue because the read-only preview RPC is unavailable. No hosted fixture,
lease, acknowledgement or message was created during that attempt. Hosted
verification must continue only after migration approval; no migration was
applied by this implementation.
