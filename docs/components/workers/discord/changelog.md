# Changelog — worker-discord

## 2026-07-29 — docs reconciliation (#216)

### Changed

- Rewrote the standard component docs (`README.md`, `api.md`, `configuration.md`,
  `data-model.md`, `flows.md`, `testing.md`, `troubleshooting.md`) to cover the
  status-channel/slash-command loop (DISCORD-6, #153) shipped on 2026-07-28
  below, which had gone entirely undocumented, and to describe "two loops" as
  "three loops" throughout.
- `api.md` went from "P2 stub, no public surface" to documenting the
  `worker:heartbeat:discord` heartbeat, the outbound Discord REST call list, and
  the inbound slash-command route the API (not this worker) answers.

## 2026-07-28 — DISCORD-6 (#153)

### Added

- `src/status-channel.ts` — `buildStatusChannelName` (SQSTAT §16.3 template:
  `{emoji}{map}_{players}x{queue}_👮{admins}`), `renameStatusChannel` (a
  Redis-backed two-renames-per-ten-minutes budget per channel, keyed
  `discord:status-channel:{channelId}`, that survives a worker restart), and
  `runStatusChannelTick` (one pass over every server with a
  `status_channel_id`, reading `rcon:status:*`/`rcon:roster:*` and the
  panel-access admin set).
- `src/status-channel-loop.ts` — `runStatusChannelLoop`, ticking on
  `DISCORD_STATUS_CHANNEL_MS` (default 10 min) behind the same
  `loadDiscordBotContext` gate role sync uses, plus one-time slash-command
  registration when `DISCORD_APPLICATION_ID` is set.
- `src/command-registration.ts` — `DISCORD_COMMAND_DEFINITIONS`
  (`/status`, `/player`, `/online-admins`, all read-only) and
  `registerApplicationCommands` (`PUT /applications/{id}/commands`, idempotent
  full-replace).
- `src/discord-rest.ts` — `patchChannelName` (`PATCH /channels/{id}`, its own
  429/`Missing Permissions` handling for the Manage-Channels-gated rename call).
- `apps/api/src/routes/discord-interactions.ts` — the inbound
  `POST /api/v1/integrations/discord/interactions` route that answers the
  registered slash commands (Ed25519-signature-verified, ephemeral replies).
- `test/status-channel.test.ts`, `test/status-channel-loop.test.ts`.

### Changed

- `src/index.ts` starts the status-channel loop alongside notify and role sync,
  and awaits all three on shutdown.

## 2026-07-27 — DISCORD-5 (#152)

### Added

- `src/role-sync.ts` — `loadDiscordBotContext` (guild id + decrypted bot token from `discord_integration`, `null` when not fully configured), `syncPlayerDiscordRoles` (one player's derivation) and `reconcileLinkedPlayers` (the whole `player_discord_links` table). Reaction and reconcile share one code path: it always reads the member's current Discord roles first, which makes it idempotent and makes drift repair fall out for free.
- `src/role-sync-consume.ts` — the `discord:role-sync` consumer group (`discord-role-sync:v1`), the hourly reconcile tick (`DISCORD_ROLE_SYNC_RECONCILE_MS`, default 1 h), and the `discord:role-sync:status` publishing the settings UI reads.
- `src/discord-rest.ts` — `fetchGuildMemberRoles`, `addGuildMemberRole`, `removeGuildMemberRole` over raw `fetch` (no Discord library, matching `apps/api/src/lib/discord-oauth.ts`), with `Retry-After`-driven 429 retries and a typed failure for `Missing Permissions`.
- `test/discord-rest.test.ts`, `test/role-sync.test.ts`, `test/role-sync-consume.test.ts`.
- `@squad/worker-discord` added to the root `test:cov` filter list, so this package's tests now run in CI.

### Changed

- `src/index.ts` starts the role-sync loop alongside the notify loop and awaits both on shutdown. The role-sync loop reuses this worker's database client, Redis connection and encryption key rather than becoming a separate service — it needs exactly the same credentials.

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:discord` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.