# `db` — Troubleshooting

---

## Migration fails with a foreign-key violation

**Symptom:** `pnpm db:migrate` exits with an error similar to:

```
ERROR: update or delete on table "organizations" violates foreign key constraint
  "audit_log_org_id_fkey" on table "audit_log"
```

**Cause:** A migration drops a parent table before dropping the FK column on the child table. Migration 0009 handles this correctly by dropping `audit_log.org_id` before dropping `organizations`, but re-running an earlier migration sequence against an out-of-order database can reproduce this.

**Fix:**

1. If you have prod data: manually drop the FK column first, then re-run the migration.
2. If pre-launch: `docker compose down -v && docker compose up -d postgres` then `pnpm db:migrate` from scratch.

**Diagnosis commands:**

```sql
-- Find FK constraints on a table
SELECT conname, conrelid::regclass, confrelid::regclass
FROM pg_constraint
WHERE confrelid = 'organizations'::regclass AND contype = 'f';
```

---

## Tests fail with `EAI_AGAIN postgres` or `ENOTFOUND postgres`

**Symptom:** Integration tests hang or fail immediately with a DNS resolution error for hostname `postgres`.

**Cause:** The `postgres` hostname is the Docker Compose service name. It only resolves inside the Docker Compose network. Tests running on the host cannot use that hostname.

**Fix:** Set `DATABASE_URL` to use `127.0.0.1`:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/api test
```

Verify the port is published:

```bash
docker compose ps postgres
# Should show 0.0.0.0:5432->5432/tcp
```

---

## `__drizzle_migrations` gap — migration file present but not applied

**Symptom:** A migration file exists (e.g. `0011_servers_is_canary.sql`) but `pnpm db:migrate` reports it has already been applied, yet the column is missing.

**Cause:** The migration was authored on a feature branch and applied there, but the DB on the current branch was never reset. The `__drizzle_migrations` table records a different hash for the same migration index from the other branch's file.

**Diagnosis:**

```sql
SELECT * FROM __drizzle_migrations ORDER BY created_at;
```

Compare the `hash` values against `packages/db/drizzle/meta/_journal.json`.

**Fix options:**

1. **Carry-forward migration** (preferred, non-destructive): write a new migration that adds the missing column with `IF NOT EXISTS`, as was done for `0011_servers_is_canary.sql`. This is the approach used in this project — do not reset a shared database to fix a missing column.
2. **Fresh install** (only on a dev database with no real data): `docker compose down -v && docker compose up -d postgres && pnpm db:migrate`.

---

## `audit_log is append-only` blocks a DELETE

**Symptom:** A DELETE or UPDATE on `audit_log` raises:

```
ERROR: audit_log is append-only
```

**Cause:** This is expected behavior. The `trg_audit_log_no_upd` and `trg_audit_log_no_del` triggers enforce the immutability invariant.

**When this is unexpected (e.g. in a test):** The test is likely calling `db.delete(auditLog)` directly. Tests must not delete from `audit_log`. Instead, delete the associated `players` row, which sets FK columns to NULL but does not remove the audit rows.

**If you suspect data corruption:** Run the chain verifier to distinguish a trigger-blocked mutation from actual corruption:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain
```

If the chain is intact, the append-only protection is working correctly.

---

## `panel_meta singleton CHECK fails` on INSERT

**Symptom:**

```
ERROR: new row for relation "panel_meta" violates check constraint "panel_meta_singleton"
```

**Cause:** Something attempted `INSERT INTO panel_meta (id) VALUES (2)` or similar. The table enforces `CHECK (id = 1)`.

**Diagnosis:** Check for duplicate inserts in migration scripts or application startup code:

```sql
SELECT * FROM panel_meta;
-- Should return exactly one row with id = 1
```

**Fix:** The singleton row is inserted by migration `0009_panel_rbac.sql`. If it is already present, use `UPDATE` or `INSERT ... ON CONFLICT DO NOTHING` instead of a bare `INSERT`.

---

## `config_versions is append-only` blocks server delete

**Symptom:** `DELETE /api/v1/servers/:id` returns 500 with `config_versions is append-only`.

**Cause:** The delete trigger on `config_versions` fires without the `WHEN (pg_trigger_depth() = 0)` guard (database is on migration 0003, before fix migration 0004 was applied).

**Fix:** Apply migrations up to and including 0004:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
```

**Verify the trigger condition is correct:**

```sql
SELECT tgname, tgwhen, tgenabled, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'config_versions'::regclass;
```

The delete trigger definition should contain `WHEN (pg_trigger_depth() = 0)`.

---

## Connection pool exhaustion

**Symptom:** API requests hang indefinitely or time out with `connection timeout exceeded`.

**Cause:** `createDatabaseClient` sets `max: 16`. If all 16 connections are held by long-running queries or uncommitted transactions, new requests queue indefinitely.

**Diagnosis:**

```sql
SELECT count(*), state, wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = 'admin'
GROUP BY state, wait_event_type, wait_event;
```

Look for `idle in transaction` rows — these indicate transactions that were opened but never committed or rolled back.

**Fix:**

1. Identify the offending query with `SELECT pid, query, state, now() - query_start AS duration FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = 'admin'`.
2. Terminate if safe: `SELECT pg_terminate_backend(pid)`.
3. Ensure application code always wraps mutations in `db.transaction()` and does not hold connections across slow I/O (bridge calls, RCON, etc.).

---

## Useful diagnostic queries

```sql
-- Row count per table
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

-- List applied migrations
SELECT * FROM __drizzle_migrations ORDER BY created_at;

-- Check audit chain length
SELECT count(*), min(id), max(id) FROM audit_log;

-- Find config versions for a server
SELECT filename, created_at, author_label, message
FROM config_versions
WHERE server_id = '<uuid>'
ORDER BY created_at DESC
LIMIT 20;

-- Check panel_meta state
SELECT * FROM panel_meta;
```
