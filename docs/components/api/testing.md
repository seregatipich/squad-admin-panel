# `api` — testing

## Where the tests live

| Tier | Location | What it covers |
|---|---|---|
| Unit | [`apps/api/test/*.test.ts`](../../../apps/api/test/) excluding `e2e/` | Auth helpers, Zod schemas, blame walker, hash chain helpers, route schemas via `fastify.inject()` with a fake bridge. |
| Integration | Same directory, marked by use of real Postgres/Redis (`TEST_DATABASE_URL` set) | Audit triggers, RBAC enforcement, WS frame splitting, install WS plumbing. |
| E2E | [`apps/api/test/e2e/*.e2e.test.ts`](../../../apps/api/test/e2e/) | Live panel + real bridge + real Docker. Run via `pnpm --filter @squad/api test:e2e`. |

## How to run

```bash
# Unit + integration (default; uses fake bridge, in-memory Redis)
pnpm --filter @squad/api test

# Single file
pnpm --filter @squad/api exec vitest run test/rcon-send.test.ts

# E2E (needs PANEL_TEST_URL + PANEL_TEST_COOKIE; see CLAUDE.md)
pnpm --filter @squad/api test:e2e
```

## What is covered

- All happy paths for routes listed in [`api.md`](api.md).
- 401/403 enforcement: every authed route has at least one negative test.
- Audit-coverage CI gate: [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) walks every registered route at startup and fails if a `POST`/`PUT`/`PATCH`/`DELETE` lacks `config.audit`.
- Hash-chain integrity in [`audit-entry.test.ts`](../../../apps/api/test/audit-entry.test.ts).
- WebSocket plumbing in [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts) and [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts).
- Bridge heartbeat loop ([`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — `tickOnce` driven manually to assert state-transition logging (alive→down warns once, down→alive logs the down-duration, no warn flapping on consecutive failures, late `onReady` after `onClose` does not leak a timer).
- Event reclaim / DLQ in [`event-dlq-autoclaim.test.ts`](../../../apps/api/test/event-dlq-autoclaim.test.ts) — `XAUTOCLAIM` cadence and the 5-delivery → DLQ rule.
- `POST /host/restart` happy + EPIPE-after-restart paths in [`host-actions.test.ts`](../../../apps/api/test/host-actions.test.ts).
- `seedConfigs` in [`server-install-configs.test.ts`](../../../apps/api/test/server-install-configs.test.ts) — 19 cfg files seeded, `Rcon.cfg`/`Server.cfg` rewrite, baseline `config_versions` rows.
- Config rewrite invariants in [`config-rewrite.test.ts`](../../../apps/api/test/config-rewrite.test.ts) — sha-unchanged short-circuit, append-only history, restore-as-new-version.
- Blame walker in [`blame.test.ts`](../../../apps/api/test/blame.test.ts), RCON wire send in [`rcon-send.test.ts`](../../../apps/api/test/rcon-send.test.ts).
- Steam profile enrichment in [`steam-profile.test.ts`](../../../apps/api/test/steam-profile.test.ts) — empty API key short-circuits, cache hit skips fetch, corrupt cache falls through to refetch, non-200 response returns null, empty players array returns null.
- Steam OpenID 2.0 login + callback handlers in [`auth-steam.test.ts`](../../../apps/api/test/auth-steam.test.ts) — 8 tests: login redirect generates nonce in cookie + query; callback rejects missing cookie, mismatched nonce, expired Redis nonce, `return_to` host mismatch, `openid.response_nonce` replay; happy path creates session + `__Host-sid` cookie; no-role path redirects to `/no-access` without setting session cookie.
- `claimFirstOwner` in [`first-owner.test.ts`](../../../apps/api/test/first-owner.test.ts) — 5 tests against a real isolated Postgres schema: claim (players/role-assignments/org-members/DB-flag all written, sentinel written last), sentinel pre-check short-circuits before any transaction, DB-flag pre-check skips sentinel write, bridge failure rolls back all DB state, 8-way concurrent race asserts exactly 1 `'claimed'` and 7 `'already_claimed'` (advisory-lock correctness).

## What is not covered

- The actual bridge over the actual socket — that's e2e.
- Cookie security flags in production deployment — verified manually with browser devtools.
- Steam OpenID real-network handshake — `check_authentication` is mocked with `vi.spyOn(globalThis, 'fetch')`; the live Steam endpoint is exercised only in e2e.
- Discord OAuth — the stub routes were removed; no Discord integration exists.

## Mocks and stubs

- Each test that needs a fake bridge declares one inline (see e.g. [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts), [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts), [`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts)) — records call list, returns scripted responses. Used by every test except e2e.
- `buildIntegrationApp` in [`test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts) creates a per-test isolated Postgres schema and an ephemeral Fastify instance. `seedOwner: { steamId64: bigint }` inserts a `players` row, assigns the Owner role, and joins `organization_members`. `loginAsOwner(h)` calls `createSession` directly (no HTTP round-trip) and invalidates the RBAC permission cache to prevent cross-test leakage.
- Postgres/Redis: integration tests use the running compose stack. Unit tests use in-memory Drizzle adapters where possible.
- No password/TOTP mocks are needed — those paths were deleted with Task 16.

## Important edge cases

- `audit_log.id` is `bigserial`; serializing without `String(...)` breaks `JSON.stringify` on bigint.
- The bridge-client decode-error path must NOT permanently close the client (a long log-follow connection blip would otherwise wedge every subsequent caller).
- `server.status` `not_polled` is a real value, not an error. Tests assert the literal `{state: 'not_polled'}` shape.
- `__Host-` cookies cannot be set without `Secure` — local dev without HTTPS-via-Caddy will fail to log in.
