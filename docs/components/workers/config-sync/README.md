# worker-config-sync

## Purpose

Will push config file changes to a Git remote so operators get a versioned off-panel history of every `.cfg` edit alongside the panel's own `config_versions` table.

## Current status — P2 stub

No-op process. Logs `"worker-config-sync idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Code location

```
apps/workers/config-sync/
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
