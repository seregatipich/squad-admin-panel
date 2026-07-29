# `api` — testing

## Where the tests live

| Tier | Location | What it covers |
|---|---|---|
| Property | [`apps/api/test/property/`](../../../apps/api/test/property/) | Fuzz/property-based tests using `@fast-check/vitest`. Audit chain hash integrity under random insertion patterns. |
| Unit | [`apps/api/test/*.test.ts`](../../../apps/api/test/) excluding `e2e/` and `security/` | Auth helpers, Zod schemas, blame walker, hash chain helpers, route schemas via `fastify.inject()` with a fake bridge. |
| Integration | Same directory, marked by use of real Postgres/Redis (`TEST_DATABASE_URL` set) | Audit triggers, RBAC enforcement, WS frame splitting, install WS plumbing. |
| Security | [`apps/api/test/security/*.test.ts`](../../../apps/api/test/security/) | Permission boundary matrix, SQL injection payloads, XSS smoke, cookie security attributes. |
| E2E | [`apps/api/test/e2e/*.e2e.test.ts`](../../../apps/api/test/e2e/) | Live panel + real bridge + real Docker. Run via `pnpm --filter @squad/api test:e2e`. |

## How to run

```bash
# Unit + integration + security + property (default; needs DATABASE_URL)
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/api test

# Property tests only
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin \
  pnpm --filter @squad/api exec vitest run test/property/

# Security suite only (uses dedicated config with hookTimeout=300 s)
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin \
  pnpm --filter @squad/api exec vitest run --config vitest.security.config.ts test/security/

# Single file
pnpm --filter @squad/api exec vitest run test/rcon-send.test.ts

# E2E (needs PANEL_TEST_URL + PANEL_TEST_COOKIE; see CLAUDE.md)
pnpm --filter @squad/api test:e2e
```

## Property-based tests

[`test/property/audit-chain.test.ts`](../../../apps/api/test/property/audit-chain.test.ts) — 1 property, 10 random runs, up to 20 rows per run:

Inserts random batches of `audit_log` rows via raw SQL (bypassing the ORM), then reads back the stored `prev_hash` and `row_hash` columns and verifies the entire chain from the first row to the last:

- `row.prev_hash_hex` equals the `row_hash` of the preceding row (or `null` for the first row ever).
- `row.row_hash_hex` equals `sha256(prev || canonical_string)` computed independently in JS using `node:crypto`.

The canonical string mirrors the DB trigger exactly: `action_type|target_type|target_id|context::text|created_at::text`.

Important: all `ORDER BY` clauses use the table-qualified form `ORDER BY audit_log.id ASC` to ensure numeric ordering — PostgreSQL resolves unqualified `ORDER BY id` to the `id::text` select expression when `id::text` appears in the column list, which would sort lexicographically.

## What is covered

- All happy paths for routes listed in [`api.md`](api.md).
- 401/403 enforcement: every authed route has at least one negative test.
- Audit-coverage CI gate: [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) walks every registered route at startup and fails if a `POST`/`PUT`/`PATCH`/`DELETE` lacks `config.audit`. The same file also enforces the **status-flip diag-emit gate** (Phase A2 Task 16): for the closed set of routes that mutate `servers.status` (`POST /api/v1/servers/:id/start`, `POST /api/v1/servers/:id/stop`, `POST /api/v1/servers/:id/install`, `DELETE /api/v1/servers/:id`, `POST /api/v1/servers/archive/:id/restore`) the test reads each handler's source file (`servers.ts` / `server-install.ts` / `server-archive.ts`) and asserts a `diag.emit({ ... kind: 'server.<...>' ... })` literal exists. Failure surfaces as `route ${method} ${url} flips server.status but does not emit a server.* diag event in ${handlerFile}`. The gate is a static-source-text scan — it does not require the bridge/db/redis to be live, and matches `req.diag.emit`, `app.diag.emit`, and `installDiag.emit` variants.
- Hash-chain integrity in [`audit-entry.test.ts`](../../../apps/api/test/audit-entry.test.ts).
- WebSocket plumbing in [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts) and [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts).
- Bridge heartbeat loop ([`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — `tickOnce` driven manually to assert state-transition logging (alive→down warns once, down→alive logs the down-duration, no warn flapping on consecutive failures, late `onReady` after `onClose` does not leak a timer).
- Event reclaim / DLQ in [`event-dlq-autoclaim.test.ts`](../../../apps/api/test/event-dlq-autoclaim.test.ts) — `XAUTOCLAIM` cadence and the 5-delivery → DLQ rule.
- `POST /host/restart`, `GET /host/info`, `GET /host/metrics/history` — happy paths, 401, 403 (no-role), bridge 5xx → 502, EPIPE-treated-as-success paths in [`host-actions.test.ts`](../../../apps/api/test/host-actions.test.ts).
- `GET /host/disk-usage` — derived-percent math (`panel_pct`, `other_pct`), `host_total_bytes=0` no-NaN edge case, 401 without session, 403 for a player with no role in [`host-disk-usage.test.ts`](../../../apps/api/test/host-disk-usage.test.ts). Bridge mock: `h.bridge.panelDiskUsage = async () => ({...})` against a deterministic payload (`total_panel_bytes=300`, `host_total_bytes=1000`, `host_used_bytes=600` → expected `panel_pct≈30`, `other_pct≈30`).
- `seedConfigs` in [`server-install-configs.test.ts`](../../../apps/api/test/server-install-configs.test.ts) — 19 cfg files seeded, `Rcon.cfg`/`Server.cfg` rewrite, baseline `config_versions` rows.
- Config rewrite invariants in [`config-rewrite.test.ts`](../../../apps/api/test/config-rewrite.test.ts) — sha-unchanged short-circuit, append-only history, restore-as-new-version.
- Blame walker in [`blame.test.ts`](../../../apps/api/test/blame.test.ts), RCON wire send in [`rcon-send.test.ts`](../../../apps/api/test/rcon-send.test.ts).
- Steam profile enrichment in [`steam-profile.test.ts`](../../../apps/api/test/steam-profile.test.ts) — empty API key short-circuits, cache hit skips fetch, corrupt cache falls through to refetch, non-200 response returns null, empty players array returns null.
- Steam OpenID 2.0 login + callback handlers in [`auth-steam.test.ts`](../../../apps/api/test/auth-steam.test.ts) — 10 tests: login redirect generates nonce in cookie + query; callback rejects missing cookie, mismatched nonce, expired Redis nonce, `return_to` host mismatch, `openid.response_nonce` replay; first-login owner happy path creates a session + `__Host-sid` cookie and redirects to `/`. Three tests pin the VIPSUB-5 (#171) scope split by reading `sessions.scope` back from the DB: a player with no role and a player whose role has `panel_access = false` each get a `__Host-sid` cookie on a `self_service`-scoped session and a redirect to `/me`; a player whose role grants panel access still gets a `panel`-scoped session and a redirect to `/`.
- `claimFirstOwner` in [`first-owner.test.ts`](../../../apps/api/test/first-owner.test.ts) — 5 direct-DB unit tests against the live DB (no isolated schema): claim sets `players.role_id` and `panel_meta.first_owner_claimed` and writes the sentinel; double-claim returns `already_claimed` and leaves player B without a role; sentinel pre-check short-circuits before the transaction; concurrent `Promise.all` race asserts advisory lock serializes to exactly 1 `'claimed'` and 1 `'already_claimed'`; missing Owner role returns `no_owner_role`. `panel_meta` singleton state and test players are saved and restored in beforeEach/afterEach.

## Security test suite

[`test/security/`](../../../apps/api/test/security/) contains four regression test files:

### permission-matrix.test.ts — 3100 tests

Programmatic permission boundary matrix. `collectProtectedRoutes()` builds a minimal Fastify app, walks `onRoute` hooks, and returns every route that declares `config.permissions` (WebSocket routes excluded — HTTP inject is incompatible with the upgrade protocol). For each route, three test categories run:

1. `returns 403 to a user with no permissions` — asserts status 403.
2. `returns not-403 to a user with all required permissions` — asserts status ≠ 403.
3. `with only <perm>: allowed|403` — one test per permission key; asserts `allowed` if that key is the exact required set, `403` otherwise.

All ~70 test users (1 no-perms, 48 single-perm, ~21 unique required-set combos) are pre-created in `beforeAll` via `Promise.all` to keep setup under 5 seconds.

### sql-injection.test.ts — 63 tests

9 classic injection payloads × 7 endpoint groups. Each test asserts:
- `res.statusCode >= 200 && res.statusCode < 500`
- `tablesExist()` is still `true` after the request (queries `information_schema.tables` for `players`, `roles`, `sessions`)

Endpoints covered: `GET /api/v1/players?q=`, `GET /api/v1/players/:steamId`, `POST /api/v1/roles` (name), `PUT /api/v1/roles/:id` (name), `POST /api/v1/servers` (slug), `GET /api/v1/audit?q=`, `PUT /api/v1/players/:steamId/role` (role_id).

### xss-smoke.test.ts — 4 tests

API-layer XSS assertions. Verifies that HTML in role names and descriptions is stored as-is (no server-side escaping/sanitization), HTML in query params returns 200 with expected shape, and `Content-Type` for JSON responses is `application/json`.

### cookie-security.test.ts — 5 tests

Verifies `__Host-sid` cookie on session touch has `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Also verifies unauthenticated requests don't set a session cookie and expired tokens return 401.

- Role CRUD HTTP surface (401, 404, 409 duplicate name, Owner immutability) in [`roles-crud.test.ts`](../../../apps/api/test/roles-crud.test.ts).
- Audit log HTTP surface (401, pagination, `page_size` validation) in [`audit-entry.test.ts`](../../../apps/api/test/audit-entry.test.ts).
- Users list HTTP surface (401, 403 no-role, INNER JOIN null-role omission) in [`users-list.test.ts`](../../../apps/api/test/users-list.test.ts).
- Players HTTP surface (401, 403 no-role, ASCII/steamId64/Cyrillic search, role-assign 200/404/409) in [`player-role-assign.test.ts`](../../../apps/api/test/player-role-assign.test.ts).
- Session management (401 on each route, revoke own session) in [`auth-sessions.test.ts`](../../../apps/api/test/auth-sessions.test.ts).
- API token management (401 on create/delete, 409 25-token limit) in [`me-tokens.test.ts`](../../../apps/api/test/me-tokens.test.ts).
- Server soft-delete orchestrator in [`server-delete.test.ts`](../../../apps/api/test/server-delete.test.ts) — `softDeleteServer` against a fake bridge: phase-1 backup writes one `config_versions` row per readable cfg, phase-1 zero-files throws, phase 2-4 errors collected in `result.errors[]` without preventing phase-5 UPDATE, `deleted_at`/`deleted_by_steam_id64`/`deletion_backup_marker_id` set. Idempotent re-call returns 404 from the route. Does NOT cover the live-bus publish (covered separately in [`live-bus.test.ts`](../../../apps/api/test/live-bus.test.ts)).
- Archive routes in [`server-archive.test.ts`](../../../apps/api/test/server-archive.test.ts) — `GET /servers/archive` returns soft-deleted rows ordered DESC, `GET /:id` returns dedup'd backups + settings snapshot + 404 on active or unknown id, `GET /:id/configs/:filename` returns content + 404 on missing backup row, `POST /:id/restore` creates a new server (201), 409 `slug_in_use` against partial-unique index, 404 on unknown archive, audit row written. `POST /:id/restore-configs` happy path overlays cfgs and inserts new `config_versions` rows, `Rcon.cfg` is in `files_skipped`, missing archive row → 404 `archive_not_found`. Does NOT exercise the actual `bridge.fileAtomicWrite` against disk — that path is covered by the e2e suite.
- E2E full lifecycle in [`server-delete-restore-lifecycle.e2e.test.ts`](../../../apps/api/test/e2e/server-delete-restore-lifecycle.e2e.test.ts) — install → boot → edit a cfg → DELETE → assert files gone from disk + container removed + archive row visible + backup rows present → POST /restore → POST /install on the new id → POST /restore-configs → POST /start → assert restored cfg sha256 matches the pre-delete edit. ~6-8 min per run; only runs under `pnpm --filter @squad/api test:e2e` against the live stack.
- E2E DELETE smoke in [`server-delete-live.e2e.test.ts`](../../../apps/api/test/e2e/server-delete-live.e2e.test.ts) — narrower target: install → DELETE → assert `ok:true`, `container_removed`, `configs_dir_removed`, audit row, soft-delete UPDATE.
- E2E Admins.cfg RCON reload in [`admins-cfg-reload-live.e2e.test.ts`](../../../apps/api/test/e2e/admins-cfg-reload-live.e2e.test.ts) — proves SYNC-3 correction №1 (#36): `POST /api/v1/admins-cfg/sync` (force-sync) → wait for the config-sync worker to publish `admins-cfg:status:<id> = in_sync` → assert the `admins_cfg.force_synced` audit row records `context.reload = 'enqueued'` (with an `XLEN rcon:commands:<id>` growth check as corroboration). Skips with a `console.warn` when no server is `running` or `rcon:status:<id>.state !== 'connected'`. Live stack only, run-deferred like the other `e2e/` specs.
- Status reconciler `mapState` purity in [`status-reconciler.test.ts`](../../../apps/api/test/status-reconciler.test.ts) — every docker state mapped explicitly, case-insensitivity on the state string, unknown states return `{known: false}` so the caller leaves the DB untouched, sanity check that `STUCK_CANDIDATE_STATES` ⊆ `TRANSIENT_STATES` and `STUCK_AFTER_MS` is well above the polling interval.
- Status reconciler integration in [`integration/status-reconciler.integration.test.ts`](../../../apps/api/test/integration/status-reconciler.integration.test.ts) — drives the live plugin against an isolated DB schema. Covers: `stopping → stopped` on docker `exited`, `starting → running` on docker `running`, `not_found` mapped to `stopped` (no row left dangling on a missing container), unknown docker state leaves DB as-is and the row appears in `stuck_servers[]`, per-server `bridge_failures_by_server` counter increments on consecutive `container_inspect` failures and resets on first success. Manual reconcile route (`POST /api/v1/servers/:id/reconcile`): happy path 200 + DB flip + LiveEvent, 502 `bridge_unavailable` on bridge throw plus a follow-up call recovering, 404 on unknown id. Health route `GET /api/v1/health/reconciler` returns `last_tick_at`, surfaces stuck rows, and the derived `healthy: false` when stuck rows exist.

## What is not covered

- The actual bridge over the actual socket — that's e2e.
- Steam OpenID real-network handshake — `check_authentication` is mocked with `vi.spyOn(globalThis, 'fetch')`; the live Steam endpoint is exercised only in e2e.
- Discord OAuth — the stub routes were removed; no Discord integration exists.
- WebSocket routes in the permission matrix (HTTP inject cannot complete a WebSocket upgrade; those routes are excluded from the matrix). The auth hook on WebSocket routes is covered by separate integration tests.

## Mocks and stubs

- Each test that needs a fake bridge declares one inline (see e.g. [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts), [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts), [`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — records call list, returns scripted responses. Used by every test except e2e.
- `buildIntegrationApp` in [`test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts) provisions a per-test isolated Postgres database by cloning a shared template that is migrated exactly once (`CREATE DATABASE … TEMPLATE`, ~80ms), instead of replaying every migration per test. The low-level cloning/migration primitives live in [`test/integration/isolated-db.ts`](../../../apps/api/test/integration/isolated-db.ts) — a route-import-free module so the per-worker setup hook does not pre-load modules that tests `vi.mock`. The template migration seeds the 5 system roles via migration 0009. `createIsolatedSchema()` returns the cloned database (its `schema` field holds the database name); `runMigrations()` is idempotent and a no-op against an already-migrated clone. The harness then builds an ephemeral Fastify instance. When `TEST_DATABASE_URL` is unset, `hostDbUrl()`/`testDbUrl` resolve the fallback connection's password from `POSTGRES_PASSWORD`, then `DATABASE_URL`, then the repo `.env`; if none resolves it, they throw instead of silently connecting as password `admin` (#221).
- The suite runs with file parallelism (`pool: 'forks'`, `maxForks: 4`; tests within a file stay sequential). `global-setup.ts` builds the one shared template and provides it to workers via Vitest `inject`; `worker-setup.ts` gives each worker its own cloned database (`DATABASE_URL`) and a dedicated Redis logical DB, so parallel files never share mutable state. `global-setup.ts` generates a random `runId` once per invocation and embeds it in every `sqtest_*`/`sqtmpl_*`/`sqworker_*` database name (via `isolated-db.ts`'s `useRunId`); the sweep before and after the run only ever drops names carrying that run's own `runId`, so multiple local sessions can run the suite against the same Postgres cluster concurrently without one session's teardown dropping another's still-live databases. `seedOwner: { steamId64: bigint }` inserts a `players` row with `roleId` pointing to the Owner role looked up from the already-seeded roles table. No org creation or M:N role-assignment tables exist. `loginAsOwner(h)` calls `createSession` directly (no HTTP round-trip) and invalidates the RBAC permission cache to prevent cross-test leakage. Downgrading a player's role in tests is done via `db.update(players).set({ roleId })` followed by `invalidatePermissionCache`.
- `first-owner.test.ts` uses the live DB directly (no harness) and manages its own fixtures via beforeEach/afterEach. It does not use `buildIntegrationApp`.
- Postgres/Redis: integration tests use the running compose stack. Unit tests use in-memory Drizzle adapters where possible.
- No password/TOTP mocks are needed — those paths were deleted with Task 16.

## Important edge cases

- `audit_log.id` is `bigserial`; serializing without `String(...)` breaks `JSON.stringify` on bigint.
- The bridge-client decode-error path must NOT permanently close the client (a long log-follow connection blip would otherwise wedge every subsequent caller).
- `server.status` `not_polled` is a real value, not an error. Tests assert the literal `{state: 'not_polled'}` shape.
- `__Host-` cookies cannot be set without `Secure` — local dev without HTTPS-via-Caddy will fail to log in.
