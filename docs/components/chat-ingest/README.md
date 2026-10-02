# `chat-ingest` — shared chat ingestion pipeline

TypeScript package (`@squad/chat-ingest`) holding everything downstream of "a chat line was observed". Chat reaches the panel from two independent producers, the log tailer ([`worker-log-ingest`](../workers/log-ingest/README.md)) and the RCON broadcast listener ([`worker-rcon`](../workers/rcon/README.md)). Both normalise a line to a `ChatInput` and hand it to `handleChat()`, so storage and fan-out cannot drift apart.

## Responsibilities

- Resolve the chat sender to a `players.id` (`resolvePlayerId`), by EOS/Steam id when the sender carries one, otherwise by normalised name and name history.
- Build the `chat.message` live frame (`buildChatFrame`) and publish it on the Redis `live-bus` channel.
- Match the message against the enabled `chat_flag_rules` (`ChatFlagDetector`) and persist the line to `chat_messages` with the flag result (`recordChatMessage`).
- Keep a worker-local sender cache (`PlayerIdCache`) so a repeat sender costs no identity queries.

## What it does NOT do

- **Does not parse chat lines.** Parsing lives in the producers (`apps/workers/rcon/src/chat.ts`, the log-ingest parser); this package starts at `ChatInput`.
- **Does not own the schema.** `chat_messages`, `chat_flag_rules`, `players` and `player_name_history` belong to [`db`](../db/README.md).
- **Does not own the pattern semantics.** Compiling and matching rules is `compileChatFlagRules` / `detectChatFlag` from [`shared-config`](../shared-config/README.md); this package only loads rows and caches the compiled set.
- **Does not read environment variables, open connections, or create clients.** The caller passes the database client and the Redis publisher.
- **Does not archive lines from unknown senders.** A sender that resolves to no player is published live but not stored (`chat_messages.player_id` is `NOT NULL`).

## Code

| File | Contents |
|---|---|
| [`packages/chat-ingest/src/index.ts`](../../../packages/chat-ingest/src/index.ts) | Barrel re-exporting the public surface |
| [`packages/chat-ingest/src/store.ts`](../../../packages/chat-ingest/src/store.ts) | `handleChat`, `resolvePlayerId`, `PlayerIdCache`, `buildChatFrame`, `recordChatMessage`, types |
| [`packages/chat-ingest/src/flag-rules.ts`](../../../packages/chat-ingest/src/flag-rules.ts) | `ChatFlagDetector` |

## Consumers

| Consumer | Uses |
|---|---|
| [`apps/workers/log-ingest`](../../../apps/workers/log-ingest/src/index.ts) | `ChatFlagDetector`, `handleChat`, `PlayerIdCache` (one of each per process); `resolvePlayerId` and the `PlayerIdCache` type in `src/chat/commands.ts` for in-game commands |
| [`apps/workers/rcon`](../../../apps/workers/rcon/src/index.ts) | `ChatFlagDetector` and `PlayerIdCache` created in `src/index.ts` and passed to the per-server supervisors; `handleChat` in `src/supervisor/per-server.ts` with `source: 'rcon'`; the `ChatChannel` / `ChatInput` types in `src/chat.ts` |

No other package or app imports `@squad/chat-ingest`. Dependencies: `@squad/db`, `@squad/shared-config`, `drizzle-orm`, `uuid` (see [`package.json`](../../../packages/chat-ingest/package.json)).

## See also

- [api.md](api.md), [configuration.md](configuration.md), [data-model.md](data-model.md), [flows.md](flows.md), [testing.md](testing.md), [troubleshooting.md](troubleshooting.md)
- [`live-bus`](../live-bus/README.md) — the API-side subscriber of the published frames.
