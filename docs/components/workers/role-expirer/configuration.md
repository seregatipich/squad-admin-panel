# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. |
| `REDIS_URL` | yes | none | Redis connection for session revocation, Admins.cfg sync streams, heartbeat, and diagnostics. |
| `ROLE_EXPIRER_INTERVAL_MS` | no | `60000` | Tick interval in milliseconds. |
| `ROLE_EXPIRY_REMINDER_INTERVAL_MS` | no | `86400000` | VIPSUB-4 expiry-reminder tick interval in milliseconds (daily). |
| `LOG_LEVEL` | no | `info` | Pino log level. |
