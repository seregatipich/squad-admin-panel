# Changelog — worker-rcon

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
