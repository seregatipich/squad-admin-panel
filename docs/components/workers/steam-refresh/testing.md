# Testing

Run the package checks:

```bash
pnpm --filter @squad/steam-api test
pnpm --filter @squad/worker-steam-refresh typecheck
pnpm --filter @squad/worker-steam-refresh build
pnpm --filter @squad/worker-steam-refresh test
```

`tick.test.ts` covers disabled mode, bounded selection, shared batch reads,
complete writes, partial responses, and failed shared requests.
`contract.test.ts` starts the built process and verifies heartbeat publication
and clean repeated `SIGTERM` handling.

## Infrastructure needs

`tick.test.ts` (6 tests) uses injected dependencies and needs neither Postgres
nor Redis. `contract.test.ts` (2 tests) spawns `dist/index.js`, so build first,
and needs Redis (`TEST_REDIS_URL` or `REDIS_URL`, default
`redis://127.0.0.1:6379`, database `TEST_REDIS_DB`, default 14). It runs the
worker with an empty `STEAM_API_KEY`, so the process never queries Postgres or
Steam. The `@squad/steam-api` tests (`packages/steam-api/test/client.test.ts`)
use an injected `fetch` and an in-memory Redis double. See
[local-test-setup.md](../../../development/local-test-setup.md).
