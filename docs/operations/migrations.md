# Migrations

Drizzle ORM manages the schema via forward-only SQL migrations. The migration runner is `packages/db/src/migrate.ts`; it is executed automatically by the `migrator` compose service before `api` starts.

## Key files

| Path | Purpose |
|---|---|
| `packages/db/drizzle/` | SQL migration files (`NNNN_slug.sql`). |
| `packages/db/drizzle/meta/_journal.json` | Drizzle journal — records applied migration order. **Do not edit by hand.** |
| `packages/db/src/migrate.ts` | Thin runner: connects via `DATABASE_URL`, calls `drizzle-orm/postgres-js/migrator`, exits. |
| `packages/db/src/schema/` | TypeScript schema files consumed by Drizzle `generate`. |

## Forward-only policy

All migrations are **forward-only**. There is no `down` migration path.

- **Pre-launch**: destructive DDL (DROP TABLE, ALTER COLUMN DROP NOT NULL) is acceptable because no production data exists.
- **Post-launch**: every migration must preserve existing data. Add columns with defaults, create new tables, never drop columns in use by running code.

If a migration shipped to production must be reverted, the path is:
1. Write a new migration that undoes the structural change at the SQL level.
2. Deploy the new migration alongside reverted application code.

## Current migrations

| # | Tag | Summary |
|---|---|---|
| 0000 | `0000_init` | Full Phase 0 schema: users (later dropped), sessions, servers, events (partitioned), audit_log (hash-chain trigger), config_versions, RCON credentials. |
| 0001 | `0001_seed_system_roles` | Reserved slot. System roles are seeded in migration 0009 instead, after the RBAC redesign. No-op DDL. |
| 0002 | `0002_server_runtime` | Adds `servers.runtime = 'container'` (CHECK constraint) and `servers.container_id`. Locks out the removed systemd-unit path. |
| 0003 | `0003_config_versions` | Adds `config_versions` table (append-only) with `server_id`, `filename`, `content`, `sha256`, `author_steam_id64`, `commit_message`. DB trigger rejects direct UPDATE/DELETE. |
| 0004 | `0004_config_versions_cascade` | Fixes trigger so FK cascades from `servers` (DELETE /servers/:id) are not blocked by the append-only guard. Uses `pg_trigger_depth() = 0` gate. |
| 0005 | `0005_backfill_config_role_perms` | Idempotent backfill: inserts `server:config:write` and `server:config:history` permissions for the four pre-existing system roles on all orgs. Fixes 403 on the Monaco config editor. |
| 0006 | `0006_rcon_host_bridge_network` | Migrates stored `rcon_host` from `127.0.0.1` to `host.docker.internal` for the bridge-network-aware api container. Immediately superseded by 0007. |
| 0007 | `0007_rcon_host_null_default` | Reverts 0006: makes `rcon_host` nullable (NULL = fall back to `RCON_HOST_DEFAULT` env var). Each service resolves the right alias independently. |
| 0008 | `0008_steam_only_auth` | Destructive. Drops `users`, TOTP, email/password. Adds `players` table keyed on `steam_id64 bigint`. Pivots sessions and audit_log to Steam identity. |
| 0009 | `0009_panel_rbac` | Destructive. Drops `organizations`, `organization_members`, `player_role_assignments`, `role_server_scopes`. Adds `players.role_id`, `roles.color` (CHECK palette), `panel_meta` singleton. Seeds five system roles (Owner, Senior Admin, Admin, Moderator, Viewer) with full permission sets. |
| 0010 | `0010_drop_servers_org_id` | Drops `servers.org_id` and its composite indexes, adds single-column replacements. Completes the multi-tenancy removal started in 0009. |
| 0011 | `0011_servers_is_canary` | Carry-forward: ensures `servers.is_canary boolean DEFAULT false` exists (originally added on a parallel branch). `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — safe on both fresh and existing DBs. |
| 0012 | `0012_host_manage_permission` | Inserts `host:manage` permission for Owner and Senior Admin roles (`ON CONFLICT DO NOTHING`). |
| 0013 | `0013_servers_soft_delete` | Adds `servers.deleted_at`, `servers.deleted_by_steam_id64`, `servers.deletion_backup_marker_id`, partial unique index on `slug` WHERE `deleted_at IS NULL`. |
| 0017 | `0017_diagnostic_events` | Adds `diagnostic_events` table — range-partitioned by `ts` (one partition per UTC day), composite PK `(id, ts)`, severity check, FK → `servers.id` ON DELETE SET NULL. Bootstraps 25 day-partitions. Mutable; pruned to 24h by `worker-event-partition`. |
| 0018 | `0018_diagnostic_events_utc_invariant` | No-op (`SELECT 1`). Documents the UTC-bounds invariant for `diagnostic_events` partitions: production Postgres MUST run with `TimeZone = 'UTC'`. The worker derives partition names/bounds in UTC via `Date.toISOString()`; `0017`'s bootstrap loop used session-TZ-dependent `current_date` and could clash with the worker on non-UTC deployments. Non-UTC bootstrap partitions naturally age out within 24h via the worker's drop-stale sweep. |

## Adding a migration

1. Edit the relevant schema TS file under `packages/db/src/schema/`.
2. Run `pnpm db:generate`. Drizzle creates `packages/db/drizzle/NNNN_slug.sql` and updates `_journal.json`.
3. **Inspect the generated SQL.** Drizzle cannot generate: audit triggers, `pg_trigger_depth()` guards, monthly partition DDL, `ON CONFLICT` clauses, advisory locks. Add hand-written DDL inside the generated file where needed.
4. Apply locally: `DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate`.
5. Stage both the schema change and the migration file in the same commit.

Naming convention: `NNNN_short_descriptive_slug.sql` (lowercase, underscores). The `NNNN` prefix is assigned by Drizzle from the journal sequence — never renumber existing files.

## Applying migrations manually

```bash
# Inside compose (migrator service):
docker compose run --rm migrator

# From host (requires Postgres port 5432 exposed on 127.0.0.1):
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

## Full DB reset (dev / staging only)

**Destroys all data.** Used after destructive forward-only migrations or for a clean dev environment.

```bash
docker compose stop api web caddy worker-rcon worker-log-ingest \
                    worker-event-partition worker-audit-archiver worker-metrics-sampler
docker compose exec -T postgres psql -U admin postgres -c 'DROP DATABASE IF EXISTS admin; CREATE DATABASE admin;'
docker compose exec -T redis redis-cli FLUSHALL
docker compose run --rm migrator
docker compose up -d
# Optional cleanup (no longer required, kept for hygiene):
sudo rm -f /var/lib/squad-panel/.first-owner-claimed
```

**Sentinel file behavior (2026-04-25 onward).** The host file `/var/lib/squad-panel/.first-owner-claimed` is **informational only** — `claimFirstOwner` does not consult it when deciding whether the trick should fire. The DB (`panel_meta.first_owner_claimed`) is the single source of truth, so a stale sentinel from a previous installation no longer wedges the claim path. The next successful Steam login overwrites the sentinel with the new Owner's metadata.

Removing the sentinel before a fresh login is therefore optional but recommended for ops cleanliness. Code from before this fix DID short-circuit on the sentinel — see `docs/components/rbac/troubleshooting.md` "Wedge after reinstall" for the migration story and a manual-recovery SQL block.

## Audit chain integrity

The `audit_log` table is hash-chained. Verify the chain after any DB restore or migration:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain
```

Script: `scripts/verify-audit-chain.ts`. Exits non-zero on the first broken link with the offending row `id`.

## See also

- [`docs/components/db/README.md`](../components/db/README.md) — schema overview and table descriptions.
- [`docs/architecture/data-flow.md`](../architecture/data-flow.md) — how data flows through the system.
- [`docs/operations/deployment.md`](./deployment.md) — how the migrator service runs in compose.
