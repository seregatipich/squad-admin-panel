# `shared-config` — testing

## Running tests

```bash
pnpm --filter @squad/shared-config test
```

Or from the root:

```bash
pnpm turbo run test
```

## Test files

All tests live in `packages/shared-config/test/` and run under vitest.

| File | What it covers |
|---|---|
| `log-stream.test.ts` | `encodeLogEntry`/`decodeLogEntry` round-trip with all fields; field omission when `serverId`/`ctx` absent; unknown source-code throws; stable source/level code mapping |
| `log-stream-sink.test.ts` | pino → XADD fields encoding; `src` field routing to per-record source; `serverId` passthrough; Redis error swallowing; minimum-level filter; pino-http meta key stripping; per-instance error latch |
| `graceful-shutdown.test.ts` | Ранний `SIGTERM` сохраняется до готовности; повторные сигналы выполняют очистку один раз; ошибка очистки возвращает код `1` |
| `metrics-pack.test.ts` | Pack to 8-integer tuple; round-trip within ±0.01 tolerance; stable stream constants; negative clamping |
| `permissions.test.ts` | Key uniqueness; every category in `PERMISSION_CATEGORIES`; `dangerous`/`unimplemented` are `true` or absent (never `false`); non-empty labels; `PERMISSION_KEYS` derivation; `isPermissionKey` type guard |
| `rcon-host.test.ts` | Explicit creds win; fallback to `RCON_HOST_DEFAULT`; fallback to `127.0.0.1`; empty-string treated as null |
| `role-colors.test.ts` | Palette matches `roles_color_palette` SQL CHECK in `0009_panel_rbac.sql`; exactly 16 colors; all unique |
| `property/registry.test.ts` | Property-based (`@fast-check/vitest`): every registered key passes `isPermissionKey`; unregistered strings are rejected; every subset of keys is a valid permission set. |

## Key edge cases

**`role-colors.test.ts`** reads the actual SQL migration file with `readFileSync` to extract the CHECK constraint. This catches palette drift without requiring a running database. The test fails if the migration file is absent or the constraint format changes.

**`log-stream-sink.test.ts`** uses a fake Redis with a call-capture array to verify the XADD argument shape. It also verifies that the error-warning latch is per-instance — two sinks with failing Redis each warn exactly once, not more.

**`permissions.test.ts`** catches the invariant that `dangerous` and `unimplemented` flags are `true | undefined` only. A future refactor changing them to `false` would break the RBAC UI assumption that the field's presence alone signals the flag.

**`graceful-shutdown.test.ts`** intentionally exercises the signal that arrives
before the worker finishes its first asynchronous startup pass. Process-level
worker contracts additionally wait for a fresh heartbeat, send `SIGTERM`
twice and require exit code `0`.

## Mutation testing

```bash
pnpm --filter @squad/shared-config test:mutation
```

Or from the root:

```bash
pnpm turbo run test:mutation --filter=@squad/shared-config
```

This runs Stryker (`stryker.config.json`) against `src/**/*.ts` using the vitest test runner (`vitest.stryker.config.ts`) and writes an HTML report to `packages/shared-config/reports/mutation/mutation.html`. It now runs in three automated places, the same as every other test script in this repo: the `test:mutation` task in the root `turbo.json`, the "Run shared-config mutation tests (Stryker)" step in `.github/workflows/ci.yml`'s `node` job, and the mutation-testing step in `scripts/pre-push-checklist.sh`.

`stryker.config.json`'s `thresholds.break` is `0`, so this gate currently only fails on a Stryker crash or a config/dependency error (e.g. in the `ajv`/`fast-uri` chain underneath `@stryker-mutator/core`) — it does not yet fail the build on a low mutation score. The actual mutation score (currently 64.72%) is below the configured `low`/`high` thresholds (75/90); raising `break` to gate on score is a deliberate follow-up, not automatic.

## What is not covered

- `configFileClass` — return values are trivially derived from the two `includes()` checks; covered implicitly by callers in integration tests.
- `heartbeat.ts` — `startHeartbeat` and the shutdown controller are additionally covered by the shared process contracts in all worker packages.
- The `node:stream` browser-bundle constraint — verified by the Next.js build (`pnpm turbo run build`), not a unit test.
