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

Unit tests for the log line parser, event extractor, and Squad-fatal detector.

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

**Squad fatal/log-exit/assertion detection:**

| Test | What it verifies |
|---|---|
| Detects `LogExit:` lines | `detectSquadFatal` returns `{ ts, message, file: null, line: null }` |
| Detects `Fatal error:` lines | `detectSquadFatal` returns `{ ts, message, file: null, line: null }` |
| Detects `Assertion failed: … [File:… Line:…]` | `detectSquadFatal` returns `{ ts: null, message, file, line }` |
| `LogIngestor` invokes `onSquadFatal` once per matching line | Three fixture lines (one per pattern) → callback fired three times with parsed payloads + raw text |
| Ordinary log lines do not invoke `onSquadFatal` | Match-state-changed line → callback not fired |

### `ingest.test.ts`

Unit tests for the `LogIngestor` player connect/disconnect flow.

| Test | What it verifies |
|---|---|
| `player.connected` when EOS follows join in window | Correlation within 2500 ms window emits event with steam_id64 |
| No `player.connected` after correlation window expires | Late EOS line (> window ms) produces no event |
| `player.disconnected` with steam_id64 | Disconnect line extracts correct steam_id64 |
| `rcon.connected` on ADMIN COMMAND line | `LogSquad: ADMIN COMMAND: ListPlayers from RCON` |
| Empty list for unrecognised lines | Unknown category/message produces no events |

### `manager.test.ts`

Unit tests for `TailManager.reconcile` — the part of the worker that owns the aborters map and emits `tails.changed`.

| Test | What it verifies |
|---|---|
| Starts a tail per new server, emits `tails.changed` payload | Factory invoked once with `(serverId, beaconPort)`; diag emit carries `{ added: ['srv-a'], removed: [], total: 1 }`, `severity: 'info'`, `component: 'worker-log-ingest'` |
| Unchanged ticks do not emit | Two reconciles with the same wanted set → exactly one diag emit total |
| Removal emits `tails.changed` with `removed` populated | Drop a server from wanted → factory not re-invoked, abort closure fires once |
| Single tick can be both add and remove | Swap A for B in one reconcile → one diag emit with both lists populated |
| Optional diag is honoured | Manager constructed without diag does not throw on reconcile |
| `stopAll` aborts every running tail and clears the set | All abort closures invoked, `manager.size()` returns 0 |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:log-ingest` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

- `tail.ts` is not unit-tested (requires a mock `BridgeClient` returning a stream). Integration coverage comes from `apps/api/test/e2e/install-lifecycle.e2e.test.ts` which verifies `server.ready` and `player.connected` appear in the event stream after a live server boot. The `tail.started` / `tail.stopped` diag emits are wired in `index.ts` glue and exercised end-to-end during the install-lifecycle e2e run.
- `publish.ts` dedup logic is untested in isolation.

## Test data

Samples are hardcoded Squad log lines matching actual v10.3.1 output. No external fixtures needed.
