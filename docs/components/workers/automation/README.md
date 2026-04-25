# worker-automation

## Purpose

Will implement user-defined automation rules of the form "when event X occurs on server Y, execute action Z". Examples: auto-broadcast on match start, auto-kick on repeated team-kills, scheduled layer rotation.

## Current status — P2 stub

The worker is deployed as a no-op process. It logs `"worker-automation idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. It does **not** publish `worker:heartbeat:automation` to Redis (no `startHeartbeat` call in current code).

## What it does not do

- Does not subscribe to Redis Streams.
- Does not send RCON commands.
- Does not read from Postgres.

## Code location

```
apps/workers/automation/
  src/
    index.ts    — P2 stub: log loop only
```

## Dependencies

- `pino` — structured logging

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
