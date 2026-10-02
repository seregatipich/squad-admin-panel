# `steam-api` — troubleshooting

## Every call returns `null` immediately

**Cause**: `deps.apiKey` is empty. The fetchers return `null` before any Redis or network access. In the panel this means `STEAM_API_KEY` is unset.

**Symptoms by consumer**: login falls back to the name `Player <last 4 digits>` and no avatar; `POST /api/v1/players/:playerId/steam-refresh` answers 503 `steam_api_key_missing`; `worker-steam-refresh` reports heartbeat status `disabled` and logs the diag event `steam_refresh.disabled`.

**Fix**: set `STEAM_API_KEY` in `.env` and recreate the api and `worker-steam-refresh` containers.

## `steam_api_error` (HTTP 502) from the manual refresh

**Cause**: at least one of the three fetchers returned `null`. The API logs `steam refresh aborted: Steam Web API did not answer` with a boolean per result (`profile`, `bans`, `ownedGames`). A `null` means a non-2xx response, a network error, a timeout (10 s), a non-JSON body, or, for the profile, that Steam returned no player for the id.

**Diagnostic**:
```bash
docker compose logs api --since 10m | grep 'steam refresh aborted'
```
Check the key against the same endpoint from the host:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=$STEAM_API_KEY&steamids=76561197960287930"
```

## A profile lookup is `null` for a valid player

`fetchSteamProfile` cannot tell "Steam does not know this id" from "the request failed". Both give `null`. An id Steam omits from the response is not cached, so each call asks Steam again.

## Stale data after a Steam-side change

Results are cached per id for 1 h (profile), 6 h (bans) and 24 h (owned games). A refresh inside the TTL returns the cached value without calling Steam. To force a refetch, delete the key:

```bash
redis-cli DEL steam-profile:<steamId64> steam-bans:<steamId64> steam-owned-games:<steamId64>
```

## `ownsSquad` is `null`

Steam returned no `games` array for the filtered request, which happens when the player's game details are private. `{ ownsSquad: null, playtimeMinutes: null }` is a successful result and is cached for 24 h. The background worker treats it as a valid owned-games result (a candidate fails only when the call returns `null`).

## The call rejects instead of returning `null`

The only rejections come from Redis: a failing `redis.get` rejects any fetcher, and a failing `redis.set` rejects `fetchSteamOwnedGames` (in the batch fetchers it is swallowed into a failed batch). Callers that cannot tolerate that must wrap the call; the login path does.

## A login takes about 3 seconds longer than usual

`auth-steam.ts` passes `timeoutMs: 3_000`; a slow `api.steampowered.com` delays the callback by up to that long before the placeholder name is used. A hung Steam endpoint can no longer hold the login for undici's 300 s default (regression tests under `Steam request deadline`).

## Some players are never refreshed by the worker

The worker counts a candidate as failed when its id is missing from the profile or ban map or when its owned-games call returns `null`; only `steam_checked_at` is touched, so the player is retried after the 7-day staleness window. See [`worker-steam-refresh`](../workers/steam-refresh/troubleshooting.md).
