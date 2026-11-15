# First discovery preflight - current status

**Owner binding is ready for separate execution approval.** The operator verified
short extension 101 maps to internal API ID `3322425015` directly in the Admin Portal.
The updated endpoint and OAuth owner pin both require that internal ID.

See [the current reviewed authorization and results](RINGCENTRAL_REVIEWED_DISCOVERY.md).
Its offline preflight passed with `ownerPinReady: true`, zero requests, no credential
reads and live execution disabled. The reviewed hash is updated; the execution hash
is empty. No real RingCentral activity or FIGA changes occurred.

The instructions below remain useful for identity checks. All older draft windows
and owner-unknown notes are historical and superseded by the current review.

## Verify the mailbox through the interface

RingCentral documents JWTs as user credentials, rather than credentials owned by
the application. A company/developer account label and app scope alone do not
identify the mailbox. Use these read-only checks yourself:

1. In the Developer Console, inspect the signed-in user/profile identity. Open the
   top-right user menu and choose **Credentials**. Find the existing JWT by its
   label and metadata; do not reveal/copy its value or click Create, Save, Revoke
   or Delete. If a details screen exposes its value, leave it closed and inspect
   only the surrounding user/profile context.
2. If a Developer Admin created the credential on someone else's behalf, inspect
   **Organization → the relevant developer → Credentials**. Establish which user's
   credential list contains that existing JWT. Do not infer ownership from which
   app is permitted to use it.
3. In the RingCentral Admin Portal, inspect that same known user's entry under
   **Users → User List → Users with Extensions**. Read the user details and displayed
   extension number without editing anything or opening messages. This is an
   operator interface check of the known identity, not an API account/extension
   enumeration. Do not change routing, roles, settings or coworkers' communications.
4. Distinguish the displayed extension number from an API internal extension ID.
   If the UI does not explicitly show the internal ID, leave it unknown. Do not
   substitute `101` or guess a URL identifier. After the user/mailbox is confirmed,
   documented `~` aliases can address that authenticated identity; the later
   separately authorized OAuth response must supply a valid numeric `owner_id`.

Report only whether the credential belongs to the intended authorized FIGA mailbox
and its non-secret role/extension label. Do not share JWTs, client secrets, customer
information, phone numbers, screenshots showing credentials or full console pages.
If the interface does not establish the user binding, the prerequisite remains unmet;
do not use a live test, token decoding service or API Explorer to guess it.

References: [personal JWT ownership and console menus](https://developers.ringcentral.com/guide/getting-started/create-credential),
[official Admin Portal guide](https://assets.ringcentral.com/us/guide/mvp_admin_guide.pdf),
[internal IDs and authenticated-user aliases](https://developers.ringcentral.com/guide/basics).

## Prepared offline authorization

New local, Git-ignored file:
`.wrangler/figa-discovery-20261115-082346.authorization.json`.
The earlier `.wrangler/figa-discovery-authorization.draft.json` remains unchanged as
an obsolete, unconfirmed draft; do not run it or reset any earlier ledger.

* Identified mailbox: FIGA Super Admin, displayed extension 101, operator-confirmed.
* Production host: `https://platform.ringcentral.com`.
* API account/extension: authenticated-user aliases `~` / `~`. The short number
  `101` is deliberately not entered as an API ID.
* Budget: **at most one JWT OAuth POST and one inbound-SMS list GET**, with no retry,
  no pagination, `messageType=SMS`, `direction=Inbound`, `perPage=1`, `page=1`.
* Explicit window: `2026-11-08T08:23:46.000Z` through
  `2026-11-15T08:23:46.000Z`, exactly seven days UTC.
* Authorization expiry: `2026-11-15T08:43:46.000Z`. The additional five-minute
  freshness rule prevents dispatch after approximately `08:28:46Z`, even though
  the authorization expiry is later. Do not silently refresh this window.
* `authorizedJwtIdentityConfirmed` is now **true**, based only on the operator's
  account-to-mailbox identity check. The evidence reference is non-secret; it is
  not an independent audit of app permissions or a successful live OAuth check.

Safe offline preflight command (no credentials, HTTP or ledger creation):

```powershell
node scripts/ringcentral-read-once.mjs --preflight-discovery --approval .wrangler/figa-discovery-20261115-082346.authorization.json
```

A successful result is `offline_preflight_passed`, `requests: 0`,
`credentialsRead: false`, `liveEnabled: false`. It checks approval schema, production
host, scope, date constraints and an unused per-approval directory. The output
correctly labels mailbox identity `operator_asserted_not_live_verified`.
`--check-discovery` still returns `disabled`, zero attempts and exit code 1.

The first separately authorized OAuth response must contain exactly `ReadMessages`,
Bearer type, sufficient lifetime and a positive numeric string `owner_id`. The list
transport is then bound to that owner. With unknown internal IDs, `~` addresses the
same authenticated JWT user without an additional lookup or account/extension
listing. This establishes the issuer-returned internal owner for the JWT; it does
not independently prove that the short extension number is 101. That mapping rests
on the operator's UI verification. Stop if new evidence contradicts it.

No credential, live pin, live bundle or request ledger is created by preflight.
If the window becomes stale before separate confirmation, prepare and review a
fresh explicit authorization. No automatic date refresh or retry occurs.

## One-shot activation cannot arm ordinary chatbot traffic

The shared transport/discovery source gates stay **false**. Future discovery must
not enable them globally. `scripts/ringcentral-discovery-runtime.mjs` instead has
an **empty** `AUTHORIZED_DISCOVERY_APPROVAL_SHA256` pin: no live approval is active.
Only after separate confirmation may one exact, validated approval file hash be
reviewed and pinned. Changing any bytes, target, ID, window or expiry breaks the pin.

The CLI claims the approval's exclusive directory and creates separate `read.json`
workflow / `oauth.json` ledgers before building its isolated runtime. Only then can
the matched pin arm the two gates in an in-memory Node bundle. No enabled bundle
is written, no source flag changes, and forbidden Worker/AI/database/Telegram imports
are rejected. Ordinary Worker code retains false gates and no discovery route.
The existing exact-message runner remains disabled.

The one-shot session is disposed in CLI `finally`, discarding credential/executor
references and rejecting future use. Disposal during OAuth prevents a later list
GET. The local process exits; the same approval cannot be rerun because its exclusive
directory/ledgers remain consumed, including after failure. No pin was set here.
This is a local operator-controlled authorization boundary, not a sandbox against
malicious code already running in the same process. A timeout cannot prove remote
processing stopped, and an OAuth token is not revoked automatically because that
would require another unauthorized API request.

## Remaining checks for one separately confirmed execution

1. Mailbox identification is complete by operator confirmation: FIGA Super Admin,
   displayed extension 101. Internal IDs may remain unknown with authenticated-user
   aliases; validate and bind the issuer-returned owner during the authorized OAuth.
2. Review a fresh exact seven-day window, expiry, unique approval ID and permission
   evidence. Confirm one OAuth POST + one GET, then pin only that approval's hash.
3. Use a trusted local interactive terminal and hidden prompts for Client ID, Client
   Secret and JWT. Debug/preload/tracing startup options are rejected before secret
   entry; inherited service environment settings are discarded without reading values.
   Fake terminal tests passed; no real terminal credential entry has been attempted.

Prepared future command, **not to execute yet**:

```powershell
node scripts/ringcentral-read-once.mjs --discover --approval .wrangler/figa-discovery-20261115-082346.authorization.json
```

At execution the issuer scope must be exactly ReadMessages, the token must be Bearer
and sufficiently fresh, and the owner must be numeric/match every known identity
binding. Customer fields are transient only; output is newly constructed ID,
direction and status. Ledgers contain only status/counts. Five-second deadlines,
16 KiB limits, redirect rejection, no attachment downloads or message mutations,
and no follow-up exact read remain enforced. Live authentication/permissions are
unverified until that separately approved execution.
