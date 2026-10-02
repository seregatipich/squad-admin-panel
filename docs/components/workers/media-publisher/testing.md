# Testing

Provision an isolated migrated database, build the worker (two suites start
`dist/index.js`), and run the package suite:

```bash
eval "$(bash scripts/new-test-db.sh media-publisher)"
pnpm --filter @squad/worker-media-publisher build
pnpm --filter @squad/worker-media-publisher exec vitest run
```

See [local-test-setup.md](../../../development/local-test-setup.md) for the
database helper. A single file runs with
`pnpm --filter @squad/worker-media-publisher exec vitest run test/tick.test.ts`.

The package uses the shared worker Vitest base (`apps/workers/_test-shared/vitest.base.ts`):
a 40-second test timeout and a setup file that fills `DATABASE_URL` and the
Redis URL from the repo `.env` when they are not exported. There is no
per-worker database clone, so the integration suite writes to the database
named by `DATABASE_URL`.

## Test files

| File | Needs | Covers |
|---|---|---|
| `tick.test.ts` (19 tests) | none | The state machine with injected publishers: publish, quota deferral that never fails a job, exponential backoff, retry budget, interrupted-upload budget, permanent failure, unconfigured deferral, a throwing publisher, release ordering, per-job isolation, session pass-through, `computeBackoffMs`. |
| `telegram.test.ts` (21 tests) | none | The real publisher against an injected `fetch`: configuration gate, `telegramMessageUrl`, `sendVideo` and `sendPhoto`, `sendDocument` above 10 MiB, the 50 MiB ceiling, 429 with `retry_after`, 5xx, 4xx, transport errors, timeout, missing message id, and bot-token leak checks. |
| `youtube.test.ts` (26 tests plus 3 parameterised groups) | none | The real publisher against an injected `fetch`: configuration gate, `msUntilQuotaReset`, token exchange, resumable session, quota reasons, auth and transport failures, request shape (title, brackets, code points), 408 and 429, timeouts on every call, streamed upload, session persistence and resume (status 308, finalized upload, expired session), credential leak checks. |
| `deps.integration.test.ts` (27 tests) | Postgres | `claimDue` (due, backoff, terminal, soft-deleted media, lease, reclaim, two concurrent claims), every status transition, persisted upload sessions, `releaseIfEnabled` (setting off, atomic swap, pending sibling, shared `storage_path`, storage-path lock, no external URL) and publisher wiring. |
| `tick-guard.test.ts` (4 tests) | none | `guardAgainstOverlap` from `@squad/worker-kit`: skips an overlapping call, runs again after settling, clears the flag on a throw. |
| `env-validation.test.ts` (7 cases) | built `dist` | The process exits with code 1 and the `must be an integer between` message for bad `MEDIA_PUBLISHER_INTERVAL_MS` and `MEDIA_PUBLISHER_BATCH_SIZE` values. |
| `contract.test.ts` (2 tests) | built `dist`, Redis | Heartbeat key `worker:heartbeat:media-publisher` appears with a TTL of at most 30 s; repeated SIGTERM exits 0. |

`deps.integration.test.ts` is declared with `describeIfDb`: without
`DATABASE_URL` it is skipped with a warning locally, and with `CI` set the run
fails instead of skipping.

## Not covered by automated tests

A real upload to YouTube or Telegram. It needs third-party credentials that
cannot be synthesised, and no test fakes a pass for it; the live publish is
verified by hand against a test channel when credentials are available.
