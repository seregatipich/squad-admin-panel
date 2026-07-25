# worker-log-ingest — Data model

## Postgres tables read

### `servers`

Queried every 15 s. Columns consumed: `id`, `status`.
Only `status IN ('running', 'starting')` servers receive a log tail.

### `server_settings`

Joined with `servers`. Column consumed: `beacon_port`.
The beacon port is used to identify the `server.ready` event — Squad binds many ports; only the beacon port signals the server is accepting connections.

## Postgres tables written (combat store)

`src/combat/store.ts` (`handleCombat` / `handleVehicle`) persists combat log lines.
Player resolution may `INSERT` into `players`, `player_name_history` and `audit_log`
(a new EOS/Steam identity), committed before the event transaction below.

Each combat/vehicle line then writes, in **one transaction**:

| Table | Write |
|---|---|
| `events` | the generic envelope (`combat_death`/`combat_damage`/`combat_wound`/`combat_revive`/`vehicle_destroyed`/`vehicle_damage`), `onConflictDoNothing` on `(event_id, occurred_at)` |
| `combat_events` | the typed raw feed row (DOSSIER-2), `event_type` mapped from the command kind. `match_id` is left `NULL` (the column is `bigint`, log-ingest resolves a `uuid`) |
| `player_weapon_stats`, `player_vehicle_stats`, `player_vehicle_kills` | the incremental dossier aggregate fold via `applyCombatEventToDossier` |

The `combat_events` insert and the aggregate fold run **only when the `events`
insert actually inserted** (the `onConflictDoNothing` returned a row). On offset
replay of the same line the envelope conflicts, so neither the `combat_events` row
nor the aggregate delta is written again — redelivery never double-counts. A throw
anywhere in the transaction rolls back all three. The Redis live-bus publish stays
**outside** the transaction. See [db/data-model.md](../../db/data-model.md) for the
aggregate table shapes and [flows.md](./flows.md#combat--vehicle-events-dossier-2).

## Redis keys written

| Key | TTL | Description |
|---|---|---|
| `events:server:{serverId}` | stream (MAXLEN ~10 000) | Per-server event stream |
| `dedup:log-ingest:v1:{event_id}` | 86 400 s | Best-effort publish dedup |
| `worker:heartbeat:log-ingest` | 30 s | Liveness heartbeat |
| `live-bus` | pub/sub | Combat/vehicle live frames (published after the DB transaction commits) |

## Diagnostic events written

Emitted through `@squad/diag` to `diag:queue`.

| Kind | Severity | Payload |
|---|---|---|
| `log.retention.sweep` | `info` when `error_count = 0`, otherwise `warn` | `{ retention_days, cutoff, servers_scanned, log_dirs_scanned, files_scanned, deleted_count, deleted_bytes, error_count, errors }` |
| `log.retention.sweep_failed` | `error` | `{ error }` |

## Log line format

Squad `SquadGame.log` lines follow this pattern:

```
[YYYY.MM.DD-HH.MM.SS:mmm][<tick>]<Category>: [<Verbosity>: ]<message>
```

Example:

```
[2026.04.23-11.30.20:485][  0]LogGameMode: Display: Match State Changed from WaitingToStart to InProgress
```

`parseLine()` in `patterns.ts` extracts `ts` (UTC Date), `tick`, `category`, `verbosity` (nullable), and `message`.

## Benign noise patterns (dropped before parsing)

Lines matching any of these patterns are silently dropped:

- `LogStreaming: … CreateExport: … EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX`
- `LogSquad: Error: Failed to spawn EquipableItem`
- `LogRedpointEOS: Verbose: …`
- `LogStreaming: Warning: Skipped failed export`

## Per-server ingestor state

`LogIngestor` holds one mutable field: `recentJoin` (`{ name, ts }` or null). It is set when a `Join succeeded` line is seen, then consumed by the next `EOS Connection` line within 2500 ms to correlate the player name with their Steam/EOS IDs.
