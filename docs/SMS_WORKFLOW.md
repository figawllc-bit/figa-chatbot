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

## Activation is still blocked

The deployed bootstrap remains unchanged and disabled. `RINGCENTRAL_SMS_DELIVERY_ENABLED` and `RINGCENTRAL_POLLING_LIVE_ENABLED` are source constants set to `false`. No env var or secret can override them. No sending scope, credentials, Cron, public route or coworker configuration was changed.

**Remaining code (blocked on decision A below):** the SQL layer is synthetic-only by design (`is_synthetic` checks, the fixed fixture-text catalogue, fixture account/extension IDs), and the live Durable Object poller has no content sink. Real-message processing needs a production schema/migration without those fixture checks, in a separate approved database (never the dev project). It also needs a production repository with its own credentials and a live processor wired into `RingCentralMonitor.poll()` that uses `exchangeSmsJwt` plus `RingCentralSmsSender` in `live` mode. The workflow logic, gates and sender are reusable as-is. Do not relabel real messages as synthetic.

## Exact go-live checklist

**A. Privacy and contracts (FIGA decision, blocks all real-content processing)**
1. Decide whether SMS content is covered PHI. If it is: Cloudflare BAA requires an Enterprise plan (Free/Paid do not include one). Workers AI (Gemma) processes message text, so it falls under the same arrangement. A production Supabase project needs Supabase's HIPAA add-on and BAA.
2. Approve retention for message content and intake fields.
3. Telegram is not a BAA-covered service. Staff summaries today contain only type, status, city/state, position, count, date, shift, an availability flag and urgency (no names, phone numbers or message text). Confirm that is acceptable, or reduce it further.
4. **Rotate the Telegram bot token** (possibly exposed in an earlier screenshot) before any production use.

**B. RingCentral (no changes made; each needs your approval)**
1. Keep `FIGA Chatbot Read-Only` (ReadMessages) unchanged for polling.
2. Create a separate app, e.g. "FIGA Chatbot SMS", with JWT auth and exactly **SMS + ReadMessages** permissions. `exchangeSmsJwt` rejects any other scope set.
3. Authorize that app's JWT as the extension 101 user (owner `3322425015`).
4. Choose the sending number. It must be SMS-enabled with the **SmsSender** feature on extension 101, and registered: a TCR/10DLC campaign for a local long code, or toll-free verification for a toll-free number. RingCentral blocks unregistered A2P traffic.
5. Extension 102 stays out of scope until separately authorized.

**C. Cloudflare**
1. Upgrade to Workers Paid (recommended). Free allows 10 ms CPU per invocation (including Cron), 100,000 requests/day, 5 Cron Triggers, and 10,000 Workers AI neurons/day. Gemma 4 26B costs 9,091 neurons per million input tokens and 27,273 per million output tokens, so roughly 19 neurons per turn (assuming about 1,500 input and 200 output tokens). That gives about 500 turns/day, which 200 contacts with several turns each can exceed.
2. Encrypted secrets (never vars): `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET`, `RINGCENTRAL_JWT` (read app), plus the SMS-app equivalents, production Supabase URL/key, `RINGCENTRAL_POLLING_APPROVAL_JSON`, and the rotated Telegram token.
3. Add the AI binding and `"triggers": { "crons": ["*/2 * * * *"] }` (matches `RINGCENTRAL_POLL_INTERVAL_SECONDS=120`) to `wrangler.jsonc`.
4. Vars: `RINGCENTRAL_POLLING_ENABLED=true`, `RINGCENTRAL_POLLING_PAUSED=false`, `RINGCENTRAL_MONITORING_SECURITY_APPROVED=true`, plus a sending-enabled and privacy-approved flag for the live sender.
5. Emergency stop: set `AI_GLOBAL_PAUSED=true` or `RINGCENTRAL_POLLING_PAUSED=true` in the dashboard. Both are checked before every poll, every inference and immediately before every SMS POST.

**D. Staged activation (each stage separately authorized)**
1. Reviewed commit flipping `RINGCENTRAL_POLLING_LIVE_ENABLED`. Run read-only polling with no AI and no sending, and confirm the baseline/checkpoints.
2. Enable inference with sending disabled. Replies are generated and stored (`generated`) but not sent, and staff review them.
3. Reviewed commit flipping `RINGCENTRAL_SMS_DELIVERY_ENABLED`. Send one outbound SMS to an explicitly approved staff number.
4. Explicit go-live authorization for customer replies.

Tests: `database-tests/ringcentral-sms-workflow.test.mjs` (13 cases: polling → Gemma → intake → guarded SMS POST, provider/caregiver, replay, STOP/START, staff states, takeover during inference, STOP during auth, pause/resume, uncertain-send terminality, concurrent claims, Telegram Take Over/Return to AI, Gemma outage) and `test/ringcentral-sms-sender.spec.ts` (strict grants, timeouts, endpoint pinning, rechecks, disabled live mode, offline isolation, SMS text rules). These are synthetic/mock results, not live model or carrier deliveries.

Official requirements: [RingCentral SMS sending](https://developers.ringcentral.com/guide/messaging/sms/sending-sms), [application permissions](https://developers.ringcentral.com/guide/basics/permissions), [SMS enablement](https://developers.ringcentral.com/guide/messaging/sms/sms-requirements), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
