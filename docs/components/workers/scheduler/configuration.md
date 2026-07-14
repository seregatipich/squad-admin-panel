# worker-scheduler — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection used for schedules and audit rows | yes |
| `REDIS_URL` | yes | — | Redis connection used for heartbeats and worker-rcon command streams | yes |
| `LOG_LEVEL` | no | `info` | Pino log level | no |
| `SCHEDULER_INTERVAL_MS` | no | `30000` | Delay between scheduler ticks | no |
| `PANEL_BRIDGE_SOCKET` | no | `/run/panel-host-bridge/bridge.sock` | Host bridge socket used to read/write server config files | no |
| `ROTATION_PROFILE_APPLY_HOUR` | no | `4` | Server-local hour at which the selected weekly profile may first be applied | no |
