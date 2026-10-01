# Testing

The non-negotiable rule: **every piece of functionality must be exercisable by a single test suite, end-to-end, against real infrastructure.** Fakes belong inside unit tests; the critical path (install a server, boot Squad, auth RCON, edit a config, stop, delete) is validated against a live panel stack with real Docker, Postgres, Redis, and the real Go bridge. If a change cannot be covered by a test that drives the system the way a human would, the change is not done.

## Three tiers + property-based

### Property-based (fuzz)

Pure-function invariants exercised by `@fast-check/vitest` (workspace root `devDependency`). Each property runs 100 random examples by default (configurable via `numRuns`). These live in `test/property/` subdirectories alongside the other test tiers.

| Package | File | What it proves |
|---|---|---|
| `@squad/web` | `test/property/slug.test.ts` | Slug utilities always produce API-valid output; idempotent round-trips for pre-valid slugs |
| `@squad/shared-config` | `test/property/registry.test.ts` | `isPermissionKey` accepts every registered key and rejects all others; every subset is a valid permission set |
| `@squad/api` | `test/property/audit-chain.test.ts` | DB-trigger hash chain is intact across 10 random batches (5–20 rows each) |

Run all property suites:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/web exec vitest run test/property/
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/shared-config exec vitest run test/property/
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/api exec vitest run test/property/
```

Property tests are included in `pnpm turbo run test` — they are not a separate step.

### Tier 1 — unit

Pure functions, parsers, validators, pure reducers. Vitest / `go test -race`. Fakes + in-memory runners. Fast (< 1 s per file).

Locations:

- `apps/api/test/*.test.ts` (most of them)
- `apps/bridge/internal/**/*_test.go`
- `packages/**/test/*.test.ts`
- `apps/workers/**/test/*.test.ts`

Run:

```bash
pnpm turbo run test        # every package; DB- and Redis-backed suites need the services (see below)
pnpm turbo run test:unit   # only the packages whose suites need no services
```

`test:unit` exists only in packages whose suites run without Postgres or Redis: `@squad/shared-config`, `@squad/shared-types`, `@squad/diag`, `@squad/bridge-client`, `@squad/chat-ingest`, `@squad/steam-api`, and `@squad/db`, whose script unsets `DATABASE_URL`/`TEST_DATABASE_URL` so its database suites skip (with a warning each) even when the variables are exported. `@squad/api` and the workers have no `test:unit`: their global setup, or tests outside the gates below, connect to Postgres and Redis. The Go bridge's `test:unit` needs a Linux host with `go` on `PATH`.

#### Suites that need Postgres or Redis

A suite that needs a service declares itself with `describeIfDb`, `describeIfRedis` or `describeIfDbAndRedis` from [`packages/db/test/helpers/describe-if.ts`](../../packages/db/test/helpers/describe-if.ts); never write a local `DATABASE_URL ? describe : describe.skip`. With `DATABASE_URL` (and `REDIS_URL` for the Redis gates) set, the suite runs like any `describe`. Without it:

- locally, the suite is skipped and a `[skipped] Suite "<name>": DATABASE_URL is not set.` line is printed;
- when `CI` is set, the test file fails at collection with an error naming the suite and the variable, so a job whose service failed to start cannot go green by skipping.

```ts
import { describeIfDb } from '../../../packages/db/test/helpers/describe-if.js';

describeIfDb('players repository', () => {
  /* … */
});
```

Import it by relative path; workers and the API do so already for the other helpers in that directory. `packages/db/test/describe-if.test.ts` covers the helper.

### Tier 2 — integration

Routes through the real Fastify instance via `inject()` or over HTTP, but with a fake bridge and (optionally) ephemeral Postgres/Redis. Proves plumbing (auth, RBAC, audit, validation, WS frame splitting) without requiring a Squad container.

Locations:

- `apps/api/test/install-ws.test.ts`, `apps/api/test/server-logs.test.ts`, `apps/api/test/audit-coverage.test.ts`, etc.

Run:

```bash
pnpm --filter @squad/api test
```

### Проверки эксплуатационных скриптов

`pnpm test:scripts` — отдельный последовательный контур для управляющих
скриптов, которые не относятся к одному workspace-пакету. Он проверяет:

- безопасные preflight/confirmation/fail-closed границы `bootstrap`,
  `install-host-bridge`, `deploy`, `rebuild` и `uninstall` на временных
  копиях со всеми host-командами, заменёнными журналирующими подменами;
- настоящий length-prefixed JSON-протокол `verify-bridge` через временный
  Unix-сокет;
- ограниченную проверку сайдкарных shadow-потоков через временный Redis (`scripts/rnsquadjs-shadow-diff.mjs`);
- `verify-audit-chain.ts` и реальные миграционные триггеры `audit_log` через
  отдельные временные PostgreSQL-БД.

Для полного локального запуска передайте обе пары адресов. Audit-набор
допускает отсутствие PostgreSQL только вне CI; в CI отсутствие БД завершает
набор ошибкой. Workflow сначала применяет миграции и только затем вызывает
`pnpm test:scripts`.

`scripts/pre-push-checklist.sh` запускает этот контур последним пунктом, после
тестов изменённых пакетов, и только когда ветка относительно `origin/dev`
меняет `scripts/` или `.github/`. Контуру нужны PostgreSQL и Redis: без
доступной БД предохранитель пропускает его с предупреждением, а `FULL=1`
запускает его всегда и без БД завершается ошибкой. Ошибка любого
эксплуатационного контракта блокирует отправку ветки. Подробнее — в разделе
[Git hooks](local-development.md#git-hooks).

```bash
DATABASE_URL=<isolated-postgres> \
TEST_DATABASE_URL=<isolated-postgres> \
REDIS_URL=<isolated-redis> \
TEST_REDIS_URL=<isolated-redis>/15 \
pnpm test:scripts
```

### Tier 3 — end-to-end (e2e)

Drives the **live panel** over HTTPS, uses the **real host bridge** RPC surface, creates an actual Docker container, boots Squad, verifies RCON AUTH succeeds with a real `ShowServerInfo` JSON response, edits configs, gracefully stops. This is the suite the project bets correctness on. Excluded from `pnpm turbo run test`.

Locations:

- [`apps/api/test/e2e/install-lifecycle.e2e.test.ts`](../../apps/api/test/e2e/install-lifecycle.e2e.test.ts) — full create → install (real `depot_update`) → start → RCON connect → config save → stop → delete. 2–3 min per run.
- [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) — every whitelisted RPC method's success + forbidden paths. 10–30 s.

Run:

```bash
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=s_019dbaa5-...
pnpm --filter @squad/api test:e2e
```

`vitest.e2e.config.ts` runs serially with a 15 min global timeout.

## Coverage reporting

Every TS package (`@squad/api`, `@squad/web`, `@squad/db`, `@squad/shared-config`, `@squad/shared-types`, `@squad/bridge-client`, `@squad/worker-rcon`, `@squad/worker-log-ingest`, `@squad/worker-metrics-sampler`) ships a `vitest.config.ts` with a `coverage.thresholds` block. The Go bridge is excluded — it uses `go test -race` separately.

Run coverage locally:

```bash
# all TS packages, with coverage table + lcov output
DATABASE_URL=<...> pnpm test:cov

# single package
DATABASE_URL=<...> pnpm --filter @squad/api exec vitest run --coverage
```

CI (`ci.yml`, on `master` pushes and dispatches) runs the `test:cov` list through [`scripts/ci-test-shard.sh`](../../scripts/ci-test-shard.sh) in three kinds of jobs:

- `test-api` splits the API suite by test file over four VMs (`vitest run --shard=<i>/4`) and `test-web` splits the web suite over two. A shard sees only part of its suite, so it runs with the thresholds switched off and uploads a vitest blob report; the `gate` job merges the blobs with `vitest --merge-reports --coverage`, which enforces the thresholds below on the merged coverage of the whole suite.
- `test-packages` runs every other package whole under its own thresholds, split over three shards (`bash scripts/ci-test-shard.sh packages <i> 3`): each shard takes every third package of the longest-first order, so each starts with one of `@squad/db`, `worker-log-ingest`, `worker-rcon`; inside a shard four packages run at a time, and one failing package does not stop the others. Unlike api and web, a package is never split, so there is no blob to merge.

No coverage report is uploaded as an artifact. To reproduce one shard locally, run `bash scripts/ci-test-shard.sh api 1 4` with the database variables set; it writes `apps/api/.vitest-reports/blob-1-4.json` (git-ignored), and `pnpm exec vitest run --merge-reports --coverage` inside `apps/api` merges whatever blobs are there.

Merged **branch** percentages are not comparable with an unsharded run of the same suite: on 2026-09-26 the API suite measured 92.7 % merged against 77.0 % unsharded, while lines, statements and functions agreed within 0.3 pp (web: 84.7 % against 84.2 %). Ratchet a branch threshold against an unsharded `pnpm --filter <package> exec vitest run --coverage`.

Threshold values reflect the measured baseline at the time coverage was introduced, minus a 5 pp safety margin. They are intentional floors, not targets — ratchet them upward as new tests are added.

| Package | lines | funcs | branches | stmts |
|---|---|---|---|---|
| `@squad/api` | 70 | 70 | 60 | 70 |
| `@squad/web` | 1 | 17 | 83 | 1 |
| `@squad/db` | 72 | 12 | 45 | 72 |
| `@squad/shared-config` | 68 | 80 | 65 | 68 |
| `@squad/shared-types` | 48 | 10 | 45 | 48 |
| `@squad/bridge-client` | 8 | 60 | 70 | 8 |
| `worker-rcon` | 12 | 68 | 77 | 12 |
| `worker-log-ingest` | 31 | 68 | 74 | 31 |
| `worker-metrics-sampler` | 34 | 62 | 55 | 34 |

Low web thresholds reflect that most page/component tests currently validate imports while runtime behavior is covered by Playwright. The web function floor was re-baselined to 17% on 2026-07-04 after the page surface expanded; keep it at or above the measured baseline and ratchet it upward as behavioral component tests are added.

## Definition of "fixed"

If you claim a bug is fixed or a feature is shipped, the corresponding test is in the right tier and passes on your machine. "Works on my manual retry" is not fixed. `pnpm turbo run test` green AND `pnpm --filter @squad/api test:e2e` green is fixed.

## Adding tests

- A new route → at least one positive integration test (`fastify.inject()` against a fake bridge) and one negative auth test.
- A new bridge RPC method → unit (Go) for the validator + e2e case in `bridge-rpc.e2e.test.ts` covering success AND forbidden paths.
- A change to the install/start/stop flow → an updated `install-lifecycle.e2e.test.ts`.
- A new event type → a unit test for the producer + a consumer test that exercises idempotency.

## Test isolation

Tests in `apps/api/test/*.test.ts` run against **isolated Postgres databases** cloned from a once-migrated template, so a run never mutates the operator's real DB. `worker-setup.ts` points `DATABASE_URL`/`TEST_DATABASE_URL` at a database of the test file's own and clones it only when the file's source reads those variables, calls `hostDbUrl()` or builds a `reusePublicSchema` harness; every `buildIntegrationApp()` call clones its own database as well. Redis has no default: `TEST_REDIS_URL` must name an isolated Redis (for example `redis://127.0.0.1:<port>/15`), and `hostRedisUrl()` in `apps/api/test/integration/isolated-db.ts` throws when it is unset, because the harness flushes logical databases and a fallback to `127.0.0.1:6379` would wipe the local stack's data. `test-isolation.regression.test.ts` enforces the scoping rules below — they remain non-negotiable for any test that mutates `players`/`roles`/`panel_meta` directly.

Database-heavy package suites — `@squad/db` and the workers `automation`, `clan-guard`, `event-partition`, `log-ingest`, `rcon`, `role-expirer` and `seed-reward` — run their files in parallel, each Vitest worker slot on its own copy of one migrated database. The package's `globalSetup` calls `setupPackageTemplateDatabase()` (`packages/db/test/helpers/package-template.ts`), which migrates a `sqworker_<run>_<package>` template once per run and hands its URL to the workers through Vitest `provide`/`inject`, so no test ever connects to the template itself. The `clone-per-worker.ts` setup file then points `DATABASE_URL` and `TEST_DATABASE_URL` at `<template>__w<VITEST_POOL_ID>`, created with `CREATE DATABASE … TEMPLATE` by the slot's first file and reused by the files that run after it in that slot — files that run at the same time never share rows. Teardown drops the template together with its clones, and the next run of the same package sweeps whatever a crashed run left behind.

The worker packages add `apps/workers/_test-shared/redis-per-worker.ts`, which gives each slot its own Redis logical database (1–7; 0 belongs to the local stack, 8–15 to the API suite) through `REDIS_URL`, `TEST_REDIS_URL` and `TEST_REDIS_DB`, so the worker a contract test spawns never shares streams, consumer groups or heartbeat keys with another file. `worker-ban-sync`, which has no database of its own, uses only this Redis setup; its one DB-backed file, `merge.integration.test.ts`, writes a uniquely named `external_ban_sources` row (and its bans) to `DATABASE_URL` and deletes them afterwards. `VITEST_MAX_FORKS` (default 4) bounds the number of slots in all of these packages, and with it the clones and connections a run holds.

### Harness lifetime

Build the integration harness **once per file** — `buildIntegrationApp()` in `beforeAll`, `h.cleanup()` in `afterAll` — never in `beforeEach`. Each build clones a database, registers every route and drops the database again, about half a second per call; when 80 files did it per test, that alone was 73% of the api suite's test time. Keep tests independent with unique fixtures (`testSteamId()`, generated names and ids) and, where a test asserts over a whole table, reset exactly the rows it depends on in a `beforeEach` (for example `h.db.delete(issues)` in the issue filter suite). `harness-per-file.regression.test.ts` fails the suite when a test file builds the harness in `beforeEach`.

### Why it matters

Per-worker cloning keeps the operator's panel DB safe from test mutations, but files that share a worker's clone can still corrupt each other: a test that calls `update(players).set({ roleId: null })` without filtering to test-only steam IDs strips the Owner role for every other test in that worker. Historically the suite ran directly against the operator DB and this stripped a real admin's Owner role mid-run — the scoping convention exists so that never recurs.

### The TEST_STEAM_BASE convention

All test players must use steam IDs from the reserved range `76561197999000000` – `76561197999999999`. Real Steam IDs are never issued in this range. The helper enforces this:

```ts
import { testSteamId } from './helpers/snapshot-restore.js';

const PLAYER_A = testSteamId(1);    // 76561197999000001n
const PLAYER_B = testSteamId(2);    // 76561197999000002n
```

`testSteamId(suffix)` throws immediately if the suffix is out of range (0–999999).

### The snapshot / mask / restore pattern

Any test that must mutate `panel_meta.first_owner_claimed` or temporarily clear the Owner role from live players (to test the first-claim path) must use the helpers in `apps/api/test/helpers/snapshot-restore.ts`:

```ts
import {
  type LiveStateSnapshot,
  maskLiveOwners,
  restoreLiveOwners,
  snapshotLiveOwnerState,
} from './helpers/snapshot-restore.js';

let liveSnapshot: LiveStateSnapshot;

beforeAll(async () => {
  liveSnapshot = await snapshotLiveOwnerState(db);
});

beforeEach(async () => {
  await maskLiveOwners(db, liveSnapshot);   // hides real Owners + resets flag
});

afterEach(async () => {
  await restoreLiveOwners(db, liveSnapshot); // restores Owners + original flag
});
```

`snapshotLiveOwnerState` reads the current Owner role ID, the list of real Owner steam IDs, and the `first_owner_claimed` flag in one pass. `maskLiveOwners` clears them; `restoreLiveOwners` puts them back exactly.

### Regression guard

`apps/api/test/test-isolation.regression.test.ts` runs as part of the normal `pnpm --filter @squad/api test` suite and greps test files for unguarded mutations of shared tables. If a new test file introduces a `delete(players)` or `update(panelMeta)` without a test-ID filter, the guard fails the suite immediately with a message pointing to this document.

To legitimately exclude a file from the guard (e.g. it uses `createIsolatedSchema()`), add it to the exclusion list inside that test file.

## Linters and type checkers

Treat as part of the test suite. The pre-commit hook runs Biome on the staged files and `gofmt -s` plus `go vet` on staged bridge files; the pre-push checklist runs Biome over the source tree and typechecks the packages changed since `origin/dev` and their dependents; CI runs all of them in full. See [Git hooks](local-development.md#git-hooks).

```bash
pnpm exec biome check .                                 # lint + format
pnpm turbo run typecheck                                # TS strict + `go build` on the bridge
cd apps/bridge && GOOS=linux GOARCH=amd64 go vet ./...  # also enforced by pre-commit
```

Where a package has a `tsconfig.test.json` (`@squad/api`, `@squad/bridge-client`, `@squad/chat-ingest`, `@squad/diag`, `@squad/shared-types`, `@squad/steam-api`), `typecheck` is one incremental `tsc -p tsconfig.test.json` over `src` and `test`, not a pass over `src` followed by one over everything. It keeps `declaration: true`, so declaration-emit errors in `src` still fail it; the `rootDir`/composite checks of `tsconfig.json` still run in `build`. The build info is written to `.cache/typecheck.tsbuildinfo` (git-ignored) and is a Turbo output of the task.

### Turbo caching of builds and tests

- `build` hashes everything in the package except test files and test-only configs (`**/*.test.*`, `test/`, `tests/`, `e2e/`, `vitest*.config.*`, `tsconfig.test.json`, …). `@squad/db` also leaves out `drizzle/`, `sql/` and `drizzle.config.ts`, and `@squad/web` its test setup, because the build never reads them. A test-only edit does not rebuild the package or anything downstream; a new migration does not rebuild `@squad/db` and its dependents.
- `test`, `test:unit` and `test:integration` hash the package plus `packages/db/test/helpers`, `packages/db/drizzle` and `packages/db/sql`, which other packages' suites read, and depend on `^build` (Turbo sees a dependency's sources only through that edge). Only the worker packages also depend on their own `build`, because their contract tests start `dist/index.js` under plain Node; the other packages' suites resolve `@squad/*` to source through the `development` export condition. A new package inherits the safe default (`build` and `^build`); list it in its own `turbo.json` to drop the own build once its tests are known not to execute `dist/`.
