# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. |
| `REDIS_URL` | yes | none | Steam response caches, heartbeat, and diagnostics. |
| `STEAM_API_KEY` | no | none | Operator Steam Web API key. An empty value disables requests without making the worker unhealthy. |
| `STEAM_REFRESH_INTERVAL_MS` | no | `3600000` | Delay between refresh sweeps in milliseconds. |
| `LOG_LEVEL` | no | `info` | Pino log level. |

`STEAM_REFRESH_INTERVAL_MS` is parsed by `intervalMsFromEnv`: an unset, blank,
non-numeric, non-positive or larger than 2147483647 value silently uses the
default. `STEAM_API_KEY` is read at startup for the dependencies and again on
every heartbeat to choose the status text (`running` with a key, `disabled`
without).

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Stale threshold | 7 days | `STEAM_REFRESH_STALE_MS` in `src/tick.ts` |
| Batch size | 100 players | `STEAM_REFRESH_BATCH_SIZE` (`STEAM_BATCH_SIZE` in `@squad/steam-api`) |
| Owned-games concurrency | 4 | `OWNED_GAMES_CONCURRENCY` in `src/tick.ts` |
| Steam request timeout | 10 000 ms | `STEAM_REQUEST_TIMEOUT_MS` in `@squad/steam-api` |
| Profile cache TTL | 1 hour | `steam-profile:<steamId64>` |
| Ban cache TTL | 6 hours | `steam-bans:<steamId64>` |
| Owned-games cache TTL | 24 hours | `steam-owned-games:<steamId64>` |
