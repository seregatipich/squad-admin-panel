# worker-automation — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `REDIS_URL` | **yes** | — | Redis connection string; the worker consumes from it and refuses to start without it | yes (may embed a password) |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

No Postgres connection — per-server stream discovery uses Redis `SCAN`, not a DB query (see [README](./README.md)).

## Tuning constants (not env-configurable in this pass)

Defined in `src/dispatch.ts`:

| Constant | Default | Purpose |
|---|---:|---|
| `DEFAULT_PLUGIN_TIMEOUT_MS` | 5,000 | Hard ceiling on a single plugin invocation before it is abandoned as a timeout |
| `DEFAULT_BLOCK_MS` | 1,000 | How long a single `XREADGROUP` call blocks waiting for new entries |
| `DEFAULT_BATCH_SIZE` | 50 | Max entries read per stream per `XREADGROUP` call |
| `DISPATCH_CONSUMER_GROUP` | `automation-dispatch:v1` | Consumer group name shared by every automation-worker process |
