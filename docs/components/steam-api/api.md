# `steam-api` — API reference

```ts
import {
  fetchSteamProfile,
  fetchSteamProfiles,
  fetchSteamBans,
  fetchSteamOwnedGames,
  STEAM_BATCH_SIZE,
  STEAM_BANS_BATCH_SIZE,
  STEAM_REQUEST_TIMEOUT_MS,
  SQUAD_APP_ID,
  type SteamApiDeps,
  type SteamProfile,
  type SteamBanInfo,
  type SteamOwnedGames,
} from '@squad/steam-api';
```

[`src/index.ts`](../../../packages/steam-api/src/index.ts) is the only source file; it exports 4 functions, 4 constants and 4 types.

## Types

### `SteamApiDeps`

| Field | Type | Notes |
|---|---|---|
| `apiKey` | `string` | Steam Web API key. An empty string makes every fetcher return `null` without any Redis or network call |
| `redis` | `Pick<Redis, 'get' \| 'set'>` | ioredis-compatible; `get(key)` and `set(key, value, 'EX', seconds)` are used |
| `fetch` | `typeof fetch` (optional) | Defaults to the global `fetch`; injectable for tests |
| `timeoutMs` | `number` (optional) | Per-request deadline, default `STEAM_REQUEST_TIMEOUT_MS` |

### `SteamProfile`

| Field | Type | Source field | Fallback |
|---|---|---|---|
| `persona` | `string` | `personaname` | `''` |
| `avatarUrl` | `string` | `avatarfull` | `''` |
| `visibility` | `number \| null` | `communityvisibilitystate` | `null` when not a finite number |
| `createdAt` | `number \| null` | `timecreated` (Unix seconds) | `null` when not a finite number |

### `SteamBanInfo`

| Field | Type | Source field | Fallback |
|---|---|---|---|
| `steamId64` | `string` | `SteamId` | entry is skipped when absent |
| `communityBanned` | `boolean` | `CommunityBanned` | `false` unless exactly `true` |
| `vacBanned` | `boolean` | `VACBanned` | `false` unless exactly `true` |
| `vacBanCount` | `number` | `NumberOfVACBans` | `0` |
| `gameBanCount` | `number` | `NumberOfGameBans` | `0` |
| `daysSinceLastBan` | `number \| null` | `DaysSinceLastBan` | `null` |
| `economyBan` | `string \| null` | `EconomyBan` | `null` when not a string |

### `SteamOwnedGames`

| Field | Type | Meaning |
|---|---|---|
| `ownsSquad` | `boolean \| null` | `true`/`false` when Steam returned a `games` array; `null` when it did not (private game list) |
| `playtimeMinutes` | `number \| null` | `playtime_forever` of the Squad entry; `null` when the entry or the number is missing |

## Constants

| Export | Value | Meaning |
|---|---|---|
| `STEAM_BATCH_SIZE` | `100` | Max SteamIDs per `GetPlayerSummaries` / `GetPlayerBans` request |
| `STEAM_BANS_BATCH_SIZE` | `STEAM_BATCH_SIZE` (100) | Alias used by the bans fetcher |
| `SQUAD_APP_ID` | `393380` | App id sent in `appids_filter[0]` and matched in the response |
| `STEAM_REQUEST_TIMEOUT_MS` | `10_000` | Default per-request deadline |

The package `SQUAD_APP_ID` is `393380`; [`shared-config`](../shared-config/api.md) exports a different `SQUAD_APP_ID` (`403240`) used for the dedicated-server depot. They are separate constants for separate purposes; do not import one in place of the other.

## Functions

### `fetchSteamProfiles(steamIds, deps)`

```ts
fetchSteamProfiles(steamIds: readonly bigint[], deps: SteamApiDeps): Promise<Map<string, SteamProfile> | null>
```

Returns a map keyed by the SteamID64 as a decimal string. Ids are deduplicated; cache hits are served from Redis; the cold ids are requested in batches of `STEAM_BATCH_SIZE`, one batch at a time. An id Steam does not return (unknown account) is absent from the map and is not cached.

### `fetchSteamProfile(steamId64, deps)`

```ts
fetchSteamProfile(steamId64: bigint, deps: SteamApiDeps): Promise<SteamProfile | null>
```

Calls `fetchSteamProfiles([steamId64], deps)` and returns that id's entry. `null` both when the call failed and when Steam does not know the account; the two cases are not distinguishable.

### `fetchSteamBans(steamIds, deps)`

```ts
fetchSteamBans(steamIds: readonly bigint[], deps: SteamApiDeps): Promise<Map<string, SteamBanInfo> | null>
```

Same shape as `fetchSteamProfiles`, keyed by SteamID64 string, batches of `STEAM_BANS_BATCH_SIZE`.

### `fetchSteamOwnedGames(steamId64, deps)`

```ts
fetchSteamOwnedGames(steamId64: bigint, deps: SteamApiDeps): Promise<SteamOwnedGames | null>
```

One id per call. Returns a fresh or cached `SteamOwnedGames`, or `null` on failure.

## Error contract

| Condition | `fetchSteamProfiles` / `fetchSteamBans` | `fetchSteamOwnedGames` |
|---|---|---|
| `apiKey` is empty | `null`, no Redis/network call | `null`, no Redis/network call |
| HTTP status not 2xx, network error, timeout, non-JSON body | That batch is skipped and flagged as failed | `null` |
| Some batches fail, others (or the cache) yield entries | The map of recovered entries is returned (partial result) | n/a |
| Failures and nothing recovered at all | `null` | n/a |
| Every id served from cache | Map returned, no request issued | Cached value returned, no request issued |
| `redis.get` rejects | **Propagates** (rejects the call) | **Propagates** |
| `redis.set` rejects | Inside the batch `try`: the batch counts as failed; entries already collected are still returned (`null` only if the map is empty) | **Propagates** |

Callers must therefore treat `null` as "do not trust, try later" and wrap calls in `try/catch` if Redis can be down; `auth-steam.ts` does so, because a Steam login must not fail on enrichment.

## Request details

| Property | Value |
|---|---|
| Method | `GET` |
| Host | `https://api.steampowered.com` |
| Auth | `key` query parameter (the API key is part of the URL) |
| Deadline | `AbortSignal.timeout(deps.timeoutMs ?? 10_000)` on every request; also cuts a stalled response body read |
| Retries | none |
| Concurrency | batches run sequentially; a call issues at most one request at a time |

| Fetcher | Path | Query parameters besides `key` |
|---|---|---|
| `fetchSteamProfiles` | `/ISteamUser/GetPlayerSummaries/v0002/` | `steamids` (comma-joined, up to 100) |
| `fetchSteamBans` | `/ISteamUser/GetPlayerBans/v1/` | `steamids` (comma-joined, up to 100) |
| `fetchSteamOwnedGames` | `/IPlayerService/GetOwnedGames/v1/` | `steamid`, `include_appinfo=false`, `include_played_free_games=true`, `appids_filter[0]=393380` |
