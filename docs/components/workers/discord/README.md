# worker-discord

## Purpose

Will relay Squad server events to Discord via webhooks and optionally expose a Discord bot for in-Discord admin commands.

## Current status — P2 stub

No-op process. Logs `"worker-discord idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Code location

```
apps/workers/discord/
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
