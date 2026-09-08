# Changelog — worker-rcon

## 2026-09-08 — Ростер обновляется каждые 5 секунд, отдельно от полного опроса

### Added

- Быстрое обновление состава: `ListPlayers` + `ListSquads` каждые `rosterIntervalMs` (по умолчанию 5 с) пишут `rcon:roster:{id}` и `rcon:squads:{id}` и публикуют `rcon.roster`, на котором панель перерисовывает живой список. Полный тик (карта, тикрейт, очередь, A2S, запись игроков и накопление времени в китах) остаётся на 30 с: гонять его в шесть раз чаще значило бы умножить нагрузку на базу ради данных, которые меняются раз в матч. Оба таймера делят один флаг занятости, поэтому команды не встают в очередь друг за другом.

## 2026-09-07 — Squad's broken probe reply no longer mis-frames the stream

### Fixed

- Squad answers the empty "probe" packet twice; the second answer claims size 10 but carries 7 extra bytes (`00 00 00 01 00 00 00`). The decoder read them as a size-256 header, so every later response was mis-framed: `invalid RCON packet size: N` decode errors, `rcon exec timeout: ListSquads/ListPlayers/ShowServerInfo`, and a teardown/reconnect loop every ~90 s — visible on tk104's own container and on the first external server. `RconPacketStream` now drops the broken frame whether it arrives whole or split, mirroring SquadJS's `core/rcon.js`. Regression tests replay the byte sequence captured from a live server.

## 2026-07-07 — RCON-1 command coverage

### Added

- `ListSquads` parser with team context, lock state, size, creator IDs, and command-squad detection.
- `ShowNextMap` parser with explicit `To be voted` handling.
- `rcon:squads:{serverId}` Redis cache written after successful poll cycles.
- `rcon:commands:{serverId}` Redis Stream consumer for P0 operator commands: `AdminBroadcast`, `AdminEndMatch`, `AdminReloadServerConfig`.
- `rcon:command-result:{requestId}` Redis result key for queued operator commands.
- `XAUTOCLAIM` replay for pending operator commands idle longer than 60 s, with a result-key guard before replay.
- Shared RCON command queue contract in `@squad/shared-types`.
- Unit coverage for `ListSquads`, `ShowNextMap`, UTF-8 `ListPlayers` nicknames, RCON command serialization, and the supervisor poll command set.
- Unit coverage for command validation, command queue success/failure result writes, API worker-first enqueue flow, and supervisor execution over a live RCON fixture.

### Changed

- `RconClient.exec()` now serializes commands through a FIFO queue so multi-packet responses cannot interleave.
- The 30 s poll cycle now runs `ListPlayers`, `ListSquads`, `ShowServerInfo`, and `ShowNextMap`.
- `rcon:status:{serverId}` can include `next_level`, `next_layer` from `ShowNextMap`, and `squad_count`.
- API graceful stop and config reload now try worker-rcon first when `rcon:status:{serverId}.state = "connected"`. Direct one-shot TCP RCON remains the fallback only when the worker is not connected or the command was not accepted into the stream.
- Queued operator commands are at-least-once around the real RCON side effect. Reclaim prevents lost pending messages; a crash after result write but before `XACK` is deduped through the result key.

### Migration notes

- No DB migration. Existing `rcon:status:{serverId}` consumers remain compatible because the new fields are additive.
- `rcon:squads:{serverId}` is a new Redis-only cache with a 90 s TTL.
- `rcon:commands:{serverId}` and `rcon:command-result:{requestId}` are Redis-only contracts. If the API has already accepted a command into the stream and then times out waiting for a result, it does not retry directly to avoid duplicate side effects.

## 2026-04-28 — Diagnostic-bundle Phase A2: diag emits

### Added

- `@squad/diag` dependency (`workspace:*`) added to `apps/workers/rcon/package.json`. The worker constructs a single `Diag` with `createDiag({ redis, log })` at startup and threads it into `RconSupervisor` via the new optional `SupervisorOptions.diag` field.
- Five new fire-and-forget emit kinds on `diag:queue`, all `component: 'worker-rcon'`:
  - `rcon.connected` (info, per-target) — fires after AUTH succeeds. Payload `{ host, port }`.
  - `rcon.auth_failed` (error, per-target) — fires when `RconClient.authenticate()` raises `rcon auth rejected` (id=-1) or `rcon auth timeout` (5 s). Payload `{ host, port, err }`.
  - `rcon.disconnected` (warn, per-target) — fires whenever the connect-loop tears down a session (remote-close, explicit-close, 3-strike poll-failure circuit-breaker, supervisor stop). Payload `{ host, port, reason }`.
  - `rcon.reconnect_attempt` (warn, per-target) — fires before each backoff sleep that precedes a reconnect. Payload `{ host, port, backoffMs }`.
  - `rcon.targets.changed` (info, no `serverId`) — fires from `RconSupervisor.reconcile()` on a **net delta only** (zero emits when the polling set is unchanged across a tick). Payload `{ added: string[], removed: string[], total: number }`.
- `apps/workers/rcon/test/supervisor-diag.test.ts`: 5 unit tests covering targets-changed delta semantics, no-emit-on-unchanged-set, no-diag-no-op, and live-TCP fixture verification of `rcon.connected` (good password) + `rcon.auth_failed` (rejected password) using a small in-process fake RCON server that speaks the Squad two-packet AUTH dance.

### Changed

- `RconSupervisor.reconcile()` now tracks `added`/`removed` arrays per tick and only emits `rcon.targets.changed` when at least one bucket is non-empty.
- `PerServerSupervisor.connectLoop()` now records `lastDisconnectReason` from the `RconClient.onDisconnect` callback and the auth-failure path so `rcon.disconnected` carries a meaningful `reason` payload.

### Fixed

- _None._

### Removed

- _None._

### Migration notes

- No DB migration. No breaking change to existing envelopes — the `rcon.connected` / `rcon.disconnected` events on `events:server:{id}` (live-bus fan-out) are unchanged. The new emits live on the separate `diag:queue` stream consumed by `worker-diag-flush`.
- `rcon.command.timeout` is **not** wired up here. Worker-rcon only runs auto-poll commands (`ListPlayers`, `ShowServerInfo`); manual RCON commands (`AdminBroadcast`, `AdminEndMatch`, `AdminKick`) are issued directly by the API via `apps/api/src/lib/rcon-send.ts` and never travel through this worker. The plan explicitly allows skipping the emit when "the worker doesn't currently have a manual-command path".

### References

- Plan: [`docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`](../../../superpowers/plans/2026-04-28-diagnostic-bundle.md) Task 11
- `@squad/diag` API: [`docs/components/diag/api.md`](../../diag/api.md)

## 2026-04-26 — Bundle E: live-bus fan-out

### Changed

- `PerServerSupervisor.writeStatus` now also `PUBLISH`es to the Redis channel `rcon:status:changed` with `{server_id, state, player_count?}` after the existing `SET rcon:status:{id}` call. The API's `live-bus` plugin subscribes to this channel and re-emits as `rcon.status` LiveEvents. Publish failures are swallowed — the SET remains the source of truth.

## 2026-04-26

### Added

- `test/supervisor.test.ts`: unit tests for `RconSupervisor` reconcile lifecycle (add/remove targets, idempotency).
- `test/contract.test.ts`: subprocess contract tests — heartbeat publication on Redis DB 14, SIGTERM exit 0 within 5s.

## 2026-04-25

### Added

- Initial implementation: `RconSupervisor`, `PerServerSupervisor`, `RconClient`, Valve RCON protocol codec.
- `ListPlayers` polling every 30 s with `upsertPlayers` persistence.
- `ShowServerInfo` keepalive every 90 s via `RconClient.keepalive`.
- `rcon:status:{serverId}` Redis key (TTL 300 s) written on every state transition and poll.
- Event publication: `rcon.connected`, `rcon.disconnected`, `rcon.players_polled`.
- Heartbeat: `worker:heartbeat:rcon` every 5 s.
- Exponential backoff on reconnect: 1 s initial, 60 s max.
- Consecutive-poll-failure circuit-breaker at 3 failures → reconnect.
- AES-256-GCM inline credential decryption seeded from `APP_ENCRYPTION_KEY`.
- Unit tests: protocol codec, `ListPlayers` parser, `ShowServerInfo` parser.
