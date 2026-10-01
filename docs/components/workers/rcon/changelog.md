# Changelog — worker-rcon

## 2026-09-30 — Allowlist of private networks for external servers (#30, #333)

### Security

- New setting `EXTERNAL_HOST_PRIVATE_ALLOWLIST`: empty (the default) keeps the previous behavior, with private addresses allowed; `none` or a list of addresses/CIDRs restricts external servers to the listed private networks only. Both the host literal and every address it resolves to are checked (protection against DNS rebinding). An invalid value stops the worker at startup.

## 2026-09-27 — An RCON password containing a line break is not sent (#34)

### Security

- `RconClient.connect()` refuses to connect if the password contains CR, LF or NUL, and does not open the socket. This way old `server_credentials` rows saved before the API-side check cannot smuggle commands into the host's Redis through the SERVERDATA_AUTH packet.

## 2026-09-27 — A split player identity no longer breaks polling

### Fixed

- [#35](https://github.com/seregatipich/squad-admin-panel/issues/35) (finding 967): `upsertPlayers` looked a player up by `eos_id OR steam_id64` with `LIMIT 1` and no ordering. If one person's eos and steam IDs lived in different `players` rows, the UPDATE failed on a unique index, the exception aborted the whole poll (after three failures, the RCON connection), and a false `player.steam_linked` record was written to `audit_log` every 30 s. Now each player is processed in its own transaction, the audit is written after the UPDATE, the row with `eos_id` takes priority, the split is flagged `steam_eos_conflict` (audit `player.eos_steam_conflict` once), an error for one player is logged and does not abort the poll, and inserting a new row uses `ON CONFLICT DO NOTHING` with a repeated lookup. Tests: `test/persist.integration.test.ts`, `test/persist.test.ts`.
- [#35](https://github.com/seregatipich/squad-admin-panel/issues/35) (finding 977): a chat packet (`SERVERDATA_CHAT_VALUE`, id 0) with a body of exactly 246 bytes starts with the same 7 bytes as the "tail" of Squad's broken second reply to the probe, and the decoder cut them off anywhere in the stream. The stream lost frame boundaries (`invalid RCON packet size: 0`), exec calls were rejected and the supervisor reconnected: any player could keep the panel's RCON connection in a reconnect loop with the length of a message. Now the tail is cut only immediately after the second empty reply with the same id. Tests: `test/protocol.test.ts`.

## 2026-09-27 — Expired operator commands are not executed (#36)

### Fixed

- If an `rcon:commands:{id}` entry has a `deadline_at` and the deadline has passed, the worker does not execute the command. It stores an `ok:false` result with `error: "expired"` and acknowledges the entry (`XACK`). The API sets this deadline to the end of its own wait, so a command for which the operator has already been told about a timeout is not executed later without an audit and ledger record, and is not executed twice on retry.

## 2026-09-27 — Squad history and creator crowns

### Added

- The worker records squad creation, leader changes and squad disbanding in `events` (`squad.created`, `squad.leader_changed`, `squad.disbanded`) and in the `events:server:{id}` stream. Squad creation is dated by the RCON message `has created Squad`, which used to be discarded. Leader changes and disbanding are computed by comparing adjacent roster snapshots (every 2 s).
- The `rcon:squad-crowns:{id}` hash holds the creator crowns of the current match: gray (handed command to a teammate) and red (left the squad or the server while being the leader). The hash is deleted when the match changes, TTL 6 h.
- The `rcon:refresh` hint now passes the supervisor a `reason`: `match.started` / `match.ended` reset the squad history without false "disbandings".

## 2026-09-25 — Server state in the panel updates immediately

### Changed

- The roster updates every 2 s (was 5 s); map / next layer / mode / queue / tickrate update every 5 s through a separate lightweight `ShowServerInfo` + `ShowNextMap` poll (previously only in the full tick, every 30 s). The intervals are configured with `RCON_ROSTER_INTERVAL_MS` and `RCON_INFO_INTERVAL_MS`. The full tick with the database, A2S and seeding still runs every 30 s.
- Right after connecting, the roster and server info are read immediately instead of waiting for the first timer tick.
- `rcon:status` is written on every update, but `rcon:status:changed` is published only when visible fields (players, squads, map, next layer, mode, queue) or the state change — otherwise the frequent updates would make every open panel re-read the server list.

### Fixed

- The operator command queue (`XREADGROUP BLOCK 500`) sat on the worker's shared Redis connection, and every status write, roster write and live-bus publish waited behind it for up to 0.5 s — on every server in turn. Now each server's queue has its own connection. Measured on a real Redis: connect → full status 521 → 118 ms, a log line about a player joining → `rcon:status:changed` 1127 → 104 ms.

### Added

- Hints for an out-of-turn poll: the Redis channel `rcon:refresh`. worker-log-ingest publishes to it on a player join/leave and on match start/end, and the worker re-reads the server immediately (with a repeat after 1.5 s for the roster) instead of on the next tick.

## 2026-09-09 — The `ListPlayers` poll writes `player_sessions` (PRES-1)

### Fixed

- `player_sessions` had no writer in production: `openPlayerSession` / `closePlayerSession` / `closeCrashedSessions` from `@squad/db` were not called from anywhere, and the log parser does not publish `player.connected`/`player.disconnected` on live servers ([#320](https://github.com/breaking-squad/squad-admin-panel/issues/320)). As a result all online data was zero: the presence card and a player's prime time, `/api/v1/players/online-status`, `player_daily_presence`, `players.total_time_played_seconds`, economy accrual, seed rewards and clan activity read an empty table.
- The full poll tick now reconciles `player_sessions` with the `ListPlayers` snapshot: it opens a session for every player in the roster who has none, and closes the sessions of those no longer in the roster. The snapshot is complete on every poll, so a lost log line heals itself on the next tick instead of leaving a session open forever.
- `connected_at` is taken from the roster's `first_seen_at` (updated every 5 s) and capped at two poll intervals back, so that an RCON reconnect does not count an offline gap as play time.
- An RCON drop or a supervisor stop closes the server's open sessions at the moment of the last successful poll — anything after it was not observed.
- Sessions are opened in `seed` mode while seeding is active, so the existing session split at the SEED-1 boundary stays consistent.

## 2026-09-08 — The roster updates every 5 seconds, separately from the full poll

### Added

- Fast roster update: `ListPlayers` + `ListSquads` every `rosterIntervalMs` (5 s by default) write `rcon:roster:{id}` and `rcon:squads:{id}` and publish `rcon.roster`, on which the panel redraws the live list. The full tick (map, tickrate, queue, A2S, player writes and time accumulation in the kits) stays at 30 s: running it six times as often would multiply the load on the database for data that changes once per match. Both timers share one busy flag, so commands do not queue behind each other.

## 2026-09-07 — Squad's broken probe reply no longer mis-frames the stream

### Fixed

- Squad answers the empty "probe" packet twice; the second answer claims size 10 but carries 7 extra bytes (`00 00 00 01 00 00 00`). The decoder read them as a size-256 header, so every later response was mis-framed: `invalid RCON packet size: N` decode errors, `rcon exec timeout: ListSquads/ListPlayers/ShowServerInfo`, and a teardown/reconnect loop every ~90 s — visible on the stand host's own container and on the first external server. `RconPacketStream` now drops the broken frame whether it arrives whole or split, mirroring SquadJS's `core/rcon.js`. Regression tests replay the byte sequence captured from a live server.

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
