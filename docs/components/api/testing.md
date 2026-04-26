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
- Audit-coverage CI gate: [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) walks every registered route at startup and fails if a `POST`/`PUT`/`PATCH`/`DELETE` lacks `config.audit`.
- Hash-chain integrity in [`audit-entry.test.ts`](../../../apps/api/test/audit-entry.test.ts).
- WebSocket plumbing in [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts) and [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts).
- Bridge heartbeat loop ([`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — `tickOnce` driven manually to assert state-transition logging (alive→down warns once, down→alive logs the down-duration, no warn flapping on consecutive failures, late `onReady` after `onClose` does not leak a timer).
- Event reclaim / DLQ in [`event-dlq-autoclaim.test.ts`](../../../apps/api/test/event-dlq-autoclaim.test.ts) — `XAUTOCLAIM` cadence and the 5-delivery → DLQ rule.
- `POST /host/restart`, `GET /host/info`, `GET /host/metrics/history` — happy paths, 401, 403 (no-role), bridge 5xx → 502, EPIPE-treated-as-success paths in [`host-actions.test.ts`](../../../apps/api/test/host-actions.test.ts).
- `seedConfigs` in [`server-install-configs.test.ts`](../../../apps/api/test/server-install-configs.test.ts) — 19 cfg files seeded, `Rcon.cfg`/`Server.cfg` rewrite, baseline `config_versions` rows.
- Config rewrite invariants in [`config-rewrite.test.ts`](../../../apps/api/test/config-rewrite.test.ts) — sha-unchanged short-circuit, append-only history, restore-as-new-version.
- Blame walker in [`blame.test.ts`](../../../apps/api/test/blame.test.ts), RCON wire send in [`rcon-send.test.ts`](../../../apps/api/test/rcon-send.test.ts).
- Steam profile enrichment in [`steam-profile.test.ts`](../../../apps/api/test/steam-profile.test.ts) — empty API key short-circuits, cache hit skips fetch, corrupt cache falls through to refetch, non-200 response returns null, empty players array returns null.
- Steam OpenID 2.0 login + callback handlers in [`auth-steam.test.ts`](../../../apps/api/test/auth-steam.test.ts) — 8 tests: login redirect generates nonce in cookie + query; callback rejects missing cookie, mismatched nonce, expired Redis nonce, `return_to` host mismatch, `openid.response_nonce` replay; happy path creates session + `__Host-sid` cookie; no-role path redirects to `/no-access` without setting session cookie.
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

## What is not covered

- The actual bridge over the actual socket — that's e2e.
- Steam OpenID real-network handshake — `check_authentication` is mocked with `vi.spyOn(globalThis, 'fetch')`; the live Steam endpoint is exercised only in e2e.
- Discord OAuth — the stub routes were removed; no Discord integration exists.
- WebSocket routes in the permission matrix (HTTP inject cannot complete a WebSocket upgrade; those routes are excluded from the matrix). The auth hook on WebSocket routes is covered by separate integration tests.

## Mocks and stubs

- Each test that needs a fake bridge declares one inline (see e.g. [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts), [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts), [`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — records call list, returns scripted responses. Used by every test except e2e.
- `buildIntegrationApp` in [`test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts) creates a per-test isolated Postgres schema, runs all migrations (which seed the 5 system roles via migration 0009), and builds an ephemeral Fastify instance. `seedOwner: { steamId64: bigint }` inserts a `players` row with `roleId` pointing to the Owner role looked up from the already-seeded roles table. No org creation or M:N role-assignment tables exist. `loginAsOwner(h)` calls `createSession` directly (no HTTP round-trip) and invalidates the RBAC permission cache to prevent cross-test leakage. Downgrading a player's role in tests is done via `db.update(players).set({ roleId })` followed by `invalidatePermissionCache`.
- `first-owner.test.ts` uses the live DB directly (no harness) and manages its own fixtures via beforeEach/afterEach. It does not use `buildIntegrationApp`.
- Postgres/Redis: integration tests use the running compose stack. Unit tests use in-memory Drizzle adapters where possible.
- No password/TOTP mocks are needed — those paths were deleted with Task 16.

## Important edge cases

- `audit_log.id` is `bigserial`; serializing without `String(...)` breaks `JSON.stringify` on bigint.
- The bridge-client decode-error path must NOT permanently close the client (a long log-follow connection blip would otherwise wedge every subsequent caller).
- `server.status` `not_polled` is a real value, not an error. Tests assert the literal `{state: 'not_polled'}` shape.
- `__Host-` cookies cannot be set without `Secure` — local dev without HTTPS-via-Caddy will fail to log in.
