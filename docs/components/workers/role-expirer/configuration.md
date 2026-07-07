# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. |
| `REDIS_URL` | yes | none | Redis connection for session revocation, Admins.cfg sync streams, heartbeat, and diagnostics. |
| `ROLE_EXPIRER_INTERVAL_MS` | no | `60000` | Tick interval in milliseconds. |
| `LOG_LEVEL` | no | `info` | Pino log level. |
