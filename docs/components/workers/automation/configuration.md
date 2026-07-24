# worker-automation — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `REDIS_URL` | **yes** | — | Redis connection string; the worker consumes events from it and refuses to start without it | yes (may embed a password) |
| `DATABASE_URL` | **yes** | — | Postgres connection string; required as of AUTO-1 to load `automation_rules` and write `automation_runs`/`audit_log`. The process exits 1 if missing. | yes (embeds a password) |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

The worker is defined as the `worker-automation` service in `docker-compose.yml` and `compose.tk104.yml` (built from `docker/worker.Dockerfile` with `WORKER: automation`), depending on `postgres`, `redis`, and `migrator`.

## Tuning constants (not env-configurable in this pass)

Defined in `src/dispatch.ts`:

| Constant | Default | Purpose |
|---|---:|---|
| `DEFAULT_PLUGIN_TIMEOUT_MS` | 5,000 | Hard ceiling on a single plugin invocation before it is abandoned as a timeout |
| `DEFAULT_BLOCK_MS` | 1,000 | How long a single `XREADGROUP` call blocks waiting for new entries |
| `DEFAULT_BATCH_SIZE` | 50 | Max entries read per stream per `XREADGROUP` call |
| `DISPATCH_CONSUMER_GROUP` | `automation-dispatch:v1` | Consumer group name shared by every automation-worker process |

Defined in `src/index.ts` / `src/rules/runtime.ts` (AUTO-1):

| Constant | Default | Purpose |
|---|---:|---|
| `RULES_CACHE_TTL_MS` | 15,000 | How long the enabled-rules snapshot is reused before reloading from Postgres |
| `DEFAULT_TIME_OF_DAY_COOLDOWN_SECONDS` | 3,600 | Per-rule cooldown so a `time_of_day` rule fires at most once per window |
