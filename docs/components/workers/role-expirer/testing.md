# Testing

The package's Vitest config provisions a migrated template database once per
run and gives every worker slot its own clone and its own Redis database, so the
suite needs Postgres and Redis. Provision an isolated database, build the
worker (the contract test starts `dist/index.js`), and run the suite:

```bash
eval "$(bash scripts/new-test-db.sh role-expirer)"
pnpm --filter @squad/worker-role-expirer build
pnpm --filter @squad/worker-role-expirer exec vitest run
```

See [local-test-setup.md](../../../development/local-test-setup.md) for the
database helper. Suites declared with `describeIfDb` skip with a warning when
`DATABASE_URL` is unset locally and fail the run when `CI` is set.

## Test files

| File | Needs | Covers |
|---|---|---|
| `tick.test.ts` (3 tests) | none | Expiry pass with injected dependencies: clear and notify, a renewal winning after the scan, per-player isolation of a failing session notification. |
| `reminders.test.ts` (8 tests) | none | Smallest crossed window, dedup, re-arming after renewal, live-bus frame, the player row, out-of-window grants, failure diagnostic. |
| `renewal.test.ts` (12 tests) | none | Charge and schedule advance, balance and role failures, batch isolation (#991), `dueAt` pass-through (#990), failure diagnostic. |
| `env.test.ts` (6 tests) | none | `positiveIntEnv` and `requiredTickIntervalMs` (#984). |
| `guard-against-overlap.test.ts` (3 tests) | none | Overlap guard from `@squad/worker-kit`. |
| `find-expired-assignments.integration.test.ts` (6 tests) | Postgres | Owner exclusion, renewal race, one outbox row per active server, audit and session delete in the same transaction (#992), outbox rollback, subscription guard (#989). |
| `renewal.integration.test.ts` (4 tests) | Postgres | Funded and unfunded renewal in one pass, two racing passes charge once, audit row written with the charge and rolled back with it. |
| `renewal-escalation.integration.test.ts` (1 test) | Postgres | A tier re-pointed at a panel-access or system role ends the subscription without granting it. |
| `session-revoke.integration.test.ts` (3 tests) | Postgres | Session delete and `session.revoked` frames, no stale cache key under a concurrent session create (#996), no-op without sessions. |
| `contract.test.ts` (2 tests) | built `dist`, Redis | Heartbeat key `worker:heartbeat:role-expirer` appears with a TTL of at most 30 s; repeated SIGTERM exits 0. |

The integration suites mock Redis; only Postgres is real there.

API tests around role assignment metadata run in the API package:

```bash
pnpm --filter @squad/api exec vitest run test/integration/vip-expiry-reminders.test.ts test/integration/player-role-assign.test.ts test/integration/users-list.test.ts
```
