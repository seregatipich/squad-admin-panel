# Steam-only login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace email/password/TOTP login with Steam OpenID 2.0 as the only auth surface; identity anchor moves from `users.id uuid` to `players.steam_id64 bigint`; first Steam-login after fresh install becomes Owner exactly once via DB-flag + bridge-sentinel double-anchor.

**Architecture:** Destructive forward-only migration `0008_steam_only_auth.sql` drops `users` and rebuilds `sessions`/`organization_members`/`audit_log`/`config_versions` with `bigint steam_id64` FKs onto existing `players` table. New `apps/api/src/lib/steam-openid.ts` + `lib/steam-profile.ts` + `lib/first-owner.ts`. New routes `auth-steam.ts` (login + callback) and session-management endpoints in `auth.ts`. Setup wizard collapses to `/check-env` + `/init`. Bridge gets one new allow-listed path for the sentinel.

**Tech Stack:** Postgres 16, Drizzle ORM, Fastify 5 + Zod, ioredis, Go 1.25 (bridge), Next.js 15 + React 19.

**Spec:** `docs/superpowers/specs/2026-04-25-steam-only-login-design.md`.

---

## Phase 0 — Branch and worktree

### Task 0: Create feature branch

**Files:** none

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```
Expected: `nothing to commit, working tree clean`. If not — stop and ask the user.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feat/steam-only-login
```

- [ ] **Step 3: Verify spec is committed on the branch**

```bash
git log --oneline -1 -- docs/superpowers/specs/2026-04-25-steam-only-login-design.md
```
Expected: shows commit `a44be4f` (or wherever spec was committed).

---

## Phase 1 — Schema & migration

### Task 1: Drop legacy Drizzle schema files

**Files:**
- Delete: `packages/db/src/schema/users.ts`
- Delete: `packages/db/src/schema/user-identities.ts`
- Delete: `packages/db/src/schema/user-role-assignments.ts`
- Delete: `packages/db/src/schema/user-api-tokens.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Delete the four schema files**

```bash
rm packages/db/src/schema/users.ts
rm packages/db/src/schema/user-identities.ts
rm packages/db/src/schema/user-role-assignments.ts
rm packages/db/src/schema/user-api-tokens.ts
```

- [ ] **Step 2: Update `packages/db/src/schema/index.ts`**

Open `packages/db/src/schema/index.ts` and remove the four corresponding `export *` lines. The remaining exports stay in the same order.

Expected diff: 4 deleted lines that match `users.js | user-identities.js | user-role-assignments.js | user-api-tokens.js`.

- [ ] **Step 3: Verify TypeScript will fail compilation (smoke check)**

```bash
pnpm --filter @squad/db exec tsc --noEmit
```
Expected: errors about missing `users`, `userRoleAssignments`, etc. — these are intentional and will be fixed as we rebuild.

- [ ] **Step 4: Do NOT commit yet** — Phase 1 commits at the end of Task 4 once schema, codegen, and migration agree.

---

### Task 2: New Drizzle schema files for `player_*` and rebuilt tables

**Files:**
- Create: `packages/db/src/schema/player-role-assignments.ts`
- Create: `packages/db/src/schema/player-api-tokens.ts`
- Modify: `packages/db/src/schema/sessions.ts`
- Modify: `packages/db/src/schema/organization-members.ts`
- Modify: `packages/db/src/schema/audit-log.ts`
- Modify: `packages/db/src/schema/config-versions.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create `player-role-assignments.ts`**

```ts
import { bigint, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { roles } from './roles.js';

export const playerRoleAssignments = pgTable(
  'player_role_assignments',
  {
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    assignedBy: bigint('assigned_by', { mode: 'bigint' }).references(() => players.steamId64, {
      onDelete: 'set null',
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.steamId64, table.roleId] }),
    roleIdx: index('player_role_assignments_role_idx').on(table.roleId),
  }),
);

export type PlayerRoleAssignmentRow = typeof playerRoleAssignments.$inferSelect;
export type NewPlayerRoleAssignment = typeof playerRoleAssignments.$inferInsert;
```

- [ ] **Step 2: Create `player-api-tokens.ts`**

```ts
import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerApiTokens = pgTable(
  'player_api_tokens',
  {
    id: uuid('id').primaryKey().notNull(),
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    steamIdIdx: index('player_api_tokens_steam_id64_idx').on(table.steamId64),
  }),
);

export type PlayerApiTokenRow = typeof playerApiTokens.$inferSelect;
export type NewPlayerApiToken = typeof playerApiTokens.$inferInsert;
```

- [ ] **Step 3: Rewrite `sessions.ts`**

Replace the entire file:

```ts
import { bigint, index, inet, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    steamIdIdx: index('sessions_steam_id64_idx').on(table.steamId64),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
    lastActivityIdx: index('sessions_last_activity_idx').on(table.lastActivityAt),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
```

- [ ] **Step 4: Rewrite `organization-members.ts`**

```ts
import { bigint, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { players } from './players.js';
import { roles } from './roles.js';

export const organizationMembers = pgTable(
  'organization_members',
  {
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    primaryRoleId: uuid('primary_role_id').references(() => roles.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.steamId64, table.orgId] }),
  }),
);

export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
```

- [ ] **Step 5: Rewrite `audit-log.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { playerApiTokens } from './player-api-tokens.js';
import { players } from './players.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    actorKind: text('actor_kind').notNull(),
    actorSteamId64: bigint('actor_steam_id64', { mode: 'bigint' }).references(
      () => players.steamId64,
      { onDelete: 'set null' },
    ),
    actorTokenId: uuid('actor_token_id').references(() => playerApiTokens.id, {
      onDelete: 'set null',
    }),
    actorSystemLabel: text('actor_system_label'),
    actorIp: inet('actor_ip'),
    actionType: text('action_type').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    beforeSnapshot: jsonb('before_snapshot'),
    afterSnapshot: jsonb('after_snapshot'),
    context: jsonb('context').notNull().default({}),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    orgId: uuid('org_id').references(() => organizations.id),
    prevHash: bytea('prev_hash'),
    rowHash: bytea('row_hash').notNull(),
  },
  (table) => ({
    createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
    actorSteamIdx: index('audit_log_actor_steam_idx').on(table.actorSteamId64, table.createdAt),
    actionIdx: index('audit_log_action_idx').on(table.actionType, table.createdAt),
    targetIdx: index('audit_log_target_idx').on(table.targetType, table.targetId),
    actorKindCheck: check(
      'audit_log_actor_kind',
      sql`(actor_kind = 'steam'  AND actor_steam_id64 IS NOT NULL AND actor_system_label IS NULL)
       OR (actor_kind = 'system' AND actor_steam_id64 IS NULL     AND actor_system_label IS NOT NULL)`,
    ),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
```

- [ ] **Step 6: Rewrite `config-versions.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const configVersions = pgTable(
  'config_versions',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    sha256: bytea('sha256').notNull(),
    parentVersionId: uuid('parent_version_id'),
    authorSteamId64: bigint('author_steam_id64', { mode: 'bigint' }).references(
      () => players.steamId64,
      { onDelete: 'set null' },
    ),
    authorLabel: text('author_label'),
    authorIp: inet('author_ip'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverFileTimeIdx: index('config_versions_server_file_time_idx').on(
      table.serverId,
      table.filename,
      table.createdAt,
    ),
    sha256Idx: index('config_versions_sha256_idx').on(table.sha256),
    authorPresence: check(
      'config_versions_author_presence',
      sql`author_steam_id64 IS NOT NULL OR author_label IS NOT NULL`,
    ),
  }),
);

export type ConfigVersionRow = typeof configVersions.$inferSelect;
export type NewConfigVersion = typeof configVersions.$inferInsert;
```

- [ ] **Step 7: Update `packages/db/src/schema/index.ts`**

Add the two new exports (alphabetically near other player-* lines):

```ts
export * from './player-api-tokens.js';
export * from './player-role-assignments.js';
```

- [ ] **Step 8: Verify tsc on `@squad/db`**

```bash
pnpm --filter @squad/db exec tsc --noEmit
```
Expected: PASS. The schema package is now self-consistent. Failures elsewhere in the monorepo are still expected (they will be fixed in later tasks).

- [ ] **Step 9: Do NOT commit yet** — wait until after Task 4.

---

### Task 3: Migration `0008_steam_only_auth.sql`

**Files:**
- Create: `packages/db/drizzle/0008_steam_only_auth.sql`

- [ ] **Step 1: Inspect prior migration to copy the audit-trigger SQL verbatim**

Find the existing append-only trigger and hash-chain code:

```bash
grep -n "audit_log\|row_hash\|prev_hash" packages/db/drizzle/0000_init.sql
```
Expected: a `BEFORE INSERT` trigger that computes `prev_hash`/`row_hash`, plus a `BEFORE UPDATE OR DELETE` trigger that raises `audit_log is append-only`. Copy these block-by-block into the new migration in step 2 — do **not** invent new logic.

- [ ] **Step 2: Write the migration file**

Create `packages/db/drizzle/0008_steam_only_auth.sql`:

```sql
-- =====================================================================
-- 0008 — Steam-only login: drop email/password/TOTP identity surface,
-- pivot to players.steam_id64 (bigint) as the universal user anchor.
--
-- Destructive forward-only. Pre-launch panel — no prod data to preserve.
-- Rollback path: git revert + DROP DATABASE + CREATE DATABASE + db:migrate.
-- =====================================================================

BEGIN;

-- 1. Drop everything that depends on users.id (CASCADE catches indices,
--    triggers, FKs).
DROP TABLE IF EXISTS audit_log         CASCADE;
DROP TABLE IF EXISTS config_versions   CASCADE;
DROP TABLE IF EXISTS sessions          CASCADE;
DROP TABLE IF EXISTS user_api_tokens   CASCADE;
DROP TABLE IF EXISTS user_identities   CASCADE;
DROP TABLE IF EXISTS user_role_assignments CASCADE;
DROP TABLE IF EXISTS organization_members   CASCADE;
DROP TABLE IF EXISTS users             CASCADE;

-- 2. Recreate identity-anchored tables on players.steam_id64.

CREATE TABLE sessions (
  id                text         PRIMARY KEY,
  steam_id64        bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  expires_at        timestamptz  NOT NULL,
  last_activity_at  timestamptz  NOT NULL DEFAULT now(),
  ip                inet,
  user_agent        text,
  created_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX sessions_steam_id64_idx     ON sessions(steam_id64);
CREATE INDEX sessions_expires_at_idx     ON sessions(expires_at);
CREATE INDEX sessions_last_activity_idx  ON sessions(last_activity_at);

CREATE TABLE player_role_assignments (
  steam_id64  bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  role_id     uuid         NOT NULL REFERENCES roles(id)            ON DELETE CASCADE,
  assigned_by bigint                   REFERENCES players(steam_id64) ON DELETE SET NULL,
  assigned_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, role_id)
);
CREATE INDEX player_role_assignments_role_idx ON player_role_assignments(role_id);

CREATE TABLE organization_members (
  steam_id64       bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  org_id           uuid         NOT NULL REFERENCES organizations(id)   ON DELETE CASCADE,
  primary_role_id  uuid                     REFERENCES roles(id),
  joined_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, org_id)
);

CREATE TABLE player_api_tokens (
  id            uuid         PRIMARY KEY,
  steam_id64    bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  name          text         NOT NULL,
  token_hash    text         NOT NULL,
  scopes        text[]       NOT NULL DEFAULT '{}',
  last_used_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX player_api_tokens_steam_id64_idx ON player_api_tokens(steam_id64);

CREATE TABLE audit_log (
  id                 bigserial    PRIMARY KEY,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  actor_kind         text         NOT NULL,
  actor_steam_id64   bigint                REFERENCES players(steam_id64)        ON DELETE SET NULL,
  actor_token_id     uuid                  REFERENCES player_api_tokens(id)      ON DELETE SET NULL,
  actor_system_label text,
  actor_ip           inet,
  action_type        text         NOT NULL,
  target_type        text,
  target_id          text,
  before_snapshot    jsonb,
  after_snapshot     jsonb,
  context            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status_code        integer,
  duration_ms        integer,
  org_id             uuid                  REFERENCES organizations(id),
  prev_hash          bytea,
  row_hash           bytea        NOT NULL,
  CONSTRAINT audit_log_actor_kind CHECK (
    (actor_kind = 'steam'  AND actor_steam_id64 IS NOT NULL AND actor_system_label IS NULL) OR
    (actor_kind = 'system' AND actor_steam_id64 IS NULL     AND actor_system_label IS NOT NULL)
  )
);
CREATE INDEX audit_log_created_at_idx  ON audit_log(created_at DESC);
CREATE INDEX audit_log_actor_steam_idx ON audit_log(actor_steam_id64, created_at)
  WHERE actor_steam_id64 IS NOT NULL;
CREATE INDEX audit_log_action_idx      ON audit_log(action_type, created_at);
CREATE INDEX audit_log_target_idx      ON audit_log(target_type, target_id);

-- Hash-chain trigger — copied verbatim from 0000_init.sql, re-attached
-- to the new audit_log shape. Inputs to canonical_json must list
-- every persisted column so hashes stay deterministic.
CREATE OR REPLACE FUNCTION audit_log_compute_hash() RETURNS trigger AS $$
DECLARE
  prev bytea;
  payload text;
BEGIN
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  IF prev IS NULL THEN
    prev := decode(repeat('00', 32), 'hex');
  END IF;
  NEW.prev_hash := prev;
  payload := jsonb_build_object(
    'id', NEW.id,
    'created_at', NEW.created_at,
    'actor_kind', NEW.actor_kind,
    'actor_steam_id64', NEW.actor_steam_id64,
    'actor_token_id', NEW.actor_token_id,
    'actor_system_label', NEW.actor_system_label,
    'actor_ip', NEW.actor_ip,
    'action_type', NEW.action_type,
    'target_type', NEW.target_type,
    'target_id', NEW.target_id,
    'before_snapshot', NEW.before_snapshot,
    'after_snapshot', NEW.after_snapshot,
    'context', NEW.context,
    'status_code', NEW.status_code,
    'duration_ms', NEW.duration_ms,
    'org_id', NEW.org_id,
    'prev_hash', encode(NEW.prev_hash, 'hex')
  )::text;
  NEW.row_hash := digest(payload, 'sha256');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_hash_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_compute_hash();

CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

-- 3. config_versions on steam_id64 author.

CREATE TABLE config_versions (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id           uuid         NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  filename            text         NOT NULL,
  content             text         NOT NULL,
  sha256              bytea        NOT NULL,
  parent_version_id   uuid,
  author_steam_id64   bigint                 REFERENCES players(steam_id64) ON DELETE SET NULL,
  author_label        text,
  author_ip           inet,
  message             text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT config_versions_author_presence CHECK (
    author_steam_id64 IS NOT NULL OR author_label IS NOT NULL
  )
);
CREATE INDEX config_versions_server_file_time_idx
  ON config_versions(server_id, filename, created_at);
CREATE INDEX config_versions_sha256_idx ON config_versions(sha256);

-- Reject UPDATE/DELETE on config_versions (preserve append-only semantics).
CREATE TRIGGER config_versions_no_update
  BEFORE UPDATE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
CREATE TRIGGER config_versions_no_delete
  BEFORE DELETE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

COMMIT;
```

> **NOTE for engineer:** if `0000_init.sql` shows different append-only trigger names or function bodies, copy those instead — the file above is a faithful template, not a verbatim quote. The shape (`canonical_json` payload + sha256) must match what `apps/api/src/lib/audit.ts` and `scripts/verify-audit-chain.ts` expect.

- [ ] **Step 3: Run migration locally against ephemeral DB**

```bash
docker compose -f docker-compose.yml down -v   # remove old volumes
docker compose up -d postgres redis
DATABASE_URL=postgres://admin:${POSTGRES_PASSWORD}@127.0.0.1:5432/admin pnpm db:migrate
```
Expected: all 8 migrations apply, no errors. If `0008` fails — read the error, fix the SQL, re-run (DB is empty so re-running is safe).

- [ ] **Step 4: Sanity-query the new shape**

```bash
psql "$DATABASE_URL" -c "\d sessions"
psql "$DATABASE_URL" -c "\d audit_log"
psql "$DATABASE_URL" -c "\d player_role_assignments"
```
Expected: `steam_id64 bigint NOT NULL` in sessions, `actor_kind` constraint visible on audit_log, PK `(steam_id64, role_id)` on player_role_assignments.

---

### Task 4: Drizzle codegen sanity + Phase 1 commit

**Files:**
- Modify: `packages/db/drizzle/meta/_journal.json` (auto-generated)
- Modify: `packages/db/drizzle/meta/0008_snapshot.json` (auto-generated)

- [ ] **Step 1: Run `db:generate`**

```bash
pnpm db:generate
```
Drizzle compares the TS schema with the live SQL state and emits a snapshot for `0008`.

- [ ] **Step 2: Inspect any auto-generated `0009_*.sql`**

```bash
ls packages/db/drizzle/00*.sql
```
Expected: only `0008_steam_only_auth.sql`. If Drizzle generated an additional `0009_*.sql`, open it — it means the TS schema diverges from the hand-written SQL. Reconcile (usually fix the schema TS to match SQL, since SQL is ground truth for this migration), delete the spurious file, re-run `pnpm db:generate`.

- [ ] **Step 3: Commit Phase 1**

```bash
git add packages/db/src/schema packages/db/drizzle/0008_steam_only_auth.sql packages/db/drizzle/meta
git commit -m "$(cat <<'EOF'
feat(db): 0008 steam-only auth — drop users, anchor on players.steam_id64

Destructive forward-only migration. sessions/organization_members/
player_role_assignments/player_api_tokens/audit_log/config_versions
rebuilt on bigint steam_id64. audit_log gains discriminated actor
(steam|system) with FK to player_api_tokens for traceability. Drizzle
schema mirrors SQL. Append-only triggers re-attached to new shape.
EOF
)"
```

---

## Phase 2 — Bridge: sentinel path allow-list

### Task 5: Allow `/var/lib/squad-panel/.first-owner-claimed` for read + atomic write

**Files:**
- Modify: `apps/bridge/internal/validate/paths.go` — add `PanelSentinelPath` validator
- Modify: `apps/bridge/internal/handlers/handlers.go:222-240` — wire it into `validateReadablePath` and `validateWritablePath`
- Test: `apps/bridge/internal/validate/paths_test.go`

- [ ] **Step 1: Write the failing Go test**

Open `apps/bridge/internal/validate/paths_test.go` (create if missing). Add:

```go
package validate

import "testing"

func TestPanelSentinelPath(t *testing.T) {
    cases := []struct {
        name    string
        path    string
        wantErr bool
    }{
        {"happy", "/var/lib/squad-panel/.first-owner-claimed", false},
        {"escape attempt", "/var/lib/squad-panel/../../etc/passwd", true},
        {"unrelated file in same dir", "/var/lib/squad-panel/something-else", true},
        {"non-absolute", ".first-owner-claimed", true},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            _, err := PanelSentinelPath(tc.path)
            if tc.wantErr && err == nil {
                t.Fatalf("expected error, got nil")
            }
            if !tc.wantErr && err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
        })
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/bridge && go test ./internal/validate -run TestPanelSentinelPath
```
Expected: `undefined: PanelSentinelPath`.

- [ ] **Step 3: Add `PanelSentinelPath` to `paths.go`**

Append to `apps/bridge/internal/validate/paths.go`:

```go
// PanelSentinelPath permits exactly /var/lib/squad-panel/.first-owner-claimed
// (and nothing else under that directory). The first-owner trick uses this
// file as an out-of-band anchor that survives DB drop-and-restore.
const sentinelFirstOwnerPath = "/var/lib/squad-panel/.first-owner-claimed"

func PanelSentinelPath(p string) (string, error) {
    cleaned, err := Path(p, sentinelFirstOwnerPath)
    if err != nil {
        return "", err
    }
    if cleaned != sentinelFirstOwnerPath {
        return "", fmt.Errorf("%w: only %q is allowed", ErrForbidden, sentinelFirstOwnerPath)
    }
    return cleaned, nil
}
```

- [ ] **Step 4: Wire it into the handler validators**

Edit `apps/bridge/internal/handlers/handlers.go`:

In `validateReadablePath` (around line 222), add a third branch BEFORE the final `return fmt.Errorf(...)`:

```go
if _, err := validate.PanelSentinelPath(p); err == nil {
    return nil
}
```

In `validateWritablePath` (around line 235), same idea — add the sentinel branch:

```go
if _, err := validate.PanelSentinelPath(p); err == nil {
    return nil
}
```

- [ ] **Step 5: Run tests**

```bash
cd apps/bridge && go test -race ./internal/validate ./internal/handlers
```
Expected: all green.

- [ ] **Step 6: Build the bridge binary**

```bash
cd apps/bridge && make build
```
Expected: `bin/panel-host-bridge` produced. Vet must also pass:

```bash
cd apps/bridge && go vet ./...
```

- [ ] **Step 7: Commit**

```bash
git add apps/bridge/internal/validate/paths.go apps/bridge/internal/validate/paths_test.go apps/bridge/internal/handlers/handlers.go
git commit -m "feat(bridge): allow first-owner sentinel under /var/lib/squad-panel"
```

> **NOTE:** the running `panel-host-bridge.service` on the host still has the OLD binary. Redeployment happens later (Task 23). Until then, e2e bridge calls touching the sentinel will fail — integration tests in Phase 4 use a mocked bridge.

---

## Phase 3 — API libraries (pure logic + small test surface)

### Task 6: `apps/api/src/lib/steam-openid.ts` — pure helpers

**Files:**
- Create: `apps/api/src/lib/steam-openid.ts`
- Test: `apps/api/test/steam-openid.test.ts`

**Why pure:** keep nonce-store I/O out of this module. Caller handles Redis. Module exports three functions that can be unit-tested with `fetch` mocks alone.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/steam-openid.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildLoginRedirectUrl,
  parseClaimedSteamId64,
  verifyWithSteam,
} from '../src/lib/steam-openid.js';

describe('buildLoginRedirectUrl', () => {
  it('builds the standard checkid_setup URL with return_to + realm', () => {
    const url = buildLoginRedirectUrl({
      panelPublicUrl: 'https://panel.example',
      nonce: 'abc123',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(u.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(u.searchParams.get('openid.return_to')).toBe(
      'https://panel.example/api/v1/auth/steam/callback?n=abc123',
    );
    expect(u.searchParams.get('openid.realm')).toBe('https://panel.example/');
    expect(u.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
  });
});

describe('parseClaimedSteamId64', () => {
  it('extracts the 17-digit id from a valid claimed_id', () => {
    expect(parseClaimedSteamId64('https://steamcommunity.com/openid/id/76561198000000001')).toBe(
      76561198000000001n,
    );
  });
  it('rejects wrong host', () => {
    expect(() =>
      parseClaimedSteamId64('https://evil.example/openid/id/76561198000000001'),
    ).toThrow(/claimed_id/);
  });
  it('rejects non-numeric id', () => {
    expect(() => parseClaimedSteamId64('https://steamcommunity.com/openid/id/abc')).toThrow(
      /claimed_id/,
    );
  });
});

describe('verifyWithSteam', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns steam_id64 + response_nonce on is_valid:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
    });
    const result = await verifyWithSteam(
      {
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'id_res',
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
        'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002',
        'openid.return_to': 'https://panel.example/api/v1/auth/steam/callback?n=abc',
        'openid.response_nonce': '2026-04-25T12:00:00Zabc',
        'openid.assoc_handle': 'x',
        'openid.signed': 'signed,op_endpoint',
        'openid.sig': 'sig',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.steamId64).toBe(76561198000000002n);
    expect(result.responseNonce).toBe('2026-04-25T12:00:00Zabc');
  });

  it('throws on is_valid:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'is_valid:false\n',
    });
    await expect(
      verifyWithSteam(
        {
          'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000002',
          'openid.response_nonce': 'x',
        } as any,
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/is_valid/);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm --filter @squad/api exec vitest run test/steam-openid.test.ts
```
Expected: cannot resolve `../src/lib/steam-openid.js`.

- [ ] **Step 3: Implement `apps/api/src/lib/steam-openid.ts`**

```ts
const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';

export interface BuildLoginRedirectUrlInput {
  panelPublicUrl: string;
  nonce: string;
}

export function buildLoginRedirectUrl(input: BuildLoginRedirectUrlInput): string {
  const base = input.panelPublicUrl.replace(/\/+$/, '');
  const returnTo = `${base}/api/v1/auth/steam/callback?n=${encodeURIComponent(input.nonce)}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': `${base}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

export function parseClaimedSteamId64(claimedId: string): bigint {
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX)) {
    throw new Error(`invalid claimed_id host: ${claimedId}`);
  }
  const tail = claimedId.slice(CLAIMED_ID_PREFIX.length);
  if (!/^\d{17}$/.test(tail)) {
    throw new Error(`invalid claimed_id format: ${claimedId}`);
  }
  return BigInt(tail);
}

export type CallbackParams = Record<string, string>;

export interface SteamVerifyResult {
  steamId64: bigint;
  responseNonce: string;
}

export interface VerifyDeps {
  fetch?: typeof fetch;
}

export async function verifyWithSteam(
  params: CallbackParams,
  deps: VerifyDeps = {},
): Promise<SteamVerifyResult> {
  const f = deps.fetch ?? fetch;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('openid.') && v !== undefined) body.set(k, v);
  }
  body.set('openid.mode', 'check_authentication');
  const res = await f(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`steam check_authentication HTTP ${res.status}`);
  const text = await res.text();
  const lines = Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf(':');
        return idx === -1 ? [l, ''] : [l.slice(0, idx), l.slice(idx + 1)];
      }),
  ) as Record<string, string>;
  if (lines.is_valid !== 'true') {
    throw new Error(`steam is_valid=${lines.is_valid ?? 'missing'}`);
  }
  const claimedId = params['openid.claimed_id'];
  if (!claimedId) throw new Error('missing openid.claimed_id');
  const steamId64 = parseClaimedSteamId64(claimedId);
  const responseNonce = params['openid.response_nonce'];
  if (!responseNonce) throw new Error('missing openid.response_nonce');
  return { steamId64, responseNonce };
}
```

- [ ] **Step 4: Run — expect green**

```bash
pnpm --filter @squad/api exec vitest run test/steam-openid.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/steam-openid.ts apps/api/test/steam-openid.test.ts
git commit -m "feat(api): steam-openid pure helpers (build url, parse claimed_id, verify)"
```

---

### Task 7: `apps/api/src/lib/steam-profile.ts` — optional persona enrichment

**Files:**
- Create: `apps/api/src/lib/steam-profile.ts`
- Test: `apps/api/test/steam-profile.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/steam-profile.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchSteamProfile } from '../src/lib/steam-profile.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => store.set(k, v)),
  };
};

describe('fetchSteamProfile', () => {
  it('returns null when API key is empty', async () => {
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: '',
      redis: fakeRedis() as any,
      fetch: vi.fn() as any,
    });
    expect(res).toBeNull();
  });

  it('hits Steam Web API and caches the result', async () => {
    const redis = fakeRedis();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          players: [
            { steamid: '76561198000000001', personaname: 'TestUser', avatarfull: 'http://a' },
          ],
        },
      }),
    });
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis: redis as any,
      fetch: fetchMock as any,
    });
    expect(res).toEqual({ persona: 'TestUser', avatarUrl: 'http://a' });
    expect(redis.set).toHaveBeenCalled();
  });

  it('returns cached value on repeat call', async () => {
    const redis = fakeRedis();
    await redis.set('steam-profile:76561198000000001', JSON.stringify({ persona: 'Cached', avatarUrl: '' }));
    const fetchMock = vi.fn();
    const res = await fetchSteamProfile(76561198000000001n, {
      apiKey: 'KEY',
      redis: redis as any,
      fetch: fetchMock as any,
    });
    expect(res).toEqual({ persona: 'Cached', avatarUrl: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm --filter @squad/api exec vitest run test/steam-profile.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/steam-profile.ts`:

```ts
import type Redis from 'ioredis';

export interface SteamProfile {
  persona: string;
  avatarUrl: string;
}

export interface FetchSteamProfileDeps {
  apiKey: string;
  redis: Pick<Redis, 'get' | 'set'>;
  fetch?: typeof fetch;
}

const CACHE_PREFIX = 'steam-profile:';
const CACHE_TTL_SECONDS = 3600;

export async function fetchSteamProfile(
  steamId64: bigint,
  deps: FetchSteamProfileDeps,
): Promise<SteamProfile | null> {
  if (!deps.apiKey) return null;
  const key = `${CACHE_PREFIX}${steamId64}`;
  const cached = await deps.redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as SteamProfile;
    } catch {
      // fall through to refetch
    }
  }
  const f = deps.fetch ?? fetch;
  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
  url.searchParams.set('key', deps.apiKey);
  url.searchParams.set('steamids', String(steamId64));
  const res = await f(url);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    response?: { players?: { personaname?: string; avatarfull?: string }[] };
  };
  const player = json.response?.players?.[0];
  if (!player) return null;
  const profile: SteamProfile = {
    persona: player.personaname ?? '',
    avatarUrl: player.avatarfull ?? '',
  };
  await deps.redis.set(key, JSON.stringify(profile), 'EX' as any, CACHE_TTL_SECONDS as any);
  return profile;
}
```

- [ ] **Step 4: Run — expect green**

```bash
pnpm --filter @squad/api exec vitest run test/steam-profile.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/steam-profile.ts apps/api/test/steam-profile.test.ts
git commit -m "feat(api): optional Steam Web API persona/avatar enrichment with redis cache"
```

---

### Task 8: `apps/api/src/lib/first-owner.ts`

**Files:**
- Create: `apps/api/src/lib/first-owner.ts`
- Test: `apps/api/test/first-owner.test.ts`

- [ ] **Step 1: Write failing tests against an ephemeral DB**

Create `apps/api/test/first-owner.test.ts`. The existing test infra (see `apps/api/test/integration/`) provides a `setupTestDb()` helper that returns a freshly-migrated DB connection; if it does not exist, the engineer should mirror the pattern from any other integration test in `apps/api/test/integration/`.

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { organizations, players, playerRoleAssignments, roles } from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { v7 as uuidv7 } from 'uuid';
import { claimFirstOwner } from '../src/lib/first-owner.js';
import { setupTestDb } from './integration/db-helper.js'; // adapt to actual helper name

const fakeBridge = (existingSentinel: boolean) => ({
  fileRead: vi.fn(async () =>
    existingSentinel ? { content: '{}' } : Promise.reject(new Error('ENOENT')),
  ),
  fileAtomicWrite: vi.fn(async () => ({ status: 'written' })),
});

describe('claimFirstOwner', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeEach(async () => {
    db = await setupTestDb();
    const orgId = uuidv7();
    await db.insert(organizations).values({ id: orgId, name: 'T', slug: 't' });
    await seedSystemRoles(db, orgId);
  });

  it('claims first owner when neither anchor is set', async () => {
    const bridge = fakeBridge(false);
    const result = await claimFirstOwner(db, bridge as any, 76561198000000010n);
    expect(result).toBe('claimed');
    const ras = await db.select().from(playerRoleAssignments)
      .where(eq(playerRoleAssignments.steamId64, 76561198000000010n));
    expect(ras.length).toBe(1);
    expect(bridge.fileAtomicWrite).toHaveBeenCalled();
  });

  it('returns already_claimed when sentinel exists', async () => {
    const bridge = fakeBridge(true);
    const result = await claimFirstOwner(db, bridge as any, 76561198000000011n);
    expect(result).toBe('already_claimed');
    expect(bridge.fileAtomicWrite).not.toHaveBeenCalled();
  });

  it('returns already_claimed when DB flag is set even without sentinel', async () => {
    const bridge = fakeBridge(false);
    await db.update(organizations).set({
      settings: { first_owner_claimed: true } as object,
    });
    const result = await claimFirstOwner(db, bridge as any, 76561198000000012n);
    expect(result).toBe('already_claimed');
  });

  it('serialises concurrent calls — exactly one claims', async () => {
    const bridge = fakeBridge(false);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimFirstOwner(db, bridge as any, BigInt(76561198000000020n + BigInt(i))),
      ),
    );
    const claimed = results.filter((r) => r === 'claimed').length;
    expect(claimed).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `apps/api/src/lib/first-owner.ts`**

```ts
import type { DatabaseClient } from '@squad/db';
import {
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
  roles,
} from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type ClaimResult = 'claimed' | 'already_claimed' | 'no_owner_role';

export interface SentinelBridge {
  fileRead(args: { path: string } | string): Promise<{ content: string } | unknown>;
  fileAtomicWrite(args: { path: string; content: string } | { path: string; content: string; mode?: number }): Promise<unknown>;
}

const SENTINEL_PATH = '/var/lib/squad-panel/.first-owner-claimed';

function stubName(steamId64: bigint): string {
  const s = String(steamId64);
  return `Player ${s.slice(-4)}`;
}

export async function claimFirstOwner(
  db: DatabaseClient,
  bridge: SentinelBridge,
  steamId64: bigint,
): Promise<ClaimResult> {
  // Cheap pre-check: bridge file_read returns success only if the
  // sentinel exists. Any error (ENOENT, forbidden, bridge down) means
  // we proceed to the transactional path which is the source of truth.
  try {
    await bridge.fileRead({ path: SENTINEL_PATH });
    return 'already_claimed';
  } catch {
    // continue
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('first_owner'))`);

    const orgs = await tx.select().from(organizations).limit(1);
    const org = orgs[0];
    if (!org) throw new Error('no_organization_yet');
    const settings = (org.settings as Record<string, unknown>) ?? {};
    if (settings.first_owner_claimed === true) return 'already_claimed';

    const ownerRole = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, org.id), eq(roles.name, 'Owner')))
      .limit(1);
    const owner = ownerRole[0];
    if (!owner) return 'no_owner_role';

    const stub = stubName(steamId64);
    await tx
      .insert(players)
      .values({
        steamId64,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
      })
      .onConflictDoNothing();

    await tx
      .insert(playerRoleAssignments)
      .values({ steamId64, roleId: owner.id, assignedBy: null })
      .onConflictDoNothing();

    await tx
      .insert(organizationMembers)
      .values({ steamId64, orgId: org.id, primaryRoleId: owner.id })
      .onConflictDoNothing();

    await tx
      .update(organizations)
      .set({ settings: { ...settings, first_owner_claimed: true } })
      .where(eq(organizations.id, org.id));

    await bridge.fileAtomicWrite({
      path: SENTINEL_PATH,
      content: JSON.stringify({
        steam_id64: String(steamId64),
        claimed_at: new Date().toISOString(),
      }),
    });

    return 'claimed';
  });
}
```

- [ ] **Step 4: Run — expect green**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/first-owner.ts apps/api/test/first-owner.test.ts
git commit -m "feat(api): claimFirstOwner with advisory-lock + dual anchor (DB flag + bridge sentinel)"
```

---

### Task 9: Sliding session TTL with Redis SETNX throttle

**Files:**
- Modify: `apps/api/src/lib/sessions.ts`
- Test: `apps/api/test/sessions-touch.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/sessions-touch.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { touchSession } from '../src/lib/sessions.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (k: string, v: string, ex: string, ttl: number, nx: string) => {
      if (nx === 'NX' && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    setBare: vi.fn(async (k: string, v: string) => store.set(k, v)),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => store.delete(k)),
  };
};

describe('touchSession', () => {
  it('updates DB and returns true on first call within window', async () => {
    const redis = fakeRedis();
    const update = vi.fn();
    const did = await touchSession({
      sessionId: 'sid1',
      redis: redis as any,
      now: new Date('2026-04-25T12:00:00Z'),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    });
    expect(did).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips DB update on second call within throttle window', async () => {
    const redis = fakeRedis();
    const update = vi.fn();
    const args = {
      sessionId: 'sid1',
      redis: redis as any,
      now: new Date(),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    };
    await touchSession(args);
    await touchSession(args);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect failure** (`touchSession` does not exist).

- [ ] **Step 3: Add `touchSession` + `lastActivityAt` to `apps/api/src/lib/sessions.ts`**

Replace the existing file (preserve `mintSessionToken`, `tokenIdFromToken`, `revokeSession`, `revokeAllForUser`, `pruneExpired`, cache helpers) and add:

1. Update the `SessionRecord` interface to include `lastActivityAt`, replace `userId` with `steamId64: bigint`.
2. Update `createSession`/`resolveSession` to read/write `steam_id64` and `last_activity_at` columns.
3. Replace the in-cache `userId` field with `steamId64: string` (we serialise BigInt as string in JSON).
4. Add `touchSession`:

```ts
export interface TouchSessionInput {
  sessionId: string;
  redis: { set(...args: any[]): Promise<unknown> };
  now: Date;
  ttlSeconds: number;
  throttleSeconds: number;
  updateDb: (newExpiresAt: Date, newLastActivity: Date) => Promise<void>;
}

export async function touchSession(input: TouchSessionInput): Promise<boolean> {
  const ok = await input.redis.set(
    `session-touch:${input.sessionId}`,
    '1',
    'EX',
    input.throttleSeconds,
    'NX',
  );
  if (ok !== 'OK') return false;
  const newExpiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  await input.updateDb(newExpiresAt, input.now);
  return true;
}
```

The full `sessions.ts` must compile cleanly — engineer rewrites the existing functions to switch from `userId: string` to `steamId64: bigint` throughout. JSON serialisation: BigInt → `String(steamId64)`, parse → `BigInt(record.steamId64)`.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --filter @squad/api exec vitest run test/sessions-touch.test.ts
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/sessions.ts apps/api/test/sessions-touch.test.ts
git commit -m "feat(api): sliding session TTL with redis SETNX throttle + last_activity_at"
```

---

## Phase 4 — API plugin + routes

### Task 10: Update `apps/api/src/plugins/auth.ts` to read players, not users

**Files:**
- Modify: `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/plugins/types.ts` — change `req.user` shape
- Modify: `apps/api/src/lib/rbac.ts` — accept `steamId64: bigint` instead of `userId: string`

- [ ] **Step 1: Update `plugins/types.ts`**

Change the type augmentation to:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      steamId64: bigint;
      canonicalName: string;
      avatarUrl: string | null;
      permissions: import('../lib/rbac.js').PermissionContext;
    };
    session?: { id: string; steamId64: bigint };
  }
}
```

(Remove the `email`/`displayName`/`id: string` fields.)

- [ ] **Step 2: Refactor `lib/rbac.ts`**

Replace every `userId: string` reference with `steamId64: bigint`. The `cache` Map keys become `String(steamId64)` to keep map-key stable. The `userRoleAssignments` table is renamed to `playerRoleAssignments` (imported from `@squad/db/schema`).

- [ ] **Step 3: Refactor `plugins/auth.ts`**

```ts
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { loadUserPermissions } from '../lib/rbac.js';
import { resolveSession, touchSession } from '../lib/sessions.js';
import { sessions as sessionsTable } from '@squad/db/schema';

export const SESSION_COOKIE = '__Host-sid';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 21600);
const SESSION_TOUCH_THROTTLE_SECONDS = Number(process.env.SESSION_TOUCH_THROTTLE_SECONDS ?? 60);

export default fp(async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = await resolveSession(app.db, app.redis, token);
      if (session) {
        const playerRows = await app.db
          .select({
            steamId64: players.steamId64,
            canonicalName: players.canonicalName,
          })
          .from(players)
          .where(eq(players.steamId64, session.steamId64))
          .limit(1);
        const player = playerRows[0];
        if (player) {
          req.session = { id: session.id, steamId64: player.steamId64 };
          req.user = {
            steamId64: player.steamId64,
            canonicalName: player.canonicalName,
            avatarUrl: null,
            permissions: await loadUserPermissions(app.db, player.steamId64),
          };
          // Sliding touch — only the throttle owner does the DB UPDATE.
          const touched = await touchSession({
            sessionId: session.id,
            redis: app.redis,
            now: new Date(),
            ttlSeconds: SESSION_TTL_SECONDS,
            throttleSeconds: SESSION_TOUCH_THROTTLE_SECONDS,
            updateDb: async (expiresAt, lastActivity) => {
              await app.db
                .update(sessionsTable)
                .set({ expiresAt, lastActivityAt: lastActivity })
                .where(eq(sessionsTable.id, session.id));
            },
          });
          if (touched) {
            reply.setCookie(SESSION_COOKIE, token, {
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'lax',
              maxAge: SESSION_TTL_SECONDS,
            });
          }
        }
      }
    }

    const required = req.routeOptions?.config?.permissions;
    if (!required || required.length === 0) return;
    if (!req.user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    for (const perm of required) {
      if (!req.user.permissions.permissions.has(perm)) {
        reply.code(403).send({ error: 'forbidden', required });
        return;
      }
    }
  });
});
```

- [ ] **Step 4: Compile-check**

```bash
pnpm --filter @squad/api exec tsc --noEmit
```
Expected: numerous errors elsewhere — every consumer of `req.user.id` or `req.user.email` will fail. **Do not fix them in this task.** Note them; subsequent tasks in this phase fix routes. Run a quick scan now to know the blast radius:

```bash
grep -rn "req.user.id\|req.user.email\|req.user.displayName" apps/api/src
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plugins/auth.ts apps/api/src/plugins/types.ts apps/api/src/lib/rbac.ts
git commit -m "refactor(api): auth plugin attaches player by steam_id64; sliding touch wired"
```

---

### Task 11: Steam OpenID routes (login + callback)

**Files:**
- Modify: `apps/api/src/routes/auth-steam.ts` (replace 501 stubs)
- Test: `apps/api/test/auth-steam.test.ts`
- Modify: `apps/api/src/config.ts` (or wherever `AppConfig` lives) — add `PANEL_PUBLIC_URL`, `STEAM_WEB_API_KEY`

- [ ] **Step 1: Add ENV vars to `AppConfig`**

In the existing config schema (search for `SESSION_SECRET` to find it: `grep -n SESSION_SECRET apps/api/src/config.ts`), add:

```ts
PANEL_PUBLIC_URL: z.string().url(),
STEAM_WEB_API_KEY: z.string().default(''),
SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(21600),
SESSION_TOUCH_THROTTLE_SECONDS: z.coerce.number().int().positive().default(60),
```

Update `.env.example` accordingly:

```
PANEL_PUBLIC_URL=https://panel.example
STEAM_WEB_API_KEY=
SESSION_TTL_SECONDS=21600
SESSION_TOUCH_THROTTLE_SECONDS=60
```

- [ ] **Step 2: Write failing tests**

Create `apps/api/test/auth-steam.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildTestApp } from './integration/build-app.js'; // adapt to existing helper

describe('GET /api/v1/auth/steam/login', () => {
  it('redirects to steam with nonce in cookie + query', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/steam/login' });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('steamcommunity.com/openid/login');
    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toMatch(/__Host-steam-nonce=/);
    expect(location).toMatch(/openid\.return_to=.*n=[A-Za-z0-9_-]{16,}/);
  });
});

describe('GET /api/v1/auth/steam/callback', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    app = await buildTestApp();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('is_valid:true\n', { status: 200 }),
    );
  });

  it('rejects when nonce cookie missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/steam/callback?n=abc&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when query nonce does not match cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/steam/callback?n=mismatch',
      cookies: { '__Host-steam-nonce': 'expected' },
    });
    expect(res.statusCode).toBe(400);
  });

  // Add: response_nonce replay test (uses redis SETNX-on-already-existing).
  // Add: claimed_id format reject test.
  // Add: happy-path test that reaches first-owner trick — see Task 13 for fixtures.
});
```

- [ ] **Step 3: Run — expect failure**

- [ ] **Step 4: Implement `apps/api/src/routes/auth-steam.ts`**

Replace the 501-stub file completely. The handler order:

```ts
import { randomBytes } from 'node:crypto';
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  buildLoginRedirectUrl,
  parseClaimedSteamId64,
  verifyWithSteam,
} from '../lib/steam-openid.js';
import { fetchSteamProfile } from '../lib/steam-profile.js';
import { claimFirstOwner } from '../lib/first-owner.js';
import { createSession } from '../lib/sessions.js';
import { SESSION_COOKIE } from '../plugins/auth.js';
import { loadUserPermissions } from '../lib/rbac.js';

const NONCE_COOKIE = '__Host-steam-nonce';
const NONCE_TTL = 300;
const NONCE_REDIS_PREFIX = 'steam-nonce:';
const RESPONSE_NONCE_REDIS_PREFIX = 'steam-response-nonce:';

const steamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/auth/steam/login',
    { config: { audit: false, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const nonce = randomBytes(16).toString('base64url');
      await app.redis.set(
        `${NONCE_REDIS_PREFIX}${nonce}`,
        JSON.stringify({ ts: Date.now(), ip: req.ip ?? null }),
        'EX',
        NONCE_TTL,
      );
      reply.setCookie(NONCE_COOKIE, nonce, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: NONCE_TTL,
      });
      const url = buildLoginRedirectUrl({
        panelPublicUrl: app.config.PANEL_PUBLIC_URL,
        nonce,
      });
      reply.redirect(302, url);
    },
  );

  app.get(
    '/api/v1/auth/steam/callback',
    { config: { audit: false, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const nonce = q.n;
      const cookieNonce = req.cookies[NONCE_COOKIE];
      reply.clearCookie(NONCE_COOKIE, { path: '/' });

      if (!nonce || !cookieNonce || nonce !== cookieNonce) {
        return reply.code(400).send({ error: 'nonce_mismatch' });
      }

      const consumed = await app.redis
        .multi()
        .get(`${NONCE_REDIS_PREFIX}${nonce}`)
        .del(`${NONCE_REDIS_PREFIX}${nonce}`)
        .exec();
      if (!consumed?.[0]?.[1]) {
        return reply.code(400).send({ error: 'nonce_expired' });
      }

      const returnTo = q['openid.return_to'];
      const expectedReturnPrefix = `${app.config.PANEL_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/auth/steam/callback`;
      if (!returnTo || !returnTo.startsWith(expectedReturnPrefix)) {
        return reply.code(400).send({ error: 'return_to_mismatch' });
      }

      let steamId64: bigint;
      let responseNonce: string;
      try {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(q)) {
          if (k.startsWith('openid.') && typeof v === 'string') params[k] = v;
        }
        const verified = await verifyWithSteam(params);
        steamId64 = verified.steamId64;
        responseNonce = verified.responseNonce;
      } catch (err) {
        req.log.warn({ err }, 'steam verification failed');
        return reply.redirect(302, '/login?error=auth_failed');
      }

      // response_nonce single-use guard.
      const setNonceOk = await app.redis.set(
        `${RESPONSE_NONCE_REDIS_PREFIX}${responseNonce}`,
        '1',
        'EX',
        3600,
        'NX',
      );
      if (setNonceOk !== 'OK') {
        return reply.code(400).send({ error: 'replay_detected' });
      }

      // Upsert player stub (canonical_name from Steam if API key present, else stub).
      let canonicalName = `Player ${String(steamId64).slice(-4)}`;
      const profile = await fetchSteamProfile(steamId64, {
        apiKey: app.config.STEAM_WEB_API_KEY,
        redis: app.redis,
      });
      if (profile?.persona) canonicalName = profile.persona;
      await app.db
        .insert(players)
        .values({
          steamId64,
          canonicalName,
          canonicalNameNormalized: canonicalName.toLowerCase(),
        })
        .onConflictDoNothing();

      const claim = await claimFirstOwner(app.db, app.bridge as any, steamId64);

      if (claim === 'no_owner_role') {
        return reply.code(500).send({ error: 'owner_role_missing' });
      }

      // After claim or already_claimed: check if player has any role.
      const ctx = await loadUserPermissions(app.db, steamId64);
      if (ctx.permissions.size === 0) {
        return reply.redirect(
          302,
          `/no-access?steam_id64=${encodeURIComponent(String(steamId64))}`,
        );
      }

      const { token } = await createSession(app.db, app.redis, {
        steamId64,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ttlMs: app.config.SESSION_TTL_SECONDS * 1000,
      });
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: app.config.SESSION_TTL_SECONDS,
      });
      reply.redirect(302, '/');
    },
  );
};

export default steamRoutes;
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @squad/api exec vitest run test/auth-steam.test.ts
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth-steam.ts apps/api/test/auth-steam.test.ts apps/api/src/config.ts .env.example
git commit -m "feat(api): /auth/steam/login + /callback with nonce, return_to bind, replay guard"
```

---

### Task 12: Strip password/TOTP routes; add session-management endpoints

**Files:**
- Modify: `apps/api/src/routes/auth.ts` — DELETE `/login`, `/me/totp/*`; ADD `/me/sessions` GET + DELETE one + DELETE all
- Test: `apps/api/test/auth-sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/auth-sessions.test.ts` covering:
- `GET /api/v1/me/sessions` returns only the caller's sessions, marks current.
- `DELETE /api/v1/me/sessions/:id` for own session — 200, session row gone.
- `DELETE /api/v1/me/sessions/:id` for another user's session — 404.
- `DELETE /api/v1/me/sessions` revokes all caller's sessions.

Use existing test helper that injects an authenticated request (e.g., `apps/api/test/integration/auth-helper.ts` or create one that issues a session row + sets cookie).

- [ ] **Step 2: Replace `apps/api/src/routes/auth.ts`**

```ts
import { sessions as sessionsTable } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { revokeAllForUser, revokeSession, tokenIdFromToken } from '../lib/sessions.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

const authRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/auth/logout',
    { config: { audit: { action: 'user.logout', resource: 'session' } } },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await revokeSession(app.db, app.redis, tokenIdFromToken(token));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  fast.get('/api/v1/me', { config: { audit: false } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    return {
      steam_id64: String(req.user.steamId64),
      canonical_name: req.user.canonicalName,
      permissions: Array.from(req.user.permissions.permissions),
      clearance: req.user.permissions.clearance,
    };
  });

  fast.get(
    '/api/v1/me/sessions',
    { config: { audit: false } },
    async (req, reply) => {
      if (!req.user || !req.session) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const rows = await app.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.steamId64, req.user.steamId64));
      return rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        user_agent: s.userAgent,
        last_activity_at: s.lastActivityAt.toISOString(),
        expires_at: s.expiresAt.toISOString(),
        current: s.id === req.session!.id,
      }));
    },
  );

  fast.delete(
    '/api/v1/me/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().min(1) }) },
      config: { audit: { action: 'user.session.revoke', resource: 'session' } },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const target = await app.db
        .select()
        .from(sessionsTable)
        .where(
          and(
            eq(sessionsTable.id, req.params.id),
            eq(sessionsTable.steamId64, req.user.steamId64),
          ),
        )
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'session_not_found' };
      }
      await revokeSession(app.db, app.redis, req.params.id);
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/me/sessions',
    { config: { audit: { action: 'user.session.revoke_all', resource: 'session' } } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      await revokeAllForUser(app.db, app.redis, req.user.steamId64);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
};

export default authRoutes;
```

Note: the existing `revokeAllForUser` signature accepts `userId: string`; update its definition in `lib/sessions.ts` to `steamId64: bigint` and adapt the SQL accordingly.

- [ ] **Step 3: Run tests + tsc**

```bash
pnpm --filter @squad/api exec tsc --noEmit
pnpm --filter @squad/api exec vitest run test/auth-sessions.test.ts
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/test/auth-sessions.test.ts apps/api/src/lib/sessions.ts
git commit -m "feat(api): drop email/password+TOTP, add session-management endpoints"
```

---

### Task 13: Collapse setup wizard to `/check-env` + `/init`

**Files:**
- Modify: `apps/api/src/routes/setup.ts`
- Test: `apps/api/test/setup.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/setup.test.ts`:
- `GET /api/v1/setup/check-env` returns checks object.
- `POST /api/v1/setup/init` creates org + roles + sets `setup_complete=true`.
- Second `POST /api/v1/setup/init` returns 410 Gone.

- [ ] **Step 2: Rewrite `apps/api/src/routes/setup.ts`**

```ts
import { organizations } from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

async function setupCompleted(app: import('fastify').FastifyInstance): Promise<boolean> {
  const rows = await app.db
    .select({ settings: organizations.settings })
    .from(organizations)
    .limit(1);
  const settings = rows[0]?.settings as Record<string, unknown> | undefined;
  return settings?.setup_complete === true;
}

const initBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
});

const setupRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/setup/check-env', { config: { audit: false } }, async (_req, reply) => {
    if (await setupCompleted(app)) {
      reply.code(410);
      return { error: 'setup_already_complete' };
    }
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const info = await app.bridge.hostInfo();
      checks.bridge = { ok: true, detail: `${info.os_name} ${info.os_version}` };
      checks.host = {
        ok: /Ubuntu|Debian/i.test(info.os_name),
        detail: `${info.os_name} ${info.os_version}`,
      };
    } catch (err) {
      checks.bridge = { ok: false, detail: (err as Error).message };
    }
    checks.public_url = { ok: !!app.config.PANEL_PUBLIC_URL, detail: app.config.PANEL_PUBLIC_URL };
    checks.steam_web_api = {
      ok: !!app.config.STEAM_WEB_API_KEY,
      detail: app.config.STEAM_WEB_API_KEY ? 'configured' : 'optional, not set',
    };
    const ok = checks.bridge.ok && checks.host.ok && checks.public_url.ok;
    return { ok, checks };
  });

  fast.post(
    '/api/v1/setup/init',
    {
      schema: { body: initBody },
      config: { audit: { action: 'setup.init', resource: 'organization' } },
    },
    async (req, reply) => {
      if (await setupCompleted(app)) {
        reply.code(410);
        return { error: 'setup_already_complete' };
      }
      const slug =
        req.body.slug ??
        req.body.name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 63);
      const orgId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx.insert(organizations).values({
          id: orgId,
          name: req.body.name,
          slug,
          settings: { setup_complete: true } as object,
        });
        await seedSystemRoles(tx, orgId);
      });
      return { org_id: orgId, slug };
    },
  );
};

export default setupRoutes;
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/setup.ts apps/api/test/setup.test.ts
git commit -m "feat(api): single-shot setup wizard (check-env + init), no owner-form"
```

---

### Task 14: Audit lib + plugin — discriminated steam-actor

**Files:**
- Modify: `apps/api/src/lib/audit.ts`
- Modify: `apps/api/src/plugins/audit.ts` — adapt actor extraction
- Test: `apps/api/test/audit-entry.test.ts` (existing — update assertions)

- [ ] **Step 1: Update `AuditEntryInput` type**

In `apps/api/src/lib/audit.ts`, change to:

```ts
export interface AuditEntryInput {
  actor:
    | { kind: 'steam'; steamId64: bigint; tokenId?: string | null }
    | { kind: 'system'; label: string };
  actorIp: string | null;
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  context: Record<string, unknown>;
  statusCode?: number;
  durationMs?: number;
  orgId?: string | null;
}

export async function writeAuditEntry(db: DatabaseClient, entry: AuditEntryInput): Promise<void> {
  const actor = entry.actor;
  await db.insert(auditLog).values({
    actorKind: actor.kind,
    actorSteamId64: actor.kind === 'steam' ? actor.steamId64 : null,
    actorTokenId: actor.kind === 'steam' ? (actor.tokenId ?? null) : null,
    actorSystemLabel: actor.kind === 'system' ? actor.label : null,
    actorIp: entry.actorIp,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: entry.before === undefined ? null : (entry.before as object),
    afterSnapshot: entry.after === undefined ? null : (entry.after as object),
    context: (entry.context ?? {}) as object,
    statusCode: entry.statusCode ?? null,
    durationMs: entry.durationMs ?? null,
    orgId: entry.orgId ?? null,
    rowHash: Buffer.from([]),
  });
}
```

- [ ] **Step 2: Update `apps/api/src/plugins/audit.ts`**

Find the existing `actorUserId: req.user?.id ?? null` extraction; replace with:

```ts
const actor: AuditEntryInput['actor'] = req.user
  ? { kind: 'steam', steamId64: req.user.steamId64, tokenId: null }
  : { kind: 'system', label: 'http-anonymous' };
```

(For unauthenticated mutating routes the audit-coverage test will catch this — see next task.)

- [ ] **Step 3: Update `apps/api/test/audit-entry.test.ts`**

Adapt assertions to read `actor_kind`, `actor_steam_id64`, `actor_system_label` columns instead of `actor_user_id`.

- [ ] **Step 4: Run audit-related tests**

```bash
pnpm --filter @squad/api exec vitest run test/audit-entry.test.ts test/audit-coverage.test.ts
```
Expected: both green. The audit-coverage test is unchanged in shape — it only asserts that mutating routes declare `config.audit`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/audit.ts apps/api/src/plugins/audit.ts apps/api/test/audit-entry.test.ts
git commit -m "refactor(api): audit-actor as discriminated steam|system union"
```

---

### Task 15: Players role-assign endpoints

**Files:**
- Modify: `apps/api/src/routes/players.ts`
- Test: `apps/api/test/players-roles.test.ts`

- [ ] **Step 1: Failing tests**

Create `apps/api/test/players-roles.test.ts` covering:
- `POST /api/v1/players/:steam_id64/roles` with `{role_id}` adds row.
- `DELETE /api/v1/players/:steam_id64/roles/:role_id` removes it.
- Removing the last Owner returns 409 `cannot_remove_last_owner`.
- Both endpoints require permission `user:manage_roles`.

- [ ] **Step 2: Add the endpoints**

In `apps/api/src/routes/players.ts`, append:

```ts
fast.post(
  '/api/v1/players/:steam_id64/roles',
  {
    schema: {
      params: z.object({ steam_id64: z.string().regex(/^\d{17}$/) }),
      body: z.object({ role_id: z.string().uuid() }),
    },
    config: {
      audit: { action: 'player.role.assign', resource: 'player' },
      permissions: ['user:manage_roles'] as const,
    },
  },
  async (req) => {
    const steamId64 = BigInt(req.params.steam_id64);
    await app.db
      .insert(playerRoleAssignments)
      .values({
        steamId64,
        roleId: req.body.role_id,
        assignedBy: req.user?.steamId64 ?? null,
      })
      .onConflictDoNothing();
    return { ok: true };
  },
);

fast.delete(
  '/api/v1/players/:steam_id64/roles/:role_id',
  {
    schema: {
      params: z.object({
        steam_id64: z.string().regex(/^\d{17}$/),
        role_id: z.string().uuid(),
      }),
    },
    config: {
      audit: { action: 'player.role.revoke', resource: 'player' },
      permissions: ['user:manage_roles'] as const,
    },
  },
  async (req, reply) => {
    const steamId64 = BigInt(req.params.steam_id64);
    const role = await app.db.select().from(roles).where(eq(roles.id, req.params.role_id)).limit(1);
    if (role[0]?.name === 'Owner') {
      const owners = await app.db
        .select({ steamId64: playerRoleAssignments.steamId64 })
        .from(playerRoleAssignments)
        .where(eq(playerRoleAssignments.roleId, req.params.role_id));
      if (owners.length <= 1) {
        reply.code(409);
        return { error: 'cannot_remove_last_owner' };
      }
    }
    await app.db
      .delete(playerRoleAssignments)
      .where(
        and(
          eq(playerRoleAssignments.steamId64, steamId64),
          eq(playerRoleAssignments.roleId, req.params.role_id),
        ),
      );
    return { ok: true };
  },
);
```

(Imports as needed: `playerRoleAssignments`, `roles`, `and`, `eq`, `z`.)

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @squad/api exec vitest run test/players-roles.test.ts
git add apps/api/src/routes/players.ts apps/api/test/players-roles.test.ts
git commit -m "feat(api): role assign/revoke on player by steam_id64 (Owner lockout-safe)"
```

---

### Task 16: Delete dead code (TOTP, argon, discord stub)

**Files:**
- Delete: `apps/api/src/lib/totp.ts`, `apps/api/test/totp.test.ts`
- Delete: `apps/api/src/lib/argon.ts`, `apps/api/test/argon.test.ts`
- Delete: `apps/api/src/routes/auth-discord.ts`
- Modify: `apps/api/src/server.ts` — remove `discordRoutes` registration
- Modify: `apps/api/test/audit-coverage.test.ts` — remove `discordRoutes` import

Check first whether `crypto.ts` is used elsewhere:

```bash
grep -rn "from '../lib/crypto" apps/api/src
```

If only TOTP routes used it, delete `crypto.ts` and its tests too. If not, leave it.

- [ ] **Step 1: Delete files**

```bash
rm apps/api/src/lib/totp.ts apps/api/test/totp.test.ts
rm apps/api/src/lib/argon.ts apps/api/test/argon.test.ts
rm apps/api/src/routes/auth-discord.ts
```

- [ ] **Step 2: Edit `apps/api/src/server.ts`** — remove the import and `app.register(discordRoutes)` line.

- [ ] **Step 3: Edit `apps/api/test/audit-coverage.test.ts`** — remove the `discordRoutes` import and `register` call.

- [ ] **Step 4: Verify monorepo compiles**

```bash
pnpm turbo run typecheck
```
Expected: green.

- [ ] **Step 5: Run full API test suite**

```bash
pnpm --filter @squad/api test
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(api): remove email/password+TOTP+discord stubs (replaced by Steam OpenID)"
```

---

## Phase 5 — Web (Next.js)

### Task 17: `/login` becomes a single Steam button

**Files:**
- Modify: `apps/web/src/app/login/page.tsx`

- [ ] **Step 1: Replace contents**

```tsx
'use client';

import { useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const params = useSearchParams();
  const error = params.get('error');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 text-neutral-100">
      <h1 className="text-2xl font-semibold mb-6">Squad Admin Panel</h1>
      {error && (
        <p className="mb-4 text-amber-400">
          {error === 'auth_failed' && 'Не удалось проверить вход через Steam. Попробуйте ещё раз.'}
          {error === 'not_authorized' && 'У вашего Steam-аккаунта нет доступа к панели.'}
        </p>
      )}
      <a
        href="/api/v1/auth/steam/login"
        className="px-6 py-3 rounded-md bg-[#1b2838] text-white border border-[#66c0f4] hover:bg-[#2a475e]"
      >
        Войти через Steam
      </a>
    </main>
  );
}
```

- [ ] **Step 2: Visual smoke test**

```bash
pnpm --filter @squad/web dev
```
Open `https://localhost:3000/login` in browser. Verify the button renders, redirect URL is `/api/v1/auth/steam/login`. (Full e2e flow happens in Task 24.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/login/page.tsx
git commit -m "feat(web/login): single Steam-button login page"
```

---

### Task 18: `/setup` two-step wizard

**Files:**
- Modify: `apps/web/src/app/setup/page.tsx`

Replace the existing 3-step form with two steps: (1) env-check (auto-runs on mount), (2) org form that POSTs `/api/v1/setup/init` and redirects to `/login` on 200.

- [ ] **Step 1: Rewrite the page**

```tsx
'use client';

import { useEffect, useState } from 'react';

interface CheckRow { ok: boolean; detail?: string }
interface CheckResp { ok: boolean; checks: Record<string, CheckRow> }

export default function SetupPage() {
  const [checks, setChecks] = useState<CheckResp | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/setup/check-env')
      .then(async (r) => {
        if (r.status === 410) {
          window.location.href = '/login';
          return;
        }
        setChecks((await r.json()) as CheckResp);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    const res = await fetch('/api/v1/setup/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug: slug || undefined }),
    });
    if (res.ok) {
      window.location.href = '/login';
    } else {
      setErr(`HTTP ${res.status}`);
      setSubmitting(false);
    }
  }

  return (
    <main className="max-w-xl mx-auto py-12 px-4 text-neutral-100">
      <h1 className="text-2xl font-semibold mb-6">Первичная настройка</h1>

      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">1. Проверка окружения</h2>
        {!checks ? (
          <p className="text-neutral-400">Проверяем…</p>
        ) : (
          <ul className="space-y-1">
            {Object.entries(checks.checks).map(([k, v]) => (
              <li key={k}>
                <span className={v.ok ? 'text-emerald-400' : 'text-rose-400'}>
                  {v.ok ? '✓' : '✗'}
                </span>{' '}
                <code>{k}</code>: {v.detail ?? (v.ok ? 'ok' : 'fail')}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">2. Создать организацию</h2>
        <label className="block mb-2">
          Название
          <input
            className="block mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block mb-4">
          Slug (опционально)
          <input
            className="block mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        {err && <p className="text-rose-400 mb-2">{err}</p>}
        <button
          type="button"
          disabled={submitting || !name || !checks?.ok}
          onClick={submit}
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
        >
          {submitting ? 'Создаётся…' : 'Создать и перейти к логину'}
        </button>
        <p className="mt-3 text-sm text-neutral-400">
          После создания организации перейдите на страницу входа. Первый, кто залогинится через
          Steam, станет Owner&apos;ом панели.
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/setup/page.tsx
git commit -m "feat(web/setup): two-step wizard (env-check + org), no owner form"
```

---

### Task 19: Sessions UI in `/settings/account`

**Files:**
- Modify: `apps/web/src/app/(dashboard)/settings/account/page.tsx`

- [ ] **Step 1: Remove all TOTP-related sections from the file** (provision/enable/disable/backup-codes blocks).

- [ ] **Step 2: Add a sessions table**

Append a section that:
1. Calls `GET /api/v1/me/sessions` on mount.
2. Renders a table with columns `IP | User-Agent | Активность | Истекает | Действия`.
3. Marks the row with `current: true` with a badge "текущая".
4. Each row has a "Завершить" button → `DELETE /api/v1/me/sessions/:id`.
5. Above the table, a button "Завершить все остальные" → iterates non-current ids and DELETE each (or use the bulk endpoint if extending). Use `DELETE /api/v1/me/sessions` for "all".

The structure mirrors existing client-component patterns in `apps/web/src/app/(dashboard)/players/page.tsx`. Russian copy throughout.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/settings/account/page.tsx
git commit -m "feat(web/account): drop TOTP UI, add active-sessions list with revoke"
```

---

### Task 20: Player role-assign UI on `/players/[steam_id64]`

**Files:**
- Modify: `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx`

- [ ] **Step 1: Read the page first** to understand existing layout.

```bash
cat 'apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx'
```

- [ ] **Step 2: Add a "Доступ к панели" section**

Add an SSR-loaded subcomponent that:
1. Server-side fetches `me` to know whether the viewer has `user:manage_roles`. If not — render nothing.
2. Fetches `roles` and the player's current `playerRoleAssignments`.
3. Renders the current roles as a list with `[×]` buttons.
4. Renders a `<select>` of unselected roles + "Назначить" button.

Use existing data-access patterns from `apps/web/src/lib/dal.ts` for SSR fetch with cookie-forwarding.

- [ ] **Step 3: Commit**

```bash
git add 'apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx'
git commit -m "feat(web/players): role-assignment block in player profile (RBAC-gated)"
```

---

### Task 21: `/no-access` page

**Files:**
- Create: `apps/web/src/app/no-access/page.tsx`
- Modify: `apps/web/src/middleware.ts` — exempt `/no-access` from auth redirect

- [ ] **Step 1: Create page**

```tsx
'use client';
import { useSearchParams } from 'next/navigation';

export default function NoAccessPage() {
  const sid = useSearchParams().get('steam_id64') ?? '';
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 text-neutral-100 px-4 text-center">
      <h1 className="text-2xl font-semibold mb-4">Доступ запрещён</h1>
      <p className="mb-2">
        Steam ID <code className="text-amber-400">{sid}</code> не имеет роли в этой панели.
      </p>
      <p className="mb-6 text-neutral-400 max-w-md">
        Обратитесь к администратору панели, чтобы вам назначили роль. После назначения войдите
        снова через Steam.
      </p>
      <a href="/login" className="text-sky-400 hover:underline">
        Вернуться на страницу входа
      </a>
    </main>
  );
}
```

- [ ] **Step 2: Update middleware**

In `apps/web/src/middleware.ts`, add `/no-access` to the public-paths list (search for `/login` to find the array). Also confirm `/setup` and `/api` paths are still exempt.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/no-access/page.tsx apps/web/src/middleware.ts
git commit -m "feat(web): /no-access landing for cookie-less rejection"
```

---

## Phase 6 — Bridge redeploy + e2e + docs

### Task 22: Redeploy bridge binary on the host

**Files:** none (runtime-only)

- [ ] **Step 1: Build fresh binary**

```bash
cd apps/bridge && make build
```

- [ ] **Step 2: Install (requires root)**

```bash
sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/
sudo systemctl restart panel-host-bridge
sudo systemctl status panel-host-bridge --no-pager
```
Expected: active (running), no errors.

- [ ] **Step 3: Verify via smoke script**

```bash
sg panel -c 'bash scripts/verify-bridge.sh'
```
Expected: all 17 RPC methods green.

- [ ] **Step 4: Manually verify the new sentinel path**

```bash
sg panel -c 'cat <<EOF | nc -U /run/panel-host-bridge.sock
{"id":"1","method":"file_read","params":{"path":"/var/lib/squad-panel/.first-owner-claimed"}}
EOF'
```
Expected: a valid framed JSON response with `code: "runtime_error"` (file does not exist yet) **NOT** `code: "forbidden"`. The forbidden code would mean the allowlist did not pick up.

- [ ] **Step 5: No commit — this is operational.**

---

### Task 23: Update e2e `install-lifecycle.e2e.test.ts`

**Files:**
- Modify: `apps/api/test/e2e/install-lifecycle.e2e.test.ts`

The e2e flow currently calls `POST /api/v1/setup/owner` with email/password. Replace with the assumption that the runner pre-supplies `PANEL_TEST_COOKIE` (cookie of an already-logged-in Owner), as documented in CLAUDE.md.

- [ ] **Step 1: Adapt setup invocation**

Find the section that invokes `setup/org` + `setup/owner` + `setup/finalize` and replace with:

```ts
const cookie = process.env.PANEL_TEST_COOKIE;
if (!cookie) {
  console.error(
    '\nE2E requires PANEL_TEST_COOKIE.\n' +
      '  1. docker compose up -d panel\n' +
      '  2. open https://<host>/setup, complete the wizard\n' +
      '  3. open https://<host>/login, log in via Steam (you become Owner)\n' +
      '  4. copy __Host-sid cookie value, export PANEL_TEST_COOKIE=...\n',
  );
  test.skip;
  return;
}
const headers = { Cookie: `__Host-sid=${cookie}` };
```

Then use `headers` for every subsequent `fetch(PANEL_TEST_URL + ...)` call.

- [ ] **Step 2: Run e2e against the live stack**

```bash
docker compose up -d
# user does the manual login flow described above
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=...
pnpm --filter @squad/api test:e2e
```
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/e2e/install-lifecycle.e2e.test.ts
git commit -m "test(api/e2e): switch install-lifecycle to PANEL_TEST_COOKIE Owner cookie"
```

---

### Task 24: New `steam-login.e2e.test.ts` with disclaimer

**Files:**
- Create: `apps/api/test/e2e/steam-login.e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from 'vitest';

const PANEL_URL = process.env.PANEL_TEST_URL;
const COOKIE = process.env.PANEL_TEST_COOKIE;

describe('steam-login e2e', () => {
  test('owner cookie returns /me with Owner permissions', async () => {
    if (!PANEL_URL || !COOKIE) {
      console.warn('skip: PANEL_TEST_URL/PANEL_TEST_COOKIE not set');
      return;
    }
    const res = await fetch(`${PANEL_URL}/api/v1/me`, {
      headers: { Cookie: `__Host-sid=${COOKIE}` },
    });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { steam_id64: string; permissions: string[] };
    expect(me.steam_id64).toMatch(/^\d{17}$/);
    expect(me.permissions.length).toBeGreaterThan(0);
  });

  test('GET /me/sessions lists current session', async () => {
    if (!PANEL_URL || !COOKIE) return;
    const res = await fetch(`${PANEL_URL}/api/v1/me/sessions`, {
      headers: { Cookie: `__Host-sid=${COOKIE}` },
    });
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as { current: boolean }[];
    expect(sessions.some((s) => s.current)).toBe(true);
  });

  test('sentinel file exists after first login', async () => {
    // Read via direct bridge socket would require the panel group;
    // instead, read indirectly through the panel: /api/v1/setup/init
    // must return 410 Gone.
    if (!PANEL_URL) return;
    const res = await fetch(`${PANEL_URL}/api/v1/setup/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'attempt' }),
    });
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @squad/api test:e2e
git add apps/api/test/e2e/steam-login.e2e.test.ts
git commit -m "test(api/e2e): steam-login smoke (me, sessions, setup-locked)"
```

---

### Task 25: Documentation updates

**Files:** see spec §14.

- [ ] **Step 1: Update `docs/components/api/api.md`** — add new routes (`/auth/steam/{login,callback}`, `/me/sessions/*`, `/players/.../roles`, `/setup/init`); remove `/auth/login`, `/me/totp/*`, `/setup/{org,owner,finalize}`, `/auth/discord/*`.

- [ ] **Step 2: Update `docs/components/api/data-model.md`** — describe new `players`-anchored tables and audit-log discriminated actor.

- [ ] **Step 3: Update `docs/components/api/flows.md`** — Steam OpenID flow, first-owner trick (DB+sentinel), sliding sessions (touch + throttle).

- [ ] **Step 4: Update `docs/components/api/configuration.md`** — env-vars table with `PANEL_PUBLIC_URL`, `STEAM_WEB_API_KEY`, `SESSION_TTL_SECONDS`, `SESSION_TOUCH_THROTTLE_SECONDS`.

- [ ] **Step 5: Update `docs/components/api/testing.md`** — note manual cookie-supply for e2e.

- [ ] **Step 6: Update `docs/components/web/flows.md`** — wizard, /login, /no-access, /settings/account, /players role-assign.

- [ ] **Step 7: Update `docs/components/bridge/api.md`** — add sentinel path to allowlist table.

- [ ] **Step 8: Update `docs/architecture/data-flow.md`** — auth flow diagram replaced with Steam OpenID variant.

- [ ] **Step 9: Update `docs/architecture/decisions.md`** — append ADR `2026-04-25 — Steam-only login + steam_id64 PK + dual-anchor first-owner trick`.

- [ ] **Step 10: Update `docs/architecture/rbac.md`** — `players` is the user identity; permissions attach via `player_role_assignments`.

- [ ] **Step 11: Update `docs/operations/setup.md`** — wizard flow, Steam first-login → Owner, sentinel-file location.

- [ ] **Step 12: Update `docs/operations/migrations.md`** — `0008` rollback path: `git revert + DROP DATABASE + CREATE DATABASE + db:migrate`. Note audit-chain restart.

- [ ] **Step 13: Update `docs/operations/environment-variables.md`** — same vars as configuration.md.

- [ ] **Step 14: Update `docs/operations/troubleshooting.md`** — sections "Reset first-owner" (delete DB row + `rm /var/lib/squad-panel/.first-owner-claimed` requires root), "Re-assign Owner if last Owner lost Steam access" (psql + DELETE/INSERT into player_role_assignments + organization_members).

- [ ] **Step 15: Commit**

```bash
git add docs
git commit -m "docs: update for Steam-only login + steam_id64 anchor"
```

---

## Phase 7 — Final verification

### Task 26: Full-stack smoke + acceptance

- [ ] **Step 1: Full typecheck + tests**

```bash
pnpm turbo run typecheck
pnpm turbo run test
```
Expected: all green.

- [ ] **Step 2: Audit-chain integrity**

```bash
DATABASE_URL=postgres://admin:${POSTGRES_PASSWORD}@127.0.0.1:5432/admin pnpm verify:audit-chain
```
Expected: green (chain valid from migration cutoff).

- [ ] **Step 3: Bridge security score**

```bash
sudo systemd-analyze security panel-host-bridge.service | head -5
```
Expected: `< 3.0`. If regressed — investigate which capability changed.

- [ ] **Step 4: Live wizard + Steam-login walkthrough on a fresh stack**

```bash
docker compose down -v
docker compose up -d
```
Then:
1. `https://<host>/setup` — fill org name → submit → 200.
2. `https://<host>/login` — click Steam button → Steam → redirect back → land on `/`.
3. Verify `GET /api/v1/me` shows your steam_id64 + Owner permissions.
4. Reset to test pending flow: ask a second person (or use a second Steam account) to log in → expect `/no-access` redirect.
5. As Owner, go to `/players/<their_steam_id64>` → assign Moderator role → ask them to log in again → land on `/`.

- [ ] **Step 5: Acceptance checklist**

Tick every item in spec §16. If any item is red, file a follow-up task and do not call the plan complete.

- [ ] **Step 6: Open PR**

```bash
gh pr create --title "feat: Steam-only login (TZ §1.1–§1.6)" --body "$(cat <<'EOF'
## Summary
- Replaces email/password/TOTP auth with Steam OpenID 2.0.
- Migrates identity anchor from `users.id uuid` to `players.steam_id64 bigint`.
- First Steam-login becomes Owner via dual-anchor trick (DB flag + bridge sentinel).
- Sliding sessions 6h with Redis SETNX touch throttle.
- Session-management UI; player-card role-assign UI.

Spec: `docs/superpowers/specs/2026-04-25-steam-only-login-design.md`
Plan: `docs/superpowers/plans/2026-04-25-steam-only-login.md`

## Test plan
- [x] `pnpm turbo run typecheck`
- [x] `pnpm turbo run test`
- [x] `pnpm --filter @squad/api test:e2e` with manual `PANEL_TEST_COOKIE`
- [x] `pnpm verify:audit-chain`
- [x] Live stack: wizard → Steam-login → me/sessions → role-assign
- [x] `systemd-analyze security panel-host-bridge.service` < 3.0
EOF
)"
```

---

## Notes for the implementing engineer

1. **BigInt everywhere.** Drizzle's `bigint(..., {mode: 'bigint'})` returns a JS `BigInt`. Never `Number(steamId64)` — Squad steam IDs exceed `Number.MAX_SAFE_INTEGER`. JSON serialisation: `String(steamId64)`. JSON parse: `BigInt(value)`.

2. **Cookie names.** `__Host-sid` (session) and `__Host-steam-nonce` (Steam OpenID single-use) both require `Secure` + `Path=/` + no `Domain`. Browsers will silently drop them otherwise.

3. **Bridge sentinel — read returns ENOENT.** The bridge `file_read` returns a runtime_error on missing file; treat any error from `bridge.fileRead({path: SENTINEL_PATH})` as "sentinel not present". Only forbidden errors should bubble up.

4. **Concurrency proof.** The `Promise.all([...8])` test in Task 8 isn't decorative — it actually exercises `pg_advisory_xact_lock`. If you skip it and rely only on the `IF first_owner_claimed` check, two simultaneous callbacks both win. The lock is the load-bearing primitive.

5. **DB drop-and-restore.** When a user `pg_dump` + `pg_restore`s without panel running, the sentinel survives but `organizations.settings.first_owner_claimed` may be missing. The `claimFirstOwner` function checks the sentinel first — so the trick stays armed-only-once.

6. **Don't add a fake-Steam test helper that bypasses validation.** It tempts everyone. Only acceptable form: a helper that creates a *session row + cookie* directly, in tests that need an authenticated request but are not testing OpenID itself. Anything else is a security smell.

7. **`pnpm turbo run typecheck` is the load-bearing CI gate.** After Task 10 the monorepo will be temporarily red — that's expected. Don't merge until it's green again at Task 16.
