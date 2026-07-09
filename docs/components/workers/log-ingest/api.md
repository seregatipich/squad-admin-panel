# worker-log-ingest — API surface

No HTTP surface. All output is Redis Streams.

## Redis stream: `events:server:{serverId}`

Entries use field `envelope` containing JSON-encoded `EventEnvelope`. The worker publishes MAXLEN ~10 000.

All envelopes share the base shape:

```json
{
  "event_id": "<uuidv7>",
  "version": 1,
  "type": "<event type>",
  "server_id": "<uuid>",
  "ts": "<ISO-8601 from Squad log line>",
  "actor": { "kind": "system", "id": null },
  "correlation_id": null,
  "payload": { ... }
}
```

### Event types and their payloads

| Type | Trigger | Key payload fields |
|---|---|---|
| `server.ready` | `LogNet: Created socket for bind address: 0.0.0.0:{beaconPort}` | `{ port: number }` |
| `server.stopped` | `LogCore: RequestExit(... ReturnCode=143)` or `ReturnCode=0` | `{ exit_code: number }` |
| `server.crashed` | `LogCore: RequestExit(... ReturnCode=<non-zero>)` | `{ exit_code: number }` |
| `player.connected` | `LogNet: Join succeeded` correlated with `LogRedpointEOS: EOS Connection` within 2500 ms; `ip` is the client address from a correlated `LogNet: AddClientConnection … RemoteAddr:` line, or `null` if none correlated | `{ name, eos_id, steam_id64, ip }` |
| `player.disconnected` | `LogNet: UChannel::Close … UniqueId: EOS:…\|STEAM:…` | `{ eos_id, steam_id64, reason: null }` |
| `match.started` | `LogGameMode: Match State Changed from WaitingToStart to InProgress` | `{ from_state, to_state }` |
| `match.ended` | `LogGameMode: Match State Changed from InProgress to WaitingPostMatch` | `{ from_state, to_state }` |

## Dedup key: `dedup:log-ingest:v1:{event_id}`

Written as `SET … EX 86400 NX` before each `XADD`. If the key already exists the event is dropped (TTL 24 h).

## Heartbeat key: `worker:heartbeat:log-ingest`

Published every 5 s, TTL 30 s. `status` field contains `"tails=N"` where N is the number of active log tails.

## Diagnostic events (`diag:queue` Redis Stream)

The worker emits structured `DiagEvent`s via `@squad/diag` (`createDiag({ redis, log })` constructed once at startup, passed into `TailManager` and into each per-server `LogIngestor`). Every emit is fire-and-forget — failures are swallowed so telemetry never derails the tail loop. All kinds carry `component: 'worker-log-ingest'`. Per-server kinds carry `serverId` so the diagnostic-bundle's per-server brief can group them.

| Kind | Severity | `serverId` | Trigger | Payload fields |
|---|---|---|---|---|
| `tail.started` | `info` | yes | `tailContainerLogs` IIFE begins for a server (immediately before the `bridge.containerLogsFollow` call) | `container: 'squad-{uuid}'` |
| `tail.stopped` | `info` | yes | `tailContainerLogs` lifecycle ends — stream returned, threw, or the manager called `abort()` | `container`, `reason: 'aborted' \| 'stream-end' \| 'stream-error'`, `error?: string` (only on `stream-error` / late-error abort) |
| `tails.changed` | `info` | no | `TailManager.reconcile()` produced a non-zero net delta (no emit on unchanged ticks) | `added: string[]`, `removed: string[]`, `total: number` |
| `parser_error` | `warn` | yes | `LogIngestor.ingest()` saw a `[`-prefixed line that did not match `PREFIX`, or `handleMessage` threw | `lineSample: string` (≤200 chars), `regex: string` (`'PREFIX'` or the failing category), `errorMessage: string` |
| `squad.log.fatal` | `fatal` | yes | A line matched any of the three Squad-game fatal patterns (`LogExit:`, `Fatal error:`, `Assertion failed: …`) — no de-duplication; fires for every matching line. Bundle-side dedupe happens at render time. | `ts: string \| null`, `file: string \| null`, `line: number \| null`, `raw: string` (≤500 chars). `message` field of the `DiagEvent` is the parsed `msg` group sliced to ≤200 chars. |

The three Squad-fatal regexes are exported from `apps/workers/log-ingest/src/parser/patterns.ts` as `SQUAD_LOG_EXIT`, `SQUAD_FATAL_ERROR`, and `SQUAD_ASSERTION_FAILED`. The detection helper `detectSquadFatal(line)` returns `{ ts, message, file, line } | null` and is called by `LogIngestor.ingest()` before the prefix parser; benign-noise filtering still runs first.

The `events:server:{serverId}` stream is unaffected by this diag instrumentation — it still carries the existing parsed envelope events for the live-bus fan-out.
