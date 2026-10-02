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

- `apps/api/**/*.test.ts` — only the service-free files, selected by content (see below). Most of the package is Tier 2: the full suite's global setup (`test/integration/global-setup.ts`) builds a migrated template database before any file runs, so a file that never touches the database still needs Postgres to be reachable under `pnpm --filter @squad/api test`
- `apps/bridge/internal/**/*_test.go`
- `packages/**/test/*.test.ts`
- `apps/workers/**/test/*.test.ts`

Run:

```bash
pnpm turbo run test        # every package; DB- and Redis-backed suites need the services (see below)
pnpm turbo run test:unit   # only the packages whose suites need no services
```

`test:unit` exists only in packages whose selected suites run without Postgres or Redis: `@squad/shared-config`, `@squad/shared-types`, `@squad/diag`, `@squad/bridge-client`, `@squad/chat-ingest`, `@squad/steam-api`, `@squad/db`, whose script unsets `DATABASE_URL`/`TEST_DATABASE_URL` so its database suites skip (with a warning each) even when the variables are exported, and `@squad/api`, which runs only part of its suite (next section). The workers have no `test:unit`: their contract tests connect to Postgres and Redis. The Go bridge's `test:unit` needs a Linux host with `go` on `PATH`.

#### The API's service-free set

`pnpm --filter @squad/api test:unit` runs [`vitest.unit.config.ts`](../../apps/api/vitest.unit.config.ts), which has no `globalSetup` and no setup file and therefore needs no database, Redis or Docker. Which files it runs is computed, never listed, by [`vitest.test-sets.ts`](../../apps/api/vitest.test-sets.ts): a test file belongs to the service set when its own source, or the source of any test-support file it imports (transitively, under `apps/api/test/` or `packages/db/test/helpers/`), names `buildIntegrationApp`, `reusePublicSchema`, `createDatabaseClient`, a `describeIf*` gate, `DATABASE_URL`, `REDIS_URL`, `hostDbUrl` or `ensureWorkerDatabase`. Every other file is in the unit set. The match is deliberately over-inclusive — a file that merely names `DATABASE_URL` as data stays in the service set — because a false positive costs one file in the fast run, while a false negative would make the local gate fail for a missing service. Imports into `src/` are not followed.

`apps/api/test/test-sets.guard.test.ts` pins the split: every test file the full suite collects is in exactly one set, so a new file cannot fall between them, and the unit config runs exactly the unit set. The full suite in CI still runs both sets; `test:unit` only adds a fast subset for machines without services, and the [pre-push checklist](ci.md#local-pre-check) runs it for an `apps/api` change when no database is available. A unit-set test must therefore stay service-free: the moment it starts using the harness or a database variable it moves to the service set by itself.

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

### Operational script checks

`pnpm test:scripts` is a separate sequential suite for the management
scripts that do not belong to a single workspace package. It verifies:

- the safe preflight/confirmation/fail-closed boundaries of `bootstrap`,
  `install-host-bridge`, `deploy`, `rebuild` and `uninstall` on temporary
  copies, with every host command replaced by logging stubs;
- the real length-prefixed JSON protocol of `verify-bridge` over a temporary
  Unix socket;
- `verify-audit-chain.ts` and the real `audit_log` migration triggers against
  separate temporary PostgreSQL databases.

The operations-script contracts are laid out one file per script
(`scripts/bootstrap.test.ts`, `deploy-stand.test.ts`, `deploy-entry.test.ts`,
`rebuild.test.ts`, `restore.test.ts`, `uninstall.test.ts`, `verify-bridge.test.ts`,
`pre-push-checklist.test.ts`, `new-test-db.test.ts` and others). The shared scaffolding
(`run`, `runAsync`, host-command shims, temporary directories) lives in
`scripts/test-helpers/ops.ts`. A new file must be added to the `test:scripts` command
in `package.json`: `scripts/static-contracts.test.ts` checks that list.
The files run strictly one after another (`--test-concurrency=1`): every script
invocation in them is limited to 15 seconds, and inside the files the `deploy` and
`rollback` blocks already run in parallel, so running the files in parallel would make
that limit depend on machine load.

For a full local run, pass both pairs of URLs. The audit suite
tolerates a missing PostgreSQL only outside CI; in CI a missing database fails
the suite. The workflow first applies the migrations and only then runs
`pnpm test:scripts`.

`scripts/pre-push-checklist.sh` runs this suite as its last item, after the
tests of the changed packages, and only when the branch changes
`scripts/` or `.github/` relative to `origin/dev`. The suite needs PostgreSQL and Redis: without
an available database the guard skips it with a warning, while `FULL=1`
always runs it and fails without a database. A failure of any
operational contract blocks the push. For details, see the section
[Git hooks](local-development.md#git-hooks).

```bash
DATABASE_URL=<isolated-postgres> \
TEST_DATABASE_URL=<isolated-postgres> \
REDIS_URL=<isolated-redis> \
TEST_REDIS_URL=<isolated-redis>/15 \
pnpm test:scripts
```

### Repository contract tests

`scripts/infra-contracts/*.test.ts` are vitest suites that read repository files — `docker/compose.yml` and the stand compose files, the Dockerfiles, the Caddyfile, every workspace `package.json` — and assert the hardening, image-pinning, Redis-auth, bridge-permission and runtime-dependency contracts. They are not API tests and need no database, which is why they live outside `apps/api/test`: there they were collected by the API shards behind the Postgres-cloning global setup. They run as the last step of `pnpm test:scripts` (`vitest run --root scripts/infra-contracts`, with `vitest` a root dev dependency), so the CI `scripts` job runs them; `scripts/static-contracts.test.ts` fails when that step disappears from the command. Run them alone, without any service:

```bash
pnpm exec vitest run --root scripts/infra-contracts
```

A change under `docker/` is therefore checked by the `scripts` job, not by the API shards. There is no test that pins prose in `docs/`: a documentation sentence is reviewed, not asserted (the former `security-md-audit-claim` test also failed on any legitimate `pnpm audit` step in CI).

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

- `test-api` splits the API suite by test file over four VMs (`vitest run --shard=<i>/4`) and `test-web` splits the web suite over two. A shard sees only part of its suite, so it runs with the thresholds switched off and uploads a vitest blob report; the `coverage` job merges the blobs with `vitest --merge-reports --coverage`, which enforces the thresholds below on the merged coverage of the whole suite.
- `test-packages` runs every other package whole under its own thresholds, split over three shards (`bash scripts/ci-test-shard.sh packages <i> 3`): the packages are assigned longest-processing-time-first onto the least-loaded shard using the `WEIGHTS` table in `ci-test-shard.sh` (seconds per package measured on CI; a package without an entry weighs the table's median), so the shards finish together and each starts with one of `@squad/db`, `worker-log-ingest`, `worker-rcon`; every run ends with a `package=seconds` list in the table's format, so refreshing the weights is a copy from the slowest recent `test-packages` logs; inside a shard four packages run at a time, and one failing package does not stop the others. Unlike api and web, a package is never split, so there is no blob to merge.

Sharding is by file, not by duration, so one slow file lands on one shard whole: the permission-matrix sweep (about 5,200 sequential requests) is therefore split over `permission-matrix.part-1..4.test.ts`, and a new suite of that size should be split the same way (see [permission-matrix.*.test.ts](../components/api/testing.md)).

No coverage report is uploaded as an artifact. To reproduce one shard locally, run `bash scripts/ci-test-shard.sh api 1 4` with the database variables set; it writes `apps/api/.vitest-reports/blob-1-4.json` (git-ignored), and `pnpm exec vitest run --merge-reports --coverage` inside `apps/api` merges whatever blobs are there.

Merged **branch** percentages are not comparable with an unsharded run of the same suite: on 2026-09-26 the API suite measured 92.7 % merged against 77.0 % unsharded, while lines, statements and functions agreed within 0.3 pp (web: 84.7 % against 84.2 %). Ratchet a branch threshold against an unsharded `pnpm --filter <package> exec vitest run --coverage`.

Threshold values reflect the measured baseline at the time coverage was introduced, minus a 5 pp safety margin. They are intentional floors, not targets — ratchet them upward as new tests are added.

| Package | lines | funcs | branches | stmts |
|---|---|---|---|---|
| `@squad/api` | 70 | 70 | 60 | 70 |
| `@squad/web` | 85 | 72 | 83 | 85 |
| `@squad/db` | 72 | 12 | 45 | 72 |
| `@squad/shared-config` | 68 | 80 | 65 | 68 |
| `@squad/shared-types` | 48 | 10 | 45 | 48 |
| `@squad/bridge-client` | 8 | 60 | 70 | 8 |
| `worker-rcon` | 12 | 68 | 77 | 12 |
| `worker-log-ingest` | 31 | 68 | 74 | 31 |
| `worker-metrics-sampler` | 34 | 62 | 55 | 34 |

Web page tests are behavioural: every `page.tsx` has a `page.test.tsx` next to it that renders the real page in happy-dom with testing-library and a stubbed `fetch`, and asserts the loading, ready, empty and error states and at least one key interaction through the visible Russian text (template: `apps/web/src/app/(dashboard)/all-players/page.test.tsx`). Components and helpers keep their own `*.test.tsx` / `*.test.ts` beside them. Playwright covers the live stack on top of this. Import-only smoke tests (a module exports a default) are not written: `tsc` and `next build` already prove that. The thresholds were re-baselined on 2026-10-01 to the unsharded measurement (lines and statements 90.5 %, functions 76.3 %, branches 86.7 %) minus a safety margin; ratchet them upward as tests are added.

## Definition of "fixed"

If you claim a bug is fixed or a feature is shipped, the corresponding test is in the right tier and passes on your machine. "Works on my manual retry" is not fixed. `pnpm turbo run test` green AND `pnpm --filter @squad/api test:e2e` green is fixed.

## Adding tests

- A new route → at least one positive integration test (`fastify.inject()` against a fake bridge) and one negative auth test.
- A new bridge RPC method → unit (Go) for the validator + e2e case in `bridge-rpc.e2e.test.ts` covering success AND forbidden paths.
- A change to the install/start/stop flow → an updated `install-lifecycle.e2e.test.ts`.
- A new event type → a unit test for the producer + a consumer test that exercises idempotency.

## Test isolation

Tests in `apps/api/test/*.test.ts` run against **isolated Postgres databases** cloned from a once-migrated template, so a run never mutates the operator's real DB. `worker-setup.ts` points `DATABASE_URL`/`TEST_DATABASE_URL` at a database of the test file's own and clones it only when the file's source reads those variables, calls `hostDbUrl()` or builds a `reusePublicSchema` harness; every `buildIntegrationApp()` call clones its own database as well. Redis has no default: `TEST_REDIS_URL` must name an isolated Redis (for example `redis://127.0.0.1:<port>/15`), and `hostRedisUrl()` in `apps/api/test/integration/isolated-db.ts` throws when it is unset, because the harness flushes logical databases and a fallback to `127.0.0.1:6379` would wipe the local stack's data. `test-isolation.regression.test.ts` enforces the scoping rules below — they remain non-negotiable for any test that mutates `players`/`roles`/`panel_meta` directly.

Locally, `eval "$(bash scripts/new-test-db.sh <slug>)"` provisions everything these suites read: a migrated `test_<slug>` database in the compose Postgres exported as `DATABASE_URL` and `TEST_DATABASE_URL`, and `TEST_REDIS_URL` with the `REDIS_PASSWORD` from `.env` and a logical database in 8–15 chosen from the slug. The api harness replaces that database index with `8 + (VITEST_POOL_ID % 8)` per worker slot, so two worktrees that run the api suite at once on one Redis flush each other's databases; give each its own stack with `COMPOSE_PROJECT_NAME` and `REDIS_HOST_PORT`. `scripts/prune-test-dbs.sh` removes the databases of deleted worktrees. Setup and the multi-worktree variables are in [local-development.md](local-development.md#develop-and-run-tests-macos-or-linux).

Database-heavy package suites — `@squad/db` and the workers `automation`, `clan-guard`, `event-partition`, `log-ingest`, `rcon`, `role-expirer` and `seed-reward` — run their files in parallel, each Vitest worker slot on its own copy of one migrated database. The package's `globalSetup` calls `setupPackageTemplateDatabase()` (`packages/db/test/helpers/package-template.ts`), which migrates a `sqworker_<run>_<package>` template once per run and hands its URL to the workers through Vitest `provide`/`inject`, so no test ever connects to the template itself. The `clone-per-worker.ts` setup file then points `DATABASE_URL` and `TEST_DATABASE_URL` at `<template>__w<VITEST_POOL_ID>`, created with `CREATE DATABASE … TEMPLATE` by the slot's first file and reused by the files that run after it in that slot — files that run at the same time never share rows. Teardown drops the template together with its clones, and the next run of the same package sweeps whatever a crashed run left behind.

The worker packages add `apps/workers/_test-shared/redis-per-worker.ts`, which gives each slot its own Redis logical database (1–7; 0 belongs to the local stack, 8–15 to the API suite) through `REDIS_URL`, `TEST_REDIS_URL` and `TEST_REDIS_DB`, so the worker a contract test spawns never shares streams, consumer groups or heartbeat keys with another file. `worker-ban-sync`, which has no database of its own, uses only this Redis setup; its one DB-backed file, `merge.integration.test.ts`, writes a uniquely named `external_ban_sources` row (and its bans) to `DATABASE_URL` and deletes them afterwards. `VITEST_MAX_FORKS` (default 4) bounds the number of slots in all of these packages, and with it the clones and connections a run holds.

### Harness lifetime

Build the integration harness **once per file** — `buildIntegrationApp()` in `beforeAll`, `h.cleanup()` in `afterAll` — never in `beforeEach`. Each build clones a database, registers every route and drops the database again, about half a second per call; when 80 files did it per test, that alone was 73% of the api suite's test time. Keep tests independent with unique fixtures (`testSteamId()`, generated names and ids) and, where a test asserts over a whole table, reset exactly the rows it depends on in a `beforeEach` (for example `h.db.delete(issues)` in the issue filter suite). `harness-per-file.regression.test.ts` fails the suite when a test file builds the harness in `beforeEach`.

### Waiting in tests

Never sleep for a fixed time (`await new Promise((r) => setTimeout(r, 200))`) to let something happen or to prove that it did not: the first is a flake on a slow runner, the second passes whether or not the code is right. Wait for the thing itself.

- **Something should happen:** poll the condition with `vi.waitFor(() => expect(...))`, or await the event. A poll loop is fine; a blind sleep is not.
- **Something should not happen over a WebSocket:** `wsRoundTrip(ws)` from `test/helpers/ws-round-trip.ts` resolves when the server answers a ping, and the server answers after every frame it had already queued for that socket, so a frame that was going to arrive has arrived. A broadcast sentinel event (`flushLiveBus` in `media-uploaded-live.test.ts`) does the same for several sockets.
- **Something should not be written to `audit_log`:** the hook writes after the response and writes are serialised on the hash chain, so fire one more audited request and wait for its row; a missing row for the earlier request is then really missing.
- **A request should be parked on a lock:** `waitForBlockedBackendOn(h.url, timeout, count)` in `test/helpers/row-lock.ts` polls `pg_stat_activity` for `count` backends waiting on a lock, over its own connection (the harness pool holds two, and the requests under test occupy them). `raceAgainstOpenTransaction` takes the same `minBlocked` count.
- **A route answers 409 before it claims anything:** assert the state it would have changed (status, bridge calls) right after the reply; no background work exists to wait for.
- **Redis TTLs and idle times** run on Redis's clock, not on fake timers: poll for the effect (`XAUTOCLAIM` returning the entry, renewals counted through a spy on `eval`).
- **Timers in the code under test** (`setInterval` renewers): fake only those with `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` and `advanceTimersByTimeAsync`.

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
