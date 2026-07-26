# worker-scheduler — Data model

The worker reads enabled rows from `seed_schedule` and `rotation_schedule`.
`rotation_schedule.last_executed_at` prevents a one-off row from being queued
more than once. Weekly rows in `rotation_profiles` store one default profile
(`weekday IS NULL`) and optional server-local weekday overrides; the selected
row's `last_applied_at` prevents repeated application on the same local day.

Execution and profile application are recorded in `audit_log` with system actor
label `rotation-scheduler`. The 0078 migration creates the two ROT-4 tables;
the migration journal is finalized by the integration branch owner.

## GAME-1 map auto-selection

The worker reads `server_settings` rows with `map_vote_enabled` (migration
`0090` adds the five `map_vote_*` columns: enable flag, selection rule,
layer/map cooldowns, optional broadcast template). `map_vote_candidates` is the
per-server pool — layer name (validated against the ROT-1 `layers` catalog by
the API), weight 1..100, per-row enable. `map_vote_picks` records exactly one
decision per match: the unique `match_id` index is the idempotency guard
(`INSERT ... ON CONFLICT DO NOTHING RETURNING` — no returned id means another
tick owns the match), `candidate_snapshot`/`rng_seed` make the pick
reproducible, and `applied`/`failure_reason` record the outcome
(`depot_update`, `rcon_enqueue_failed`). Ticks audit with system actor label
`map-vote-scheduler` (`server.map_vote.applied` / `.skip_depot_update` /
`.no_candidates`).

## AUTO-2 / MSG-4 scheduled tasks

The worker also reads enabled `scheduled_tasks` rows (AUTO-2, #73) and appends
one `scheduled_task_runs` row per attempt (`executed` / `skipped_depot_update` /
`failed`), auditing with system actor label `task-scheduler`. `last_executed_at`
is the dedup cursor with the same semantics as `seed_schedule`.

MSG-4 (#187) adds `scheduled_tasks.rotation_index integer NOT NULL DEFAULT 0`
(migration `0086`): a `broadcast` task with `params.messages` (an ordered
rotation) fires `messages[rotation_index % messages.length]`, and the cursor is
advanced (modulo the list length) after each successful dispatch — a single
`params.message` never advances it. When the broadcast succeeds and the task has
a non-null `created_by`, the resolved text is echoed into `chat_messages` (scope
`broadcast`, source `panel`, `player_id = created_by`); a null creator skips the
echo (recorded as `echo: 'skipped_no_author'` in the run detail) because
`chat_messages.player_id` is `NOT NULL`. An echo failure never downgrades the
already-executed run (recorded as `echo: 'failed'`).
