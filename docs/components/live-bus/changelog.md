# `live-bus` — changelog

## 2026-07-09 — COMBAT-6: combat.event reconnect buffer + per-event combat:view gate

### Added

- `apps/api/src/lib/combat-ring-buffer.ts` — `CombatRingBuffer`, mirroring `ChatRingBuffer`: bounded per-server ring (last 100) retaining only `combat.event` frames, with `tailFor(serverId)`/`tail()` for replay.
- `apps/api/test/combat-ring-buffer.test.ts`, `apps/api/test/combat-live-replay.test.ts` — unit coverage for the buffer and an end-to-end `@fastify/websocket` + live-bus test covering live delivery, reconnect tail replay, and the `combat:view` gate.
- Web: `combatEventToRow`/`prependLiveRow` in `apps/web/src/app/(dashboard)/combat-log/helpers.ts` and a `Live` toggle in `CombatLog.tsx` that prepends incoming `combat.event` rows scoped to the locked server.

### Changed

- `apps/api/src/routes/live.ts` — `/api/v1/ws/live` now instantiates a `CombatRingBuffer` alongside the existing `ChatRingBuffer` and replays its tail on connect, right after the chat tail. Connections whose `req.user.permissions.combatView` is falsy never receive `combat.event` frames, live or buffered.

### Migration notes

- No DB migration. Purely in-memory, per-API-replica buffering (like the chat buffer), so a reconnect to a different replica can still miss events published only to the replica it was previously connected to.

## 2026-04-26 — Bundle E: initial release

### Added

- `apps/api/src/plugins/live-bus.ts` — Fastify plugin: `EventEmitter`-backed `liveBus.publish/subscribe` decorations plus a Redis subscriber on `live-bus` and `rcon:status:changed` channels for cross-replica fan-out.
- `apps/api/src/routes/live.ts` — `GET /api/v1/ws/live` WebSocket route. `server:view` permission, server-side ping every 10 s, 30 s pong timeout, close code 4000 on timeout.
- `apps/workers/rcon/src/supervisor.ts` — `PerServerSupervisor.writeStatus` now also `PUBLISH`es to `rcon:status:changed` after the existing `SET rcon:status:{id}`.
- Producer: `apps/api/src/plugins/status-reconciler.ts` emits `server.status` LiveEvent on every reconciled state edge.
- Producer: `apps/api/src/plugins/bridge-heartbeat.ts` emits `bridge.connection` LiveEvent on `up`↔`down` edges.
- `apps/api/test/live-bus.test.ts` — vitest: forwarding, pong-keepalive, subscriber leak guard.

### Migration notes

- No DB migration. Existing `rcon:status:{id}` Redis SET semantics unchanged; `rcon:status:changed` is a new pub/sub channel without retention.
- Web client (Bundle F) must implement the `pong` reply and a reconnect strategy; without it sockets die every 30 s.
- Adding new `LiveEvent` variants is backward-compatible — existing clients ignore unknown `type` values.

## 2026-04-26 — Bundles C+D wire-up: `server.deleted` / `server.restored` go live

### Changed

- `apps/api/src/routes/servers.ts` — `DELETE /api/v1/servers/:id` now emits `{type: 'server.deleted', data: {server_id, deleted_at, by}}` on every successful soft-delete. `by` is the actor's `steam_id64` as a string, or `null` for system actors.
- `apps/api/src/routes/server-archive.ts` — `POST /api/v1/servers/archive/:id/restore` emits `{type: 'server.restored', data: {old_server_id, new_server_id}}` immediately after the new row insert.
- The data-model table previously marked these two variants as "Not emitted yet"; the entries have been updated to point at the producers.
