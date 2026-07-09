# worker-automation — Flows

## Startup

1. Connect to Redis (`REDIS_URL`, required — the process exits 1 if missing).
2. Build a `PluginRegistry` and call `loadPlugins(registry, BUILTIN_PLUGINS)` — throws (failing startup) if any built-in manifest is invalid or duplicates an id.
3. Start the dispatch loop (`runDispatchLoop`, see below) in the background.
4. Start the Redis heartbeat (`worker:heartbeat:automation`, `@squad/shared-config`).
5. Register `SIGINT`/`SIGTERM` handlers.

## Dispatch loop (`src/dispatch.ts`, `runDispatchLoop`)

Repeats until told to stop:

1. Discover event streams: `events:global` plus every `events:server:<id>` key currently in Redis (`SCAN events:server:*`).
2. For any newly-discovered stream, create its consumer group (`XGROUP CREATE ... MKSTREAM`, idempotent — `BUSYGROUP` is swallowed).
3. `XREADGROUP` across every known stream (`BLOCK` 1s, `COUNT` 50).
4. For each entry read:
   a. Parse the `envelope` field and validate it against `eventEnvelope` (malformed → log + ack, skip).
   b. Consumer-side dedup: `SET dedup:<group>:<event_id> ... NX` — already claimed → ack, skip.
   c. `dispatchEnvelope`: look up plugins subscribed to `envelope.type`, and for each:
      - Skip (and log) if the plugin lacks the `events:read` permission.
      - Otherwise invoke `handler.onEvent(envelope)` — with `payload` redacted to `null` if the plugin lacks `events:payload` — under a hard timeout (`invokeWithTimeout`). A throw, a rejection, or exceeding the timeout is caught, logged, and counted; it never affects any other plugin's delivery for the same event.
   d. Ack the stream entry.
5. A failure processing one entry (bad JSON, a Redis blip) is logged; the loop continues to the next entry/iteration rather than crashing the worker.

## Shutdown

1. On `SIGINT`/`SIGTERM`: flip the loop's stop flag, stop the heartbeat, await the in-flight dispatch-loop iteration, `redis.quit()`, `process.exit(0)`.
