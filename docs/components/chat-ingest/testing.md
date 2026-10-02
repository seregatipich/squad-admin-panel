# `chat-ingest` — testing

All tests are unit tests with hand-written stubs. They need neither Postgres nor Redis, so [local-test-setup.md](../../development/local-test-setup.md) (isolated test database) does not apply to this package. There is no vitest config file in the package, so vitest runs with its defaults and picks up `test/*.test.ts`.

## How to run

```bash
# Whole package
pnpm --filter @squad/chat-ingest exec vitest run

# One file
pnpm --filter @squad/chat-ingest exec vitest run test/store.test.ts

# Package script (same as `vitest run`)
pnpm --filter @squad/chat-ingest test

# Typecheck, including test/
pnpm --filter @squad/chat-ingest typecheck
```

In CI the package runs in the `packages` shard of `test:cov`; its weight in [`scripts/ci-test-shard.sh`](../../../scripts/ci-test-shard.sh) is `9`.

## Test files

15 test cases in 2 files.

| File | Cases | Covers |
|---|---:|---|
| [`test/store.test.ts`](../../../packages/chat-ingest/test/store.test.ts) | 12 | `buildChatFrame`, `handleChat`, `resolvePlayerId`, `PlayerIdCache` |
| [`test/flag-rules.test.ts`](../../../packages/chat-ingest/test/flag-rules.test.ts) | 3 | `ChatFlagDetector` caching and failure handling |

### `store.test.ts`

| Group | Case |
|---|---|
| `buildChatFrame` | Carries sender identity and message onto the frame; defaults `source` to `log` |
| `buildChatFrame` | Every frame gets a distinct `data.id` |
| `buildChatFrame` | A caller-supplied `source` (`rcon`) is carried through (#470) |
| `handleChat` | Publishes on `live-bus` even when the sender is unknown, does not insert, labels the frame with the given source |
| `handleChat` | Still returns the frame when no publisher is wired (`redis` null) |
| `handleChat` flag detection failures | A rejecting detector calls `onFlagError` and the line is archived with `isFlagged: false`, `matchedRuleId: null` |
| `resolvePlayerId` name fallback (#1057) | A sender whose ids match nobody is not matched by name (exactly one `select`) |
| `resolvePlayerId` name fallback (#1057) | A sender with no ids falls back to the name |
| `handleChat` publish failure (#1058) | A rejecting `publish` calls `onPublishError` and the line is still archived |
| `resolvePlayerId` with a cache | A repeat sender (also with only one of the two ids) is answered from the cache with a single query in total |
| `resolvePlayerId` with a cache | Misses and name-only matches are not cached |
| `PlayerIdCache` | Entries expire after `ttlMs`; past `maxEntries` the oldest is evicted (injected clock) |

### `flag-rules.test.ts`

| Case | Covers |
|---|---|
| Shares one reload between concurrent `detect()` calls | 10 concurrent calls issue one `select`; 5 of the 10 messages match |
| Reloads after the TTL and after `invalidate()` | `ttlMs = 0` reloads every call; a 60 s TTL does not until `invalidate()` |
| Does not cache a failed reload | Both concurrent waiters reject from a single `select`; the next call retries and succeeds |

## Test technique

- The database is a chain stub: `select().from().where().orderBy().limit()` returns the same chain object and the terminal call (`limit` for identity lookups, `orderBy` for the rule query) resolves the rows. Insert is `insert().values()` with a spy on `values`. The assertions are on call counts and on the object passed to `values`.
- The rule-query stub resolves on a later macrotask (`setTimeout(5)`) so concurrent `detect()` calls genuinely overlap.
- The Redis publisher is a `{ publish: vi.fn() }` object.

## What is not covered here

| Concern | Where it lives |
|---|---|
| A real `chat_messages` insert (constraints, partitioning), real identity queries | [`apps/workers/log-ingest/test/chat-store.test.ts`](../../../apps/workers/log-ingest/test/chat-store.test.ts), `chat-log.test.ts`, `chat-flag-detector.test.ts`: these import `@squad/chat-ingest` and run it against a real Postgres (`chat-store.test.ts` throws when `DATABASE_URL` is unset), so use the isolated database from [local-test-setup.md](../../development/local-test-setup.md) |
| Pattern compilation and matching semantics | [`shared-config`](../shared-config/testing.md) |
| The producers' line parsing | The rcon and log-ingest worker tests |
| Live-bus delivery to browsers | [`live-bus`](../live-bus/testing.md) |
