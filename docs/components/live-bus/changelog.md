# `live-bus` — changelog

## 2026-09-30 — #51 (finding #1327): `events_appended` trigger kept, review threshold documented

### Docs

- `docs/operations/monitoring.md` — section «Live events feed: NOTIFY load»: measurements on the stand (about 1,200 `events` rows per day, a peak of 5 rows per second, an empty notification queue), the check commands and the review threshold (`pg_notification_queue_usage()` consistently above 0.1, or more than 100 rows per second). This changes no code: the global lock on the `pg_notify` queue shows up at hundreds of commits per second, and the previous API release receives live events only through `LISTEN events_appended`, so the trigger stays until the two-release transition (a new channel, then removal of the trigger).

## 2026-09-28 — #62: `combat.vehicle` frames no longer bypass `combat:view`

### Security

- `apps/api/src/routes/live.ts` filtered out only the `combat.event` type for users without `combat:view`, so `combat.vehicle` frames from worker-log-ingest (attacker, weapon, damage, vehicle) went out to everyone with `server:view`. The filter now triggers on any type with the `combat.` prefix. Regression test: `apps/api/test/combat-live-replay.test.ts`.

## 2026-09-28 — #69: socket event subscriptions, token permissions narrowed on re-validation

### Changed

- `apps/api/src/routes/live.ts` — the types `chat.message`, `combat.event`, `rcon.roster`, `externalban.matched` and all worker events not described in the API (`banname.matched`, `bansync.*`, `match.*`) reach the socket only after a `{"type":"subscribe","events":[...]}` frame (cancelled with `unsubscribe`; the reply is `subscribed`/`unsubscribed`). The chat and combat tail is no longer sent to every connection: it is replayed when subscribing to `chat.message` / `combat.event`.
- `ChatRingBuffer` and `CombatRingBuffer` were replaced by a single `ServerRingBuffer` (`apps/api/src/lib/server-ring-buffer.ts`); the buffer of a deleted server is cleared on `server.deleted`.
- The periodic re-validation of a socket using an API token narrows permissions to the token's scopes (`narrowToTokenScopes`), like the HTTP hook: after the first tick the token no longer receives `combat.event` or role notifications based on the owner's role flags.
- Web: `apps/web/src/lib/live-bus.ts` subscribes the socket to the types listened to by mounted `useLiveSubscription` hooks, with reference counting and re-subscription after reconnect.

### Migration notes

- No DB migrations. A third-party `/api/v1/ws/live` client that needs chat, combat or roster must send `subscribe`.

## 2026-09-27 — #12: the server closes `/api/v1/ws/live` itself when a session is revoked or permissions are lost

### Changed

- `apps/api/src/routes/live.ts` — the `session.revoked` event for the socket's own session is still sent to the client, after which the server closes the socket with code `4001` (`session revoked`) without relying on the client. Every 30 s (the plugin option `revalidateIntervalMs`) the socket re-checks the session or API token and the player's permissions: a missing or revoked session/token gives `4001`, loss of `server:view` (for a `self_service` session, `panel_access`) gives `4003` (`forbidden`); the `combat:view` and role-assignment filters are updated to the fresh permissions. A check failure caused by Postgres/Redis being unavailable does not close the socket — it is retried on the next tick.
- `apps/api/src/routes/role-members.ts` — import into a role without `panel_access`, bulk removal and moving of members now publish `session.revoked` (they pass `app.liveBus` to `revokeAllForPlayer`), so the open sockets of the affected players are closed immediately.

### Migration notes

- No DB migrations.

## 2026-09-25 — `server.events.appended`: live events feed

### Added

- `apps/api/src/plugins/events-feed.ts` listens to Postgres `NOTIFY events_appended` (the migration 0116 trigger fires on every insert into `events`, whoever makes it), coalesces notifications per server over 250 ms and publishes `server.events.appended` `{ server_id, kinds }`. The frame carries no event data — the list re-reads the first page via `GET /api/v1/events` with the usual permission check.
- Web: `EventsBrowser` pulls new events in at the top (at most once per second) if the frame matches the open filters; the server card is re-read immediately on `rcon.status`.

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
