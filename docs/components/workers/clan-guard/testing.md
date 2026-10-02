# worker-clan-guard - Testing

## Running tests

The package is `@squad/worker-clan-guard`. All files except the pure unit file need infrastructure, and `contract.test.ts` spawns the built worker:

```bash
pnpm --filter @squad/worker-clan-guard build
pnpm --filter @squad/worker-clan-guard exec vitest run
```

The package runs its files in parallel on isolated resources (see [testing.md](../../../development/testing.md)):

- `test/global-setup.ts` calls `setupPackageTemplateDatabase(project, 'clan_guard')`, which migrates one template database per run on the Postgres server named by `TEST_DATABASE_URL` or `DATABASE_URL`; `packages/db/test/helpers/clone-per-worker.ts` gives every Vitest worker slot its own clone. No `new-test-db.sh` call is needed, but Postgres must be reachable. `_test-shared/load-env.ts` fills `DATABASE_URL` from the repo `.env` (see [local-test-setup.md](../../../development/local-test-setup.md)).
- `_test-shared/redis-per-worker.ts` gives each slot its own Redis logical database (1 to 7), so the worker the contract test spawns never shares a heartbeat key with another file.
- `VITEST_MAX_FORKS` (default 4) bounds the number of slots.
- `vitest.config.ts` also includes `apps/workers/_test-shared/database-isolation.regression.test.ts`.

Run only the unit file, which needs no database or Redis for its tests:

```bash
pnpm --filter @squad/worker-clan-guard exec vitest run test/tick.test.ts
```

(The global setup still runs and skips the template when no database URL is configured.)

## Test files

### `tick.test.ts` (21 tests, mocked dependencies)

| Group | What it verifies |
|---|---|
| `matchProtectedTag` (8) | Case-insensitive prefix for a wrapped tag; no match for a non-prefix occurrence or a bare tag mid-name; bare tag re-wrapped in brackets; a bare tag that only starts a longer word does not match (#17); a bare tag worn as a separate leading word does match (#17); tags with their own trailing symbol; empty tag. |
| `findImpostorMatch` (1) | Returns the clan/tag and skips clans the player belongs to. |
| `buildClanGuardMessage` (1) | The exact single-line Russian message without CR/LF. |
| `runClanGuardTick` (11) | Kill-switch skip with no further queries or RCON; first detection warns once and writes the ledger and audit rows without a kick; kick after the grace period with `kick` ledger and audit rows; no action inside the grace period; clan member wearing their own tag untouched; panel-access holder re-warned and never kicked, no ledger row; re-sent kick writes no second ledger or audit row; no protected clans means no player query; player without `eos_id` skipped; an RCON failure for one player does not stop the rest (`player_failed` emitted, `errors: 1`); `findLastWarn` is scoped by the session `connectedAt`. |

### `tick.integration.test.ts` (1 test, Postgres)

| Test | What it verifies |
|---|---|
| One audit row for the warn and another for the kick | Against a real database with a stubbed Redis `xadd`: the first tick writes one `moderation_actions` warn row and one `clan.tag_protection.warn` audit row with the expected fields; a tick 301 s later kicks and writes the second pair; a tick 421 s after connect writes no further rows. |

The test asserts only the rows it owns, because the tick processes every online player in the (clone) database.

### `bare-tag.integration.test.ts` (1 test, Postgres)

| Test | What it verifies |
|---|---|
| Bare tag (#17) | With clan tag `Q17`, a player named `Q17rush` is not actioned and `Q17 Самозванец` receives exactly one `warn` ledger row with the expected `clan_id`, `tag` and `matched_name`. |

### `contract.test.ts` (2 tests, Redis + built worker)

Shared `workerContract`: the worker publishes `worker:heartbeat:clan-guard` with a TTL of at most 30 s, and exits with code 0 after two SIGTERMs. It runs against the database in `DATABASE_URL` for the spawned process.

### `database-isolation.regression.test.ts` (2 tests, shared)

Checks that this package's `DATABASE_URL` points at the slot's clone of the run template and that `REDIS_URL`, `TEST_REDIS_URL` and `TEST_REDIS_DB` point at the slot's Redis database.

Total: 27 tests.

## Test data

The integration files create their own server, clan, players and sessions with fixed test-range SteamID64s and generated UUIDs, and delete them in `afterAll`. Redis is replaced by an object whose `xadd` returns a fixed id, so no RCON entries are produced.

## Coverage gaps

- `loadSettings`, `loadProtectedClans`, `loadOnlinePlayers` and `sendRconCommand` are exercised only indirectly (the integration tests use the first three against a real database; the real `sendRconCommand` payload is not asserted).
- The disabled kill-switch is covered at unit level only.
- Startup and interval behavior in `src/index.ts` is covered only by the contract test.
