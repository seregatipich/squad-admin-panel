# 100% Sentrux Test Coverage

**Date**: 2026-05-04
**Goal**: Close all sentrux `test_gaps` — every source file in the import graph has a corresponding test.
**Baseline**: 616 source files, 120 tested (19.5%), 496 untested.

## Principles

1. **Exclude noise, test what matters.** Auto-generated files (`.next/types/`) are excluded from the scan. Declarative files (DB schemas, type-only modules) get lightweight import-validation tests that also serve as regression guards.
2. **No test simplification.** Every test must exercise real behavior — no empty test bodies, no `expect(true).toBe(true)`.
3. **Sentrux is the scoreboard.** `test_gaps` untested count must reach 0 after all work is done. `quality_signal` must not decrease. `check_rules` must remain green.

## Exclusion Strategy

`.next/types/` (29 auto-generated route-type files) must not inflate the untested count. Clean the `.next/` build artifacts before scanning:

```bash
rm -rf apps/web/.next
```

Sentrux scans the filesystem. If `.next/` does not exist, those 29 files drop from the count, bringing the effective baseline to ~587 source files, ~467 untested.

## Tier 1 — Pure Logic Unit Tests

Standalone functions with clear inputs/outputs. Vitest, no mocks needed beyond Redis/DB fakes already in the test harness.

### apps/api/src/lib/

| File | Lines | What to test |
|---|---|---|
| `admins-cfg-sync.ts` | 97 | `syncAdminsCfg()` — parse current cfg, compute diff against DB roles, produce new cfg content. Test: roles in → cfg out, empty roles, malformed input. |
| `auto-prune.ts` | 75 | Prune-eligibility logic, age threshold, dry-run mode. |
| `cleanup-orphans.ts` | 166 | Orphan detection: containers in Docker but not in DB → returns list. Mock bridge responses, assert correct filtering. |
| `log-export.ts` | 178 | Format conversion (JSON/CSV/plain), timestamp ranges, field selection. Pure transform — feed log rows, assert output format. |
| `logger.ts` | 69 | Factory creates pino instance with correct config. Assert log level, redaction, serializers. |

### apps/workers/

| File | Lines | What to test |
|---|---|---|
| `config-sync/src/syncer.ts` | 311 | Core sync loop: read bridge files → diff against DB snapshot → apply writes. Mock bridge + DB, assert write calls match diff. |
| `config-sync/src/audit.ts` | 82 | Audit event shape: given a sync result, produces correct `EventEnvelope`. Assert field mapping. |
| `config-sync/src/db-snapshot.ts` | 46 | Snapshot query: given DB rows, returns `Map<filename, {sha256, content}>`. Mock Drizzle, assert structure. |
| `log-ingest/src/tail.ts` | 72 | Line splitting from raw Docker log stream. Feed chunked buffers, assert line boundaries. |
| `log-ingest/src/publish.ts` | 25 | Redis XADD call shape: given parsed event, assert stream key and payload structure. Mock Redis. |
| `rcon/src/client.ts` | 186 | Connection lifecycle: connect, AUTH, send, reconnect on error. Mock socket, assert packet framing. |
| `rcon/src/persist.ts` | 49 | Redis SET/GET for `rcon:status:{id}`. Mock Redis, assert key format and TTL. |

### apps/web/src/lib/

| File | Lines | What to test |
|---|---|---|
| `api.ts` | ~50 | Fetch wrapper: base URL construction, error status → thrown error, auth header injection. Mock fetch. |
| `dal.ts` | ~80 | Server-side data access: cookie forwarding, response parsing. Mock fetch. |
| `live-bus.ts` | ~40 | EventSource creation, reconnect logic, message parsing. Mock EventSource. |
| `use-live-bus.ts` | ~30 | React hook: subscribes on mount, unsubscribes on unmount. `@testing-library/react` renderHook. |

## Tier 2 — API Plugin Integration Tests

Test via the existing Fastify harness (`buildApp()` + `app.inject()`). The test infrastructure already exists in `apps/api/test/`.

| File | Lines | What to test |
|---|---|---|
| `plugins/health.ts` | 82 | `GET /health` returns `{status, db, redis, bridge}`. Inject with healthy/degraded mocks. |
| `plugins/metrics.ts` | 68 | Metrics collection registers and increments counters. Assert `/metrics` endpoint shape. |
| `plugins/orphan-sweep.ts` | 64 | Sweep fires on interval, calls cleanup-orphans, logs result. Assert bridge call count. |
| `plugins/heartbeat-watch.ts` | 82 | Watch lifecycle: registers timer, fires callback, handles Redis errors. |
| `config.ts` | 38 | Env parsing: required vars throw, defaults apply, sensitive vars redacted. |
| `server.ts` | 136 | Route registration: after build, all expected routes are registered. Already partially tested by smoke.test.ts — need explicit coverage. |

## Tier 3 — React Components & Pages

### Setup

Add `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` to `apps/web` devDependencies. Configure vitest with `jsdom` environment in `apps/web/vitest.config.ts`.

### Components (12 files)

Each component gets a test file at `apps/web/src/components/<Name>.test.tsx`.

| Component | Test focus |
|---|---|
| `AdminsCfgDriftBanner` | Renders when drift detected, hidden when clean. Mock API response. |
| `connection-banner` | Renders on disconnect, hidden on connect. Mock WebSocket state. |
| `DiskBreakdownModal` | Opens/closes, renders disk data, handles empty state. |
| `DockerPruneButton` | Click triggers API call, shows loading state, shows result. |
| `LogConsole` | Renders log lines, auto-scrolls, handles empty state. |
| `LogList` | Renders log entries, pagination, filter application. |
| `LogoutButton` | Click triggers logout API call, redirects. |
| `MetricHistoryChart` | Renders chart with data points, handles empty series. |
| `MetricHistoryModal` | Opens/closes, loads metric data, renders chart. |
| `RestartBridgeButton` | Click triggers restart, confirmation dialog, loading state. |
| `RoleColorDot` | Renders correct color for each role color value. |
| `RoleEditor` | Permission toggles, name editing, save triggers API call. |
| `SidebarNav` | Renders nav items, highlights active route, collapses on mobile. |

### Pages (27 files)

Pages are mostly server components that fetch data and render. Testing strategy:

- **Server components**: Render-smoke tests — mock the `fetch`/`dal` calls, assert the page renders without throwing and contains expected structural elements.
- **Client-heavy pages** (configs editor, events page): More thorough tests with user interaction.

Batch into test files by route group:
- `test/pages/dashboard.test.tsx` — dashboard, audit, logs, users
- `test/pages/servers.test.tsx` — servers list, detail, configs, events, new, archive
- `test/pages/roles.test.tsx` — roles list, detail, new
- `test/pages/players.test.tsx` — players list, detail
- `test/pages/settings.test.tsx` — account, groups, tokens
- `test/pages/auth.test.tsx` — login, no-access, root layout

### Middleware

`apps/web/src/middleware.ts` — test redirect logic: unauthenticated → login, authenticated → dashboard, no-access route for blocked users. Mock `NextRequest`/`NextResponse`.

## Tier 4 — Trivial Import Tests

For type-only and barrel re-export files. One test file per package that imports all exports and asserts they're defined.

| File | Test |
|---|---|
| `api/src/plugins/types.ts` | Import all exported types, assert `typeof` is not undefined for runtime values. |
| `api/src/lib/rcon-host.ts` (2 lines) | Import re-export, assert defined. |
| `api/src/index.ts` | Already starts server — covered by smoke test. Needs explicit import. |
| Worker `index.ts` entry points (12 files) | Contract tests already spawn the process. Add explicit `import` in contract test to register coverage. |
| `packages/db/src/schema/*.ts` (14 files) | One test: `schema-exports.test.ts` that imports every schema file and asserts table names. |
| `packages/db/src/migrate.ts` | Import and assert `migrate` function is defined. |
| `packages/db/drizzle.config.ts` | Import and assert config object shape. |

## Execution Order

| Phase | Tier | Est. files | Prerequisite |
|---|---|---|---|
| 0 | Exclude `.next/` | 29 removed | None |
| 1 | Tier 4 — trivial imports | ~30 files covered | None |
| 2 | Tier 1 — api/lib unit tests | 5 files | None |
| 3 | Tier 1 — worker unit tests | 7 files | None |
| 4 | Tier 1 — web/lib unit tests | 4 files | None |
| 5 | Tier 2 — api plugins | 6 files | None |
| 6 | Tier 3 — web setup | 0 (infra) | @testing-library/react installed |
| 7 | Tier 3 — components | 12 files | Phase 6 |
| 8 | Tier 3 — pages + middleware | 28 files | Phase 6 |
| 9 | Final scan | 0 untested target | All phases |

## Success Criteria

1. `sentrux test_gaps` reports 0 untested source files (after `.next/` exclusion)
2. `sentrux check_rules` passes (0 violations)
3. `sentrux health` quality_signal >= 5404 (no regression from baseline)
4. `pnpm turbo run test` all green
5. `pnpm turbo run typecheck` all green

## Out of Scope

- Line-level code coverage (Istanbul/c8) — sentrux measures file-level structural coverage, not line-level. Line coverage is a separate initiative.
- Refactoring untested code to be more testable — tests wrap existing code as-is.
- New e2e tests in `test/e2e/` — existing e2e suite is not part of this work. Tier 3 uses component/render tests, not browser-driven e2e.
