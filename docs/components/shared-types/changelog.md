# `shared-types` — changelog

## 2026-07-27

### Added
- `events.ts` (`DISCORD-5`, #152): `DISCORD_ROLE_SYNC_STREAM` (`discord:role-sync`), `DISCORD_ROLE_SYNC_GROUP` (`discord-role-sync:v1`), `DISCORD_ROLE_SYNC_MAXLEN`, `DISCORD_ROLE_SYNC_STATUS_KEY` (`discord:role-sync:status`), and the `discordRoleSyncRequest` / `discordRoleSyncStatus` Zod schemas. Deliberately a stream of its own rather than an `EventEnvelope` on `events:*`: the payload is a work item ("re-derive this player's Discord roles"), not a domain event, and worker-discord's notify loop must not see it. `player_id: null` means "reconcile every linked player".

## 2026-07-09

### Added
- `plugins.ts` (`INT-4`): `pluginManifest` Zod schema, `PLUGIN_PERMISSIONS`/`PluginPermission`, `PluginHandler` contract, `hasPluginPermission` helper — the plugin/event-hook contract hosted by `apps/workers/automation`.

## 2026-04-25

### Added
- Full 8/8 component documentation (api, data-model, flows, configuration, testing, troubleshooting, changelog).

## 2025-11-15

### Added
- `api.ts`: `serverCreateInput` (resource limits, CPU affinity, niceness, memory, IO weight fields); `serverRow`, `playerRow`, `auditEntry`, `paginated` factory; `hostInfo`, `hostMetrics`, `bridgeStatus`, `serverStatus`.
- `events.ts`: `server.install.started`, `server.install.progress`, `server.install.failed`, `server.install.completed` types for install WebSocket progress.
- `events.ts`: `bridge.connected`, `bridge.disconnected` types for bridge health events.
- `STREAM_NAME`, `CONSUMER_GROUP`, `DEDUP_KEY`, `DEDUP_TTL_SECONDS`, `XAUTOCLAIM_IDLE_MS`, `XAUTOCLAIM_TICK_MS`, `DLQ_DELIVER_THRESHOLD` constants.
- `matchStateChangedPayload`, `serverLifecyclePayload` Zod schemas.
- Sub-path exports `./events` and `./api` in `package.json`.

### Changed
- `EventEnvelope.event_id` clarified to UUIDv7 (producers use `uuid` v7).
- `auditEntry.id` changed from `z.number()` to `z.string()` to handle `bigserial` safely.

## 2025-09-01

### Added
- Initial package: `events.ts` with `EventEnvelope`, `EVENT_TYPES` (12 initial types), `playerConnectedPayload`, `playerDisconnectedPayload`, `rconPlayersPolledPayload`, `validatePayload` dispatcher.
