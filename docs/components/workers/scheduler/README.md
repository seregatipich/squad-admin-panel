# worker-scheduler

## Purpose

Will execute cron-style scheduled tasks against Squad servers: periodic restarts, layer rotations, broadcast messages on a timed schedule.

## Current status

The worker runs the SEED-3 seed schedule, ROT-4 rotation calendar, AUTO-2
general scheduled-task, GAME-1 map auto-selection, and LEAD-7 season
finalisation ticks every 30 seconds by default. One-off rotation entries enqueue `AdminSetNextLayer` or
`AdminChangeLayer` through worker-rcon. Weekly profiles replace only the managed
`LayerRotation.cfg` segment through the host bridge. AUTO-2 `scheduled_tasks`
run restart / layer / broadcast actions on a one-off instant or a recurring
cron; MSG-4 (#187) adds broadcast **message rotation** (multiple
`params.messages` fired in turn via a `rotation_index` cursor) and a
`chat_messages` echo (scope `broadcast`, source `panel`) authored by the task
creator. GAME-1 (#80) picks the next layer from a per-server candidate pool
(weighted-random or least-recently-played, with layer/map cooldowns) and applies
exactly one `AdminSetNextLayer` per match, idempotently, skipping depot-update
windows. Per the map-rotation ADR (accepted trade-off), if the worker is down at
a match boundary no pick is applied and the server falls back to the static
`LayerRotation.cfg` managed-segment list last synced by ROT-2. LEAD-7 (#178)
closes every `active` season whose `ends_at` has passed, setting
`status='closed'` and `finalized=true` in one statement and then flushing the
`leaderboard:*` cache. Finalisation is what stops the leaderboard aggregator
recomputing a season: `loadActiveSeasonTarget` only returns active,
non-finalized rows, so once both columns flip the materialised slice is frozen
for good.

## Code location

```
apps/workers/scheduler/
  src/
    index.ts                    — tick loop, heartbeat, and graceful shutdown
    seed-schedule-tick.ts       — SEED-3 execution
    rotation-schedule-tick.ts   — ROT-4 one-off execution
    rotation-profile-tick.ts    — ROT-4 weekly managed-segment application
    scheduled-task-tick.ts      — AUTO-2 tasks + MSG-4 broadcast rotation/echo
    map-vote-tick.ts            — GAME-1 per-match map auto-selection
    season-finalize-tick.ts     — LEAD-7 closes + freezes expired seasons
    deps.ts                     — DB/Redis/bridge wiring for every tick
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
