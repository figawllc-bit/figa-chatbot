# Prepared one-time RingCentral read runner

**Disabled. No real OAuth or API request has been made.** Neither the existing
`RINGCENTRAL_LIVE_CONNECTION_ENABLED` nor the separate
`ONE_TIME_RINGCENTRAL_RUNNER_ENABLED` gate was enabled. There is no environment or
command-line override. SMS delivery, webhook/subscription setup, Worker routes,
Telegram, Supabase and RingCentral settings are outside this runner.

## Prepared functionality

`scripts/ringcentral-read-once.mjs` bundles only the existing standalone read
modules and the small `src/ringcentral/one-time-runner.ts` orchestrator. It uses the
existing JWT exchange, pinned transport, bounded SMS validator and durable
`createRunLedger` helper. It does not run Wrangler, load its configuration, read
`.dev.vars*` / `.env*`, import an SDK or connect to persistence.

There are only two possible requests after separately reviewed activation:

1. One `POST https://platform.ringcentral.com/restapi/oauth/token`.
2. On a valid grant only, one
   `GET https://platform.ringcentral.com/restapi/v1.0/account/ACCOUNT/extension/EXTENSION/message-store/MESSAGE`.

The JWT request uses Basic client authentication and the documented form fields
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion`. No refresh,
scope escalation, automatic retry, introspection or discovery request is added.
Both operations retain the existing five-second deadline, 16 KiB bound, exact URL
and method validation and redirect rejection. IDs must be explicit numeric IDs;
`~`, query strings, list endpoints and attachment URLs are prohibited.

The operator confirms the dedicated private production JWT app and independently
verified `ReadMessages`-only configuration and authorized extension. These approval
assertions are **not** treated as an API permission audit. The actual OAuth response
must also contain exactly `ReadMessages`, a Bearer token, the approved `owner_id`
and adequate expiry. Excess scopes and a legacy `Messages` alias fail closed.
Successful live reporting would say `scopeEvidence: issuer_response` and
`applicationPermissionsIndependentlyVerified: false`. App configuration and account
binding still require independent operator evidence; no broader-permission lookup
is performed to establish them.

The SMS must match its approved ID, direction, subject hash and both E.164 identity
hashes. Inbound: from=controlled sender, to=business; outbound: from=business,
to=controlled recipient. Require exactly one recipient. Recording/non-text
attachments are rejected; no attachment is downloaded. No read/unread update,
deletion, SMS send, call or settings request is supported.

Only fixed verification booleans, attempt counts, scope-evidence labels and sanitized
error categories/status codes reach output or ledgers. No SMS content, telephone
numbers, tokens, JWT, client secret, full headers, URLs or response bodies are
reported or persisted. Message/token data exist transiently in memory; JavaScript
reference cleanup cannot guarantee memory erasure.

## Supplying credentials locally

Do **not** supply credentials yet. Both gates must first receive separate activation
approval. The currently safe readiness command is:

```powershell
node scripts/ringcentral-read-once.mjs --check
```

It returns `category: disabled`, zero attempts, exit code 1. It reads no approval or
credentials and creates no ledgers. An `--execute` invocation also stops at that gate.

After future authorization and reviewed activation, use your own trusted local
interactive terminal, outside the Codex tool console, with no debugger, tracing,
preload hooks or terminal capture. The prepared invocation is:

```powershell
node scripts/ringcentral-read-once.mjs --execute --approval .wrangler/approved-read.json
```

The **only** argument containing a path is the non-secret approval file. Client ID,
Client Secret and JWT are entered at three hidden terminal prompts, with no echo
(including no stars). They are not command arguments, environment variables,
source files, Git files or Codex messages. Piped/non-interactive input is rejected.
Ctrl+C cancels; prompts time out after two minutes; terminal raw mode is restored
after completion or handled failure. The helper imports no file/environment or
network code. The CLI discards inherited service/proxy/debug environment settings
without reading their values; a clean Node launch remains necessary because a
preload can execute before application startup. The prompts are tested with fake
TTY streams only; actual terminal behavior still needs a local fictional-input check
before any future credential entry.

The approval file has this shape; placeholders are intentionally invalid:

```json
{
  "approvalId": "APPROVED_UNIQUE_RUN_ID",
  "appName": "FIGA Chatbot Read-Only",
  "privateProductionJwtAppConfirmed": true,
  "independentReadMessagesOnlyEvidence": "LOCAL_EVIDENCE_REFERENCE",
  "authorizedExtensionConfirmed": true,
  "fictionalMessageConfirmed": true,
  "authorizedRequests": ["oauth_token", "one_sms_get"],
  "message": {
    "host": "https://platform.ringcentral.com",
    "accountId": "EXACT_NUMERIC_ACCOUNT_ID",
    "extensionId": "EXACT_NUMERIC_EXTENSION_ID",
    "messageId": "EXACT_NUMERIC_SMS_ID",
    "permissions": ["ReadMessages"],
    "purpose": "fictional_sms_verification",
    "expiresAt": "FUTURE_UTC_TIME_WITHIN_ONE_HOUR",
    "expectedDirection": "Inbound",
    "expectedSubjectSha256": "LOCALLY_COMPUTED_LOWERCASE_SHA256",
    "expectedFromSha256": "LOCALLY_COMPUTED_LOWERCASE_SHA256",
    "expectedToSha256": "LOCALLY_COMPUTED_LOWERCASE_SHA256"
  }
}
```

Compute hashes locally over the exact UTF-8 text and exact E.164 strings. Do not put
raw text/numbers or credentials in this file or chat. Phone hashes remain sensitive
because phone numbers can be guessed; retain the file locally under `.wrangler`.
Evidence is a short local reference, not a credential or a copied console response.

The approval ID fixes the exclusive directory
`.wrangler/ringcentral-read-only/APPROVAL_ID/`. Its creation fails if already present.
Separate `read.json` and `oauth.json` ledgers allow one reservation each; the read
workflow is reserved before credential prompts and OAuth. Failure/interruption still
consumes the run. Never delete, reset or choose another ID to retry the same
authorization. Obtain new approval first. A local timeout does not prove that remote
processing stopped; no retry is made.

## Selecting one SMS without broad history access

Prefer an exact ID already available in operator-held metadata for a known
fictional SMS. An authorized owner can supply that ID out of band. Do not open
unread coworker messages in a UI that automatically marks them read, scrape a
mailbox, send a new SMS or use `~` to discover a tenant/extension.

If no ID is available, this runner stops. The narrowest API alternative would need
**separate discovery authorization and a separately reviewed bounded client**:
one list request on the already approved account/extension, SMS-only, a tight
explicit time window around the controlled fictional message, direction filter and
the smallest page size, with no pagination, retries or attachment access. Validate
the endpoint's supported filters against current documentation before implementation.
A small page can still contain unrelated communications; do not claim that a
one-record limit guarantees fictional provenance. Where that risk cannot be
accepted, obtain the exact ID out of band instead. The exact-message transport rejects listings. A separate, disabled discovery
operation is now prepared with a fixed seven-day inbound-SMS query; see
[RINGCENTRAL_SMS_DISCOVERY.md](RINGCENTRAL_SMS_DISCOVERY.md). It does not activate
this exact-message runner or authorize a follow-up read.

## Before the first separately authorized connection

* Exact production account/extension/SMS ID; approved direction and three hashes;
  controlled fictional provenance; explicit authorization to access that extension.
* Confirmation/evidence for the app settings already reported by the operator,
  and that the active JWT belongs to the selected authorized user/extension.
  No credentials or screenshots containing secrets should be sent to Codex.
* One time-limited approval ID explicitly budgeting **one OAuth POST plus one SMS
  GET**, with no retry, and approval to activate both reviewed source gates.
* A local fictional-input terminal check, fresh secure runtime entry and a clean
  unused approval ledger directory. No exposed credential files are loaded.

No migration, deployment, shared-extension modification, coworker permission change,
webhook or subscription is required. Live permission/authentication success remains
unverified until that separately approved run.

Official references reviewed for this preparation:
[JWT authentication](https://developers.ringcentral.com/guide/authentication/jwt-flow),
[permissions](https://developers.ringcentral.com/guide/basics/permissions),
[message store](https://developers.ringcentral.com/guide/messaging/message-store/working-with-message-store),
[single-message endpoint](https://developers.ringcentral.com/api-reference/Message-Store/readMessage).
