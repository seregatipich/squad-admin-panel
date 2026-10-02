# `steam-api` — configuration

## Environment variables

None are read by the package (no `process.env` reference in [`src/index.ts`](../../../packages/steam-api/src/index.ts)). Everything arrives through the `SteamApiDeps` argument.

## Variables consumed by callers

| Variable | Read by | Passed as | Notes |
|---|---|---|---|
| `STEAM_API_KEY` | `apps/api/src/config.ts` (optional string, exposed as `app.config.STEAM_API_KEY`); `apps/workers/steam-refresh/src/index.ts` (`process.env.STEAM_API_KEY`) | `deps.apiKey` (`?? ''` when unset) | Unset or empty disables every call: the fetchers return `null` without touching Redis or the network. The API route answers 503 `steam_api_key_missing`; the worker reports heartbeat status `disabled` |
| `STEAM_REFRESH_INTERVAL_MS` | `apps/workers/steam-refresh/src/index.ts` | n/a | Sweep interval of the worker (default 3 600 000); not a package setting |

See [`docs/operations/environment-variables.md`](../../operations/environment-variables.md) for the full table.

## Per-call settings (`SteamApiDeps`)

| Setting | Default | Callers that override it |
|---|---|---|
| `timeoutMs` | `STEAM_REQUEST_TIMEOUT_MS` = `10_000` | `auth-steam.ts` passes `3_000` (`STEAM_LOGIN_PROFILE_TIMEOUT_MS`) so a slow Steam Web API delays a login by at most about 3 s |
| `fetch` | global `fetch` | tests only |

## Fixed constants

| Constant | Value |
|---|---|
| Batch size (`STEAM_BATCH_SIZE`, `STEAM_BANS_BATCH_SIZE`) | `100` |
| `SQUAD_APP_ID` | `393380` |
| Profile cache key prefix / TTL | `steam-profile:` / 3 600 s (1 h) |
| Bans cache key prefix / TTL | `steam-bans:` / 21 600 s (6 h) |
| Owned-games cache key prefix / TTL | `steam-owned-games:` / 86 400 s (24 h) |

None of these can be changed without editing the source.

## Package export paths

| Export path | Resolves to |
|---|---|
| `@squad/steam-api` | `types: ./dist/index.d.ts`, `development: ./src/index.ts`, `default: ./dist/index.js` |

The `development` condition lets vitest and `tsx` import the source without a build. `pnpm --filter @squad/steam-api build` runs `tsc -p tsconfig.json` (rootDir `src`, outDir `dist`); `typecheck` runs `tsc -p tsconfig.test.json`, which also covers `test/`. [`turbo.json`](../../../packages/steam-api/turbo.json) makes `test` and `test:unit` depend on `^build`.
