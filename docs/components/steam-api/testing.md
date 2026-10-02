# `steam-api` — testing

All tests are unit tests with an in-memory Redis stub and an injected `fetch`. They need neither Postgres, Redis nor network access, so the isolated test database from [local-test-setup.md](../../development/local-test-setup.md) does not apply. There is no vitest config file in the package; vitest runs with its defaults and picks up `test/*.test.ts`.

## How to run

```bash
# Whole package
pnpm --filter @squad/steam-api exec vitest run

# One file
pnpm --filter @squad/steam-api exec vitest run test/client.test.ts

# Package script (same as `vitest run`)
pnpm --filter @squad/steam-api test

# Typecheck, including test/
pnpm --filter @squad/steam-api typecheck
```

In CI the package runs in the `packages` shard of `test:cov`; its weight in [`scripts/ci-test-shard.sh`](../../../scripts/ci-test-shard.sh) is `3`.

## Test file

[`test/client.test.ts`](../../../packages/steam-api/test/client.test.ts) is the only file: 15 test cases (two `it.each` blocks over the three fetchers expand to 3 cases each).

| Group | Cases | Covers |
|---|---:|---|
| `fetchSteamProfiles` | 5 | No API key means no request; cached profile plus at most 100 cold ids per request; 101 cold ids split into 100 + 1; a failing second batch keeps the first batch's results (#1191); a 200 response with a non-JSON body resolves `null` instead of throwing |
| `fetchSteamBans cache validation (#1189)` | 2 | A malformed cached entry is refetched; a well-formed cached entry is used without calling Steam |
| `fetchSteamOwnedGames cache validation (#1189)` | 1 | A malformed cached entry is refetched |
| `Steam request deadline` | 6 | For each of the three fetchers: a fetch that never answers is aborted after `timeoutMs` (50 ms in the test) and the call resolves `null` in under 2 s; and the request always carries an `AbortSignal` with the default deadline |
| `cache round trips (#1190)` | 1 | The 20 cache reads of a batch are in flight at once (peak concurrency 20) for both `fetchSteamBans` and `fetchSteamProfiles` |

## Test technique

- `memoryRedis()` is a `Map`-backed object with `vi.fn` `get` and `set`; tests pre-seed `store` to simulate cache hits.
- `fetch` is a `vi.fn` returning `{ ok, json }` objects; the URL (a `URL` instance) is inspected through `searchParams`.
- The deadline tests use a fetch that rejects with `signal.reason` when the abort signal fires, which exercises the real `AbortSignal.timeout`.

## What is not covered here

| Concern | Where it lives |
|---|---|
| Real calls to `api.steampowered.com` and a real Redis | Not tested anywhere in the package |
| Further unit coverage of the fetchers (the `GetOwnedGames` URL and query parameters, ownership and playtime mapping, private-profile fields, legacy cache entries, empty `players[]`, non-200 responses, corrupt cached JSON) | Lives in the API test directory, which imports the package directly: [`apps/api/test/steam-profile.test.ts`](../../../apps/api/test/steam-profile.test.ts), [`steam-bans.test.ts`](../../../apps/api/test/steam-bans.test.ts), [`steam-owned-games.test.ts`](../../../apps/api/test/steam-owned-games.test.ts) |
| Consumer behaviour: manual refresh route, background sweep | `apps/api/test/integration/steam-refresh.test.ts` (needs the API integration harness, see local-test-setup.md); `apps/workers/steam-refresh/test/tick.test.ts` |
