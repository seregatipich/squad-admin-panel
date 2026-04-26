# worker-backup

## Purpose

Will create restic-based snapshots of the Postgres database and all server config files on a configurable schedule.

## Current status — P2 stub

No-op process. Logs `"worker-backup idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Code location

```
apps/workers/backup/
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
