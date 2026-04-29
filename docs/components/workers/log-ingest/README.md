# worker-log-ingest

## Purpose

Tails `docker logs -f squad-{uuid}` for every running Squad container via the host bridge, regex-parses `SquadGame.log` lines, and publishes structured `EventEnvelope` entries to per-server Redis Streams.

## Responsibilities

- Reconcile the set of active log tails against live DB rows every 15 s.
- Open a `container_logs_follow` stream per running server via `BridgeClient`.
- Parse each stdout line with `LogIngestor` (category dispatch + regex matching).
- Publish events to `events:server:{serverId}` with client-side best-effort dedup.
- Publish `worker:heartbeat:log-ingest` every 5 s.

## What it does not do

- Does not read log files directly from the filesystem — only Docker stdout.
- Does not write to Postgres.
- Does not send RCON commands.
- Does not process stderr lines from the container.

## Code location

```
apps/workers/log-ingest/
  src/
    index.ts                  — entry point, reconcile loop, shutdown
    manager.ts                — TailManager (aborters map + tails.changed diag)
    tail.ts                   — tailContainerLogs (bridge → line buffer)
    publish.ts                — Redis XADD with dedup key
    parser/
      patterns.ts             — log line prefix parser + regex patterns
                                + Squad fatal detection (LogExit / Fatal / Assertion)
      ingest.ts               — LogIngestor class (per-server state machine)
  test/
    patterns.test.ts
    ingest.test.ts
    manager.test.ts
    contract.test.ts
```

## Dependencies

- `@squad/bridge-client` — `containerLogsFollow` RPC
- `@squad/db` — `servers`, `serverSettings` tables (status + beaconPort)
- `@squad/diag` — `createDiag` factory; emits to `diag:queue`
- `@squad/shared-config` — `startHeartbeat`, `redisSinkStream`
- `@squad/shared-types` — `EventEnvelope`, `STREAM_NAME`, `DEDUP_KEY`
- `ioredis` — Redis client

## Bridge socket requirement

The worker bind-mounts `/run/panel-host-bridge/bridge.sock` and must run with primary GID `panel` (`user: "0:${PANEL_GID:-987}"` in `compose.yml`).

## Components that depend on it

- API — reads `events:server:{id}` stream for the live event feed.
- `worker-rcon` — events from both workers land in the same per-server stream; consumers must handle interleaving.

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
