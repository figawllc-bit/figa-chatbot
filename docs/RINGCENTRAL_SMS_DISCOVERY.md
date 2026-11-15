# Minimal read-only SMS discovery — prepared, disabled

Current first-execution status: [reviewed authorization](RINGCENTRAL_REVIEWED_DISCOVERY.md).
Live GET now requires `expectedOwnerId`, independently mapped to the intended
mailbox and matched against OAuth. An omitted owner pin passes schema preflight
with `ownerPinReady: false` but cannot dispatch a live SMS GET.

No actual OAuth/API request was made. The existing live connection gate remains
false, and the independent `RINGCENTRAL_SMS_DISCOVERY_ENABLED` gate is false.
No command argument or environment variable can override these source gates.
The exact-message runner's separate gate also remains false.

## Allowed operation

The discovery session reuses the existing JWT exchange and pinned transport. A
new approval type is separate from fictional exact-message approvals: real customer
content may occur in the discovery response and must never enter the fictional
receiver, synthetic Supabase data, Telegram, AI context or any output/ledger.

After separately reviewed activation, only these requests are possible:

1. One production JWT-to-OAuth POST, with its own one-attempt ledger.
2. On a valid grant, one GET on the authorized user's Message Store:

```text
https://platform.ringcentral.com/restapi/v1.0/account/ACCOUNT/extension/EXTENSION/message-store
  ?messageType=SMS&direction=Inbound&perPage=1&page=1
  &dateFrom=APPROVED_FROM&dateTo=APPROVED_TO
```

The actual URL is encoded, without whitespace, with exactly those six query keys.
No operator-provided filter, body, method override, alternate host/path, second page,
retry, redirect, account/extension enumeration, attachment request or message
mutation is allowed. No subscription or webhook is needed.

`dateFrom` and `dateTo` are explicit canonical UTC timestamps exactly 604800000 ms
(seven days) apart. `dateTo` cannot be in the future and must be at most five minutes
old at validation/dispatch. Approval expiry is within one hour. A stale approval
fails closed; the code does not shift or broaden the window automatically. These
are project safety constraints, not platform rate limits.

## Authenticated-user aliases and owner checks

Use numeric internal IDs when known. `~` is allowed only for discovery's account
and/or extension path parameters, where RingCentral documents it as the currently
authenticated user's account/extension. It is not an enumeration operation and
does not select a different coworker or shared extension on behalf of an unrelated
JWT user. The operator must confirm that the JWT's identity is the FIGA identity
authorized for this mailbox; the app being private does not establish that by itself.

The shared JWT exchange verifies the actual token response: exact `ReadMessages`
scope, Bearer type, adequate expiry and a positive numeric string `owner_id`. Extra
scopes, missing scope, legacy aliases such as `Messages`, malformed owners and wrong
known owners stop before listing. A known extension ID, including a numeric
credential binding when the URL uses `~`, must match `owner_id`. The transport must
be bound once to that issuer-returned owner before a list GET is allowed. An optional
record URI must identify that same owner and message ID; known account IDs are
checked too. Account aliases remain bound by RingCentral's authenticated session;
the OAuth owner field is not an independent account-ID lookup.

App-permission metadata and approval evidence are operator/provider assertions,
not an independent audit of RingCentral app settings. Actual returned token scope
is checked, but local tests do not prove live application/user permissions or access
to FIGA's mailbox. No extra permission/introspection request is made to claim proof.

## Transient parsing and safe output

OAuth and list responses each retain the five-second deadline and 16 KiB streamed
limit. Both require HTTP 200 JSON; redirects and network errors fail without retry.
The list envelope must contain zero or one record; conflicting page/per-page
metadata is rejected. A selected record must have type `SMS`, direction `Inbound`,
a safe numeric ID and an unambiguous creation timestamp within the approved window.

JSON bytes and parsed customer fields exist transiently in process memory because
the API can return them. The code reads only validation metadata, never renders
customer text/numbers/names, never follows links, and returns a newly constructed
allowlist. JavaScript cannot guarantee immediate physical memory erasure after
references are dropped. Do not use a debugger, tracing, crash dumps or raw HTTP logs
with live responses.

Only this selected result may be displayed locally:

```json
{"status":"selected","messageId":"300001","direction":"Inbound"}
```

The sample ID is fictional. An empty result returns
`{"status":"no_matching_sms","messageId":null,"direction":null}` and stops.
No widening or page traversal follows. Errors expose only fixed categories, optional
numeric HTTP status and attempt counts. The CLI's ledgers store only outcome status
and request counts, not the selected ID or any message record/content/identity.
Do not post a real selected ID publicly or infer that its content is fictional.

## Local entry point and credentials

The existing hidden-terminal runner has a separate discovery operation:

```powershell
node scripts/ringcentral-read-once.mjs --check-discovery
```

This is safe now: it stops with `disabled`, zero attempts and exit code 1 before
opening approval files, prompting for credentials or creating ledgers.

The prepared future invocation, **not authorized to run live by this task**, is:

```powershell
node scripts/ringcentral-read-once.mjs --discover --approval .wrangler/approved-discovery.json
```

It reuses the hidden Client ID, Client Secret and JWT prompts. No credential file,
environment credential, command argument, Git file or Codex message is used for
these values. Use a trusted clean local terminal with no debugger/preload/capture;
the existing [terminal procedure](RINGCENTRAL_ONE_TIME_READ.md) applies. Piped input
is rejected. No credentials were entered or read for the offline tests.

An exclusive directory `.wrangler/ringcentral-read-only/APPROVAL_ID/` prevents
concurrent/restarted execution of the same approval. `read.json` reserves the whole
discovery workflow before credentials/OAuth; `oauth.json` separately reserves one
token exchange. Reservations stay consumed after errors or timeouts. Never reset
the files or invent another approval ID to retry the same authorization. A timeout
does not prove remote processing stopped.

Approval shape (placeholders are intentionally invalid):

```json
{
  "operation": "sms_discovery",
  "approvalId": "APPROVED_UNIQUE_DISCOVERY_ID",
  "host": "https://platform.ringcentral.com",
  "accountId": "~",
  "extensionId": "~",
  "permissions": ["ReadMessages"],
  "expiresAt": "FUTURE_UTC_TIME_WITHIN_ONE_HOUR",
  "dateFrom": "EXPLICIT_UTC_TIME_SEVEN_DAYS_BEFORE_DATE_TO",
  "dateTo": "EXPLICIT_RECENT_UTC_TIME",
  "authorizedJwtIdentityConfirmed": true,
  "independentReadMessagesOnlyEvidence": "LOCAL_EVIDENCE_REFERENCE"
}
```

## First live discovery prerequisites

* Confirm the dedicated production app settings already reported, the JWT's
  authorized FIGA mailbox identity, and any known numeric account/extension IDs.
  Authorize authenticated-user aliases where those IDs remain unknown. Use a local
  non-secret evidence reference; do not share credentials or customer information.
* Supply the exact seven-day UTC window, approval expiry and unused approval ID.
  Explicitly budget one OAuth POST plus one list GET, with no retries or automatic
  follow-up read. Confirm transient inspection of a potentially real customer SMS
  and metadata-only local output; prior general read-only authorization is retained.
* Separately confirm the exact execution and review a SHA-256 pin for that one
  approval file. Only its isolated CLI bundle may arm the transport/discovery gates
  in memory; shared source gates stay false. Keep the exact-read runner and all
  SMS delivery/other integration controls disabled. See the current preflight guide.
* Complete a local fictional-input terminal check before entering fresh credentials
  privately. No existing credential files or exposed credentials are loaded.

A returned ID does not trigger an exact-message read. The existing exact-read
runner still requires its fictional-message/hash approval and cannot be relabeled
to accept real customer content. A later real-content exact read needs its own
reviewed transient-only approval path and separate request authorization; no such
change or request is included here.

Official sources consulted:
[current API basics and authenticated-user aliases](https://developers.ringcentral.com/guide/basics),
[Message Store guide](https://developers.ringcentral.com/guide/messaging/message-store/working-with-message-store),
[JWT exchange](https://developers.ringcentral.com/guide/authentication/jwt-flow),
[list API reference](https://developers.ringcentral.com/api-reference/Message-Store/listMessages).
The API reference's dynamic viewer did not expose its schema in this environment;
parameter names were cross-checked against RingCentral's
[published OpenAPI snapshot](https://github.com/ringcentral/ringcentral-api-specifications/blob/master/ringcentral.spec.2019110220191017-1140.openapi2.json)
(an older snapshot, not evidence of live behavior). No platform API was probed to
resolve documentation gaps.
