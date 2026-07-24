# worker-automation — Data model

## Postgres tables (AUTO-1, #72)

The worker reads and writes these tables (schema in `packages/db/src/schema/automation-rules.ts`, migration `0084_automation_rules.sql`):

| Table | Direction | Purpose |
|---|---|---|
| `automation_rules` | read | Enabled "if {condition} → {action}" rules the worker evaluates. `condition_type` ∈ `chat_keyword`/`player_count`/`time_of_day`/`player_flag`; `action_type` ∈ `rcon_command`/`kick`/`warn`/`notify_admin`; parameters in the `condition`/`action` jsonb (validated against `@squad/shared-types` schemas). A null `server_id` is a global rule. |
| `automation_runs` | write | Append-only firing history — one row per matched evaluation. `matched` snapshots the trigger data; `action_result` records what ran (or a dry-run preview); `dry_run` distinguishes a test from a real firing; `status` ∈ `matched`/`no_match`/`executed`/`failed`/`skipped`. |
| `audit_log` | write | One system-actor entry (`automation_rule.fire`) per real firing. |
| `players` | read | `player_flag` conditions resolve a connecting player's flags from their `players` row. |

The plugin host (INT-4) itself has no tables — plugin registration is in-code (`BUILTIN_PLUGINS` in `src/loader.ts`).

## Redis keys read/written

| Key pattern | Direction | Purpose |
|---|---|---|
| `events:global` | read | Shared stream for events with no `server_id` |
| `events:server:<id>` | read | Per-server event stream (discovered via `SCAN events:server:*`) |
| `rcon:commands:<serverId>` | write | AUTO-1 actions (`rcon_command`/`kick`/`warn`) enqueue an operator command here for worker-rcon to run |
| `automation:tod:<ruleId>` | read/write | Per-rule cooldown so a `time_of_day` rule fires at most once per window instead of on every event inside it |
| `dedup:automation-dispatch:v1:<event_id>` | read/write | Consumer-side idempotency: an entry already claimed here is ack'd without re-dispatching |
| `worker:heartbeat:automation` | write | Liveness heartbeat (`@squad/shared-config`'s `startHeartbeat`) |

The `EventEnvelope` shape consumed from those streams is defined once in `packages/shared-types/src/events.ts` (`EVT-1`); the plugin manifest/permission contract is defined in `packages/shared-types/src/plugins.ts`. The `chat_keyword` condition is evaluated in `@squad/worker-log-ingest` (chat is not on the event stream), not here.
