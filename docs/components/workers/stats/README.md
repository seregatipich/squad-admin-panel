# worker-stats

## Purpose

Will project player statistics from the `events:server:{id}` Redis Streams into a queryable Postgres table to back a future stats UI: playtime per player per server, kills/deaths, squad participation, map history.

## Current status — P2 stub

No-op process. Logs `"worker-stats idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Code location

```
apps/workers/stats/
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
