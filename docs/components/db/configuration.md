# `db` — Configuration

---

## Environment variables

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | Yes | — | all | PostgreSQL connection string in `postgres://user:pass@host:port/dbname` format | Yes |
| `POSTGRES_PASSWORD` | Yes (migrator container) | — | Docker Compose `postgres` service | Password for the `admin` Postgres superuser created by the `postgres` Docker image | Yes |
| `TEST_DATABASE_URL` | No | falls back to `DATABASE_URL` | test | Override the database URL for Tier 2 integration tests to target a dedicated test database | Yes |

---

## `DATABASE_URL` format

```
postgres://admin:<POSTGRES_PASSWORD>@<host>:5432/admin
```

| Scenario | `<host>` value | Notes |
|---|---|---|
| Inside Docker Compose (`api`, workers) | `postgres` | Service name resolves via Compose DNS |
| Host-side migration run | `127.0.0.1` | Postgres port is published on the host in `docker-compose.yml` |
| CI (GitHub Actions) | `127.0.0.1` | Postgres service container started in the job |
| Tier 2 integration tests on host | `127.0.0.1` | Same as host-side migration |

**Example (host-side migrate):**

```bash
DATABASE_URL=postgres://admin:changeme@127.0.0.1:5432/admin pnpm db:migrate
```

**Example (inside Docker Compose):**

```yaml
environment:
  DATABASE_URL: postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin
```

---

## Connection pool settings

### Production (`apps/api`)

Set in `packages/db/src/client.ts` (`createDatabaseClient`):

| Setting | Value | Notes |
|---|---|---|
| `max` | `16` | Maximum simultaneous connections |
| `idle_timeout` | `30` | Seconds before an idle connection is returned to the pool |
| `connect_timeout` | `10` | Seconds before a new connection attempt times out |
| `prepare` | `false` | Prepared statements disabled; required if running behind PgBouncer in transaction mode |

### Test / integration

Tests create their own client directly using `postgres(url, { max: 3, onnotice: () => undefined })`. The lower ceiling of 3 prevents port exhaustion when multiple test files run in parallel. The `onnotice` suppresses Postgres NOTICE messages from triggers during tests.

### Migration runner

`packages/db/src/migrate.ts` uses `max: 1` — a single connection is sufficient for sequential DDL execution.

---

## Drizzle configuration

`packages/db/drizzle.config.ts` is read by `drizzle-kit generate` and `drizzle-kit studio`:

```ts
defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',  // compiled output, not source
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
```

`DATABASE_URL` must be set before running `pnpm db:generate` or `pnpm db:studio`.

---

## Session storage notes

Sessions are stored in the `sessions` table in Postgres, not in Redis. The `__Host-sid` cookie value is the `sessions.id` column. Redis stores RCON status (`rcon:status:{id}`), worker heartbeats (`worker:heartbeat:{name}`), and the config-blame cache (`config-blame:{tip_version_id}`). There is no Redis-backed session store.

---

## Docker Compose Postgres service

The `postgres` service in `docker-compose.yml` uses the official `postgres:16-alpine` image. The database and user named `admin` are created automatically from `POSTGRES_USER` and `POSTGRES_DB` environment variables. Port `5432` is published on the host for external access (migrations, Drizzle Studio, test runs).

Data is persisted in the `pgdata` named volume. To reset the database:

```bash
docker compose down -v   # drops pgdata volume
docker compose up -d postgres
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```
