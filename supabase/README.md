# Isolated development database — approval required

Phase 4 adds a separate pending migration and verified staff authorization. See
[Telegram staff setup](STAFF_TELEGRAM.md); it supersedes the legacy assignment
RPC access described below without modifying either applied Phase 3 migration.

The migration files are prepared for review only. No remote Supabase project has
been created, connected, or modified, and no remote migration has been applied.

## Review and connection steps

1. Review both files in `migrations/` in filename order. Approve the schema and
   a **new, empty, isolated** Supabase development project before proceeding.
2. After approval, create that new project (for example `figa-chatbot-dev`) in a
   Free organization. Do not select or link any existing FIGA project. Do not
   enable paid services. Save its project URL/reference for the next step.
3. Only after approval, open the **new project's SQL Editor** and execute
   `20261112000100_figa_schema.sql`, then `20261112000200_figa_transactions.sql`.
   Each file is transactional. They create seven tables plus restricted RPCs.
   They intentionally fail if those tables already exist instead of replacing them.
4. In the new project's **Settings → API Keys**, copy a modern server secret key
   beginning `sb_secret_` into a Git-ignored local dev-vars file. Do not paste
   it into chat, browser code, source files, or `wrangler.jsonc`. No publishable
   browser key or legacy JWT service-role key is required by this application.
5. Put the following in `.dev.vars` for both `npm run dev` and `npm run dev:ai`.
   The AI command explicitly loads this same file with `--env-file .dev.vars`,
   so no second copy of the database secret is needed. Fill values in your editor:

   ```dotenv
   SUPABASE_ENABLED=true
   SUPABASE_ISOLATED_DEV_CONFIRMED=true
   SUPABASE_PROJECT_REF=<new-project-reference>
   SUPABASE_URL=https://<new-project-reference>.supabase.co
   SUPABASE_SECRET_KEY=<new-project-server-secret-key>
   ```

   The URL must exactly match the explicit reference. These flags are operator
   confirmations, not proof that a project is isolated. Leave them false until
   approval. Existing `.dev.vars` files are not overwritten by this implementation.
6. Run `npm.cmd run dev -- --ip 127.0.0.1 --port 8787`. To avoid inference quota
   during database testing, select **Deterministic** in the UI. `/health` reports
   configuration readiness without querying the database; it is not a live DB check.
7. Select **Save fictional conversation**, confirm fictional data, and send a
   sample request. Refresh: the stored ID plus the original HttpOnly cookie restore
   the last 50 messages and current collected details. Correct a field with
   `count: 3`. Reset starts a new browser conversation; audit history is retained.

## Access and failure behavior

- `POST /conversations` accepts `{ "syntheticData": true }`, creates a contact
  and conversation, and issues a seven-day random capability in an HttpOnly,
  SameSite=Strict cookie. Only its SHA-256 hash is stored. Use HTTPS outside local
  development; the Worker enables Secure cookies on HTTPS requests.
- `GET /conversations/:id` requires the matching cookie. Missing/wrong/expired
  access cannot retrieve a conversation by ID. No service secret or access token
  is included in JSON or localStorage. One current conversation cookie is supported
  per browser; a new conversation replaces access to the previous one.
- Persistent `POST /chat` requires `conversationId`, a UUID `messageId`, and
  `syntheticData: true`. Browser state is ignored. Keep the same message ID on
  retries; conflicting reuse returns 409. Leases expire after 60 seconds.
- Database failures return 503 for saved conversations and never generate from
  untrusted browser state. Starting a separate stateless conversation remains
  available without a database. The UI does not silently switch saved chats to
  stateless mode. No automatic network or inference retries occur.
- SQL rechecks mode, status, revision, active ownership and lease before saving
  an outbound reply. HUMAN/blocked turns retain inbound messages but return no
  automated reply. Takeover during inference suppresses the generated reply.
- RLS is enabled on every table; public, anon, authenticated, and service-role
  direct table grants are revoked. Only the narrow service-role RPCs can access
  app data. The internal snapshot helper is not directly callable by service_role.
- `figa_begin_turn` records authorized inbound messages for HUMAN, blocked,
  closed, or actively assigned conversations as `kind: controlled`, without an
  AI lease or engine call. Existing in-flight leases are preserved so the
  finish-time takeover checks still suppress late replies. Duplicate IDs remain
  idempotent; conflicting reuse is rejected.
- Invalid or unknown supplied caregiver counts are removed from collected facts
  and trigger clarification. Both the backend and SQL validate whole numbers
  from 1 to 10,000 before inserting; unknown counts are stored as NULL.
  Valid JSON numeric counts are normalized to strings in conversation state and
  to integers in `provider_requests`, preserving the existing API state format.
- `figa_assign_human` is a privileged internal primitive with row locking,
  expected-revision checks (including rejection of NULL), and one active owner.
  Its `auth.users` foreign key proves identity existence, **not FIGA staff
  authorization**. Service-role access is server authentication, not staff
  authentication. Before exposing any staff HTTP endpoint, a trusted backend
  must verify the caller's identity, active FIGA staff membership and permissions,
  and authorization for the conversation. Derive the staff ID from that verified
  identity, never a request-body ID. These staff checks are not implemented yet;
  this RPC must remain internal. No staff endpoint or messaging integration exists.
  SQL Editor/postgres and server secrets remain privileged and operator-controlled.

## Local verification, no remote services

```powershell
npm.cmd run typecheck
npm.cmd run test:run
npm.cmd run test:database
```

The last command executes both migrations in ephemeral PGlite PostgreSQL with
minimal Supabase role/auth fixtures. This is a development-only dependency; it
does not ship with the Worker. Tests cover constraints, grants/RLS, provider and
caregiver rows, deduplication, leases, takeover races and rollback. They do not
replace a post-approval check against hosted Supabase/PostgREST. No hosted project
or AI is used during these tests.

Only fictional test data is allowed. Medical/contact-sensitive patterns are
rejected before persistence, but heuristics and a consent checkbox cannot prove
data is synthetic. All intake remains user-reported and unverified. Identity
login, token recovery/rotation, retention/deletion policy, rate limiting and staff
authentication for a future operational UI remain later production work.

Official references: [modern API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security),
[database functions](https://supabase.com/docs/guides/database/functions).
