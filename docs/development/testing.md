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
pnpm turbo run test
```

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
  `install-host-bridge`, `deploy-tk104`, `rebuild` и `uninstall` на временных
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

Этот же контур входит в `scripts/pre-push-checklist.sh`: локальный
предохранитель сначала подготавливает изолированную мигрированную БД, затем
запускает `pnpm test:scripts` и только после него пакетные тесты. Ошибка любого
эксплуатационного контракта блокирует отправку ветки.

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
- `test-packages` runs every other package whole under its own thresholds, four at a time, starting the longest suites (`@squad/db`, `worker-log-ingest`, `worker-rcon`) first; one failing package does not stop the others.

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

Tests in `apps/api/test/*.test.ts` run against a **per-worker isolated Postgres database** — each Vitest worker clones a fresh database from a once-migrated template (`worker-setup.ts` overrides `DATABASE_URL`/`TEST_DATABASE_URL`), so a run never mutates the operator's real DB. Test files that share a worker still share that worker's clone, and `test-isolation.regression.test.ts` enforces the scoping rules below — so they remain non-negotiable for any test that mutates `players`/`roles`/`panel_meta` directly (i.e. not via the harness's per-test isolated database).

Database-heavy package suites use `globalSetup` with `createIsolatedPackageTestDatabase()` to provision one migrated `sqworker_*` database for the whole package run. Both `DATABASE_URL` and `TEST_DATABASE_URL` are replaced before test modules load, and the database is dropped during teardown. Packages whose contract and integration files can sweep the same rows, including `worker-clan-guard`, also disable file parallelism so tests inside that package cannot change each other's cooldown or deduplication state.

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

Treat as part of the test suite. Pre-commit (`lefthook`) and CI both run them.

```bash
pnpm exec biome check .         # lint + format
pnpm turbo run typecheck        # TS strict + `go build` on the bridge
cd apps/bridge && go vet ./...  # also enforced by pre-commit
```
