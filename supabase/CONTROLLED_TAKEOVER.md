# Controlled Telegram takeover test — pending approval

No remote permissions, feature flags, migrations, polling sessions or Telegram
messages are changed by the implementation. All verification uses fictional
local PostgreSQL data and a simulated Telegram transport.

## Implemented controls

`View Status` is shown only with active `view` authorization. `Take Over` also
requires `takeover`, an open AI conversation, and no current owner. `Resolve`
and `Return to AI` require their own explicit permissions, an open HUMAN
conversation, and ownership by the current staff identity. Missing permission
metadata defaults to **no buttons**. No permission is inferred from model state,
callback data, a browser ID, or a Telegram username.

The new `20261114000200_staff_controls.sql` adds one service-role-only read RPC
for effective actions and current status. It changes no staff permissions and
does not replace the applied takeover transaction. The existing transaction
locks/revision checks, one-owner constraint, update-ID deduplication and
finish-time AI suppression remain authoritative. Previously issued buttons can
become stale or unauthorized; the action transaction always checks again.

## Safe local commands (no remote services)

```powershell
npm.cmd run telegram:poll -- --dry-run
npm.cmd run demo:telegram
npm.cmd run typecheck
npm.cmd run test:run
npm.cmd run test:database
```

The polling dry run only prints a plan; it does not read credentials or contact
Telegram/Supabase. `demo:telegram` uses ephemeral PostgreSQL and fictional staff
with control permissions. It exercises all four buttons, stale/duplicate
updates, pending-reply suppression and explicit return/resolve locally.

## Exact steps AFTER explicit approval

1. Review and approve `20261114000200_staff_controls.sql`, then apply that file
   only to the isolated development database. Do not modify/reapply earlier
   migrations. This RPC depends on the existing Phase 4 staff schema; the
   notification-preview migration is independent of the controlled runner.
2. Verify that `7646333318` still maps to the already verified FIGA development
   identity in `staff_roster`. Approve each requested permission explicitly.
   To test all controls, manually execute
   `supabase/dev/grant_verified_tester_controls.sql` in that same project's SQL
   Editor. It refuses to create/reactivate an identity and grants only that
   existing verified tester `view`, `takeover`, `resolve`, `return_ai`.
   For takeover-only approval use `array['view','takeover']` instead; Resolve and
   Return to AI will remain unavailable until those permissions are approved.
   Do not start a takeover test without an approved plan for explicit release.
3. Create or select one **fictional, persisted, open** conversation in the local
   chatbot. Obtain its UUID from the saved response's `persistence.conversationId`
   or the browser's `figa.conversationId` localStorage entry. Use no actual
   customer data. Keep staff test activity limited to this UUID.
4. After approval, edit only `.dev.vars.workers-ai` in your editor:

   ```dotenv
   TELEGRAM_STAFF_ENABLED=true
   TELEGRAM_LIVE_ENABLED=true
   TELEGRAM_WEBHOOK_ENABLED=false
   ```

   Keep the existing bot token private. Keep `.dev.vars` Telegram flags false;
   the local chatbot uses that file and must not become a live dispatcher.
   Do not register a webhook. The runner checks the actual `getWebhookInfo`
   result and refuses to poll when a webhook is registered; it never deletes one.
5. In the tester's private chat with `@figa_staff_assistant_bot`, send
   `/summary <CONVERSATION_UUID>`. Then approve exactly one processing pass:

   ```powershell
   npm.cmd run telegram:poll -- --once --approve-live --conversation-id <CONVERSATION_UUID>
   ```

   This polls at most one pending update for up to five seconds and then exits.
   Only authenticated updates from tester `7646333318` can act on the selected
   conversation. `/start` and `/inbox` are scoped to that same conversation.
   Other users, unsupported updates, and callbacks for other conversations are
   ignored without granting access. Such ignored updates are checkpointed, so
   use a dedicated development bot, never a shared operational bot.
   If an older update was pending, review the result and run another explicitly
   approved pass; the runner never loops or drops a backlog automatically.
6. Confirm `View Status` and `Take Over` are visible. Press **Take Over**, then
   run the exact one-pass command again. The status must show `HUMAN` and the
   permitted owner controls. A stale button returns an acknowledgement and a
   fresh status. This mode sends status only to the tester and does not drain
   queued notifications, acquire notification delivery leases or broadcast.
7. In the same saved local chatbot conversation, send a fictional follow-up
   with AI selected. Confirm `engine.used` is `none`, the assistant response is
   empty, and human attention is shown. In SQL Editor, read-only verification is:

   ```sql
   select id, mode, status, revision
   from public.conversations where id='<CONVERSATION_UUID>'::uuid;
   select a.staff_user_id, a.released_at
   from public.staff_assignments a
   where a.conversation_id='<CONVERSATION_UUID>'::uuid
     and a.released_at is null;
   ```

   Do not supply real customer information or intentionally consume AI quota.
   Local tests already prove that an inference started before takeover is
   suppressed at completion. There is no inactivity-based return to AI.
8. Press **Return to AI** and run another approved pass to verify explicit
   release. Test **Resolve** only on an owned HUMAN conversation; it closes the
   conversation and releases ownership. Closed/blocked conversations cannot be
   reopened by these controls. Disable the two live flags after testing. Only
   after assignments are explicitly returned/resolved should an approved
   operator restore the tester to `array['view']`; never silently strand a HUMAN
   conversation by revoking its owner's release permission.

## Checkpoints and single-poller protection

The runner uses a bot-ID-specific, exclusive host lock in the OS temporary
directory under `figa-telegram-pollers/`. Another copy on this host is rejected
before `getUpdates`. Never start any other polling client for this bot.
Checkpoints under `.wrangler/telegram-polling/<BOT_ID>.json` are synced to a
temporary file then atomically renamed, after successful update processing.
Failures do not advance the checkpoint; replay cannot repeat the database action.
A replay may refresh the status message. Normal completion releases the lock;
an abrupt crash can leave it behind. Do not delete a lock until an operator
verifies its recorded process is no longer running. Malformed checkpoints fail
closed and are never reset automatically. SIGINT stops before handling a newly
received update and releases the lock after bounded network work settles.

The host lock is not a distributed lock across different machines. Telegram
cannot atomically commit a status send with a PostgreSQL action/checkpoint;
status notifications can repeat after a crash, while staff actions remain
idempotent. Already committed/in-transit customer replies cannot be recalled.
The pending-completion guard applies at the final database check; any future
customer delivery adapter must also enforce ownership at its delivery boundary.
No such adapter, production staff administration or live customer channel is
enabled here.
