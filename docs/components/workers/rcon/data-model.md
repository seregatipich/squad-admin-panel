# worker-rcon — Data model

## Postgres tables written

### `players`

Upserted on every `ListPlayers` poll via `persist.ts:upsertPlayers`, one transaction per player. The row is found by `eos_id` or `steam_id64` (the eos match wins); a player whose transaction fails is logged (`player upsert failed`) and the rest of the poll continues. A new row is inserted with `ON CONFLICT DO NOTHING` and, if log-ingest created it first, the worker re-reads and updates that row.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | UUIDv7 for rows created here |
| `eos_id` | `text` | Back-filled when the matched row has none |
| `steam_id64` | `bigint` | Back-filled when the matched row has none (audit `player.steam_linked`, written after the UPDATE) — unless another row already holds that steam id |
| `steam_eos_conflict` | `boolean` | Set when the eos row and the steam row are different `players` rows (split identity, #967); audit `player.eos_steam_conflict` is written once, when the flag is raised |
| `canonical_name` | `text` | Latest name seen |
| `canonical_name_normalized` | `text` | `normalizePlayerName` (`@squad/shared-config`): lowercase + strip leading clan tags and non-letter chars |
| `last_seen_at` | `timestamptz` | Updated on every upsert |
| `updated_at` | `timestamptz` | Updated on every upsert |

### `player_name_history`

Upserted alongside `players`. Unique on `(player_id, name_normalized)`, so a name change inserts a new row while repeat logins under the same normalized name update the existing one.

| Column | Type | Notes |
|---|---|---|
| `player_id` | `uuid` FK → `players.id` | |
| `name` | `text` | Raw name (UTF-8 preserved) |
| `name_normalized` | `text` | `normalizePlayerName`: lowercase + strip leading clan tags and non-letter chars |
| `last_seen_at` | `timestamptz` | Updated on conflict |
| `observation_count` | `int` | Incremented on conflict |

### `player_sessions`

Reconciled on every full `ListPlayers` poll via `persist.ts:reconcilePlayerSessions` (PRES-1). The roster snapshot — not the log stream — is the source of truth for presence: every poll is a complete roster, so a dropped log tail or a missed disconnect line self-heals at the next poll instead of leaking an open session.

| Column | Type | Notes |
|---|---|---|
| `player_id` | `uuid` FK → `players.id` | Resolved from the roster entry's `eos_id`, falling back to `steam_id64` |
| `server_id` | `uuid` FK → `servers.id` | The polled server |
| `connected_at` | `timestamptz` | The roster's `first_seen_at` when known, clamped to at most two poll intervals before the poll so an RCON reconnect cannot credit offline time; otherwise the poll instant |
| `disconnected_at` | `timestamptz` | Set at the first poll where the player is absent from the roster, or at the last successful poll when the RCON connection drops (`persist.ts:closeServerSessions`) |
| `duration_seconds` | `int` | `disconnected_at - connected_at`, floored at 0 |
| `closed_reason` | `text` | `disconnect` on both paths |
| `mode` | `text` | `seed` while the seeding state machine reports `seeding`, else `online`. SEED-1 boundary transitions re-split open sessions (`splitOpenSessionsAtSeedingTransition`) |

Presence is therefore poll-granular: a session shorter than one poll interval (30 s by default) can be missed entirely, and `connected_at` is only as precise as the 5 s roster refresh that recorded `first_seen_at`. A hard worker crash leaves sessions open until the next start, whose first reconcile closes everyone absent at that poll — overcounting by roughly the downtime.

Downstream, `worker-presence-daily` recomputes `player_daily_presence` and `players.total_time_played_seconds` from these rows on its hourly tick.

### `events` (squad history)

`squad.created`, `squad.leader_changed` and `squad.disbanded` rows are inserted directly by `PerServerSupervisor.emitSquadEvent`, the same way as the seeding transitions (`onConflictDoNothing` on `(event_id, occurred_at)`). `actor_kind = 'player'`, `actor_id` = the EOS id of the squad's creator (`created`, `disbanded`) or of the leader who gave up command (`leader_changed`), so `events_actor_occurred_idx` serves per-player lookups. Payload schemas: `packages/shared-types/src/events.ts` (`squadCreatedPayload`, `squadLeaderChangedPayload`, `squadDisbandedPayload`). Retention follows the `events` partitions (24 months).

## Postgres tables read

### `servers`

Queried every 15 s: `SELECT id, status FROM servers`.
Only rows with `status IN ('starting', 'running')` are kept as targets.

### `server_credentials`

Joined with `servers`: provides `rcon_host`, `rcon_port`, `rcon_password_encrypted` (AES-256-GCM blob).

### `server_settings`

Joined with `servers` to satisfy the inner join; no columns currently consumed but the join ensures the settings row exists before targeting.

## Redis keys

| Key | TTL | Description |
|---|---|---|
| `rcon:status:{serverId}` | 300 s | RCON connection state + poll results |
| `rcon:squads:{serverId}` | 90 s | Latest `ListSquads` snapshot grouped with team context |
| `rcon:squad-crowns:{serverId}` | 6 h, refreshed on write | Hash: creator EOS id → `SquadCrown` JSON for the current match; deleted on match reset |
| `rcon:command-result:{requestId}` | 120 s | Result of a queued P0 operator command |
| `worker:heartbeat:rcon` | 30 s | Liveness heartbeat |
| `events:server:{serverId}` | stream (MAXLEN ~10000) | Published events |
| `rcon:commands:{serverId}` | stream (MAXLEN ~500 by API producer) | P0 operator commands consumed by worker-rcon |

## Redis stream entries read

### `rcon:commands:{serverId}`

Worker-rcon owns consumer group `worker-rcon:commands:v1`.

| Field | Type | Notes |
|---|---|---|
| `request` | JSON | `request_id`, `command`, optional `args`, optional `actor_player_id`, optional `enqueued_at` |

Allowed `command` values: `AdminBroadcast`, `AdminEndMatch`, `AdminReloadServerConfig`.

## Credential blob schema

`server_credentials.rcon_password_encrypted` is a `bytea` column storing a UTF-8-encoded JSON blob:

```json
{
  "v": 1,
  "kv": 1,
  "iv": "<base64 12 bytes>",
  "tag": "<base64 16 bytes>",
  "ct": "<base64 N bytes>"
}
```

Decrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` (32-byte base64).
