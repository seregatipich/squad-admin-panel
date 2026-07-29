# worker-backup — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `LOG_LEVEL` | no | `info` | Pino log level | no |
| `REDIS_URL` | no | unset | Enables the `worker:heartbeat:backup` heartbeat. When unset, no Redis client is created and no heartbeat is published. | no |
