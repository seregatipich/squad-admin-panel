# `db` — Testing

---

## Test locations

| Tier | Location | Runner |
|---|---|---|
| 1 — unit (schema surface) | `packages/db/test/schema.test.ts` | `vitest` |
| 1 — unit (client + constraints) | `packages/db/test/client.test.ts` | `vitest` with `DATABASE_URL` |
| 2 — integration (live DB) | `apps/api/test/*.test.ts` | `vitest` with `DATABASE_URL` |
| 3 — e2e (full stack) | `apps/api/test/e2e/*.e2e.test.ts` | `vitest` (separate config) |

---

## Tier 1 — Schema surface tests

**File**: `packages/db/test/schema.test.ts`

**How to run:**

```bash
pnpm --filter @squad/db test
# or from root:
pnpm turbo run test --filter=@squad/db
```

**What is covered:**

- All 14 expected table exports are present in the `@squad/db/schema` barrel.
- `server_credentials.rcon_host` is nullable (migration 0007 invariant).
- `server_credentials` primary key columns (`server_id`, `rcon_port`, `rcon_password_encrypted`) are NOT NULL.

These tests use `getTableColumns` from `drizzle-orm` to interrogate the schema definition in memory; no database connection is required.

**What is not covered:**

- Trigger behavior (requires a live DB).
- CHECK constraint enforcement (requires a live DB).
- Actual column DDL in the database matching the schema (covered by Tier 2).

---

## Tier 1 — DB client and constraint tests

**File**: `packages/db/test/client.test.ts`

**Requires `DATABASE_URL`.** Connects to the live Postgres instance, creates and cleans up its own isolated rows.

**How to run:**

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/db test
```

**What is covered:**

| Test | What it proves |
|---|---|
| `connects and runs a trivial query` | `drizzle(postgres(url))` reaches Postgres and executes `SELECT 1` |
| `commits on success` | Rows inserted inside a successful transaction are visible after commit |
| `rolls back on throw` | Rows inserted inside a thrown transaction are absent after rollback |
| `serializes two concurrent transactions on the same lock key` | `pg_advisory_xact_lock(hashtext(...))` forces serial execution; second transaction waits ≥ 95 ms |
| `ON DELETE CASCADE removes server_settings when server deleted` | Deleting a `servers` row also removes its `server_settings` row |
| `ON DELETE SET NULL preserves player but clears role_id when role deleted` | Deleting a `roles` row sets `players.role_id = NULL` but leaves the player row intact |

**Test isolation**: each test creates rows with `uuidv7()` identifiers and deletes them in the test body (or via cascade). The advisory lock test uses `hashtext('test_lock_unit')` and leaves no rows.

---

## Tier 2 — Integration tests against a live database

These tests connect to the real Postgres instance specified by `DATABASE_URL`. They insert test data, exercise API behavior, and clean up after themselves.

**Prerequisites:**

```bash
docker compose up -d postgres
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

**How to run:**

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/api test
```

**Test files that directly exercise DB tables:**

| File | Tables exercised | What it proves |
|---|---|---|
| `apps/api/test/rbac.test.ts` | `players`, `roles`, `role_permissions` | `loadUserPermissions` resolves the correct permission set; cache invalidation works |
| `apps/api/test/roles-crud.test.ts` | `roles`, `role_permissions` | POST/PUT/DELETE role endpoints insert/update/delete correctly; Owner role deletion is forbidden |
| `apps/api/test/first-owner.test.ts` | `players`, `roles`, `panel_meta` | `claimFirstOwner` sets `players.role_id` to Owner and sets `panel_meta.first_owner_claimed = true` |
| `apps/api/test/player-role-assign.test.ts` | `players`, `roles` | PATCH `/players/:id/role` updates `players.role_id` |
| `apps/api/test/auth-sessions.test.ts` | `sessions`, `players` | Session creation, lookup by cookie, and expiry |
| `apps/api/test/me-tokens.test.ts` | `player_api_tokens`, `players` | Token creation, revocation, and `last_used_at` update |
| `apps/api/test/audit-entry.test.ts` | `audit_log` | Audit rows are inserted with correct actor/action fields |
| `apps/api/test/integration/server-configs.test.ts` | `config_versions`, `servers` | PUT config appends a version row; restore creates a new version row |
| `apps/api/test/integration/servers.test.ts` | `servers`, `server_settings`, `server_credentials` | Server create/update/delete CRUD |

**Test player SteamID range:**

Tests use fake SteamIDs in the range `76561197999000001` – `76561197999000099` (e.g. `PLAYER_A = 76561197999000001n`). These are outside the valid Steam64 range for real accounts. Each test's `afterAll` or `afterEach` deletes its own player rows (cascade handles sessions, tokens, and audit FK nullification).

**Connection settings in tests:**

```ts
const sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
const db = drizzle(sql, { schema });
```

`onnotice` suppresses Postgres NOTICE messages from trigger functions during test output.

---

## Tier 3 — End-to-end tests

These tests drive the full panel stack and exercise DB behavior indirectly through the API.

**Files:**

| File | DB behavior exercised |
|---|---|
| `apps/api/test/e2e/install-lifecycle.e2e.test.ts` | Full server lifecycle: `servers` row transitions, `config_versions` baseline seeding, status updates via reconciler |
| `apps/api/test/e2e/config-versioning.e2e.test.ts` | Multiple `config_versions` rows created per edit; sha256 dedup prevents no-op writes |
| `apps/api/test/e2e/panel-rbac.e2e.test.ts` | `players.role_id` assignment enforces permission checks end-to-end |
| `apps/api/test/e2e/server-delete-live.e2e.test.ts` | `servers` row deleted; cascade to `server_settings`, `server_credentials`, `config_versions` verified |

**How to run:**

```bash
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=s_019dbaa5-...   # __Host-sid value from browser devtools
pnpm --filter @squad/api test:e2e
```

---

## Audit chain verification

The audit chain is not tested by the vitest suite directly. Use the standalone verifier:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain
```

Exit 0 = chain intact. Exit 1 = first broken link id printed. Should be run after any bulk data operation or manual DB intervention.

---

## Test data pollution notes

- All Tier 2 tests clean up in `afterAll`/`afterEach` via targeted `DELETE FROM players WHERE steam_id64 IN (...)`. Because `sessions`, `player_api_tokens`, `player_ip_history`, `player_name_history`, and `audit_log` (FK SET NULL) all cascade from `players`, a single player delete handles the cascade tree.
- `audit_log` rows from tests are not deleted (the table is append-only by trigger). This is expected and does not affect test isolation because each test creates unique `action_type` + `target_id` combinations.
- `roles` created by `roles-crud.test.ts` are tracked in a `createdRoleIds` array and deleted in `afterEach`.
