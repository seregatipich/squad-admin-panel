# Changelog — worker-discord

## 2026-09-30

### Fixed

- Отправитель проверяет сохранённый `template` (`isDiscordEmbedTemplate` из `@squad/shared-config`) и при повреждённой строке берёт шаблон по умолчанию, а не передаёт произвольный jsonb в рендер (#78, 1126). Тест: `test/sender.test.ts`.

## 2026-09-30 — one Discord REST request wrapper (#92)

### Changed

- `roleCall`, `fetchGuildMemberRoles` and `patchChannelName` in `discord-rest.ts` now share a single `discordRequest` wrapper for the request timeout, network errors and 429 handling. A member lookup no longer sleeps through a `Retry-After` above 30 s: it reports `rate_limited` at once, like role changes.

## 2026-09-28

### Fixed

- Шаблон с плейсхолдером-именем свойства прототипа (`{constructor}`, `{__proto__}`) больше не роняет отправку, а поле без значения (например, `{steam_id64}` у игрока только с EOS) и слишком длинный текст больше не дают HTTP 400 от Discord: это исправлено в `renderDiscordTemplate` из `@squad/shared-config` (#52).

## 2026-09-28 — consumer groups on new and re-created streams (#60)

### Fixed

- A stream discovered after the loop started gets its consumer group at `0`, not `$`, so the first events of a new server's `events:server:<id>` stream (including the XADD that created it) are delivered. Streams present on the first discovery still start at `$`.
- `NOGROUP` from the multiplexed `XREADGROUP` clears the known-stream cache and re-creates the groups; a deleted and re-created stream no longer stops reading every stream until a restart.

- #883: the notify loop discovers streams (`SCAN events:server:*`) and runs the `XAUTOCLAIM` sweep every 30 s instead of on every poll, and no longer writes a 24-hour dedup key for event types Discord never renders.
- #1292: a failing `XGROUP CREATE` (e.g. `LOADING` after a Redis restart) no longer ends the notify or role-sync loop — it is retried, and a `NOGROUP` read error re-creates the group; if a loop still rejects, the worker exits 1 instead of heartbeating as healthy. The Redis client now waits for the ready check. New notify groups start at `0`, so events published before a stream was discovered are delivered.

## 2026-09-28 — reliability fixes (#62)

### Fixed

- Notify no longer acknowledges an entry whose delivery failed for any webhook:
  the entry stays pending and is retried by the reclaim sweep (up to
  `MAX_DELIVERY_ATTEMPTS` = 10), and a per-webhook ledger
  (`dedup:<group>:<event_id>:<webhook_id>`) keeps a retry from re-posting to
  webhooks that already got the embed. `deliverEnvelope` takes an optional
  `WebhookDeliveryLedger`.
- A `NOGROUP` answer (stream deleted and recreated) now evicts the
  consumer-group cache so the group is recreated instead of stalling every
  stream; group creation failures in both consumers are retried inside the
  loop instead of ending it.
- A loop that returns or throws before shutdown now exits the process with
  code 1 instead of leaving a dead loop behind a green heartbeat.
- Notify and role sync each use their own Redis connection
  (`redis.duplicate()`), so one loop's blocking `XREADGROUP` no longer delays
  the other loop's commands or the heartbeat.
- Webhook POSTs time out after 10 s (`DEFAULT_WEBHOOK_TIMEOUT_MS`), a 429
  asking to wait longer than 60 s (`MAX_RETRY_AFTER_MS`) fails fast, and the
  retry sleep is interrupted by shutdown.
- `fetchGuildMemberRoles` retries a 429 after `Retry-After` and reports
  `rate_limited` when the retries run out, instead of `Discord вернул 429`.
- `reconcileLinkedPlayers` loads mappings and link/role rows once per sweep
  (two queries instead of three per player), accepts `{ shouldStop }` to stop
  between players, and full-reconcile requests read in one batch are
  coalesced into a single sweep.

## 2026-09-30 — bounded REST calls and first-event delivery (#92)

### Fixed

- A per-server event stream discovered after the worker started gets its consumer group at `0`
  (was `$`), so the events written before discovery are no longer skipped.
- A single-player role-sync request for an unlinked player or a non-guild-member no longer resets
  the published role-sync status to `ok`.

### Changed

- Discord HTTP calls carry a 10 s timeout; a `Retry-After` above 30 s is reported as
  `rate_limited` instead of being waited out, and a channel-rename 429 is not retried.
- The encrypted-blob column is validated (`{ v: 1, kv, iv, tag, ct }`) before decrypting.
- `DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS` and `DISCORD_ROLE_SYNC_RECONCILE_MS` must be positive
  integers; a bad value fails startup instead of silently disabling reclaim or reconciliation.

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