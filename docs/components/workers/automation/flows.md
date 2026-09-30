# worker-automation — Flows

## Startup

1. Connect to Postgres (`DATABASE_URL`, required — AUTO-1) and Redis (`REDIS_URL`, required — the process exits 1 if either is missing).
2. Build a `PluginRegistry` and call `loadPlugins(registry, BUILTIN_PLUGINS)` — throws (failing startup) if any built-in manifest is invalid or duplicates an id.
3. Start the dispatch loop (`runDispatchLoop`, see below) with the AUTO-1 `onEnvelope` hook, in the background.
4. Start the Redis heartbeat (`worker:heartbeat:automation`, `@squad/shared-config`).
5. Register `SIGINT`/`SIGTERM` handlers.

## Dispatch loop (`src/dispatch.ts`, `runDispatchLoop`)

Repeats until told to stop:

1. Discover event streams: `events:global` plus every `events:server:<id>` key currently in Redis (`SCAN events:server:*`).
2. For any newly-discovered stream, create its consumer group (`XGROUP CREATE ... MKSTREAM`, idempotent — `BUSYGROUP` is swallowed). Streams found on the first iteration start at `$` (a first start does not replay history); a stream first seen later was created after the loop started, so its group starts at `0` and the XADD that created it is delivered (#60). Redelivery is harmless — dedup is by `event_id`.
3. `XREADGROUP` across every known stream (`BLOCK` 1s, `COUNT` 50).
4. For each entry read:

1. Discover event streams — `events:global` plus every `events:server:<id>` key in Redis (`SCAN events:server:*`) — at most every 30 s (`DEFAULT_STREAM_REFRESH_MS`), not on every poll: the `SCAN` walks the whole keyspace. A failed discovery keeps the previous stream set.
2. For any stream without a consumer group yet, create it (`XGROUP CREATE ... 0 MKSTREAM`, idempotent — `BUSYGROUP` is swallowed). The group starts at `0`, so events a new server published before its stream was discovered are still delivered. A failed creation (e.g. `LOADING`) skips that stream for this iteration and is retried on the next one; it never stops the loop.
3. Every 30 s (and once at boot), `XAUTOCLAIM` entries idle for more than 30 s from any consumer — a crashed process, or an entry whose processing failed — and process them like new ones.
4. `XREADGROUP` across every stream with a group (`BLOCK` 1s, `COUNT` 50). A `NOGROUP` error (Redis lost its data) forgets the created groups so they are re-created on the next iteration.
5. For each entry read or reclaimed:
   a. Parse the `envelope` field and validate it against `eventEnvelope` (malformed → log + ack, skip).
   b. Consumer-side dedup: `GET dedup:<group>:<event_id>` — present → the event was already fully handled, ack, skip.
   c. `dispatchEnvelope`: look up plugins subscribed to `envelope.type`, and for each:
      - Skip (and log) if the plugin lacks the `events:read` permission.
      - Otherwise invoke `handler.onEvent(envelope)` — with `payload` redacted to `null` if the plugin lacks `events:payload` — under a hard timeout (`invokeWithTimeout`). A throw, a rejection, or exceeding the timeout is caught, logged, and counted; it never affects any other plugin's delivery for the same event.
   d. Run the AUTO-1 `onEnvelope` hook (`processAutomationEnvelope`): map the envelope to a trigger input (`player_count` from `rcon.players_polled`; `player_flag` + player ref from `player.connected`; `time_of_day` off any event), load the enabled rules (cached ~15s), `evaluate` them, and for each match `runMatch` (real firing) — enqueuing an RCON command / notifying, and writing an `automation_runs` + `audit_log` row. A `time_of_day` match is gated by the `automation:tod:<ruleId>` cooldown. A `player_count` match is edge-triggered: it fires only when `SET automation:pc:<ruleId>:<serverId> NX EX 600` succeeds (the false→true transition); later matching polls just refresh the latch, and a roster poll on which the rule does not match deletes the latch so the next crossing fires again. Errors here are logged and swallowed — they never block plugin delivery or the ack.
   e. Ack the stream entry.
5. A failure processing one entry (bad JSON, a Redis blip) is logged; the loop continues to the next entry/iteration rather than crashing the worker.
6. `NOGROUP` from `XREADGROUP` (a known stream was deleted and possibly re-created by a later XADD) clears the known-stream cache, so the next iteration re-creates every group instead of the read stalling until a restart (#60).

   d. Run the AUTO-1 `onEnvelope` hook (`processAutomationEnvelope`): map the envelope to a trigger input (`player_count` from `rcon.players_polled`; `player_flag` + player ref from `player.connected`; `time_of_day` off any event), load the enabled rules (cached ~15s), `evaluate` them, and for each match `runMatch` (real firing) — enqueuing an RCON command / notifying, and writing an `automation_runs` + `audit_log` row. A `time_of_day` match is gated by the per-server `automation:tod:<ruleId>:<serverId>` cooldown (`global` for a serverless envelope, which only a `notify_admin` rule can use — an RCON action never spends the window on it); a firing that throws or records `failed` releases the cooldown. If the trigger input or the rule set cannot be loaded (e.g. the database is down) the hook rejects before anything fired.
   e. `SET dedup:<group>:<event_id> ... NX`, then ack the stream entry.
6. Delivery is at-least-once: any failure in step 5 (a rejected hook, a Redis blip) is logged and leaves the entry pending without a dedup key, so step 3 retries it; plugins may then see the event again. Nothing inside an iteration rejects the loop. If the loop ever does reject, the process exits 1 so the container restarts instead of heartbeating while consuming nothing.

## Shutdown

1. On `SIGINT`/`SIGTERM`: flip the loop's stop flag, stop the heartbeat, await the in-flight dispatch-loop iteration, `redis.quit()`, `process.exit(0)`.
