# RingCentral discovery readiness and just-in-time authorization

## Current prepared authorization — separate live approval still required

Prepared using the tested generator, reviewed from its actual saved JSON, pinned
with `--review`, verified in a separate `--verify` process, and independently
checked using PowerShell `Get-FileHash -Algorithm SHA256`. Full offline preflight
returned `offline_preflight_passed`, `ownerPinReady: true`, `requests: 0`,
`credentialsRead: false`, `liveEnabled: false`.

- ID: `figa-discovery-f74681b6-ef81-403d-9c63-301b12daf94c`.
- File: `.wrangler/figa-discovery-f74681b6-ef81-403d-9c63-301b12daf94c.authorization.json`.
- Production host; account `~`; explicit extension and expected OAuth owner `3322425015`.
- Permission: exactly `ReadMessages`.
- UTC window: `2026-11-08T09:27:10.159Z` to `2026-11-15T09:27:10.159Z`.
- Expiry: `2026-11-15T09:47:10.159Z`.
- **Earlier freshness cutoff: `2026-11-15T09:32:10.159Z`. Stop after this cutoff.**
- SHA-256: `8dbdb6876c3fa6fe202ff2c651afa146701d09843c449b26e5c3de4da8acb3b1`.

No retired authorization was reused or changed. The new execution directory does
not exist. The AUTHORIZED pin is empty; shared connection/discovery/runner flags
remain false. SMS delivery remains blocked by `phase7a_receive_only`. No credential
entry, network requests, forwarding, message/account modifications or deployment
occurred. Issuer scope and owner verification remain pending actual OAuth, and
must pass before the GET. Limits remain one OAuth POST and one incoming-SMS GET,
`perPage=1`, no pagination, attachments or retries; five-second deadlines and
16 KiB response limits remain in force.

### Exact procedure AFTER separate approval, only while fresh

Use a clean trusted local terminal in the project root. Never enter credentials
in Codex, command arguments, files or environment variables. First re-run:

```powershell
$approvalPath = '.wrangler/figa-discovery-f74681b6-ef81-403d-9c63-301b12daf94c.authorization.json'
node --import ./scripts/offline-guard.mjs scripts/ringcentral-review-discovery.mjs --verify --approval $approvalPath
if ($LASTEXITCODE -ne 0) { throw 'Pin verification failed' }
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $approvalPath).Hash.ToLowerInvariant()
if ($digest -cne '8dbdb6876c3fa6fe202ff2c651afa146701d09843c449b26e5c3de4da8acb3b1') { throw 'Independent hash mismatch' }
node --import ./scripts/offline-guard.mjs scripts/ringcentral-read-once.mjs --preflight-discovery --approval $approvalPath
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed; stop without activation' }
```

Only after that separate live approval and successful fresh rechecks, activate
the single reviewed hash using the tested declaration editor. This block is
documented for review and WAS NOT executed:

```powershell
@'
import { readFile, writeFile } from 'node:fs/promises';
import { readDiscoveryPins, replaceDiscoveryPin, verifyDiscoveryApprovalPin } from './scripts/ringcentral-discovery-pin.mjs';
const hash = '8dbdb6876c3fa6fe202ff2c651afa146701d09843c449b26e5c3de4da8acb3b1';
const bytes = await readFile('.wrangler/figa-discovery-f74681b6-ef81-403d-9c63-301b12daf94c.authorization.json');
verifyDiscoveryApprovalPin(bytes, hash);
const a = JSON.parse(bytes), now = Date.now();
if (now < Date.parse(a.dateTo) || now - Date.parse(a.dateTo) > 300000 || now >= Date.parse(a.expiresAt)) throw Error('stale_authorization_stop');
const path = 'scripts/ringcentral-discovery-runtime.mjs';
const source = await readFile(path, 'utf8'), pins = readDiscoveryPins(source);
if (pins.reviewed !== hash || pins.authorized !== '') throw Error('authorization_pin_check_failed');
await writeFile(path, replaceDiscoveryPin(source, 'AUTHORIZED', '', hash));
'@ | node --import ./scripts/offline-guard.mjs --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Activation failed; do not execute' }
try {
  node scripts/ringcentral-read-once.mjs --discover --approval $approvalPath
} finally {
  # Belt-and-braces cleanup even if Node cannot start. No HTTP or prompts here.
  @'
import { revokePinnedDiscoveryAuthorization } from './scripts/ringcentral-discovery-runtime.mjs';
await revokePinnedDiscoveryAuthorization();
'@ | node --import ./scripts/offline-guard.mjs --input-type=module
  if ($LASTEXITCODE -ne 0) { throw 'Authorization cleanup failed; stop' }
}
```

The runner claims an exclusive execution directory and separate one-attempt
ledgers, revokes the disk pin before hidden credential prompts, validates actual
OAuth scope/owner before listing, disposes its session and emits only sanitized
results. Do not retry or follow with an exact-message read. If this authorization
becomes stale before approval, STOP and explicitly prepare/review/verify a NEW
authorization; do not modify dates in this pinned file.

## Earlier offline diagnosis and preparation reference

All outstanding offline checks passed. Live execution, discovery and SMS delivery remain disabled. No usable authorization was generated during this debugging round; generated test authorizations existed only in isolated fixture roots and were removed after testing.

## Confirmed approval_invalid cause

The existing reviewed authorization is .wrangler/figa-discovery-106a697e-6cf7-4407-884b-c0cce640704a.authorization.json. Its expiry is 2026-11-15T09:27:26.984Z, but its dateTo is 2026-11-15T09:07:26.984Z. The validator has TWO independent time restrictions: approval expiry and a maximum five-minute age for dateTo. Its effective freshness cutoff was 2026-11-15T09:12:26.984Z.

At 2026-11-15T09:22:20.484Z the real validator rejected that file with ONLY window_stale, while expiry was still in the future. Replay of the unchanged file at creation plus one second passed. Replay at the cutoff plus one millisecond rejected window_stale. Replay after expiry rejected both approval_expired and window_stale. Hash and checksum still match; shape, IDs, permissions, canonical timestamps, seven-day duration and owner binding all pass at creation. The exact time of the operator earlier terminal invocation is unknown, so these are reproduced results rather than an invented diagnosis of an unrecorded run.

This is distinct from the older authorization_pin_check_failed source-editing bug: a whole-source occurrence count matched both a declaration and a revocation string. The anchored declaration editor fixed that bug. The retired e379dbaa authorization, checksum and zero-request execution history remain unchanged.

## Implementation

- src/ringcentral/discovery-approval.ts retains the existing validation rules and exposes fixed reason codes through smsDiscoveryApprovalIssues. The validator uses those same checks, so diagnostics cannot silently disagree with acceptance.
- src/ringcentral/sms-discovery.ts re-exports the diagnostic helper. scripts/ringcentral-read-once.mjs includes only allowlisted reason-code strings when approval validation fails. No raw values, prompts, tokens or customer data are printed.
- scripts/ringcentral-prepare-discovery.mjs --create builds a UUID authorization at invocation time, validates it using the actual validator, and exclusively writes UTF-8 JSON without a BOM. It requires the live pin and shared gates to remain disabled. It neither pins an execution authorization nor accesses credentials or HTTP.
- The fixed profile is production https://platform.ringcentral.com, authenticated account ~, explicit extension and expected OAuth owner 3322425015, ReadMessages only, exactly seven days, 20-minute expiry, and the unchanged five-minute freshness cutoff.
- Review and exact-byte pinning remain separate explicit offline steps. --verify checks byte integrity, not time validity; full runner preflight remains mandatory. PowerShell Get-FileHash independently verifies the digest.

Operator confirmation of extension 101 and application permissions is not independent runtime proof. A future separately authorized OAuth response must still have exactly ReadMessages, Bearer type, adequate lifetime, and owner_id 3322425015 before any discovery GET. A different owner, scope, permission or safety failure stops before the GET. Maximum one OAuth POST plus one inbound-SMS GET, perPage=1, no retries, pagination or attachments. Shared extension 102 is never a fallback.

## Actual offline results

- 133 mocked authentication/discovery unit tests passed (52 authentication, 81 discovery), including separate stale-window/expiry diagnosis.
- All eight RingCentral offline Node/SQL test files passed: authentication ledger, discovery ledger/preflight, pin review, pin verification, preparation, read ledger, receive-only SQL and runner.
- The preparation fixture executes the actual generator, reads the exact JSON for policy assertions, runs --review, runs --verify in a separate process, checks the digest using node:crypto independently, and runs real --preflight-discovery. It verifies exclusive writes, tamper rejection, safe diagnostic output, no execution ledger creation, and disabled live execution. Production-source pins are not modified by the fixture.
- Both application and test TypeScript checks passed. The earlier sandbox/approval-service blocker did not recur when the guarded test runs were authorized this round.
- Network attempts, real OAuth/API requests, AI inference and credential access: zero. No deployments, remote writes, settings or feature-flag changes.

Commands used:

```powershell
node --import ./scripts/offline-guard.mjs --test database-tests/ringcentral-*.test.mjs
node --import ./scripts/offline-guard.mjs node_modules/vitest/vitest.mjs run --config vitest.offline.config.mts test/ringcentral-auth.spec.ts test/ringcentral-discovery.spec.ts --silent
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit
node --import ./scripts/offline-guard.mjs node_modules/typescript/bin/tsc --noEmit -p test/tsconfig.json
```

## Create only immediately before an approved run

Do not run these commands while debugging. They prepare and verify an authorization only; they never enable live access. Run in the project root. Creating it does not authorize a live request.

```powershell
$creationJson = node --import ./scripts/offline-guard.mjs scripts/ringcentral-prepare-discovery.mjs --create
if ($LASTEXITCODE -ne 0) { throw "Offline preparation failed" }
$prepared = $creationJson | ConvertFrom-Json
$approvalPath = $prepared.approvalPath
Get-Content -LiteralPath $approvalPath
```

REVIEW the displayed JSON before continuing: unique ID, production host, account ~, explicit extension/owner 3322425015, only ReadMessages, seven-day UTC window ending now, expiry, and operator evidence. No credentials belong in this file. Do not edit it after pinning. These fields are non-secret authorization metadata.

Then pin and verify the exact reviewed file:

```powershell
node --import ./scripts/offline-guard.mjs scripts/ringcentral-review-discovery.mjs --review --approval $approvalPath
if ($LASTEXITCODE -ne 0) { throw "Review or pinning failed" }
$verificationJson = node --import ./scripts/offline-guard.mjs scripts/ringcentral-review-discovery.mjs --verify --approval $approvalPath
if ($LASTEXITCODE -ne 0) { throw "Pin verification failed" }
$verified = $verificationJson | ConvertFrom-Json
$independentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $approvalPath).Hash.ToLowerInvariant()
if ($verified.status -ne "reviewed_pin_verified" -or $independentHash -cne $verified.sha256) { throw "Independent SHA-256 verification failed" }
node --import ./scripts/offline-guard.mjs scripts/ringcentral-read-once.mjs --preflight-discovery --approval $approvalPath
if ($LASTEXITCODE -ne 0) { throw "Offline preflight failed" }
```

If review exceeds the five-minute freshness cutoff, STOP. Do not extend expiry, relax freshness or silently regenerate. When ready, explicitly create and review a new unique authorization. Preserve previous files and ledgers. The AUTHORIZED pin must stay empty until separate live-execution approval; the reviewed hash alone cannot enable execution.

Before any separately authorized live attempt, repeat the final integrity and preflight checks within the fresh window. Credentials may then be entered only at hidden prompts in a trusted local terminal, never in Codex, arguments, files, logs or Git. The one-shot runner must consume its exclusive ledger and revoke its disk execution pin before credential entry. No live command was executed or authorized by this debugging task.
