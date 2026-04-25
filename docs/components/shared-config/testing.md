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
| `metrics-pack.test.ts` | Pack to 8-integer tuple; round-trip within ±0.01 tolerance; stable stream constants; negative clamping |
| `permissions.test.ts` | Key uniqueness; every category in `PERMISSION_CATEGORIES`; `dangerous`/`unimplemented` are `true` or absent (never `false`); non-empty labels; `PERMISSION_KEYS` derivation; `isPermissionKey` type guard |
| `rcon-host.test.ts` | Explicit creds win; fallback to `RCON_HOST_DEFAULT`; fallback to `127.0.0.1`; empty-string treated as null |
| `role-colors.test.ts` | Palette matches `roles_color_palette` SQL CHECK in `0009_panel_rbac.sql`; exactly 16 colors; all unique |

## Key edge cases

**`role-colors.test.ts`** reads the actual SQL migration file with `readFileSync` to extract the CHECK constraint. This catches palette drift without requiring a running database. The test fails if the migration file is absent or the constraint format changes.

**`log-stream-sink.test.ts`** uses a fake Redis with a call-capture array to verify the XADD argument shape. It also verifies that the error-warning latch is per-instance — two sinks with failing Redis each warn exactly once, not more.

**`permissions.test.ts`** catches the invariant that `dangerous` and `unimplemented` flags are `true | undefined` only. A future refactor changing them to `false` would break the RBAC UI assumption that the field's presence alone signals the flag.

## What is not covered

- `configFileClass` — return values are trivially derived from the two `includes()` checks; covered implicitly by callers in integration tests.
- `heartbeat.ts` — `startHeartbeat` is covered by the worker integration tests in `apps/workers/rcon/test/`.
- The `node:stream` browser-bundle constraint — verified by the Next.js build (`pnpm turbo run build`), not a unit test.
