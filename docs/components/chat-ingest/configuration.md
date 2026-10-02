# `chat-ingest` — configuration

## Environment variables

None. The package does not read `process.env` (no `process.env` reference in [`src/`](../../../packages/chat-ingest/src)). Connections are created by the consuming worker and passed in as the `db` and `redis` arguments.

## Tunables (constructor arguments, not env)

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `ttlMs` | `new ChatFlagDetector(db, ttlMs)` | `5_000` (`DEFAULT_TTL_MS`) | How long the compiled rule set is reused before the next `detect()` reloads it |
| `ttlMs` | `new PlayerIdCache({ ttlMs })` | `60_000` | Lifetime of a cached id-to-player entry |
| `maxEntries` | `new PlayerIdCache({ maxEntries })` | `5_000` | Size cap across both id kinds (`eos:` and `steam:` keys count separately) |
| `now` | `new PlayerIdCache({ now })` | `Date.now` | Injectable clock for tests |

Both consumers construct `new ChatFlagDetector(db)` and `new PlayerIdCache()` with the defaults.

## Fixed constants

| Constant | Value | Where |
|---|---|---|
| `LIVE_BUS_CHANNEL` | `'live-bus'` | [`store.ts`](../../../packages/chat-ingest/src/store.ts); the API subscriber uses the same literal in `apps/api/src/plugins/live-bus.ts` |
| Default `source` | `'log'` | `handleChat`, `buildChatFrame`, `recordChatMessage` |

## Package export paths

| Export path | Resolves to |
|---|---|
| `@squad/chat-ingest` | `types: ./dist/index.d.ts`, `development: ./src/index.ts`, `default: ./dist/index.js` |
| `@squad/chat-ingest/package.json` | `./package.json` |

The `development` condition lets vitest and `tsx` import the source without a build. `pnpm --filter @squad/chat-ingest build` runs `tsc -p tsconfig.json` (rootDir `src`, outDir `dist`); `typecheck` runs `tsc -p tsconfig.test.json`, which also covers `test/`.

## Build graph

[`turbo.json`](../../../packages/chat-ingest/turbo.json) extends the root config; `test` and `test:unit` depend on `^build`, so the workspace dependencies (`@squad/db`, `@squad/shared-config`) are built first when run through Turbo.
