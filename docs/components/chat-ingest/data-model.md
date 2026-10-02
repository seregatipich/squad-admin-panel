# `chat-ingest` — data model

The package owns no tables, no migrations and no Redis keys of its own. It reads and writes tables defined in [`packages/db/src/schema/`](../../../packages/db/src/schema) and publishes to one Redis pub/sub channel.

## Tables touched

| Table | Access | By | Columns used |
|---|---|---|---|
| `players` | read | `resolvePlayerId` | `id`, `eos_id`, `steam_id64`, `canonical_name_normalized` |
| `player_name_history` | read | `resolvePlayerId` (name-only senders) | `player_id`, `name_normalized`, `last_seen_at` |
| `chat_flag_rules` | read | `ChatFlagDetector` | `id`, `pattern`, `pattern_type`, `enabled`, `created_at` |
| `chat_messages` | insert | `recordChatMessage` | `player_id`, `server_id`, `sent_at`, `scope`, `message`, `source`, `team_id`, `squad_id`, `is_flagged`, `matched_rule_id` |

### `chat_messages` constraints that shape the code

- `player_id` is `NOT NULL` with a foreign key to `players`; this is why an unknown sender is not archived.
- `scope` is checked against `all, team, squad, admin, broadcast, direct`. `handleChat` only ever writes `all`, `team`, `squad`, `admin` (the `CHANNEL_SCOPE` map).
- `source` is checked against `log, panel, rcon`. `handleChat` writes `log` (default) or the value its caller passes (`rcon` from `worker-rcon`).
- The primary key is `(id, sent_at)` and `id` is a `bigserial`, so the id is database-generated; the package never sets it.
- `matched_rule_id` references `chat_flag_rules(id)` with `ON DELETE SET NULL`.

### `chat_flag_rules` query

```
SELECT id, pattern, pattern_type FROM chat_flag_rules
WHERE enabled = true
ORDER BY created_at ASC, id ASC
```

The order matters: `detectChatFlag` returns the id of the first rule that matches, so the oldest enabled rule wins. Rows whose `pattern_type` is not `word` or `regex` are treated as `word`; empty word patterns and regex patterns that fail `validateChatFlagPattern` are dropped at compile time by `compileChatFlagRules`.

## Redis

| Key / channel | Type | Direction | Payload |
|---|---|---|---|
| `live-bus` | pub/sub channel | `PUBLISH` from `handleChat` | `JSON.stringify(ChatMessageFrame)` |

No keys are read or written. The package does not subscribe.

## In-process state

| Holder | State | Bound |
|---|---|---|
| `PlayerIdCache` | `Map<'eos:<id>' \| 'steam:<id>', { playerId, expiresAt }>` | `ttlMs` (60 s default), `maxEntries` (5 000 default), oldest evicted first |
| `ChatFlagDetector` | compiled rule array, `loadedAt` timestamp, optional in-flight reload promise | `ttlMs` (5 s default) |

Both live in the memory of one worker process; restarting a worker empties them.

## Frame shape

See [api.md](api.md#chatmessageframe--chatmessagedata). The frame `data.id` is a UUIDv7 generated for the live frame only; it is not the `chat_messages.id`.
