# Changelog — worker-discord

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