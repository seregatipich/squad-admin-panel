# worker-clan-priority-expirer - Testing

## Running tests

The package is `@squad/worker-clan-priority-expirer`. Two of its four files need infrastructure:

- `tick.integration.test.ts` and `tick-atomicity.integration.test.ts` use Postgres through `DATABASE_URL` (skipped with a warning when it is unset, and a hard error when `CI` is set). `_test-shared/load-env.ts` fills `DATABASE_URL` from the repo `.env` when it is absent, which points at the shared `admin` database, so provision an isolated migrated database first.
- `contract.test.ts` spawns `dist/index.js`, so the package must be built, and needs Redis.

```bash
eval "$(bash scripts/new-test-db.sh clan-priority-expirer)"
pnpm --filter @squad/worker-clan-priority-expirer build
pnpm --filter @squad/worker-clan-priority-expirer exec vitest run
```

Run a single file with `pnpm --filter @squad/worker-clan-priority-expirer exec vitest run test/tick.test.ts` (that file needs no database). See [local-test-setup.md](../../../development/local-test-setup.md).

`vitest.config.ts` spreads `workerTestBase` (40 s test timeout, `load-env.ts` setup file) and sets `fileParallelism: false`: a tick enqueues a sync for every active server, which would race another file deleting its own server.

## Test files

### `tick.test.ts` (7 tests, no infrastructure)

Unit tests of `runClanPriorityExpiryTick` and `buildClanPriorityExpiryAuditEntry` with mocked dependencies.

| Test | What it verifies |
|---|---|
| No-op when nothing expired | Returns `{ 0, 0 }`, never calls `expireClans`, still emits `run_ok`. |
| Expires found clans in one call | `expireClans` receives the candidates, `now` and an event with `reason: 'clan.priority.expire'` and `actor_player_id: null`; result reflects what that call returned. |
| Already-processed clan does not re-fire | An empty find result leads to no expiry. |
| Never touches `clan_members.has_priority` | The dependency interface has no member-mutating function. |
| `run_failed` and rethrow | A failing `findExpiredUnprocessedClans` emits `run_failed` (`error`) and rejects. |
| Reports only clans actually expired (#865) | Two candidates, one returned by `expireClans`: the result counts one. |
| Audit entry shape | System actor `clan-priority-expirer`, before/after snapshots, context, status 200. |

### `tick.integration.test.ts` (1 test, Postgres)

| Test | What it verifies |
|---|---|
| Commits the processed marker with one pending row per active server | `expireClans` returns `enqueued` equal to the number of servers with `deleted_at IS NULL`, the clan is `priority_expiry_processed = true`, and every `admins_cfg_sync_outbox` row for the test `request_id` is pending (`relayed_at IS NULL`) and covers exactly the active server ids. |

### `tick-atomicity.integration.test.ts` (3 tests, Postgres)

| Test | What it verifies |
|---|---|
| Marks the clan processed together with its audit row | After a tick, the clan is processed and exactly one `clan.priority.expire` audit row exists for it. |
| Audit failure leaves the clan unprocessed (#866) | A `BEFORE INSERT` trigger on `audit_log` raises for the clan; the tick rejects and the clan stays unprocessed with no audit row. |
| Extension after selection is not overwritten (#865) | A `PATCH /expire`-style update (new deadline, flag reset) lands between the select and the update; the clan stays unprocessed with no audit row. |

### `contract.test.ts` (2 tests, Redis + built worker)

Shared `workerContract` from `apps/workers/_test-shared/contract.ts`.

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30 s of start | `worker:heartbeat:clan-priority-expirer` has a TTL of at most 30 s. |
| Exits 0 on repeated SIGTERM | Two SIGTERMs 25 ms apart end in exit code 0 within 8 s. |

The contract test uses Redis database `TEST_REDIS_DB` (default `14`) derived from `TEST_REDIS_URL` or `REDIS_URL`; this package's Vitest config does not include `redis-per-worker.ts`.

## Test data

The integration files create their own clans, players and servers with random ids (and a SteamID64 in a test-only range) and delete them afterwards. The atomicity file also creates and drops the `test_fail_clan_expiry_audit` trigger function.

## Coverage gaps

- `findExpiredUnprocessedClans` (including the silent marking of clans with no `has_priority` member) has no direct assertion; only the paths through `runClanPriorityExpiryTick` and `expireClans` are covered.
- The startup, interval and overlap-skip behavior in `src/index.ts` is covered only by the contract test (heartbeat and clean shutdown).
