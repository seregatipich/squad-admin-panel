# Full Test Coverage Implementation Plan

> **For the executing agent:** Follow tasks in order. Each sub-task is bite-sized (write failing test → impl/verify → green → commit). The three tiers have different infrastructure assumptions; Tier 1 uses fakes, Tier 2 hits the live Postgres container with an isolated test schema (`test_<timestamp>`) + Redis db 15, and Tier 3 drives the live panel + real bridge socket via the `panel` group. All work lands on `master`; small commits, push at natural boundaries.

**Goal:** Take the monorepo from ~13% test coverage (24 files, ~100 tests) to end-to-end coverage across every route, every bridge RPC method, every lib, every production worker, every web page user flow, with green tier-1, tier-2, and tier-3 suites plus Playwright evidence for UI features.

**Architecture:**
- Tier 1 adds new vitest / `go test` files colocated with the code they cover; fakes for all external deps.
- Tier 2 adds new Fastify `inject()` tests in `apps/api/test/integration/` against a fresh ephemeral DB schema + Redis db 15; uses a scripted fake bridge client.
- Tier 3 (a) expands `apps/api/test/e2e/bridge-rpc.e2e.test.ts` for the 5 untested RPC methods, and (b) introduces `apps/web/e2e/**` Playwright suites against the running Caddy-fronted panel.

**Tech stack:** Vitest 3.2, Fastify 5, Zod 3.24, Drizzle, ioredis, Playwright 1.59 (already in `apps/web`), Go 1.22 (bridge), ripgrep / biome / lefthook on host.

**Live infra available right now on this host** (verified):
- Containers: `squad-admin-panel-{api,web,worker-*,postgres,redis,caddy}-1` all up.
- Postgres: `admin/admin@127.0.0.1:5432/admin` (inside compose network; host port not always exposed — run migrations from inside the api container or with `docker exec postgres-1 psql`).
- Redis: `redis:7-alpine`, default port exposed to host.
- Bridge socket: `/run/panel-host-bridge.sock`, owner root:panel, mode 0660. The `squad` user is in the `panel` group already (id output confirmed) — running tests under that user gives socket access without `sg panel -c`.
- Caddy: serves the web UI on `https://localhost/` (80/443 published); self-signed cert → tests must use `NODE_TLS_REJECT_UNAUTHORIZED=0` or `ignoreHTTPSErrors: true` in Playwright.
- Depot volume `squad-depot` populated.

**Out of scope for this plan (deferred to P1):**
- Stub workers (automation, backup, config-sync, discord, scheduler, stats) — no functionality yet.
- Web component-level rendering tests (React Testing Library) — Playwright E2E gives functional coverage.
- Chaos / load tests.

---

## Phase 0 — Baseline fix

- [x] Fix `packages/shared-config/test/permissions.test.ts` Viewer-regex bug (`server:config:history` is read-only but not `view`). Committed in `20109c6`.
- [x] Confirm baseline green via `pnpm -r run test` + `pnpm turbo run typecheck`.

---

## Phase 1 — Tier 1 (unit) gaps

**Scope:** 6 new files / ~70 tests covering crypto, RBAC, blame, audit, all DB schema constraints, all untested bridge RPC handlers, bridge-client method wrappers.

### Task 1.1 — `apps/api/test/argon.test.ts`

**Purpose:** Password hashing round-trip + verify rejects wrong passwords + stored hash format.

- [ ] Create `apps/api/test/argon.test.ts`
- [ ] Cases: (a) `hashPassword` produces `$argon2id$` prefix (b) `verifyPassword` true on correct plaintext (c) `verifyPassword` false on wrong plaintext (d) `verifyPassword` false on malformed hash (doesn't throw) (e) different hashes for same password (random salt)
- [ ] Run: `pnpm --filter @squad/api exec vitest run test/argon.test.ts`
- [ ] Commit: `test(api): argon2 password hash/verify coverage`

### Task 1.2 — `apps/api/test/sessions.test.ts`

**Purpose:** `mintSessionToken`, `tokenIdFromToken`, `createSession`/`resolveSession`/`revokeSession`/`revokeAllForUser`/`pruneExpired` with in-memory Drizzle stub and real `ioredis` pointed at db 15.

Fake DB approach — build a tiny `FakeDb` object that implements the 5 methods used (`insert`, `select`, `delete`, chained `.where().limit()`). This avoids the integration-test weight while exercising the branching in `sessions.ts`.

- [ ] Create `apps/api/test/sessions.test.ts`
- [ ] Cases: (a) `mintSessionToken` returns `s_…` token + sha256 tokenId (b) `tokenIdFromToken` is deterministic (c) `createSession` inserts into fake DB + sets Redis key with TTL (d) `resolveSession` cache hit path (e) `resolveSession` cache miss → DB → hydrate cache (f) `resolveSession` expired returns null + deletes (g) `revokeSession` removes from DB + Redis (h) `pruneExpired` returns rowCount
- [ ] Use `new Redis('redis://127.0.0.1:6379/15')`; `afterEach` flush db 15.
- [ ] Run: `pnpm --filter @squad/api exec vitest run test/sessions.test.ts`
- [ ] Commit: `test(api): sessions CRUD + redis cache coverage`

### Task 1.3 — `apps/api/test/totp.test.ts`

**Purpose:** TOTP generate/verify, backup codes generate/consume, step arithmetic.

- [ ] Create `apps/api/test/totp.test.ts`
- [ ] Cases:
  - `generateTotp` returns 20-byte secret, otpauth URI containing account, 32-char Base32 manual entry
  - `verifyTotpCode` accepts current TOTP from same secret
  - `verifyTotpCode` rejects codes that aren't 6 digits
  - `verifyTotpCode` rejects whitespace-stripped but out-of-window codes
  - `currentStep` is monotonic (date + 30s ⇒ step+1)
  - `generateBackupCodes` returns 8 codes of shape `XXXXX-XXXXX` with matching hashed array
  - `consumeBackupCode` consumes, removes hash, returns remaining
  - `consumeBackupCode` case-insensitive + trim
  - `consumeBackupCode` false on unknown code, doesn't mutate
- [ ] Run; commit `test(api): totp + backup code coverage`.

### Task 1.4 — `apps/api/test/rbac.test.ts`

**Purpose:** `loadUserPermissions` (with fake db), `hasPermission`, cache invalidation, `hasServerPermission`.

- [ ] Create `apps/api/test/rbac.test.ts`
- [ ] Cases: empty-role user returns empty PermissionContext; multiple roles unioned; clearance = max(role clearance); cache hit within TTL; `invalidatePermissionCache` forces re-read; `hasPermission` all-required semantics; `hasServerPermission` fails when permission missing; `hasServerPermission` fails when server row absent.
- [ ] Run; commit `test(api): rbac permission loader + cache coverage`.

### Task 1.5 — `apps/api/test/blame.test.ts`

**Purpose:** `computeBlame` correctness across insert/delete/modify.

- [ ] Create `apps/api/test/blame.test.ts`
- [ ] Cases:
  - Empty versions → []
  - Single version → every line attributed to it
  - Two versions, unchanged → all lines keep v1 attribution
  - Two versions with line insertion → new line attributed to v2, others v1
  - Two versions with line deletion → remaining lines keep original
  - Three versions with modify-then-revert → tip attribution points to latest author that touched that line
  - CRLF handling (lines split on `\r?\n`)
  - Unordered versions input (sort by created_at enforced)
- [ ] Run; commit `test(api): blame diff attribution coverage`.

### Task 1.6 — `apps/api/test/audit.test.ts`

**Purpose:** `writeAuditEntry` serialization, default `actorKind`, `null` before/after pass-through.

- [ ] Create `apps/api/test/audit.test.ts`
- [ ] Use fake db with `insert(...).values(v)` capturing payload.
- [ ] Cases: minimal entry → actorKind defaults to 'user'; explicit 'system'/'external' passes through; `before`/`after` undefined → null; `context` omitted → `{}`; `orgId` default null; `statusCode`/`durationMs` pass through.
- [ ] Run; commit `test(api): audit row construction coverage`.

### Task 1.7 — `packages/db/test/schema.test.ts` expansion

**Purpose:** Cover every table's critical invariants — FK columns declared; NOT NULL on required columns; generated trigger for `audit_log` hash; `config_versions` append-only trigger.

- [ ] Extend `packages/db/test/schema.test.ts`
- [ ] Use Drizzle schema introspection — loop over every exported table from `@squad/db/schema` and assert: primary key present; `createdAt`/`updatedAt` columns where expected; FK relations aren't double-declared.
- [ ] Trigger / constraint checks that can't be introspected (append-only triggers, partition DDL) go in a new **integration** test in Phase 2 (`test/integration/db-triggers.test.ts`).
- [ ] Run `pnpm --filter @squad/db test`
- [ ] Commit `test(db): introspective schema invariants across all 19 tables`.

### Task 1.8 — `apps/bridge/internal/handlers/handlers_test.go`

**Purpose:** Unit-test the 5 untested handler functions (`processInfo`, `fileWrite`, `containerStart`, `containerStop`, `containerRm`) and the dispatch table.

The handlers that shell out (container_*) should use a `Runner` interface so we can inject a `FakeRunner`. Check current signature — `runner/docker.go` — and plumb a receiver-injection if needed. Otherwise wrap with a minimal test helper that replaces `exec.CommandContext` via a package-level indirection (common Go pattern).

- [ ] Create `apps/bridge/internal/handlers/handlers_test.go`
- [ ] Cases:
  - `processInfo` for PID of the current Go test process returns a populated struct
  - `fileWrite` happy path writes bytes to an allowlisted tempfile
  - `fileWrite` forbidden path is rejected by `validate.go`
  - `containerStart/Stop/Rm` with injected runner: command is built correctly (arg order), stderr → error, non-allowlisted name → validation error before runner called
- [ ] Run `cd apps/bridge && go test -race -count=1 ./internal/handlers/`
- [ ] Commit `test(bridge): unit tests for process_info, file_write, container_start/stop/rm`.

### Task 1.9 — `packages/bridge-client/test/client.test.ts`

**Purpose:** Each RPC wrapper marshals args correctly + decodes results; error frame surfaces as rejection; connection drop mid-call reconnects on next call (the `closed=true` invariant).

- [ ] Create `packages/bridge-client/test/client.test.ts`
- [ ] Use a net.Socket pair (or `net.createServer` on a Unix socket) to pretend to be the bridge; assert the client's outbound frame bytes match expected JSON, respond with a canned frame.
- [ ] Cases:
  - All 15 method wrappers send the right `method` + `params`
  - Result decode returns typed value
  - Error frame surfaces as a thrown Error with code
  - Decode-error path drops socket but does NOT set `closed=true` (subsequent call reconnects)
- [ ] Commit `test(bridge-client): RPC method wrappers + error handling coverage`.

### Task 1.10 — Worker unit tests

**Purpose:** Fill gaps in rcon supervisor/client/persist and log-ingest ingest/tail/publish using fakes.

- [ ] Create `apps/workers/rcon/test/supervisor.test.ts`
  - Cases: ticks ListPlayers every 30s (fake timer), emits `rcon:status` JSON shape (state connected, player_count, last_poll_at), drops target when server status transitions away from running, reconnects after a client error.
- [ ] Create `apps/workers/rcon/test/client.test.ts`
  - Cases: AUTH happy path, AUTH bad password surfaces typed error, queue serializes commands, socket close rejects pending.
- [ ] Create `apps/workers/rcon/test/persist.test.ts`
  - Cases: `insertPollHistory` with fake db persists row; swallow (or surface?) DB error according to current impl.
- [ ] Create `apps/workers/log-ingest/test/ingest.test.ts`
  - Cases: pattern → EventEnvelope shape; timestamp extracted; unknown line becomes `log.raw` event.
- [ ] Create `apps/workers/log-ingest/test/tail.test.ts`
  - Cases: split multi-line frames; resume after a partial line; `done` callback fires on EOF.
- [ ] Create `apps/workers/log-ingest/test/publish.test.ts`
  - Cases: publishes to `events:server:{id}` via XADD; batches under a single pipeline; ack on success.
- [ ] Commit per-worker: `test(worker-rcon): supervisor/client/persist coverage`, `test(worker-log-ingest): ingest/tail/publish coverage`.

---

## Phase 2 — Tier 2 (integration) gaps

**Scope:** 7 new files / ~95 tests. Use live Postgres (create a fresh schema per run) + Redis db 15. Real Fastify via `inject()`. Fake bridge client.

### Task 2.0 — Shared test harness `apps/api/test/integration/harness.ts`

Single helper exports:
- `buildApp({ seedOrg?: boolean, seedUser?: { role?: RoleName; totp?: boolean } })` — registers all plugins + routes against a fresh schema, migrates, seeds system roles, returns `{ app, db, redis, schema, cleanup() }`.
- `makeFakeBridge(overrides)` — returns a `BridgeClient`-shaped object with sensible defaults (`ping` returns hostname, `hostInfo` returns fixture, `fileRead`/`fileWrite` use an in-memory map, `containerInspect` returns canned state).
- `loginAs(app, user)` — POSTs `/auth/login`, returns the `__Host-sid` cookie for subsequent injects.
- `withAuditAssert(app, { action, resource }, fn)` — runs fn, then queries audit_log to assert a row was written within the last 5s matching the tag.

**Schema-per-test** approach: at `beforeEach`, create `test_${random()}` schema via `CREATE SCHEMA`, set `search_path`, run `drizzle migrate`, teardown drops the schema. This keeps Postgres containers clean across runs.

- [ ] Create `apps/api/test/integration/harness.ts`
- [ ] Create `apps/api/test/integration/harness.setup.ts` (global setup — ensures Postgres reachable, container running).
- [ ] Update `apps/api/vitest.config.ts` to include `test/integration/**` in the default test run AND expose `pnpm --filter @squad/api test:integration` that includes only that dir.
- [ ] Smoke test: `apps/api/test/integration/harness.test.ts` — builds + tears down; asserts schema disappears.
- [ ] Commit: `test(api): integration-test harness (ephemeral schema + fake bridge + login helper)`.

### Task 2.1 — `apps/api/test/integration/auth.test.ts`

- [ ] Create file; use harness with `seedOrg: true`.
- [ ] 12 cases:
  1. POST /auth/login — unknown email → 401 invalid_credentials
  2. POST /auth/login — wrong password → 401 invalid_credentials
  3. POST /auth/login — good password, no TOTP → 200, cookie set, session in DB, audit row written
  4. POST /auth/login — TOTP-required user without code → 401 totp_required
  5. POST /auth/login — valid TOTP → 200, totp_last_used_step updated
  6. POST /auth/login — replay of same TOTP → 401 totp_replay
  7. POST /auth/login — backup code valid → 200, code removed from remaining hashes
  8. POST /auth/login — backup code invalid → 401 invalid_backup_code
  9. POST /auth/logout — revokes session, clears cookie, audit row written
  10. GET /me — 401 when unauthenticated; 200 when authenticated returns permissions + clearance
  11. POST /me/totp/provision — encrypts secret, returns URI + 8 backup codes
  12. POST /me/totp/enable — wrong TOTP → 401; right TOTP → 200
  13. POST /me/totp/disable — wrong password → 401; right password → 200 and secret nulled
- [ ] Commit `test(api): integration coverage for /auth + /me + TOTP endpoints`.

### Task 2.2 — `apps/api/test/integration/setup.test.ts`

- [ ] 8 cases:
  1. GET /setup/check-env — returns bridge OK when fake bridge returns an Ubuntu-looking hostInfo; returns host.ok=false if os_name isn't Ubuntu/Debian
  2. GET /setup/check-env when setup_complete=true → 410
  3. POST /setup/org — creates row, seeds system roles (Owner/SeniorAdmin/Admin/Viewer), slug derived when omitted
  4. POST /setup/org — custom slug accepted; rejects invalid slug by Zod
  5. POST /setup/owner before org → 400 no_organization_yet
  6. POST /setup/owner — inserts user, assigns Owner role, adds organization_members row, password is argon2 hashed
  7. POST /setup/owner with duplicate email → 409
  8. POST /setup/finalize — flips `setup_complete=true`, audit row written
- [ ] Commit `test(api): integration coverage for /setup flow`.

### Task 2.3 — `apps/api/test/integration/servers.test.ts`

- [ ] 15 cases covering `routes/servers.ts`:
  - GET /servers empty + seeded; merges redis rcon:status JSON; null when not polled
  - POST /servers — inserts server+settings+credentials, RCON password encrypted, slug auto-gen; Zod validation 422 on missing fields
  - POST /servers duplicate slug → 409
  - GET /servers/:id 404; 200 with full shape
  - POST /servers/:id/start — no-op if already running; issues container_start via fake bridge; audit row
  - POST /servers/:id/stop — issues RCON AdminBroadcast + AdminEndMatch + container_stop; audit row
  - POST /servers/:id/restart — stop+start sequence; audit row
  - DELETE /servers/:id — cascades settings+credentials; issues container_rm; audit row
  - Permission enforcement: Viewer → 403 on POST/DELETE; Owner → 200
- [ ] Commit `test(api): integration coverage for /servers CRUD + lifecycle + permissions`.

### Task 2.4 — `apps/api/test/integration/server-configs.test.ts`

- [ ] 10 cases covering `routes/server-configs.ts`:
  - GET /configs lists from bridge (fake returns 19 .cfg names)
  - GET /configs/:name returns file content from fake bridge
  - PUT /configs/:name — writes via bridge, inserts config_versions row, returns sha256; audit row
  - PUT idempotent sha256 skip: second PUT with same content returns `{ unchanged: true }`, no new version
  - GET /configs/:name/history — lists versions oldest→newest
  - GET /configs/:name/versions/:vid — returns specific version content + metadata
  - GET /configs/:name/diff?from=&to= — unified diff text
  - GET /configs/:name/blame — uses blame cache on second call; invalidated after PUT
  - POST /configs/:name/restore/:vid — creates a new version referencing restored content, audit row with previous version id
  - Rcon.cfg PUT: audit row records sha256 only, NEVER content
- [ ] Commit `test(api): integration coverage for /server-configs editor`.

### Task 2.5 — `apps/api/test/integration/host-players-audit-depot.test.ts`

- [ ] 20 cases across the remaining routes:
  - GET /host/info forwards fake bridge hostInfo
  - GET /host/metrics forwards fake bridge hostMetrics
  - GET /host/bridge-status reports `connected: true` on successful ping; `false` + error on ping throw
  - GET /permissions returns the 4 system roles with clearance + keys
  - GET /players paginated
  - GET /players/:steamId returns profile + ip_history + name_history (seeded rows)
  - GET /players/:steamId 404 on unknown
  - Permissions: `player:view_ips` absent → IP history omitted
  - GET /audit — paginated; filter by action, actor, target; date range
  - GET /audit — Viewer cannot see audit (permission check) OR can (depending on perms config — assert matches rbac)
  - GET /depot — state (populated/empty)
  - POST /depot/update — audit row written; streaming WS /depot/progress/ws delivers fake bridge `depot_update` lines; closes on exit code
- [ ] Commit `test(api): integration coverage for host, permissions, players, audit, depot`.

### Task 2.6 — `apps/api/test/integration/plugins.test.ts`

- [ ] 12 cases for plugins (auth, audit, request-context, status-reconciler):
  - auth: unauthenticated GET of a `permissions: ['server:view']` route → 401
  - auth: authenticated without permission → 403 with `required`
  - auth: expired session cookie → 401
  - auth: corrupted cookie → 401 no crash
  - audit: `audit: false` routes do NOT write audit_log rows
  - audit: `audit: {action, resource}` routes DO write, including error responses (statusCode≠2xx)
  - audit: extractTargetId picks `id` > `serverId` > `userId` from params
  - status-reconciler: inspect returns 'running' → DB status flips to running; inspect returns 'exited' → DB flips to stopped; inspect 'not_found' → DB is unchanged (404 handled)
  - request-context: decorates `req.id` and correlates to response headers
  - install-progress: publish-before-subscribe replays buffered messages (already covered — regression guard)
- [ ] Commit `test(api): integration coverage for auth / audit / request-context / status-reconciler plugins`.

### Task 2.7 — `apps/api/test/integration/db-triggers.test.ts`

- [ ] 6 cases against the ephemeral schema:
  - `audit_log` BEFORE UPDATE raises 'audit_log is append-only'
  - `audit_log` BEFORE DELETE raises same
  - `audit_log.row_hash` chain computed correctly across three inserts (`sha256(prev || canonical_json(row))`)
  - `config_versions` UPDATE/DELETE triggers raise
  - `config_versions` INSERT updates `tip_version_id` on corresponding server_config record (if present in current schema)
  - `events` partition insert → routes to correct `events_YYYY_MM` partition
- [ ] Commit `test(db): trigger + append-only invariants`.

### Task 2.8 — Unskip + extend `event-dlq-autoclaim.test.ts`

`test/event-dlq-autoclaim.test.ts` has 2 skipped cases. Figure out WHY they're skipped (missing Redis? env?) and either make them pass against our live Redis, or delete the `.skip` and fix the cause.

- [ ] Read file; identify skip reason.
- [ ] If Redis-dep-only, point at db 15 and unskip.
- [ ] Add 4 more cases: claim moves to pending; ack removes from DLQ; non-ack within timeout → re-pending; idempotent reclaim.
- [ ] Commit `test(api): unskip + extend event-dlq autoclaim coverage`.

---

## Phase 3 — Tier 3 (E2E) gaps

**Scope:** Expand bridge-rpc file for 5 untested methods. Introduce Playwright suite in `apps/web/e2e` for 6 user flows.

### Task 3.1 — Expand `apps/api/test/e2e/bridge-rpc.e2e.test.ts`

- [ ] Add success-path cases for:
  - `process_info(pid)` → returns current api-container PID info
  - `file_write` → write + read back under a temp path in the allowlist (use `/var/lib/squad-panel/saved/{test-uuid}/scratch.txt`)
  - `container_start/stop/rm` — create a throwaway `alpine:3` container through `container_run` first (it's the one allowed tag? — if only `squad-server:latest` and `squad-panel/depot-init:latest` are allowlisted, instead target the already-running test fixture that the e2e harness creates, or add a dedicated test image allowlist entry behind `NODE_ENV=test`).
  - If allowlist prevents it, test container_start/stop/rm against the depot-init image (transient container) and assert lifecycle transitions via `container_inspect`.
- [ ] Add forbidden-path cases for:
  - `file_write` outside allowlist → validation error
  - `container_start` with non-squad/depot-init name → validation error
  - `container_rm` for container owned by another UID (root) → validation error
- [ ] Commit `test(e2e): complete bridge-rpc coverage for process_info / file_write / container_start/stop/rm`.

### Task 3.2 — Playwright harness

- [ ] Create `apps/web/playwright.config.ts` targeting `https://localhost` via Caddy with `ignoreHTTPSErrors: true`, headless Chromium, 3 workers, retries:1 on CI, `globalSetup` that logs in an Owner via API and stores the cookie in a storageState file.
- [ ] Add `test:e2e` script to `apps/web/package.json` (`playwright test`), wire into `turbo.json` `test:e2e` pipeline, install browsers (`npx playwright install chromium --with-deps`) in CI.
- [ ] Create `apps/web/e2e/global-setup.ts` that ensures the panel is in "setup complete" state (creates org + owner via API if not) and seeds a testing Owner account with known credentials; persists storage state.
- [ ] Commit `test(web): playwright harness + global setup`.

### Task 3.3 — Playwright specs

Each spec file scoped to one flow. Use Russian UI copy (locale is Russian per CLAUDE.md) — match by `role`/`name` where possible, fall back to `data-testid` if needed (add test IDs in source as a small bite-sized change before writing the spec).

- [ ] `apps/web/e2e/auth.spec.ts` — login (email+password), login with TOTP, login with backup code, logout, invalid credentials error is shown; screenshot each terminal state to `ai_docs/test-evidence/playwright/auth/`.
- [ ] `apps/web/e2e/setup.spec.ts` — full onboarding: /setup page shows env checks, fills org, fills owner, clicks finalize, redirects to /login; asserts subsequent /setup returns 410.
- [ ] `apps/web/e2e/servers.spec.ts` — create server form → appears on list; click Install → progress WS frames render; stop → status flips; delete → row removed. Uses fake bridge mode via an env override so this doesn't require a real Squad server (or: runs only when `SQUAD_E2E_FULL=1` and boots a real one).
- [ ] `apps/web/e2e/config-editor.spec.ts` — open Admins.cfg → Monaco loads → edit a line → commit message → save → История tab shows new version → diff opens in Monaco diff viewer → Blame tab attributes the new line.
- [ ] `apps/web/e2e/players.spec.ts` — player list loads; click player → profile with ip_history visible only for permitted roles.
- [ ] `apps/web/e2e/audit.spec.ts` — audit table loads, filter by action, date range; row hash chain indicator shown if present.
- [ ] Commit per-spec: `test(web): playwright coverage for <flow>`.

### Task 3.4 — Worker integration E2E

- [ ] `apps/api/test/e2e/workers.e2e.test.ts` — spins up a test server, asserts worker-rcon publishes `rcon:status:{id}` to Redis within 30s; worker-log-ingest publishes a synthetic log line (injected via the test server) to `events:server:{id}` stream.
- [ ] Commit `test(e2e): worker-rcon + worker-log-ingest end-to-end coverage`.

---

## Phase 4 — Final verification + evidence

- [ ] `pnpm turbo run typecheck` green
- [ ] `pnpm turbo run test` green (all tiers except e2e)
- [ ] `pnpm --filter @squad/api test:integration` green (includes harness + 7 integration files)
- [ ] `pnpm --filter @squad/api test:e2e` green
- [ ] `pnpm --filter @squad/web test:e2e` green — Playwright HTML report at `apps/web/playwright-report/`, copy to `ai_docs/test-evidence/playwright-report/`
- [ ] `pnpm verify:audit-chain` exit 0
- [ ] `apps/bridge && go test -race -count=1 ./...` green
- [ ] Collect counts: test file count, test case count, per-tier durations; write `ai_docs/test-evidence/SUMMARY.md`.
- [ ] Push to origin.

---

## Execution order rationale

1. Tier-1 first (Tasks 1.1 → 1.10) — no infra dependencies, fastest feedback, builds confidence in lib contracts before integration tests lean on them.
2. Tier-2 harness (2.0) before any tier-2 case, so every subsequent file can reuse the login/audit-assertion helpers.
3. Tier-2 route files in order of critical-path importance: auth → setup → servers → server-configs → the long tail.
4. Plugins and db-triggers at the end of tier-2 because they depend on patterns already established.
5. Tier-3 bridge RPCs before Playwright — unblocks the "we covered every RPC method" claim and is cheaper.
6. Playwright last because it needs the panel in a known good state (created by completing the tier-2 setup tests beforehand).

## Conventions (applied to every test file)

- One `describe` per function/route group.
- Prefer `it('<verb> <outcome>', …)` phrasings.
- No `.skip` — if a test is genuinely blocked, surface it (don't quietly skip).
- Fresh schema per test file (integration) or per test case where state leaks matter.
- No mocking of internals (vi.mock on project code is a code smell). Mocks only for node built-ins / library I/O at the boundary.
- Assert audit rows by querying the live DB, not by spying on `writeAuditEntry`.
- Commit each file separately; if a file contains 10+ cases, a single commit is fine.
- Push every 3–5 commits.
