# Changelog — worker-log-ingest

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
