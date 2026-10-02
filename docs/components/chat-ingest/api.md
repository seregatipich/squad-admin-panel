# `chat-ingest` — API reference

```ts
import {
  ChatFlagDetector,
  PlayerIdCache,
  buildChatFrame,
  handleChat,
  recordChatMessage,
  resolvePlayerId,
  LIVE_BUS_CHANNEL,
  type ChatChannel,
  type ChatInput,
  type ChatMessageData,
  type ChatMessageFrame,
  type ChatPublisher,
  type ChatRecord,
} from '@squad/chat-ingest';
```

The barrel in [`src/index.ts`](../../../packages/chat-ingest/src/index.ts) exports 6 values (`ChatFlagDetector`, `handleChat`, `PlayerIdCache`, `recordChatMessage`, `resolvePlayerId`, `buildChatFrame`), 1 constant (`LIVE_BUS_CHANNEL`) and 6 types.

## Types

### `ChatChannel`

`'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin'` — the in-game channel names as Squad writes them.

### `ChatInput`

One chat line, however it arrived.

| Field | Type | Notes |
|---|---|---|
| `ts` | `string` | ISO-8601 timestamp; parsed with `new Date(ts)` for the archive row |
| `channel` | `ChatChannel` | |
| `eosId` | `string \| null` | |
| `steamId64` | `string \| null` | Converted with `BigInt()` for the lookup, so it must be a decimal integer string |
| `playerName` | `string` | |
| `message` | `string` | |

### `ChatPublisher`

`{ publish(channel: string, message: string): Promise<unknown> }` — the subset of an ioredis client used for fan-out.

### `ChatMessageFrame` / `ChatMessageData`

```ts
interface ChatMessageFrame { type: 'chat.message'; ts: string; data: ChatMessageData }
interface ChatMessageData {
  id: string;               // UUIDv7 generated per frame
  server_id: string;
  ts: string;
  channel: ChatChannel;
  player_id: string | null;
  player_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  message: string;
  source: ChatSource;       // 'log' | 'panel' | 'rcon', from @squad/db
}
```

### `ChatRecord`

Input of `recordChatMessage`.

| Field | Type | Value written when omitted |
|---|---|---|
| `playerId` | `string` | required |
| `serverId` | `string` | required |
| `sentAt` | `Date` | required |
| `scope` | `ChatScope` | required |
| `message` | `string` | required |
| `source` | `ChatSource` (optional) | `'log'` |
| `teamId` | `number \| null` (optional) | `null` |
| `squadId` | `number \| null` (optional) | `null` |
| `isFlagged` | `boolean` (optional) | `false` |
| `matchedRuleId` | `string \| null` (optional) | `null` |

## Constants

| Export | Value |
|---|---|
| `LIVE_BUS_CHANNEL` | `'live-bus'` |

## Functions

### `handleChat(db, redis, options, detector?)`

```ts
handleChat(
  db: DatabaseClient,
  redis: ChatPublisher | null,
  options: {
    serverId: string;
    chat: ChatInput;
    source?: ChatSource;                 // default 'log'
    onArchiveError?: (err: Error) => void;
    onFlagError?: (err: Error) => void;
    onPublishError?: (err: Error) => void;
    playerIds?: PlayerIdCache;
  },
  detector?: ChatFlagDetector | null,
): Promise<ChatMessageFrame>
```

Order of operations: resolve the player, build the frame, publish it (when `redis` is non-null), then, only if a player was resolved, run flag detection and insert the archive row. Returns the frame that was built, whatever the publish and archive outcomes.

Error behaviour:

| Failure | Behaviour |
|---|---|
| Live-bus `publish` rejects | `onPublishError` is called; the archive write still happens |
| `detector.detect()` rejects | `onFlagError` is called; the line is archived with `isFlagged: false`, `matchedRuleId: null` |
| Archive insert rejects | `onArchiveError` is called; the already-built frame is still returned |
| `resolvePlayerId` rejects (identity query fails) | **Propagates.** Nothing is published or archived and `handleChat` rejects; callers must catch (both consumers attach a `.catch` and log) |
| Sender unknown | Frame is published with `player_id: null`; nothing is archived |

If a callback (`onArchiveError`, `onFlagError`, `onPublishError`) is not supplied, the error is silently dropped.

`channel` maps to `chat_messages.scope` through a fixed table: `ChatAll` to `all`, `ChatTeam` to `team`, `ChatSquad` to `squad`, `ChatAdmin` to `admin`. `handleChat` does not set `teamId` or `squadId`.

### `resolvePlayerId(db, chat, cache?)`

```ts
resolvePlayerId(db: DatabaseClient, chat: ChatInput, cache?: PlayerIdCache): Promise<string | null>
```

1. A fresh `cache.lookup(chat)` hit is returned without any query.
2. If the sender has `eosId` and/or `steamId64`: one `SELECT ... LIMIT 1` on `players` with `eos_id = ?` OR `steam_id64 = ?`. A hit is cached (when a cache was given) and returned; **no hit returns `null` without falling back to the name**.
3. A sender with no ids: normalise `playerName` with `normalizePlayerName`; an empty result returns `null`. Otherwise look up `players.canonical_name_normalized`, then `player_name_history.name_normalized` (most recent `last_seen_at` first). Name matches are never cached.

### `PlayerIdCache`

Worker-local, in-process cache of EOS/Steam id to `players.id`. Not shared between processes.

```ts
new PlayerIdCache(opts?: { ttlMs?: number; maxEntries?: number; now?: () => number })
cache.lookup(chat: Pick<ChatInput, 'eosId' | 'steamId64'>): string | undefined
cache.remember(chat: Pick<ChatInput, 'eosId' | 'steamId64'>, playerId: string): void
```

| Option | Default |
|---|---|
| `ttlMs` | `60_000` |
| `maxEntries` | `5_000` |
| `now` | `Date.now` |

Keys are `eos:<eosId>` and `steam:<steamId64>`; `remember` stores the player under every id the sender carries. An expired entry is deleted on `lookup`. When `remember` pushes the map past `maxEntries`, the oldest-inserted entries are evicted (re-remembering an id moves it to the newest position).

### `ChatFlagDetector`

```ts
new ChatFlagDetector(db: DatabaseClient, ttlMs?: number)   // ttlMs default 5_000
detector.detect(message: string): Promise<string | null>   // id of first matching enabled rule
detector.invalidate(): void                                // force a reload on the next detect()
```

Rules are loaded lazily, compiled with `compileChatFlagRules`, and cached for `ttlMs`. See [flows.md](flows.md#flag-rule-cache-reload). `detect` rejects when the rule set cannot be reloaded. A stored `pattern_type` that is not a known type is compiled as `'word'`.

### `buildChatFrame(playerId, serverId, chat, source = 'log')`

Pure function returning a `ChatMessageFrame` with a fresh UUIDv7 `data.id`.

### `recordChatMessage(db, record)`

Inserts one `chat_messages` row from a `ChatRecord` (defaults in the table above). Rejects on database error.
