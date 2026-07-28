# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. |
| `REDIS_URL` | yes | none | Steam response caches, heartbeat, and diagnostics. |
| `STEAM_API_KEY` | no | none | Operator Steam Web API key. An empty value disables requests without making the worker unhealthy. |
| `STEAM_REFRESH_INTERVAL_MS` | no | `3600000` | Delay between refresh sweeps in milliseconds. |
| `LOG_LEVEL` | no | `info` | Pino log level. |
