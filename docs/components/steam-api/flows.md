# `steam-api` — flows

## Batched profile / ban fetch

`fetchSteamProfiles` and `fetchSteamBans` share the same flow; only the endpoint, cache prefix and TTL differ.

```
fetchSteamBans(steamIds, deps)
  1. apiKey empty?                    ─▶ return null
  2. ids = unique(steamIds.map(String))
  3. cached = await Promise.all(ids.map(id => redis.get('steam-bans:' + id)))
       valid entry  ─▶ result.set(id, entry)
       missing/bad  ─▶ cold.push(id)
  4. for each batch of 100 cold ids (sequential):
       GET .../GetPlayerBans/v1/?key=...&steamids=a,b,c      (10 s deadline)
         !response.ok            ─▶ hadFailure, next batch
         throws (network, timeout, bad JSON)
                                 ─▶ hadFailure, next batch
         else for each returned entry with a SteamId:
              result.set(id, entry)
              redis.set('steam-bans:' + id, JSON, 'EX', 21600)   (awaited together)
  5. hadFailure and result is empty ─▶ return null
     otherwise                       ─▶ return result (possibly partial)
```

Consequences:

- 250 cold ids cost 3 requests (100, 100, 50) in sequence.
- A failure in batch 2 does not discard batch 1 or the cached entries (regression test for #1191).
- A partial result is indistinguishable from a complete one at the return value; callers that need every id must compare `result.size` or look each id up (the worker marks a candidate as failed when its id is missing from the map).

## Single-id fetch (`fetchSteamProfile`)

Wraps `fetchSteamProfiles([id])` and returns `map.get(String(id)) ?? null`.

## Owned games

```
fetchSteamOwnedGames(id, deps)
  1. apiKey empty?                  ─▶ null
  2. redis.get('steam-owned-games:' + id); valid JSON of the right shape ─▶ return it
  3. GET .../IPlayerService/GetOwnedGames/v1/
       ?key&steamid&include_appinfo=false&include_played_free_games=true&appids_filter[0]=393380
       !ok / throws / non-JSON      ─▶ null
  4. games = payload.response.games
       not an array (private list)  ─▶ { ownsSquad: null, playtimeMinutes: null }
       array                        ─▶ { ownsSquad: <entry with appid 393380 exists>,
                                         playtimeMinutes: entry.playtime_forever or null }
  5. redis.set(key, JSON, 'EX', 86400); return result
```

## Consumer: login enrichment

`GET /api/v1/auth/steam/callback` calls `fetchSteamProfile` after OpenID verification with `timeoutMs: 3_000`. `persona` and `avatarUrl` replace the placeholder name `Player <last 4>` when present. Any thrown error (for example a Redis failure) is caught and logged as `steam profile enrichment failed (non-fatal)`; the login continues.

## Consumer: manual refresh

`POST /api/v1/players/:playerId/steam-refresh` runs, in parallel, `fetchSteamProfile`, `fetchSteamBans([id])` and `fetchSteamOwnedGames(id)` with the default 10 s timeout.

| Outcome | HTTP |
|---|---|
| Player not found | 404 `player_not_found` |
| Player has no `steam_id64` | 409 `no_steam_id` |
| `STEAM_API_KEY` empty | 503 `steam_api_key_missing` |
| Any of the three results is `null` | 502 `steam_api_error` (logs which of the three failed) |
| Otherwise | snapshot written to `players`, returned |

The route's limit is 20 requests per minute per user (`STEAM_REFRESH_RATE_LIMIT_PER_MINUTE`).

## Consumer: background sweep

`runSteamRefreshTick` (worker-steam-refresh) selects up to `STEAM_BATCH_SIZE` (100) players that were never checked or last checked more than 7 days ago, then:

1. Calls `fetchSteamProfiles` and `fetchSteamBans` for all of them in parallel; if either returns `null` the tick fails and no per-player call is made.
2. Calls `fetchSteamOwnedGames` per candidate with concurrency 4 (`OWNED_GAMES_CONCURRENCY`); a rejection from one candidate is turned into `null` for that candidate.
3. A candidate missing any of the three results is counted as failed and only has `steam_checked_at` touched; the others are saved.

The worker's sweep interval is `STEAM_REFRESH_INTERVAL_MS` (default one hour). Because the package caches for 1 h / 6 h / 24 h, a sweep that lands inside the TTL of a recent manual refresh is served from Redis for that player.
