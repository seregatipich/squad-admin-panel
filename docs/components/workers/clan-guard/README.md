# worker-clan-guard

## Purpose

Enforces clan tag protection. Every 120 s it looks at the players currently online, finds those whose in-game name starts with the tag of a protected clan they do not belong to, warns them over RCON, and kicks them if the name is still unchanged once a grace period has passed. Warnings and kicks are recorded in the moderation ledger and the audit log.

## Responsibilities

- Run `runClanGuardTick` at startup and on every `CLAN_GUARD_INTERVAL_MS` tick (default 120 000 ms).
- Read the kill-switch and grace period from the singleton `clan_guard_settings` row on every tick; skip the whole tick while `enabled` is false.
- Load protected clans (`clans.is_tag_protected = true`, not soft-deleted) with their member sets, and online players (open `player_sessions` rows with `mode = 'online'`).
- Match each online player's raw name against each protected clan's tags (`matchProtectedTag`), ignoring clans the player is a member of.
- First detection in a session: send an `AdminWarn`, write a `moderation_actions` row (`phase: warn`) and an audit row.
- Detection past the grace period: send an `AdminKick` (or, for holders of a panel-access role, another `AdminWarn`), and record the kick once per session.
- Publish `worker:heartbeat:clan-guard` every 5 s and emit `clan_guard.*` diagnostic events.

## What it does not do

- Does not talk to the bridge or hold an RCON connection. Commands are appended to the per-server Redis stream `rcon:commands:<serverId>` and executed by `worker-rcon`; the worker never waits for the result.
- Does not ban. The strongest action is `AdminKick`.
- Does not kick players that hold a role with `panel_access = true`; they are re-warned on every tick past the grace period instead (admin self-lockout protection).
- Does not touch players without an `eos_id` or without an open online session.
- Does not manage clans or their tags; that is the API (`/api/v1/clans`) and the settings page (`/api/v1/settings/clan-guard`).
- Exposes no HTTP API and opens no port.

## Code location

```
apps/workers/clan-guard/
  src/
    index.ts    - runWorker() wiring: env, tick interval, overlap guard
    env.ts      - re-exports positiveIntEnv from @squad/worker-kit
    tick.ts     - runClanGuardTick(), matchProtectedTag(), findImpostorMatch(), message builder
    deps.ts     - Postgres/Redis implementations of the tick's dependencies
  test/
    global-setup.ts
    contract.test.ts
    tick.test.ts
    tick.integration.test.ts
    bare-tag.integration.test.ts
  vitest.config.ts
```

## Dependencies

- `@squad/worker-kit` - `createWorkerLog`, `runWorker`, `positiveIntEnv`
- `@squad/db` - Drizzle client and schema (`clanGuardSettings`, `clans`, `clanMembers`, `players`, `playerSessions`, `roles`, `moderationActions`, `auditLog`)
- `@squad/shared-types` - `rconCommandRequestSchema`, `rconCommandStream`
- `@squad/diag` - diagnostic events
- `ioredis` (heartbeat, diagnostics and the RCON command stream), `uuid` (request ids), `drizzle-orm`

## Components that depend on it

- `worker-rcon` consumes the `rcon:commands:<serverId>` entries this worker appends.
- API `GET|PATCH /api/v1/settings/clan-guard` edits the kill-switch and grace period this worker reads.
- The player card's moderation history shows the `clan_tag_protection` ledger rows.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [rcon worker](../rcon/README.md)
