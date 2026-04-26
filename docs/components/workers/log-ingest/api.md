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
| `player.connected` | `LogNet: Join succeeded` correlated with `LogRedpointEOS: EOS Connection` within 2500 ms | `{ name, eos_id, steam_id64, ip: null }` |
| `player.disconnected` | `LogNet: UChannel::Close … UniqueId: EOS:…\|STEAM:…` | `{ eos_id, steam_id64, reason: null }` |
| `match.started` | `LogGameMode: Match State Changed from WaitingToStart to InProgress` | `{ from_state, to_state }` |
| `match.ended` | `LogGameMode: Match State Changed from InProgress to WaitingPostMatch` | `{ from_state, to_state }` |

## Dedup key: `dedup:log-ingest:v1:{event_id}`

Written as `SET … EX 86400 NX` before each `XADD`. If the key already exists the event is dropped (TTL 24 h).

## Heartbeat key: `worker:heartbeat:log-ingest`

Published every 5 s, TTL 30 s. `status` field contains `"tails=N"` where N is the number of active log tails.
