# worker-clan-guard - Data model

## Postgres

### Read

| Table | Columns | Why |
|---|---|---|
| `clan_guard_settings` | `enabled`, `grace_period_seconds` (row `id = 1`) | Kill-switch and grace period, read on every tick. |
| `clans` | `id`, `name`, `tags`, `is_tag_protected`, `deleted_at` | Protected clans: `is_tag_protected = true AND deleted_at IS NULL`. `tags` is a text array. |
| `clan_members` | `clan_id`, `player_id` | Membership sets; a member is never an impostor of their own clan. |
| `player_sessions` | `player_id`, `server_id`, `connected_at`, `disconnected_at`, `mode` | Online players: `disconnected_at IS NULL AND mode = 'online'`. |
| `players` | `id`, `eos_id`, `canonical_name`, `role_id` | The name that is matched is `canonical_name` as stored (not normalized); `eos_id` is the RCON target. |
| `roles` | `panel_access` | Left-joined through `players.role_id`; a player with no role counts as `false`. |
| `moderation_actions` | `player_id`, `server_id`, `action_type`, `context->>'phase'`, `created_at`, `reverted_at` | Detect an existing warn or kick in the current session. |

### Written

| Table | Change |
|---|---|
| `moderation_actions` | Insert on the first warn of a session and on the first kick of a session (`phase` `warn` / `kick`). Fields in [api.md](./api.md). |
| `audit_log` | Insert alongside each ledger row: `clan.tag_protection.warn` / `clan.tag_protection.kick`. `row_hash` is inserted as an empty buffer; the `audit_log` append trigger computes the chain. |

The ledger and audit rows are two separate inserts, not one transaction, and neither is in the same unit as the RCON enqueue.

### Session scoping

A warn or kick counts for the current session only when its `moderation_actions` row has `player_id` and `server_id` equal to the session's, `action_type = 'clan_tag_protection'`, `context->>'phase'` equal to the phase, `reverted_at IS NULL` and `created_at >= player_sessions.connected_at`. A player who disconnects and rejoins gets a new `connected_at`, so the cycle starts again with a fresh warn.

## Redis keys written

| Key | Retention | Description |
|---|---|---|
| `rcon:commands:<serverId>` (stream) | `MAXLEN ~ 500` | `AdminWarn` / `AdminKick` requests, field `request` |
| `worker:heartbeat:clan-guard` | TTL 30 s | Liveness heartbeat |
| `diag:queue` (stream) | `MAXLEN` managed by `@squad/diag` | Diagnostic events |

The worker never reads Redis streams.
