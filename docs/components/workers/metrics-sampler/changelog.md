# Changelog — worker-metrics-sampler

## 2026-04-25

### Added

- Initial implementation: `runSampler` with 15 s interval, `XADD host:metrics MAXLEN ~ 5760`.
- `packHostMetrics` encoding: 8-integer tuple with `x100` for percentages and load averages.
- Pino multistream: stdout + `panel:logs` Redis sink.
- Heartbeat: `worker:heartbeat:metrics-sampler` every 5 s.
- Bridge error isolation: `warn` log on failure, sampling continues on next tick.
- Unit tests: tick count, packed array encoding, error resilience.

### Notes

- `user: "0:${PANEL_GID:-987}"` required in compose — primary GID `panel` for bridge `SO_PEERCRED` auth. `group_add: panel` is insufficient.
