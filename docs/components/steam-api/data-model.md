# `steam-api` — data model

## Database

The package touches no Postgres tables, owns no schema and ships no migrations. Consumers copy results into `players.steam_account_created_at`, `steam_playtime_minutes`, `steam_checked_at` and related columns; see [`db`](../db/README.md) and [`worker-steam-refresh`](../workers/steam-refresh/README.md).

## Redis

Three string keys per SteamID64, written with `SET key value EX ttl`. Values are JSON. Nothing else is stored; there are no locks, counters or streams.

| Key | Value | TTL | Written by | Read by |
|---|---|---|---|---|
| `steam-profile:<steamId64>` | `SteamProfile` | 3 600 s | `fetchSteamProfiles` | `fetchSteamProfiles` |
| `steam-bans:<steamId64>` | `SteamBanInfo` | 21 600 s | `fetchSteamBans` | `fetchSteamBans` |
| `steam-owned-games:<steamId64>` | `SteamOwnedGames` | 86 400 s | `fetchSteamOwnedGames` | `fetchSteamOwnedGames` |

Example values:

```json
{"persona":"Alpha","avatarUrl":"https://.../full.jpg","visibility":3,"createdAt":1500000000}
{"steamId64":"76561198000000001","communityBanned":false,"vacBanned":false,"vacBanCount":0,"gameBanCount":0,"daysSinceLastBan":null,"economyBan":null}
{"ownsSquad":true,"playtimeMinutes":4200}
```

### Cache semantics

- Only successful results are cached. A failed batch, a non-2xx response, a timeout or an id Steam did not return leaves no key, so the next call asks Steam again.
- Reads for a whole id list are issued together with `Promise.all`, so ioredis pipelines them rather than paying one round trip per id.
- Cache entries are validated on read and a bad entry is treated as cold (refetched and overwritten):
  - profiles: the value must be parseable JSON; missing fields are defaulted (`persona`/`avatarUrl` to `''`, numbers to `null`); a value that makes parsing throw (invalid JSON, or JSON `null`) is cold.
  - bans: must match the full `SteamBanInfo` shape (type guard `isSteamBanInfo`).
  - owned games: must match the `SteamOwnedGames` shape (type guard `isSteamOwnedGames`).
- A `SteamOwnedGames` of `{ ownsSquad: null, playtimeMinutes: null }` (private game list) is a successful result and is cached for the full 24 h.
- The owned-games cache stores a not-owned result (`ownsSquad: false`) the same way.
- The cache is shared by every process that uses the same Redis: the API process and `worker-steam-refresh` read and write the same keys, so a manual refresh from the panel warms the worker's next sweep and vice versa.

### Key and PII notes

Keys hold only SteamID64s (public identifiers). The Steam API key is never stored in Redis; it is sent only as the `key` query parameter of requests to `api.steampowered.com`.
