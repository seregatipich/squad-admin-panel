# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. |
| `REDIS_URL` | yes | none | Redis connection for session revocation, Admins.cfg sync, heartbeat, and diagnostics. |
| `SEED_REWARD_INTERVAL_MS` | no | `86400000` | Reconciliation interval in milliseconds. |
| `LOG_LEVEL` | no | `info` | Pino log level. |
