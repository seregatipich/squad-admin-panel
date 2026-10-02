# worker-ban-sync - Testing

## Running tests

The package is `@squad/worker-ban-sync`. Seven of the 13 files need nothing but Node; the rest need Postgres and/or Redis, and two spawn the built worker (`dist/index.js`), so build first:

```bash
eval "$(bash scripts/new-test-db.sh ban-sync)"
pnpm --filter @squad/worker-ban-sync build
pnpm --filter @squad/worker-ban-sync exec vitest run
```

See [local-test-setup.md](../../../development/local-test-setup.md). Unlike `worker-clan-guard`, this package has no per-slot database clone: every file uses `DATABASE_URL` directly (`_test-shared/load-env.ts` fills it from the repo `.env`, which points at the shared `admin` database, hence `new-test-db.sh`). `vitest.config.ts` runs files in forked workers (`VITEST_MAX_FORKS`, default 4) and loads `_test-shared/redis-per-worker.ts`, which gives each slot its own Redis logical database (1 to 7), because the contract and shutdown tests both start the worker, which shares one heartbeat key and one `bansync:manual` stream.

Run one file, for example the pure unit tests:

```bash
pnpm --filter @squad/worker-ban-sync exec vitest run test/merge.test.ts
```

## Test files

Counts are the number of `it` declarations; the `it.each` in `fetch-source.test.ts` expands to 4 cases.

### Pure unit tests (no database, no Redis)

| File | Tests | What it verifies |
|---|---:|---|
| `adapters.test.ts` | 12 | BattleMetrics default shape and overridden mapping, nickname from the `name` identifier, `json_generic` with `list_path` and dot-paths, records without identity skipped, CSV by header and by index with quoted fields, `parseBanList` dispatch and unknown-format error, out-of-range timestamps skipped, malformed `parser_config` rejected with a descriptive error. |
| `squad-bans-cfg.test.ts` | 6 | Permanent (expiry 0) and temporary bans, admin name from a bracketed prefix and reason from the comment, malformed lines and non-17-digit ids counted as skipped, blank and comment lines ignored, overflowing expiry counted as skipped. |
| `merge.test.ts` | 11 | `planMerge`: new record inserted; `raw` differing only in key order is unchanged (#34); missing `raw` equals the stored `{}`; real `raw` or array-order changes update; identical repeat updates nothing; changed reason or expiry updates; absent ban revoked, never deleted; already revoked not re-revoked; reappearing ban gets `revoked_at` cleared; epoch coalesce for a null `issued_at`; duplicate keys counted and not inserted twice. |
| `tick.test.ts` | 10 | `isDue` (3 cases), `backoffDelayMs` doubling capped at 60 minutes, `runBanSyncTick`: syncs a due source and clears backoff, skips a source that is not due, skips a failed source inside its backoff window, records backoff after a failure, never syncs one source twice at once (#853), stops between sources on shutdown. |
| `sync-source.test.ts` | 8 | Success path (status ok, counters, `bansync.completed`, cache invalidation); failure path (status error, `consecutive_failures + 1`, `bansync.failed`); the alert fires exactly on the third consecutive failure; typed size-limit and timeout errors are readable in `last_sync_error`; auth header decrypted and passed on; a failed completion publish keeps the sync successful (#856); recording a failure never rejects even if the recording fails (#856). |
| `manual-queue.test.ts` | 7 | Syncs the requested source and acks; skips a source the tick is already syncing (#853); keeps consuming after an `XACK` failure (#1292); acks a job whose source lookup fails; acks malformed jobs and unknown sources without syncing; retries group creation and recreates the group after `NOGROUP` (#1292); returns when shutdown closes the connection under the blocked read. |
| `fetch-source.test.ts` | 15 | Against local HTTP servers on loopback (the address policy is relaxed by an injected `isAddressAllowed`): auth header sent and body returned; eager `content-length` cap; mid-stream cap without `content-length`; timeout against a silent server; non-2xx as a typed error. Policy tests: a loopback source is refused without connecting; `http://redis:6379/`, `http://169.254.169.254/...`, `http://[::1]/` and `file:///etc/passwd` are refused (4 cases); a public-looking name resolving to a private address is refused; a redirect into an internal address is refused; a same-origin redirect keeps the auth header and a cross-origin one drops it; too many redirects fail. |

### Postgres-backed

| File | Tests | What it verifies |
|---|---:|---|
| `events.test.ts` | 2 | `persistAndPublish` stores the envelope once across retries with no `processed_events` row (#62), and never publishes to the live-bus channel (#858). Uses `DATABASE_URL` or a default local URL and is not skipped without it. |
| `merge.integration.test.ts` | 1 | `syncSource` against the real `external_bans` table: a second sync of an unchanged `json_generic` list adds, updates and revokes nothing (regression for #34), and `imported_count` is 0. |
| `merge-apply.integration.test.ts` | 4 | `applyMergePlan` against Postgres: insert, batch update and revoke in one pass; a reappearing ban gets `revoked_at` cleared and keeps a null expiry; a failure midway leaves no partial state (#854); an overlapping sync that already inserted the same ban does not fail (#853). |
| `merge-batching.integration.test.ts` | 1 | Imports 7 000 rows (more than one statement can bind) and later revokes them. |

The three `*.integration.test.ts` files use `describeIfDb`: they are skipped with a warning when `DATABASE_URL` is unset, and fail when `CI` is set.

### Spawned worker (Redis, Postgres and the built `dist/index.js`)

| File | Tests | What it verifies |
|---|---:|---|
| `contract.test.ts` | 2 | Shared `workerContract`: `worker:heartbeat:ban-sync` appears with a TTL of at most 30 s, and the worker exits with code 0 after two SIGTERMs. Runs with `APP_ENCRYPTION_KEY` set to 32 bytes of `0x07`. |
| `shutdown.regression.test.ts` | 1 | SIGTERM interrupts the blocking manual-queue read: after a job for an unknown source is read and acknowledged, the worker exits with code 0 in under 2 s instead of waiting out the 5 s block. |

Total: 80 tests.

## Test data

The pure tests use in-memory fakes for the database, Redis, fetch and diag dependencies. The integration tests create uniquely named `external_ban_sources` rows (and their bans) and delete them in `afterAll` / `afterEach`; `events.test.ts` deletes its event row. The spawned-worker tests delete the heartbeat key and the `bansync:manual` stream afterwards.

## Coverage gaps

- The `index.ts` wiring (tick timer, overlap skip, manual loop startup) is covered only by the contract and shutdown tests.
- `raiseBanSyncFailureAlert` and `createTickDeps`' database listing are not asserted directly; the alert is checked through a stubbed dependency.
- `crypto.ts` decryption is exercised only through a stubbed `decryptAuthHeader` in `sync-source.test.ts`.
