# worker-audit-archiver — API surface

No HTTP surface. The worker emits diagnostic events to the shared `diag:queue` Redis Stream and publishes a heartbeat key.

## Heartbeat key: `worker:heartbeat:audit-archiver`

Published every 5 s (default interval), TTL 30 s.

`status` field: `"архивация не реализована (P1)"` ("archiving not implemented (P1)") — indicates Phase 1 archival logic is not yet active.

## Diagnostic events (`diag:queue` Redis Stream)

The worker emits structured `DiagEvent`s via `@squad/diag` (`createDiag({ redis, log })` constructed once at startup). All kinds carry `component: 'worker-audit-archiver'`. Each emit is `await`ed but never thrown — `Diag.emit` swallows Redis failures and falls back to pino, so telemetry never derails the worker loop.

| Kind | Severity | Trigger | Payload fields |
|---|---|---|---|
| `audit_archiver.started` | `info` | Right after `startHeartbeat` | `pid: number` |
| `audit_archiver.stopped` | `info` | Inside the SIGTERM/SIGINT handler before `process.exit(0)`. | `sig: 'SIGTERM' \| 'SIGINT'` |

## Planned Phase 1 surface

When Phase 1 ships, this worker will write archive bundle metadata to a Redis key or stream so the panel's audit UI can display the last archive run timestamp and row count.
