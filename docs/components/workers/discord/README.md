# worker-discord

## Purpose

Will relay Squad server events to Discord via webhooks and optionally expose a Discord bot for in-Discord admin commands.

## Current status

Consumes the shared per-server event streams and delivers enabled Discord
webhook templates. SEED-4 maps `seed.call_sent` and
`server.seeding_started` to the editable `seed_needed` template, including a
Steam join link when the event carries one. The worker stays in heartbeat-only
idle mode when its database or encryption key is not configured.

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
