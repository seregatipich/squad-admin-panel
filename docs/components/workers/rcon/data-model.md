# worker-rcon — Data model

## Postgres tables written

### `players`

Upserted on every `ListPlayers` poll via `persist.ts:upsertPlayers`.

| Column | Type | Notes |
|---|---|---|
| `steam_id64` | `bigint` PK | Conflict target for upsert |
| `canonical_name` | `text` | Latest name seen |
| `canonical_name_normalized` | `text` | `normalizePlayerName` (`@squad/shared-config`): lowercase + strip leading clan tags and non-letter chars |
| `eos_id` | `text` | `COALESCE(excluded.eos_id, players.eos_id)` — never overwrites a known value with null |
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
