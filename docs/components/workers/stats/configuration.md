# worker-stats — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | no | — | Postgres connection. When unset the reconcile guard is disabled and the worker idles. | yes |
| `REDIS_URL` | no | — | Redis connection for the heartbeat and `dossier_reconcile.*` diagnostics. When unset, heartbeat and diagnostics are disabled. | yes |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

## Tuning constants

Compile-time constants in `src/index.ts` (not environment-driven):

| Constant | Value | Meaning |
|---|---|---|
| `RECONCILE_INTERVAL_MS` | `24 h` | Cadence of the reconcile tick (nightly). |
| `RECONCILE_WINDOW_HOURS` | `48` | `combat_events` look-back window each pass inspects. |
