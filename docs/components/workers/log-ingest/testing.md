# worker-log-ingest — Testing

## Running tests

```bash
pnpm --filter @squad/worker-log-ingest test
# or from the repo root:
pnpm turbo run test --filter=@squad/worker-log-ingest
```

## Test files

All tests live under `apps/workers/log-ingest/test/`.

### `patterns.test.ts`

Unit tests for the log line parser and event extractor.

**Log line prefix parser:**

| Test | What it verifies |
|---|---|
| Parses `Display`-verbosity `LogGameMode` line | `category`, `verbosity`, `message` extracted correctly |
| Parses no-verbosity `LogGameState` line | `verbosity` is null |
| Filters audio-export noise | `isBenignNoise` returns true for known noise patterns |

**`LogIngestor` event extraction:**

| Test | What it verifies |
|---|---|
| `server.ready` only on configured beacon port | Wrong port → no event; correct port → `server.ready` |
| `match.started` only on `WaitingToStart → InProgress` | `EnteringMap → WaitingToStart` produces no event |
| `match.ended` only on `InProgress → WaitingPostMatch` | Correct state transition produces one event |
| `server.stopped` on exit code 143 (clean SIGTERM) | `ReturnCode=143` → `server.stopped` |
| `server.crashed` on non-143 non-zero exit | `ReturnCode=134` → `server.crashed` |
| Drops benign audio-export noise before parsing | Noise line → empty event list |

## Coverage gaps

- `tail.ts` is not unit-tested (requires a mock `BridgeClient` returning a stream). Integration coverage comes from `apps/api/test/e2e/install-lifecycle.e2e.test.ts` which verifies `server.ready` and `player.connected` appear in the event stream after a live server boot.
- `publish.ts` dedup logic is untested in isolation.
- The join-correlation 2500 ms window is not exercised by any current test — a test verifying that a late EOS line does not produce `player.connected` would be a useful addition.

## Test data

Samples are hardcoded Squad log lines matching actual v10.3.1 output. No external fixtures needed.
