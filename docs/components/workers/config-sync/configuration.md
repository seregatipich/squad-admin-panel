# worker-config-sync — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres URL the worker reads roles + players from. | yes |
| `REDIS_URL` | ✅ | — | Redis used for streams (`events:admins-cfg-sync:*`), status keys (`admins-cfg:status:*`), heartbeat. | no |
| `PANEL_BRIDGE_SOCKET` | no | `/run/panel-host-bridge/bridge.sock` | Unix socket for the Go host bridge (`file_read` / `file_atomic_write`). | no |
| `LOG_LEVEL` | no | `info` | Pino log level. | no |
| `ADMINS_CFG_DRIFT_INTERVAL_MS` | no | `300000` | Drift sweep interval (ms). 5 min default. | no |
| `CONFIG_DRIFT_INTERVAL_MS` | no | `300000` | Generic config-drift sweep interval (ms) over the 16 non-managed config files (CFG-2, #64). 5 min default. | no |
| `ADMINS_CFG_RECLAIM_INTERVAL_MS` | no | `30000` | Cadence for the `XAUTOCLAIM` pass that takes over orphaned PEL messages (ms). | no |
| `ADMINS_CFG_RECLAIM_MIN_IDLE_MS` | no | `60000` | Minimum idle time before a pending message becomes eligible for reclaim (ms). | no |

## Operational notes

- The worker must run as a member of the `panel` group on the host so the bridge socket is accessible (`SO_PEERCRED` + GID check).
- Postgres user needs `SELECT` on `roles`, `role_squad_permissions`, `players`, `servers`, plus `INSERT` on `audit_log` (plus the chained-hash invariants enforced by triggers).
- Redis must support consumer groups (Redis ≥ 5.0).
- Multiple worker instances can run simultaneously: they share the `config-sync` consumer group; each entry is delivered to one consumer.
