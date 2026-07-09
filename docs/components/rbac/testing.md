# `rbac` — testing

## Test files

### Tier 1 — unit (`packages/shared-config/test/`)

| File | What it covers |
|---|---|
| [`packages/shared-config/test/permissions.test.ts`](../../../packages/shared-config/test/permissions.test.ts) | Permission keys are unique across the registry. Every category referenced by an entry exists in `PERMISSION_CATEGORIES`. `dangerous` and `unimplemented` flags are `true \| undefined`, never `false`. |
| [`packages/shared-config/test/role-colors.test.ts`](../../../packages/shared-config/test/role-colors.test.ts) | `ROLE_COLORS` TS constant matches the color list in the SQL CHECK constraint in `0009_panel_rbac.sql`. Reads the migration file text, parses the `IN (...)` list, and asserts set equality. Fails if they drift. |

### Tier 2 — integration (`apps/api/test/`)

Each integration test uses `buildIntegrationApp` from [`apps/api/test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts), which provisions a fresh Postgres schema, runs all migrations (including 0009–0012), seeds an Owner player, and registers the live Fastify app. Teardown runs in `afterEach`.

| File | What it covers |
|---|---|
| [`apps/api/test/permissions-list.test.ts`](../../../apps/api/test/permissions-list.test.ts) | `GET /api/v1/permissions` returns exactly `PERMISSIONS.length` objects with correct shape. Requires `role:view`. |
| [`apps/api/test/roles-crud.test.ts`](../../../apps/api/test/roles-crud.test.ts) | Full POST/GET/PUT/DELETE lifecycle. Owner role returns 400 on PUT/DELETE. Duplicate name returns 409. `assigned_users_count` is accurate. |
| [`apps/api/test/player-role-assign.test.ts`](../../../apps/api/test/player-role-assign.test.ts) | PUT valid `role_id` assigns the role. PUT `null` removes it. PUT with a non-existent UUID returns 404. Owner-lockout: attempting to remove the last Owner returns 409. Cache invalidation: PUT role, then make a follow-up request — the new permission set is effective immediately without waiting for TTL. |
| [`apps/api/test/users-list.test.ts`](../../../apps/api/test/users-list.test.ts) | `GET /api/v1/users` only returns players with `role_id NOT NULL`. Role join is correct. Response includes all expected fields. |
| [`apps/api/test/first-owner.test.ts`](../../../apps/api/test/first-owner.test.ts) | `claimFirstOwner` assigns Owner on first call. A concurrent call (advisory-lock race) does not create a second Owner. After `first_owner_claimed = true`, subsequent calls are no-ops. |
| [`apps/api/test/permission-rename-coverage.test.ts`](../../../apps/api/test/permission-rename-coverage.test.ts) | Greps all TypeScript files under `apps/api/src/` for the old permission key names (`server:edit`, `server:config:write`, `server:config:history`, `role:manage`, `host:bridge_control`, etc.) and asserts zero matches. Fails the build if a rename was missed. |

`apps/api/test/audit-coverage.test.ts` (existing) now includes the roles and users route modules. It continues to fail if any `POST`/`PUT`/`PATCH`/`DELETE` route is missing `config.audit`.

### Tier 3 — e2e (`apps/api/test/e2e/`)

| File | What it covers |
|---|---|
| [`apps/api/test/e2e/panel-rbac.e2e.test.ts`](../../../apps/api/test/e2e/panel-rbac.e2e.test.ts) | Full RBAC lifecycle against a live panel stack: create role → assign to secondary user → verify access (server:view works, audit:view denied) → modify role permissions → verify instant revocation (no TTL wait) → delete role → verify secondary has null role → verify cannot remove last Owner (409). |
| [`apps/api/test/e2e/steam-login.e2e.test.ts`](../../../apps/api/test/e2e/steam-login.e2e.test.ts) | Live Steam-session smoke: supplied Owner cookie can read `/me` and sessions, legacy `POST /api/v1/setup/init` remains 404, and Steam login still redirects to Steam OpenID. |

## How to run

```bash
# Tier 1 — unit (no infra needed)
pnpm --filter @squad/shared-config exec vitest run test/permissions.test.ts
pnpm --filter @squad/shared-config exec vitest run test/role-colors.test.ts

# Tier 2 — integration (needs Docker compose: Postgres + Redis)
pnpm --filter @squad/api exec vitest run test/roles-crud.test.ts
pnpm --filter @squad/api exec vitest run test/player-role-assign.test.ts
pnpm --filter @squad/api exec vitest run test/users-list.test.ts
pnpm --filter @squad/api exec vitest run test/permissions-list.test.ts
pnpm --filter @squad/api exec vitest run test/first-owner.test.ts
pnpm --filter @squad/api exec vitest run test/permission-rename-coverage.test.ts

# All tiers (including the above) except e2e
pnpm turbo run test

# Tier 3 — e2e (needs live panel + bridge + real cookie)
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=s_019dbaa5-...    # Owner session cookie
pnpm --filter @squad/api test:e2e
```

## What is not covered

- Multi-instance cache invalidation — the in-memory cache is per-process. Horizontal scaling would need Redis pub/sub invalidation (future).
- UI component behaviour — the role editor, color picker, and assign modal are not covered by automated tests. Manual validation follows the gate in the spec.
