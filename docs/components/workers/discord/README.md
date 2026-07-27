# worker-discord

## Purpose

Will relay Squad server events to Discord via webhooks and optionally expose a Discord bot for in-Discord admin commands.

## Current status

Two loops in one process:

- **notify** (DISCORD-2) — consumes the shared per-server event streams and
  delivers enabled Discord webhook templates. SEED-4 maps `seed.call_sent` and
  `server.seeding_started` to the editable `seed_needed` template, including a
  Steam join link when the event carries one.
- **role sync** (DISCORD-5) — drives every linked player's Discord guild roles
  from `players.role_id` through `discord_role_mappings`, reacting to
  `discord:role-sync` requests published by the API and repairing drift on an
  hourly reconcile. The panel is the source of truth, but only over the Discord
  roles an enabled mapping names.

The worker stays in heartbeat-only idle mode when its database or encryption key
is not configured; role sync additionally idles until an operator stores a guild
id and a bot token on the `discord_integration` row.

## Code location

```
apps/workers/discord/
  src/
    index.ts             — entrypoint: heartbeat + both loops
    consume.ts           — notify consumer group (events:*)
    sender.ts            — embed rendering + webhook POST
    mapping.ts           — event type → Discord event type
    crypto.ts            — AES-256-GCM decrypt (mirrors the API's scheme)
    role-sync.ts         — panel role → Discord role derivation + reconcile
    role-sync-consume.ts — discord:role-sync consumer group + status publishing
    discord-rest.ts      — the three guild-member REST calls, over raw fetch
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
