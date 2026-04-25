# `db` — database schema

Postgres 16+ via Drizzle ORM 0.45. Source of truth for the operational data model. The schema lives in TypeScript ([`packages/db/src/schema/`](../../../packages/db/src/schema/)); migrations are hand-written SQL ([`packages/db/drizzle/`](../../../packages/db/drizzle/)).

## Responsibilities

- Schema definition + types (`@squad/db` re-exports inferred row types).
- Migrations runner ([`packages/db/src/migrate.ts`](../../../packages/db/src/migrate.ts)).
- System-role seed ([`packages/db/src/seed/system-roles.ts`](../../../packages/db/src/seed/system-roles.ts)).
- Drizzle Studio access (`pnpm db:studio`).

## What this component does NOT do

- It does not own any business logic.
- Drizzle's `generate` is used after schema edits, but the generated SQL is **not** authoritative — Phase 0 ships hand-written SQL (audit triggers, monthly partitions, functional indexes) that the generator can't produce. After regenerating, merge by hand and keep the triggers intact.

## Schema files

| File | Purpose |
|---|---|
| `players.ts` | One row per SteamID64. Universal identity anchor — replaces the old `users` table. |
| `sessions.ts` | Opaque session IDs, keyed on `players.steam_id64`. |
| `player-api-tokens.ts` | Programmatic API tokens, keyed on `players.steam_id64`. |
| `roles.ts` + `role-permissions.ts` + `role-server-scopes.ts` | RBAC bag-of-permissions. |
| `player-role-assignments.ts` | Player → role mapping per org (steam_id64 primary key). |
| `organizations.ts` + `organization-members.ts` | Multi-tenant scaffold (P0 ships a single org). Members keyed on steam_id64. |
| `servers.ts` | One row per managed Squad server. |
| `server-credentials.ts` | RCON password (encrypted), Squad license key (encrypted). |
| `server-settings.ts` | Per-server panel-side preferences (scheduler, discord). |
| `player-name-history.ts` | Append-only on every poll where the name changes. |
| `player-ip-history.ts` | Append-only on every connect with a new IP. |
| `config-versions.ts` | Append-only history of every cfg edit. DB trigger rejects `UPDATE`/`DELETE` (trigger uses `WHEN (pg_trigger_depth() = 0)` to allow cascade deletes from parent `servers` row). |
| `events.ts` | Partitioned monthly. Mirrors the canonical `EventEnvelope`. |
| `audit-log.ts` | Append-only, hash-chained. DB trigger rejects `UPDATE`/`DELETE` and writes `row_hash`. Actor is `actorKind: 'steam' \| 'system'` with `actorSteamId64` or `actorSystemLabel`. |

## Migrations

Apply:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

After editing a schema file:

```bash
pnpm db:generate
# review packages/db/drizzle/<n>_<name>.sql
# merge by hand if it overrides hand-written triggers
git add packages/db/drizzle/*.sql
```

## Hash chain integrity

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm verify:audit-chain
```

Walks `audit_log` in `id` order, recomputes `sha256(prev_hash || canonical_json(row))`, exits non-zero on the first break with the offending `id`.

## See also

- [`architecture/data-flow.md`](../../architecture/data-flow.md) for how data is written and read across components.
- [`architecture/security.md`](../../architecture/security.md) for how `audit_log` integrity is enforced.
