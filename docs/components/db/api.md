# `@squad/db` — Public API

The package exposes three entry points. All are consumed only by `apps/api` and the worker processes; the web app never imports from this package directly.

---

## Entry points

| Import path | Purpose |
|---|---|
| `@squad/db` | `DatabaseClient` type, `createDatabaseClient` factory, re-exports `schema` namespace |
| `@squad/db/schema` | Every Drizzle table object and its inferred TypeScript row types |
| `packages/db/src/migrate.ts` (run via `pnpm db:migrate`) | Standalone migration runner |

---

## `@squad/db`

### `createDatabaseClient(url: string): DatabaseClient`

Creates a fully typed Drizzle-ORM client backed by the `postgres` driver.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `url` | `string` | PostgreSQL connection string, e.g. `postgres://admin:pass@postgres:5432/admin` |

**Returns** a Drizzle client with the full schema attached (type `DatabaseClient`).

**Pool settings** (hard-coded, not overridable at call site):

| Setting | Value | Notes |
|---|---|---|
| `max` | `16` | Connection pool ceiling for production |
| `idle_timeout` | `30` s | Connections returned to the pool are closed after 30 s idle |
| `connect_timeout` | `10` s | Fail fast if Postgres is unreachable |
| `prepare` | `false` | Prepared statements disabled — required for PgBouncer compatibility |

**Example (apps/api bootstrap):**

```ts
import { createDatabaseClient } from '@squad/db';

const db = createDatabaseClient(process.env.DATABASE_URL!);
app.decorate('db', db);
```

**Test override** (lower pool ceiling):

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@squad/db/schema';

const sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
const db = drizzle(sql, { schema });
```

---

### `DatabaseClient` type

```ts
export type DatabaseClient = ReturnType<typeof createDatabaseClient>;
```

Used as the type of `app.db` Fastify decorator and passed into service functions so the type matches exactly.

---

### `schema` namespace re-export

`@squad/db` also re-exports the schema barrel so consumers can import table objects and types from either `@squad/db` or `@squad/db/schema`:

```ts
import { schema } from '@squad/db';
// equivalent to:
import * as schema from '@squad/db/schema';
```

---

## `@squad/db/schema`

Every Drizzle table and its associated TypeScript types. All 14 exports below are available from `@squad/db/schema`.

| Export name | Table | Row type | Insert type |
|---|---|---|---|
| `auditLog` | `audit_log` | `AuditLogRow` | `NewAuditLog` |
| `configVersions` | `config_versions` | `ConfigVersionRow` | `NewConfigVersion` |
| `events` | `events` | `EventRow` | `NewEvent` |
| `processedEvents` | `processed_events` | `ProcessedEventRow` | `NewProcessedEvent` |
| `panelMeta` | `panel_meta` | `PanelMetaRow` | — (singleton, no insert type exported) |
| `playerApiTokens` | `player_api_tokens` | `PlayerApiTokenRow` | `NewPlayerApiToken` |
| `playerIpHistory` | `player_ip_history` | `PlayerIpHistoryRow` | `NewPlayerIpHistory` |
| `playerNameHistory` | `player_name_history` | `PlayerNameHistoryRow` | `NewPlayerNameHistory` |
| `players` | `players` | `PlayerRow` | `NewPlayer` |
| `rolePermissions` | `role_permissions` | `RolePermissionRow` | `NewRolePermission` |
| `roles` | `roles` | `RoleRow` | `NewRole` |
| `serverCredentials` | `server_credentials` | `ServerCredentialsRow` | `NewServerCredentials` |
| `serverSettings` | `server_settings` | `ServerSettingsRow` | `NewServerSettings` |
| `servers` | `servers` | `ServerRow` | `NewServer` |
| `sessions` | `sessions` | `SessionRow` | `NewSession` |

### Usage examples

**Select with type inference:**

```ts
import { servers, type ServerRow } from '@squad/db/schema';
import { eq } from 'drizzle-orm';

const row: ServerRow | undefined = await db.query.servers.findFirst({
  where: eq(servers.id, serverId),
});
```

**Insert:**

```ts
import { players, type NewPlayer } from '@squad/db/schema';

const payload: NewPlayer = {
  steamId64: 76561198012345678n,
  canonicalName: 'SquadPlayer',
  canonicalNameNormalized: 'squadplayer',
};
await db.insert(players).values(payload).onConflictDoNothing();
```

**Transaction pattern:**

```ts
await db.transaction(async (tx) => {
  await tx.insert(servers).values(serverRow);
  await tx.insert(serverSettings).values(settingsRow);
  await tx.insert(serverCredentials).values(credRow);
});
```

---

## Migration runner (`pnpm db:migrate`)

Source: [`packages/db/src/migrate.ts`](../../../packages/db/src/migrate.ts)

Reads `DATABASE_URL` from the environment, opens a single-connection Drizzle client (`max: 1`), and calls `drizzle-orm/postgres-js/migrator` against the `./drizzle` folder. On completion it closes the connection and prints `migrations applied`.

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
# or inside Docker Compose:
docker compose run --rm api sh -c "pnpm --filter @squad/db migrate"
```

**Journal tracking**: Drizzle records applied migrations in the `__drizzle_migrations` table inside the target database. The table is created automatically on the first run. The local journal of file hashes lives at [`packages/db/drizzle/meta/_journal.json`](../../../packages/db/drizzle/meta/_journal.json).

**Idempotency**: already-applied migrations are skipped; running `pnpm db:migrate` on an up-to-date database is a no-op.

---

## Schema generation (`pnpm db:generate`)

```bash
DATABASE_URL=postgres://... pnpm db:generate
```

Reads [`packages/db/drizzle.config.ts`](../../../packages/db/drizzle.config.ts) and diffs the compiled schema (`dist/schema/index.js`) against the live database to produce a new numbered SQL file under `packages/db/drizzle/`. **Always review the generated file before committing** — the generator cannot produce hand-written constructs like hash-chain triggers, partial indexes with `WHERE`, or monthly partition bootstrapping. Merge those manually.
