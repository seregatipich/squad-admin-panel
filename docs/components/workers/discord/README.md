# worker-discord

## Purpose

Relays Squad server events to Discord via webhooks, syncs the panel's roles into
a Discord guild, and keeps a status channel plus a small set of read-only slash
commands live for the community.

## Current status

Three loops in one process:

- **notify** (DISCORD-2) — consumes the shared per-server event streams and
  delivers enabled Discord webhook templates. SEED-4 maps `seed.call_sent` and
  `server.seeding_started` to the editable `seed_needed` template, including a
  Steam join link when the event carries one.
- **role sync** (DISCORD-5) — drives every linked player's Discord guild roles
  from `players.role_id` through `discord_role_mappings`, reacting to
  `discord:role-sync` requests published by the API and repairing drift on an
  hourly reconcile. The panel is the source of truth, but only over the Discord
  roles an enabled mapping names.
- **status channel** (DISCORD-6, #153) — every tick (default 10 min), renames
  each server's configured Discord channel to a live `map_players x queue_admins`
  summary built from `worker-rcon`'s cached status/roster, honouring Discord's
  two-renames-per-ten-minutes budget. The same loop registers the worker's
  read-only slash commands (`/status`, `/player`, `/online-admins`) with Discord
  once a `DISCORD_APPLICATION_ID` is configured; the commands themselves are
  answered by the API (`apps/api/src/routes/discord-interactions.ts`), not here.

The worker stays in heartbeat-only idle mode when `DATABASE_URL`/`APP_ENCRYPTION_KEY`
is not configured — all three loops are disabled rather than crash-looping. Role
sync and the status channel additionally idle (tick and do nothing) until an
operator stores a guild id and a bot token on the `discord_integration` row, via
the shared `loadDiscordBotContext` gate.

## Code location

```
apps/workers/discord/
  src/
    index.ts                 — entrypoint: heartbeat + all three loops
    consume.ts                — notify consumer group (events:*)
    sender.ts                 — embed rendering + webhook POST
    mapping.ts                — event type → Discord event type
    crypto.ts                 — AES-256-GCM decrypt (mirrors the API's scheme)
    role-sync.ts               — panel role → Discord role derivation + reconcile; also exports loadDiscordBotContext, shared with the status channel loop
    role-sync-consume.ts       — discord:role-sync consumer group + status publishing
    status-channel.ts          — DISCORD-6: per-server channel rename tick + rename budget
    status-channel-loop.ts     — DISCORD-6: drives the status-channel tick and one-time slash-command registration
    command-registration.ts    — DISCORD-6: declares and PUTs the /status, /player, /online-admins slash commands
    discord-rest.ts            — guild-member role REST calls plus the channel-rename call, over raw fetch
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
