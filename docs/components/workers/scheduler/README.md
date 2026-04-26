# worker-scheduler

## Purpose

Will execute cron-style scheduled tasks against Squad servers: periodic restarts, layer rotations, broadcast messages on a timed schedule.

## Current status — P2 stub

No-op process. Logs `"worker-scheduler idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Code location

```
apps/workers/scheduler/
  src/
    index.ts    — P2 stub
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
