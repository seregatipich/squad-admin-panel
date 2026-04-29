# Changelog — worker-log-ingest

## 2026-04-28

### Fixed

- `docker-compose.yml`: replaced `group_add: [${PANEL_GID:-987}]` with `user: "0:${PANEL_GID:-987}"`. The previous form left the container running with `gid=0(root)` as primary GID; the bridge's SO_PEERCRED check inspects the primary GID and rejected every `containerLogsFollow` call with `rejected untrusted peer`. See [`docs/components/bridge/troubleshooting.md`](../../bridge/troubleshooting.md) and the matching [`config-sync` changelog entry](../config-sync/changelog.md#2026-04-28).

## 2026-04-26

### Added

- Added `test/ingest.test.ts`: player connect/disconnect flow tests (correlation window, player.disconnected, rcon.connected, unknown lines).
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- Initial implementation: `tailContainerLogs`, `LogIngestor`, `publish` with dedup.
- Log line prefix parser (`parseLine`) handling all Squad UE4 log categories.
- Benign noise filter for known high-volume non-event lines.
- Event types: `server.ready`, `server.stopped`, `server.crashed`, `player.connected`, `player.disconnected`, `match.started`, `match.ended`.
- Player-connect correlation: `Join succeeded` + `EOS Connection` within 2500 ms window.
- Reconcile loop: attaches/detaches tails as server status changes every 15 s.
- Heartbeat: `worker:heartbeat:log-ingest` every 5 s.
- Unit tests: log line parser, `LogIngestor` event extraction, noise filter.