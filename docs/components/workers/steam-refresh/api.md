# API

The worker has no direct HTTP API and opens no port. The related HTTP surface
belongs to the API service: `POST /api/v1/players/:playerId/steam-refresh`
refreshes one player on demand (permission `player:view`, audited as
`player.steam_refresh`, limited to 20 requests per minute per user). It uses the
same `@squad/steam-api` functions and Redis caches as this worker.

## Exported functions

| Module | Function or constant | Purpose |
|---|---|---|
| [`src/tick.ts`](../../../../apps/workers/steam-refresh/src/tick.ts) | `runSteamRefreshTick(deps)` | One sweep. Returns `{ disabled, selected, updated, failed }`. |
| `src/tick.ts` | `createSteamRefreshDeps(db, redis, apiKey)` | Builds the database and Steam dependencies; `redis` needs only `get` and `set`. |
| `src/tick.ts` | `STEAM_REFRESH_STALE_MS`, `STEAM_REFRESH_BATCH_SIZE` | Seven days and 100 players. |

`@squad/steam-api` exports `fetchSteamProfiles`, `fetchSteamBans`,
`fetchSteamOwnedGames` (used here) and `fetchSteamProfile`, plus
`STEAM_BATCH_SIZE`, `SQUAD_APP_ID` (393380) and `STEAM_REQUEST_TIMEOUT_MS`.

## Outbound HTTP

All requests are `GET` calls to `api.steampowered.com` with the operator key in
the `key` query parameter and a 10-second deadline (body included).

| Endpoint | Used for | Batching |
|---|---|---|
| `/ISteamUser/GetPlayerSummaries/v0002/` | Persona name, avatar, visibility, account creation time | Up to 100 `steamids` per request, cold ids only. |
| `/ISteamUser/GetPlayerBans/v1/` | VAC and game ban counts, days since last ban | Up to 100 `steamids` per request, cold ids only. |
| `/IPlayerService/GetOwnedGames/v1/` | Squad ownership and playtime (`appids_filter[0]=393380`, `include_played_free_games=true`, `include_appinfo=false`) | One account per request, at most four in flight. |

## Redis surfaces

| Key | Direction | TTL | Content |
|---|---|---|---|
| `worker:heartbeat:steam-refresh` | write | 30 s, refreshed every 5 s | Heartbeat; `status` is `running` with an API key and `disabled` without one. |
| `steam-profile:<steamId64>` | read, write | 1 hour | JSON `SteamProfile`. |
| `steam-bans:<steamId64>` | read, write | 6 hours | JSON `SteamBanInfo`. |
| `steam-owned-games:<steamId64>` | read, write | 24 hours | JSON `SteamOwnedGames`; a private library is cached as `ownsSquad: null`. |
| `diag:queue` stream | write | n/a | Diagnostic events. |

A cached value that fails shape validation is treated as cold and fetched again.
The worker publishes and consumes no other stream or channel.

## Diagnostic events

All events use `component: 'worker-steam-refresh'`.

| Kind | Severity | Emitted when | Payload |
|---|---|---|---|
| `steam_refresh.started` | `info` | Startup | `{ intervalMs, configured }` |
| `steam_refresh.stopped` | `info` | SIGINT or SIGTERM | `{ sig }` |
| `steam_refresh.disabled` | `info` | A tick runs with an empty `STEAM_API_KEY` (every tick) | `{ disabled: true, selected: 0, updated: 0, failed: 0 }` |
| `steam_refresh.run_ok` | `info` | No stale players, or every selected player updated | `{ disabled, selected, updated, failed }` |
| `steam_refresh.run_partial` | `warn` | At least one selected player failed | `{ disabled, selected, updated, failed }` |
| `steam_refresh.run_failed` | `error` | The shared profile or ban request recovered nothing, or a save call threw after the candidates were selected; the error is rethrown to the runner. A failure of the candidate query itself emits no event and is only logged by the runner | `{ selected, error }` |
