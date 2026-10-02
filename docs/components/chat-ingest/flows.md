# `chat-ingest` — flows

## Chat line to live frame and archive row

```
producer (log tailer onChat  |  RCON per-server chat queue, source: 'rcon')
  │   normalises the line to ChatInput
  ▼
handleChat(db, redis, { serverId, chat, source, playerIds, on*Error }, detector)
  1. resolvePlayerId(db, chat, playerIds)          // may throw -> handleChat rejects
  2. buildChatFrame(playerId, serverId, chat, source)
  3. redis.publish('live-bus', JSON.stringify(frame))     // skipped when redis is null
        └─ failure -> onPublishError, continue
  4. if playerId is null -> return frame (live only, nothing archived)
  5. matchedRuleId = detector?.detect(chat.message)      // null when no detector
        └─ failure -> onFlagError, matchedRuleId = null
  6. recordChatMessage(db, { playerId, serverId, sentAt, scope, message,
                             source, isFlagged: matchedRuleId !== null, matchedRuleId })
        └─ failure -> onArchiveError
  7. return frame
```

Both consumers call `handleChat` without awaiting on the hot path and attach a `.catch` that logs. In `worker-rcon` the calls are chained on a per-server `chatQueue` promise so lines for one server are handled in order; in `worker-log-ingest` each `onChat` invocation starts its own `handleChat` call.

`worker-rcon` additionally hands every parsed RCON chat line to `worker-log-ingest` on the `rcon:chat:{serverId}` stream, where the command, `chat_keyword` automation and `!report` handlers run (they are not part of `handleChat`); see [worker-log-ingest](../workers/log-ingest/api.md#chat-reactions-from-rcon-rconchatserverid).

The API process subscribes to `live-bus` and forwards `chat.message` frames to browsers over the live WebSocket; see [`live-bus`](../live-bus/README.md).

## Player resolution

```
cache hit (fresh)?  ─ yes ─▶ return cached players.id          (0 queries)
        │ no
sender has eosId or steamId64?
   ├─ yes ─▶ SELECT id FROM players WHERE eos_id = ? OR steam_id64 = ? LIMIT 1
   │            ├─ row  ─▶ cache under every carried id, return id
   │            └─ none ─▶ return null          (never falls back to the name)
   └─ no  ─▶ n = normalizePlayerName(playerName); empty -> null
              players.canonical_name_normalized = n   ─▶ row -> id
              player_name_history.name_normalized = n
                 ORDER BY last_seen_at DESC LIMIT 1   ─▶ row -> id, else null
```

Rationale (from the source comments): a display name is not an identity. A sender whose platform ids match nobody (the roster poll has not created the player yet) is left unresolved rather than filed under whoever else wears the same normalised name. Misses are never cached because the roster poll can create the player at any moment, and name-only matches are never cached because names move between players.

## Flag rule cache reload

```
detect(message)
  └─ ensureLoaded()
       loadedAt != 0 and now - loadedAt < ttlMs ?  ─ yes ─▶ use compiled rules
       │ no
       a reload already in flight? ─ yes ─▶ await the same promise
       │ no
       start reload(): SELECT enabled rules ORDER BY created_at, id
                       compileChatFlagRules(...)  loadedAt = now
       finally: clear the in-flight promise
  └─ detectChatFlag(message, compiled)  ─▶ first matching rule id, or null
```

- Concurrent callers that find the cache stale share one `SELECT`.
- A failed reload rejects every waiter, does not update `loadedAt`, and is not cached: the next `detect` retries. The stale compiled set is not served in the meantime.
- `invalidate()` sets `loadedAt` to 0, so the next `detect` reloads regardless of the TTL. The package itself never calls it; a rule edited in the panel becomes visible to a worker within `ttlMs`.
- Each worker process holds its own detector, so there is no cross-process invalidation.

## Failure matrix

| Dependency down | Effect |
|---|---|
| Redis | Live frame not delivered (`onPublishError`); archive row still written |
| Rules table unreadable | Line archived unflagged (`onFlagError`) |
| `chat_messages` insert fails | Live frame already published; `onArchiveError`; line missing from the archive |
| Identity query fails | `handleChat` rejects before publishing; the caller logs it |
