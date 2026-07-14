# worker-scheduler

## Purpose

Will execute cron-style scheduled tasks against Squad servers: periodic restarts, layer rotations, broadcast messages on a timed schedule.

## Current status

The worker runs the SEED-3 seed schedule and ROT-4 rotation calendar ticks every
30 seconds by default. One-off rotation entries enqueue `AdminSetNextLayer` or
`AdminChangeLayer` through worker-rcon. Weekly profiles replace only the
managed `LayerRotation.cfg` segment through the host bridge.

## Code location

```
apps/workers/scheduler/
  src/
    index.ts                    — tick loop, heartbeat, and graceful shutdown
    seed-schedule-tick.ts       — SEED-3 execution
    rotation-schedule-tick.ts   — ROT-4 one-off execution
    rotation-profile-tick.ts    — ROT-4 weekly managed-segment application
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
