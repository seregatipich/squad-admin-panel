# worker-rcon — Data model

## Postgres tables written

### `players`

Upserted on every `ListPlayers` poll via `persist.ts:upsertPlayers`.

| Column | Type | Notes |
|---|---|---|
| `steam_id64` | `bigint` PK | Conflict target for upsert |
| `canonical_name` | `text` | Latest name seen |
| `canonical_name_normalized` | `text` | Trimmed, whitespace-collapsed, lowercased |
| `eos_id` | `text` | `COALESCE(excluded.eos_id, players.eos_id)` — never overwrites a known value with null |
| `last_seen_at` | `timestamptz` | Updated on every upsert |
| `updated_at` | `timestamptz` | Updated on every upsert |

### `player_name_history`

Upserted alongside `players`. Unique on `(steam_id64, name_normalized)`.

| Column | Type | Notes |
|---|---|---|
| `steam_id64` | `bigint` FK → `players` | |
| `name` | `text` | Raw name |
| `name_normalized` | `text` | Normalised name |
| `last_seen_at` | `timestamptz` | Updated on conflict |
| `observation_count` | `int` | Incremented on conflict |

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
| `worker:heartbeat:rcon` | 30 s | Liveness heartbeat |
| `events:server:{serverId}` | stream (MAXLEN ~10000) | Published events |

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
