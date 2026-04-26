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

### `ingest.test.ts`

Unit tests for the `LogIngestor` player connect/disconnect flow.

| Test | What it verifies |
|---|---|
| `player.connected` when EOS follows join in window | Correlation within 2500 ms window emits event with steam_id64 |
| No `player.connected` after correlation window expires | Late EOS line (> window ms) produces no event |
| `player.disconnected` with steam_id64 | Disconnect line extracts correct steam_id64 |
| `rcon.connected` on ADMIN COMMAND line | `LogSquad: ADMIN COMMAND: ListPlayers from RCON` |
| Empty list for unrecognised lines | Unknown category/message produces no events |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:log-ingest` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

- `tail.ts` is not unit-tested (requires a mock `BridgeClient` returning a stream). Integration coverage comes from `apps/api/test/e2e/install-lifecycle.e2e.test.ts` which verifies `server.ready` and `player.connected` appear in the event stream after a live server boot.
- `publish.ts` dedup logic is untested in isolation.

## Test data

Samples are hardcoded Squad log lines matching actual v10.3.1 output. No external fixtures needed.
