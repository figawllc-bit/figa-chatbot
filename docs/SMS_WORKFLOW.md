# FIGA SMS workflow and activation requirements

Implemented locally on the existing stack; no deployment, live model calls, RingCentral calls, secret access, or remote SQL changes were performed.

## Working synthetic path

`RingCentralIncomingPoller` detects authored incoming SMS and invokes its optional fixture processor. `SyntheticSmsWorkflow` uses the existing observation adapter, conversation mapping, `PersistentChatService`, Gemma Workers AI adapter, approved FIGA instructions, validated extraction, application response rendering, and Supabase begin/finish transactions. The new `SmsWorkflowRepository` is deliberately a local SQL fixture adapter, like the existing receive-only repository; it has no remote credential transport.

The pending migration `20261115000200_ringcentral_sms_workflow.sql` adds a service-only/RLS-protected durable job ledger and narrow RPCs. It extends the fixed fictional catalog with the two previously tested Alex/Sam inputs and changes no existing applied migration. It preserves synthetic-only table constraints and expires browser access after every internal channel transaction. No browser token is issued. STOP/START, HUMAN/closed/blocked state, active assignments, unknown-outbound holds and revision/lease fences reuse existing authoritative SQL behavior.

Processing and sending are separate: intake may be saved while sending is disabled. Pending jobs are drained on a subsequent synthetic polling cycle, even when the inbound message has already been checkpointed. Claiming a generated reply durably marks it `sending` before network I/O. The sender rechecks ownership, opt-outs, revision and pause after authentication and immediately before the SMS POST. Once claimed, accepted, failed, suppressed, uncertain or interrupted jobs are never automatically resent. A crash after claim can lose a reply, by design; an ambiguous result requires operator reconciliation. This is at-most-one application POST per job, not a guarantee of carrier delivery or transactional atomicity across Supabase and RingCentral. A staff action racing after the final database check cannot retract an already dispatched HTTP request.

`RingCentralSmsSender` implements the documented HTTPS POST to `/restapi/v1.0/account/~/extension/{owner}/sms`, with one approved sender, one recipient, plain text only, redirects rejected, a five-second POST deadline, a 16 KiB response limit, sanitized outcomes and zero retries. HTTP acceptance is distinguished from carrier delivery. Accepted message IDs register trusted chatbot origin; unknown outbound events are never guessed to be staff replies. Shared-extension employees still need the authoritative takeover controls; incoming-only polling does not independently discover every manual staff outbound reply.

The separate `exchangeSmsJwt` reuses the existing bounded JWT exchange and accepts exactly `ReadMessages` plus `SMS` from the actual OAuth response. Grants carry private in-process verification provenance; arbitrary caller permission metadata is not proof. The original read-only exchange still rejects SMS scope. Offline HTTP uses the existing registered JSON-only simulator, not arbitrary injected network wrappers.

## 2026-11-15 fixes (Claude Code session)

- **Staff-handled messages are never auto-answered later.** An SMS that arrives while staff own the thread, or while it is closed/blocked/opted-out, is now marked `suppressed` in `figa_rc_sms_prepare`. Before this fix it stayed `new`, and the next drain after **Return to AI** would have had Gemma answer a message staff had already handled. Edited in place in the still-pending, never-applied migration `20261115000200_ringcentral_sms_workflow.sql`.
- **SMS-safe reply text.** `SmsChannelEngine` (in `src/ringcentral/sms-workflow.ts`) wraps the existing engine for the SMS channel. It strips developer diagnostics such as "Workers AI free quota is exhausted. The local deterministic engine handled this message." and rewords the "no notification has been sent" review notice truthfully. A reply over RingCentral's 1000-character limit goes to staff review and is never truncated. The stored transcript equals the text that would be sent.
- **New end-to-end coverage**, using the real Telegram staff RPC `figa_telegram_process`: an escalation queues Telegram notifications, Take Over suppresses inference and sending, Return to AI does not answer stale messages, and a later SMS on the same thread receives prior history and keeps collected intake. A Gemma outage still produces exactly one clean SMS.

## Staff control from Telegram (global bot mode)

Migration `20261115000300_bot_mode.sql` (pending, offline only) adds one global mode that approved staff switch from Telegram:

| Command / button | Mode | What the bot does |
|---|---|---|
| `/away` or `/resume` | **Away** | Staff unavailable: the bot answers caregiver and provider texts automatically. |
| `/onduty` | **On Duty** | Staff are answering: the bot stays silent and sends a Telegram alert, with a Take Over button, for each new text. |
| `/pause` | **Paused** | Everything off: no reply is generated or sent, and staff still get an alert for each text. |
| `/auto` | **Auto** | Follows office hours: On Duty during office hours, Away otherwise. |
| `/sethours mon-fri 08:00-17:00 sat 09:00-12:00` | (schedule) | Replaces the office hours (Pacific time). `/sethours none` clears them, so Auto means always Away. |
| `/status` or `/hours` | (any) | Shows the mode, what the bot is doing right now, and the office hours, with buttons if you may change them. |

- A fresh database starts **Paused**.
- Changing the mode needs the new roster permission `bot_mode`; `view` can only see the status. Every change is announced to all rostered staff.
- The mode is part of the single SQL gate checked before inference, when a reply is claimed, and again immediately before the SMS POST. Pausing therefore also stops a reply that was already generated or is in the middle of sending.
- Texts received while On Duty or Paused are never answered later, after switching back to Away.
- Per-conversation **Take Over / Return to AI / Resolve** work unchanged on top of this.
- The Cloudflare variables `AI_GLOBAL_PAUSED` and `RINGCENTRAL_POLLING_PAUSED` remain a second emergency stop.

**Office hours** (migration `20261115000400_office_hours_hand_replies.sql`):
- Away, On Duty and Paused are manual settings that stay until changed; Auto follows the schedule.
- The default schedule is a placeholder (Mon–Fri 08:00–17:00 Pacific); set the real one with `/sethours`.
- Holidays are not handled; use `/onduty` or `/pause` for them.

**Hand replies:**
- When the workflow is attached, the poller also downloads outgoing texts and handles them before incoming ones on the same page.
- An outgoing text the bot did not send (staff replying from the RingCentral app) places a review hold on that conversation. The bot stops there at once, even for a customer text that arrived just before the staff reply, and staff get a Telegram alert.
- To hand the conversation back, press **Take Over**, then **Return to AI** (or **Resolve**); that clears the hold.
- The bot's own sent replies are recognised by their RingCentral message ID and never trigger a hold. A send whose result was uncertain is treated as unknown, so it also holds the thread for staff review, which is the safe choice.
- Limit: ordering is per page of 20 texts, so in a very busy two-minute window a staff reply on a later page could be seen one page late.

## Activation is still blocked

All production code is written and tested offline; nothing real runs until the reviewed code locks are flipped and the approvals and credentials below exist. The deployed bootstrap remains unchanged and disabled. No sending scope, credentials, Cron, public route or coworker configuration was changed.

**How the production path works** (all locked off):
- **Database:** the same migrations serve a SEPARATE production Supabase project. Migration `0500` adds a deployment profile. Development (the default) accepts only fixtures; production accepts only real rows with FIGA's configured RingCentral account, extension and number. `supabase/production/configure.sql` switches a fresh, empty project once and can never be reversed. The development project must never be switched.
- **Worker:** every minute the scheduled job runs one Telegram pass (staff commands via getUpdates, then queued alerts; no public webhook) and, every 2 minutes, one RingCentral poll. When `productionReadiness()` reports nothing missing for processing, texts flow into `SmsWorkflow` with the `production` policy (`src/production/runtime.ts`).
- **Gemma** runs on real texts only with `AI_PRODUCTION_DATA_APPROVED=true`; otherwise the rule-based engine answers. Sensitive texts never go to Gemma and are flagged for staff.
- **SMS text:** test-only wording is rewritten for customers. The first reply says it is FIGA's automated assistant and ends with "Reply STOP to opt out."
- **Staff alerts:** besides new requests, urgent requests, status changes, hand replies and texts received while the bot is off, staff now get a "Needs staff review" alert when a conversation newly needs a person (migration `0600`).
- `npm run preflight` prints which code locks, switches and Cloudflare secrets are still off or missing (names only).

## Exact go-live checklist

**A. Privacy and contracts (FIGA decision, blocks all real-content processing)**
1. Decide whether SMS content is covered PHI. If it is: Cloudflare BAA requires an Enterprise plan (Free/Paid do not include one). Workers AI (Gemma) processes message text, so it falls under the same arrangement. A production Supabase project needs Supabase's HIPAA add-on and BAA.
2. Approve retention for message content and intake fields.
3. Telegram is not a BAA-covered service. Staff summaries contain only type, status, city/state, position, count, date, shift, an availability flag and urgency (no names, phone numbers or message text). Confirm that is acceptable, or reduce it further.
4. **Rotate the Telegram bot token** (possibly exposed in an earlier screenshot) before any production use.

**B. RingCentral (no changes made; each needs your approval)**
1. Keep `FIGA Chatbot Read-Only` (ReadMessages) unchanged for polling.
2. Create a separate app, e.g. "FIGA Chatbot SMS", with JWT auth and exactly **SMS + ReadMessages** permissions. `exchangeSmsJwt` rejects any other scope set.
3. Authorize that app's JWT as the extension 101 user (owner `3322425015`).
4. Choose the sending number. It must be SMS-enabled with the **SmsSender** feature on extension 101, and registered: a TCR/10DLC campaign for a local long code, or toll-free verification for a toll-free number. RingCentral blocks unregistered A2P traffic. Start this early; approval can take days to weeks.
5. Note the numeric RingCentral account ID (it appears in message-store URIs).
6. Extension 102 stays out of scope until separately authorized.

**C. Production database**
1. Create a separate Supabase project (with BAA if decision A requires it). Apply every file in `supabase/migrations/` in order.
2. Run `supabase/production/configure.sql` with the account ID and sender number, before any conversation exists.
3. Add verified staff to `staff_roster`; grant `bot_mode` only to people who should switch the bot.

**D. Cloudflare** (everything is prepared in `wrangler.jsonc` `env.production`; deploy with `--env production`)
1. Upgrade to Workers Paid (recommended). Free allows 10 ms CPU per invocation (including Cron), 100,000 requests/day, 5 Cron Triggers, and 10,000 Workers AI neurons/day. Gemma 4 26B costs 9,091 neurons per million input tokens and 27,273 per million output tokens, so roughly 19 neurons per turn (assuming about 1,500 input and 200 output tokens). That gives about 500 turns/day, which 200 contacts with several turns each can exceed.
2. Secrets via `npx wrangler secret put <NAME> --env production` (never vars): `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET`, `RINGCENTRAL_JWT` (read-only app), `RINGCENTRAL_POLLING_APPROVAL_JSON`, `RINGCENTRAL_SMS_CLIENT_ID`, `RINGCENTRAL_SMS_CLIENT_SECRET`, `RINGCENTRAL_SMS_JWT` (SMS app), `SUPABASE_PRODUCTION_SECRET_KEY`, and the rotated `TELEGRAM_BOT_TOKEN`.
3. Vars in `env.production`: `RINGCENTRAL_ACCOUNT_ID`, `RINGCENTRAL_SMS_FROM_NUMBER`, `SUPABASE_PRODUCTION_PROJECT_REF`, `SUPABASE_PRODUCTION_URL`, then the switches for each stage below.
4. Emergency stop: set `AI_GLOBAL_PAUSED=true` or `RINGCENTRAL_POLLING_PAUSED=true` in the dashboard, or `/pause` in Telegram. All are checked before every poll, every inference and immediately before every SMS POST.

**E. Staged activation** (each stage separately authorized; run `npm run preflight` before each)
1. **Staff controls only:** `TELEGRAM_STAFF_ENABLED`, `TELEGRAM_LIVE_ENABLED`, `TELEGRAM_POLLING_ENABLED`, `SUPABASE_PRODUCTION_ENABLED` = true. Check `/status` in Telegram; the bot stays Paused.
2. **Read and draft, no sending:** a reviewed commit flips `RINGCENTRAL_POLLING_LIVE_ENABLED` and `RINGCENTRAL_PRODUCTION_PROCESSING_ENABLED`. Set `FIGA_PRIVACY_APPROVED`, `RINGCENTRAL_MONITORING_SECURITY_APPROVED`, `RINGCENTRAL_POLLING_ENABLED` = true and `RINGCENTRAL_POLLING_PAUSED`, `AI_GLOBAL_PAUSED` = false. Optionally `AI_ENABLED` and `AI_PRODUCTION_DATA_APPROVED` = true. Replies are generated and stored but not sent; staff review them.
3. **One test send:** a reviewed commit flips `RINGCENTRAL_SMS_DELIVERY_ENABLED`; set `RINGCENTRAL_SMS_SENDING_ENABLED=true` and send one reply to an explicitly approved staff phone.
4. **Go live:** after explicit authorization, `/auto` or `/away` in Telegram.

Tests: `database-tests/production-profile.test.mjs` (deployment profile guard; production workflow with fictional production-shaped data), `test/production-runtime.spec.ts` (every production lock and readiness item), `database-tests/ringcentral-sms-workflow.test.mjs` (16 cases: polling → Gemma → intake → guarded SMS POST, provider/caregiver, replay, STOP/START, staff states, takeover during inference, STOP during auth, pause/resume, uncertain-send terminality, concurrent claims, Telegram Take Over/Return to AI, Gemma outage, bot mode, hand replies, office hours) and `test/ringcentral-sms-sender.spec.ts` (strict grants, timeouts, endpoint pinning, rechecks, disabled live mode, offline isolation, SMS text rules). These are synthetic/mock results, not live model or carrier deliveries.

Official requirements: [RingCentral SMS sending](https://developers.ringcentral.com/guide/messaging/sms/sending-sms), [application permissions](https://developers.ringcentral.com/guide/basics/permissions), [SMS enablement](https://developers.ringcentral.com/guide/messaging/sms/sms-requirements), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
