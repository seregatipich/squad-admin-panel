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

## Alert rules (`alert_events`)

`src/alerts/store.ts` runs the AUTO-3 engine (`src/alerts/engine.ts`) for every event the parser emits ([#19](https://github.com/seregatipich/squad-admin-panel/issues/19)). Enabled rules are cached for 15 s; each row's `config` is validated against its type's schema and an invalid row is skipped with an `alert rule skipped: invalid config` warning. `role_expiring` is not evaluated here (worker-role-expirer schedules it).

| Rule type | Fires on | Firing policy |
|---|---|---|
| `server_crashed` | `server.crashed` | every crash; default severity `critical` |
| `unusual_activity` | `player.connected` when the server's connects in the last `windowMinutes` (default 5) reach `connectThreshold` | at most once per window per server |
| `admin_login_new_ip` | `player.connected` of a player whose unexpired role has `panel_access` (or the system Owner role) from an IP missing from `player_ip_history` | evaluated **before** the identity handler records the IP |
| `custom` | an event whose type equals `eventKind` | every match, or once per `threshold` matches when a threshold is set (the counter restarts after each firing) |

`custom` rules see two sets of event kinds. Those this parser emits (`server.ready`, `server.stopped`, `server.crashed`, `player.connected`, `player.disconnected`, `match.started`, `match.ended`) are evaluated inline, per log line. Those worker-rcon publishes to `events:server:{id}` — `rcon.connected`, `rcon.disconnected`, `rcon.players_polled`, `performance.degraded`, `squad.created`, `squad.leader_changed`, `squad.disbanded` — never pass through the log, so a stream reader (`src/alerts/stream.ts`, group `log-ingest-alert-stream:v1`) evaluates them ([#27](https://github.com/seregatipich/squad-admin-panel/issues/27)); it reads `events:global` and every live `events:server:{id}` stream (not the sidecar's `:shadow` copies) on a connection of its own and skips every other kind (`STREAM_ALERT_KINDS`). Kinds raised elsewhere — `bansync.failed`, `externalban.matched`, `alt.ban_evasion_suspected`, `reports.spam_flagged`, seed notifications — keep being written by their own producers, and `server.seeding_*` by worker-rcon's seeding tracker; evaluating them here would alert twice. A rule on any other kind is accepted by `POST /api/v1/alert-rules` and never fires.

Each firing is delivered through `src/alerts/sink.ts` (no transport is configured in any deployment yet, so `delivered` stays `false`), inserted into `alert_events`, and announced as an `alert.triggered` live-bus frame whose `data` is `{ event_kind: <rule type>, rule_id, rule_name, severity, server_id }` — never the payload, which holds an IP for `admin_login_new_ip`. `GET /api/v1/alerts` strips `payload.ip` for callers without `player:view_ips`.

Redis keys:

| Key | Type | Purpose |
|---|---|---|
| `dedup:log-ingest-alerts:v1:{event_id}` | string, `EX 86400 NX` | one evaluation per event — the tail replays its last lines on reattach |
| `alerts:connects:{serverId}` | sorted set (score = event time, member = event id) | sliding connect window for `unusual_activity`; trimmed to the longest window |
| `alerts:cooldown:{ruleId}:{serverId}` | string, `PX <window> NX` | `unusual_activity` once-per-window guard |
| `alerts:custom-count:{ruleId}:{serverId}` | counter | matches since the last firing of a `custom` rule with a threshold |

## Chat reactions from RCON (`rcon:chat:{serverId}`)

Squad does not write in-game chat to `SquadGame.log`; worker-rcon receives it as an RCON broadcast and archives it. The reactions to a chat line — `!stats` / `!rules` / `!report` answers (AUTO-4), `chat_keyword` automations (AUTO-1) and `!report` records (REPORT-1) — live in this worker, so worker-rcon also XADDs each parsed line to `rcon:chat:{serverId}` (`MAXLEN ~ 2000`, field `entry`, JSON `{ v: 1, ts, channel, eos_id, steam_id64, player_name, message }`, schema `rconChatEntrySchema` in `@squad/shared-types`) and `src/chat/rcon-chat.ts` reads those streams with group `log-ingest-rcon-chat:v1` ([#2](https://github.com/seregatipich/squad-admin-panel/issues/2)). The reader runs the same handlers the log tail's `onChat` / `onReport` call. A line that arrives through both producers (a Squad build that logs chat) is handled once: `chat:handled:{serverId}:{sender}:{channel}:{sha1(text)}` and `chat:handled-report:{serverId}:{reporter}:{channel}:{sha1(target, text)}` are claimed with `SET NX EX 15` before reacting, in both paths. A malformed entry is logged and dropped; a handler failure is logged and the entry acked (the command cooldown is already claimed); only a Redis failure leaves an entry pending for the reclaim sweep (30 s idle). Both stream readers (`src/stream-consumer.ts`) use their own Redis connection because `XREADGROUP` blocks.

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
