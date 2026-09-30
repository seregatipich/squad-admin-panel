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
- **Two-phase removal.** `scripts/rollback-stand.sh` and redeploying an older SHA never undo migrations, so every migration must work with the release before it. Dropping a column or table takes two releases: the first stops reading and writing it (removes it from the Drizzle schema, which otherwise names every column in `SELECT`s), the next one drops it. Keep data you may still need: archive a table before dropping it.
- **Known exception: 0115.** `0115_remove_bss_integration` dropped `players.role_lifecycle_event_id`, `panel_meta.vip_lifecycle_strict` and `vip_lifecycle_events` in the same release that removed them from the schema (commit `10134844`). No release before `10134844` can run against a database that applied 0115, and the `vip_lifecycle_events` history survives only in the `pg_dump` taken before it (issue #50; see "Интеграция bss.games удалена" in [deployment.md](./deployment.md)).

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
| 0019 | `0019_license_id` | Adds nullable `server_credentials.license_id` for encrypted license-key management. |
| 0116 | `0116_events_appended_notify` | Adds `events_notify_appended()` and the AFTER INSERT row trigger `trg_events_notify_appended` on `events` (cloned onto every partition): `pg_notify('events_appended', {server_id, kind})`. The API LISTENs to push `server.events.appended` to open event lists. Additive, rollback-safe. |
| 0117 | `0117_monthly_partition_defaults` | Issue #6: adds DEFAULT partitions `chat_messages_default` and `bonus_transactions_default`, and creates the current UTC month and three months ahead for `chat_messages`, `bonus_transactions` and `combat_events` (each missing month is built with `LIKE`, receives the DEFAULT partition's rows for its range, then is attached). `worker-event-partition` keeps rotating them from then on. Additive, rollback-safe. |
| 0118 | `0118_clan_members_release_disbanded` | Data-only: deletes `clan_members` rows of soft-deleted (disbanded) clans, which blocked those players from joining any other clan through the global `clan_members_player_unique_idx` (#14). Disband now removes the roster itself. No schema change, rollback-safe. |
| 0119 | `0119_message_templates_seed_once` | Issue #36: seeds the built-in message templates once (`ON CONFLICT (id) DO NOTHING`); the API no longer re-seeds on read, so a deleted template stays deleted. Data only, rollback-safe (the previous release still re-seeds on read). |
| 0120 | `0120_automation_kick_default_reason` | Issue #53: backfills a reason on `kick` automation rules saved with the old empty default, which worker-rcon refuses. Data only, rollback-safe. |
| 0121 | `0121_role_can_manage_infrastructure` | Issue #36: adds `roles.can_manage_infrastructure boolean NOT NULL DEFAULT false` and grants it to Owner, the seeded Admin and every role that can edit roles. The previous release ignores the column. |
| 0122 | `0122_role_permissions_legacy_wipe` | Issue #36: deletes the legacy explicit grants in `role_permissions`. Data only; the previous release finds no extra grants, i.e. a stricter permission set. Runs after 0121 because `rbac.ts` now gates explicit rows by the flags. |
| 0123 | `0123_whitelist_application_verified` | Issue #52: adds `whitelist_applications.verified` (default false) and splits the one-pending-per-SteamID unique index into a verified and an unverified partial index. The previous release's inserts get `verified = false` and still hit the unverified index on a duplicate. |
| 0124 | `0124_seasons_start_day_unique` | Issues #84/#576: unique index on the UTC start day of `seasons`. Additive. |
| 0125 | `0125_clan_tags_normalized_uniqueness` | Issue #1088: `clans_normalize_tag()` and `clans_enforce_unique_tags()` compare normalised clan tags under a transaction advisory lock. Function bodies only, rollback-safe. |
| 0126 | `0126_player_search_and_report_indexes` | Issues #40, #71, #117: trigram GIN indexes on `players.canonical_name_normalized` and `player_name_history.name_normalized`; `player_reports` indexes on `created_at`, `(reporter_player_id, created_at)` and `handler_player_id`. Indexes only. |
| 0127 | `0127_events_indexes` | Issues #39, #1324: `events (occurred_at DESC, event_id DESC)`, the `payload->>'rule_id'` partial index and the seeding-kind partial index. Indexes only. |
| 0128 | `0128_list_query_indexes` | Issues #44, #52, #68: indexes for the chat flag reindex and rule cleanup, closed player sessions, balancer proposals, active external bans and `processed_events (processed_at)`; drops the unused `processed_events_group_idx`. |
| 0129 | `0129_vip_subscription_renewal_lead` | Issue #364: moves `next_renewal_at` of active VIP subscriptions to `VIP_RENEWAL_LEAD` before their role expires. Data only. |
| 0130 | `0130_media_publication_upload_session` | Adds nullable `media_publications.upload_session_url` so a retried YouTube upload resumes its session. Add-only. |
| 0131 | `0131_combat_events_match_uuid` | Issue #50: `combat_events.match_uuid` (FK to `matches.id` ON DELETE SET NULL, partial index). The bigint `match_id` stays for the previous release and is dropped later. |
| 0132 | `0132_events_notify_per_statement` | Issues #1089, #1327: replaces the row trigger `trg_events_notify_appended` with a statement trigger over a transition table, announcing each distinct `(server_id, kind)` once. Channel and payload unchanged. |
| 0133 | `0133_schema_integrity_hardening` | Issue #77: `audit_log`/`config_versions` actor and author FKs become NO ACTION (SET NULL was unreachable behind the append-only triggers); `config_versions.parent_version_id` gets its FK back (NOT VALID, validated when no orphans exist); seven redundant indexes are dropped; partial indexes back the scheduler's pending-entry reads. |
| 0134 | `0134_appeal_token_hash_and_api_token_index` | Issues #78, #1084: unique index on `player_api_tokens.token_hash`; `ban_appeals.tracking_token_hash` (sha256 hex, NOT NULL, unique) backfilled from and replacing the plaintext `tracking_token`, which stays as a nullable legacy column while a BEFORE INSERT/UPDATE trigger hashes and clears any plaintext the previous release writes. Rollback-safe except that the previous release's appeal status page cannot find tokens (it looks up plaintext) until the next roll forward. |
| 0135 | `0135_audit_log_chain_v2` | Issues #36, #49, #1064, #1066, #1067, #1251: the single definition of `audit_log_append()`: id drawn after the chain lock (the column default is dropped), TimeZone pinned to UTC, `hash_version` (default 1) and the v2 all-column length-prefixed hash form; BEFORE TRUNCATE triggers on `audit_log` and `config_versions`. Additive; the previous release's verifier reports v2 rows as broken, writes are unaffected. |
| 0136 | `0136_index_cleanup_balancer_open_key` | Issue #78: drops seven indexes no query reads; partial unique index `balancer_proposals_open_key` (one open snapshot per `(server_id, mode)`). Rollback-safe: indexes only. |
| 0137 | `0137_player_notes_author_set_null` | Issues #78, #1137: `player_notes.author_id` becomes nullable and its FK `ON DELETE SET NULL` (was `CASCADE`), so deleting an author keeps their notes. Rollback-safe: a constraint is relaxed, no data changes; the previous release's inner joins skip a note without an author. |

| 0137 | `0137_combat_events_match_uuid_backfill` | Issue #50 (#1073): backfills `combat_events.match_uuid` for events stored before 0131, resolving the match like log-ingest (the match of the same server covering `occurred_at`). Touches only rows still NULL inside a known match, idempotent, rollback-safe (the previous release never names the column). |
| 0020 | `0020_uuid_player_id` | Data-preserving identity migration: gives `players` a UUID primary key, keeps `steam_id64` as a nullable unique external identity, migrates all child FKs to UUID player IDs, and adds setup-wizard metadata. |

## Adding a migration

Migrations are **hand-written**. `drizzle-kit generate` cannot be used: the only snapshot it could diff against was from migration 0008, and it numbers files by journal index, which no longer matches the file numbers. `pnpm db:generate` therefore fails on purpose.

1. Edit the relevant schema TS file under `packages/db/src/schema/` so the Drizzle schema matches the database after the migration.
2. Write `packages/db/drizzle/NNNN_short_descriptive_slug.sql` (next free number, lowercase, underscores) with an opening ticket comment. Separate statements with `--> statement-breakpoint` and keep them idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` before `ADD`).
3. Append the entry to `packages/db/drizzle/meta/_journal.json`: next `idx`, `"version": "7"`, a `when` later than the previous entry's, the file name without `.sql` as `tag`, `"breakpoints": true`.
4. Apply locally: `DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate`, and cover the change with a test under `packages/db/test/`.
5. Stage both the schema change and the migration file in the same commit.

Never renumber or edit an applied migration file — not even a comment.

### Writing a migration

`bash scripts/test-migration-lint.sh` (run in CI) enforces the first two rules:

- **No `BEGIN;` / `COMMIT;`.** `drizzle-orm`'s `migrate()` runs every pending migration in one transaction. An explicit `COMMIT` ends it early, and every later migration then runs in autocommit, so a failure half-way leaves a partially applied schema and no journal row. Migrations 0008–0020 predate this rule and are grandfathered.
- **CHECK constraints on large partitioned tables are added `NOT VALID`** (`events`, `chat_messages`, `combat_events`, `diagnostic_events`, `bonus_transactions`, `player_sessions`), followed by `VALIDATE CONSTRAINT` in its own statement. A plain `ADD CONSTRAINT … CHECK` scans every partition under an ACCESS EXCLUSIVE lock that is held until the migration transaction commits; `VALIDATE` only takes SHARE UPDATE EXCLUSIVE. The same applies to foreign keys on large tables.
- **Indexes on large partitioned tables** are built per partition: `CREATE INDEX … ON ONLY parent`, one index per partition, then `ALTER INDEX … ATTACH PARTITION`.
- **Stay compatible with the previous release**, which keeps running against the new schema after a rollback: add first, drop what it still reads only in a later release.

### Hand-written constraint DDL

Some cross-row invariants can only be enforced by triggers, which Drizzle does not generate from the schema TS. Where a feature needs them, the trigger/function DDL lives in a committed, idempotent `.sql` file under `packages/db/sql/` and must be appended to that feature's generated migration in step 3 above.

| File | Enforces |
|---|---|
| `packages/db/sql/clans-constraints.sql` | `clans` / `clan_members` invariants: a tag is globally unique across active clans, a clan has exactly one leader once it has members, priority members never exceed `max_priority_slots`, and `max_priority_slots` cannot be lowered below the current priority count. |

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

The chain alone cannot show that rows were cut off its tail or that it was regenerated as a whole by someone with write access to the table. Anchor its head outside the database (issue #50, #1064):

```bash
# After a verified run, record the printed `head: <id>:<row_hash>` line in an ops log
# or password-manager note, not on the database host:
AUDIT_CHAIN_PRINT_HEAD=1 pnpm verify:audit-chain
# Later runs (and every restore) check that the anchored row still exists unchanged:
AUDIT_CHAIN_ANCHOR=<id>:<row_hash> pnpm verify:audit-chain
```

`GET /api/v1/audit/verify-chain` returns the same `head` and accepts `anchor_id` + `anchor_hash`; a missing or changed anchored row is reported as `reason: "anchor"`. Refresh the recorded anchor after each verified run (for example weekly); rows appended since the anchor do not affect it.

## See also

- [`docs/components/db/README.md`](../components/db/README.md) — schema overview and table descriptions.
- [`docs/architecture/data-flow.md`](../architecture/data-flow.md) — how data flows through the system.
- [`docs/operations/deployment.md`](./deployment.md) — how the migrator service runs in compose.
