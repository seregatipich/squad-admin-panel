# `db` — Flows

---

## Migration flow

### Actors

- Developer or CI running `pnpm db:migrate` on a host that can reach Postgres.
- `apps/api` Dockerfile (runs migrations on container startup via the `migrate` script in `package.json`).

### How it works

1. `pnpm db:migrate` executes `packages/db/src/migrate.ts` via `tsx`.
2. The script reads `DATABASE_URL` from the environment and exits with an error if it is absent.
3. A single-connection Drizzle client (`max: 1`) is created; `prepare: false` is not set here because only DDL/DML is executed (no prepared queries).
4. `drizzle-orm/postgres-js/migrator` is called with `{ migrationsFolder: './drizzle' }`. Drizzle reads `packages/db/drizzle/meta/_journal.json` to discover which SQL files exist, compares the `idx` sequence against the `__drizzle_migrations` table in the target database, and executes only the unapplied files in order.
5. Each SQL file is executed as a single statement batch. Files that wrap their DDL in `BEGIN; ... COMMIT;` run as an explicit transaction. Files without a transaction wrapper rely on Postgres auto-commit per statement.
6. After all files are applied, the script closes the connection and prints `migrations applied`.

### Fresh install vs upgrade

**Fresh install** (empty database):

```
__drizzle_migrations table does not exist
→ Drizzle creates it
→ Applies 0000_init.sql through 0012_host_manage_permission.sql in order
→ All triggers, indexes, partitions, and seed data are created
```

**Upgrade** (existing database):

```
__drizzle_migrations contains entries up to 0010_drop_servers_org_id
→ Drizzle skips 0000–0010
→ Applies 0011_servers_is_canary.sql, then 0012_host_manage_permission.sql
→ Connection closed
```

### Transaction boundaries

| Migration | Wraps in `BEGIN/COMMIT`? | Notes |
|---|---|---|
| 0000–0007 | No | Individual statements auto-committed |
| 0008 | Yes | Destructive drop-and-recreate; rolls back atomically if any step fails |
| 0009 | Yes | RBAC pivot; roles/permissions seeded atomically |
| 0010 | Yes | Column drop and index recreation |
| 0011 | Yes | `IF NOT EXISTS` no-op guard |
| 0012 | Yes | `ON CONFLICT DO NOTHING` permission insert |

### Idempotency

- `IF NOT EXISTS` guards on `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ADD COLUMN` make individual statements safe to re-run manually.
- Drizzle's `__drizzle_migrations` journal prevents re-execution of already-applied files.
- `ON CONFLICT DO NOTHING` in migrations 0005 and 0012 prevents duplicate permission rows.

---

## Query flow

### Connection lifecycle

`apps/api` creates one `DatabaseClient` at startup via `createDatabaseClient(process.env.DATABASE_URL!)` and decorates the Fastify instance with it as `app.db`. All route handlers and service functions receive this shared client. The pool settings (`max: 16`, `idle_timeout: 30`, `connect_timeout: 10`) are hard-coded in `packages/db/src/client.ts`.

Workers that need database access (`worker-audit-archiver`, `worker-event-partition`) create their own client using the same `createDatabaseClient` factory.

### Typical select pattern

```ts
import { servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';

const server = await app.db.query.servers.findFirst({
  where: eq(servers.id, req.params.id),
});
if (!server) return reply.code(404).send({ error: 'server not found' });
```

### Typical insert pattern

```ts
import { auditLog } from '@squad/db/schema';

await app.db.insert(auditLog).values({
  actorKind: 'steam',
  actorSteamId64: session.steamId64,
  actorIp: req.ip,
  actionType: 'server.start',
  targetType: 'server',
  targetId: server.id,
  afterSnapshot: { status: 'starting' },
  context: {},
  statusCode: 200,
  durationMs: timer(),
});
```

### Transaction pattern

```ts
await app.db.transaction(async (tx) => {
  const [serverRow] = await tx.insert(servers).values(newServer).returning();
  await tx.insert(serverSettings).values({ serverId: serverRow.id, ...settings });
  await tx.insert(serverCredentials).values({ serverId: serverRow.id, ...creds });
});
```

If any statement inside the callback throws, Drizzle rolls back the transaction automatically.

### Upsert pattern (player history tables)

```ts
import { playerNameHistory } from '@squad/db/schema';
import { sql } from 'drizzle-orm';

await app.db
  .insert(playerNameHistory)
  .values({ steamId64, name, nameNormalized, firstSeenAt: now, lastSeenAt: now })
  .onConflictDoUpdate({
    target: [playerNameHistory.steamId64, playerNameHistory.nameNormalized],
    set: {
      lastSeenAt: sql`excluded.last_seen_at`,
      observationCount: sql`player_name_history.observation_count + 1`,
    },
  });
```

---

## Audit chain insertion

### Trigger execution path

1. Application code calls `db.insert(auditLog).values({ actorKind, actorSteamId64, actionType, ... })`.
2. Postgres fires `trg_audit_log_ins` (BEFORE INSERT, FOR EACH ROW) which executes `audit_log_append()`.
3. `audit_log_append()` acquires a transaction-scoped advisory lock with key `hashtextextended('audit_log', 0)`. This serializes concurrent inserts so the hash chain is linear.
4. It reads the current maximum `row_hash` with `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`.
5. It sets `NEW.prev_hash` to the value just read (NULL if this is the first row).
6. It computes `NEW.row_hash` as:
   ```sql
   digest(
     COALESCE(prev, ''::bytea) ||
     convert_to(
       action_type || '|' || COALESCE(target_type,'') || '|' || COALESCE(target_id,'')
       || '|' || context::text || '|' || created_at::text,
       'UTF8'
     ),
     'sha256'
   )
   ```
7. The modified `NEW` row is inserted.
8. Any attempt to UPDATE or DELETE a row instead fires `audit_log_deny()` which raises `audit_log is append-only`.

### Why actor fields are excluded from the hash

The hash covers action semantics (`action_type`, `target_type`, `target_id`, `context`, `created_at`). Actor identity columns (`actor_steam_id64`, `actor_ip`, etc.) can be set to NULL by FK cascades when a player row is deleted — that would break the chain after a legitimate delete. Excluding actor fields from the hash means player deletions do not invalidate historical audit entries.

### Verifying the chain

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain
```

`scripts/verify-audit-chain.ts` walks every row in `id` order, recomputes the expected hash from the same canonical form, and exits 1 on the first mismatch with the offending `id` printed. Exit 0 means the chain is intact.

### `config_versions` append-only guard

`config_versions` uses a similar trigger pair (`trg_config_versions_no_upd`, `trg_config_versions_no_del`) but without a hash chain — the append-only property is a data-integrity guarantee, not a cryptographic one. The delete trigger uses `WHEN (pg_trigger_depth() = 0)` so that `ON DELETE CASCADE` from a parent `servers` row can clean up orphan version rows when a server is deleted, while direct client DELETEs are still rejected.
