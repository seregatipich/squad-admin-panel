# `steam-api` — Steam Web API client with Redis caching

Small TypeScript package (`@squad/steam-api`) that reads three Steam Web API resources for a set of SteamID64s: persona/avatar summaries, ban status and Squad ownership/playtime. Every call goes through a Redis cache and a per-request timeout. It is a plain function library: no class, no background work, no database access.

## Responsibilities

- `fetchSteamProfiles` / `fetchSteamProfile` — `ISteamUser/GetPlayerSummaries`: persona name, avatar, profile visibility, account creation time.
- `fetchSteamBans` — `ISteamUser/GetPlayerBans`: community/VAC/game/economy ban status.
- `fetchSteamOwnedGames` — `IPlayerService/GetOwnedGames`, filtered to the Squad app id: ownership and playtime.
- Batch ids (100 per request), cache successful results in Redis, validate cache contents, and bound every request with a deadline.

## What it does NOT do

- **Does not read environment variables.** The caller passes the Steam API key (`STEAM_API_KEY` in the consumers) in `deps.apiKey`.
- **Does not create a Redis client.** The caller passes an object with `get` and `set` (`Pick<Redis, 'get' | 'set'>`).
- **Does not retry.** A failed request is not repeated; the failure is reported through the return value (see [api.md](api.md#error-contract)).
- **Does not rate-limit.** Throttling is the caller's concern (the API route and the worker add their own).
- **Does not touch Postgres.** Persisting the results into `players.steam_*` columns belongs to the consumers.
- **Does not implement Steam OpenID login.** That lives in `apps/api/src/lib/steam-openid.ts`; this package is used there only to enrich the signed-in player's profile.

## Code

| File | Contents |
|---|---|
| [`packages/steam-api/src/index.ts`](../../../packages/steam-api/src/index.ts) | The whole package: types, constants, the three fetchers, cache parsing |

## Consumers

| Consumer | Uses | Notes |
|---|---|---|
| [`apps/api/src/routes/auth-steam.ts`](../../../apps/api/src/routes/auth-steam.ts) | `fetchSteamProfile` | After a verified Steam login, with `timeoutMs: 3_000`; failure is non-fatal (falls back to `Player <last 4 digits>`) |
| [`apps/api/src/routes/player-steam-refresh.ts`](../../../apps/api/src/routes/player-steam-refresh.ts) | `fetchSteamProfile`, `fetchSteamBans`, `fetchSteamOwnedGames` | `POST /api/v1/players/:playerId/steam-refresh`, the three calls in parallel with the default timeout; rate-limited to 20 per minute per user; any `null` becomes HTTP 502 `steam_api_error` |
| [`apps/workers/steam-refresh/src/tick.ts`](../../../apps/workers/steam-refresh/src/tick.ts) | `fetchSteamProfiles`, `fetchSteamBans`, `fetchSteamOwnedGames`, `STEAM_BATCH_SIZE`, the three result types | Background sweep; see [`worker-steam-refresh`](../workers/steam-refresh/README.md) |

API tests that import the package: `apps/api/test/steam-bans.test.ts`, `steam-profile.test.ts`, `steam-owned-games.test.ts`, `integration/steam-refresh.test.ts`, and `routes-graph.test.ts` (which wraps the module in `vi.mock` with `importOriginal`).

## Dependencies

`ioredis` is listed under `dependencies` in [`package.json`](../../../packages/steam-api/package.json) but the source only does `import type Redis from 'ioredis'`, so the package never imports ioredis at runtime. There are no workspace dependencies.

## See also

- [api.md](api.md), [configuration.md](configuration.md), [data-model.md](data-model.md), [flows.md](flows.md), [testing.md](testing.md), [troubleshooting.md](troubleshooting.md)
- [`docs/operations/environment-variables.md`](../../operations/environment-variables.md) — `STEAM_API_KEY`, `STEAM_REFRESH_INTERVAL_MS`.
