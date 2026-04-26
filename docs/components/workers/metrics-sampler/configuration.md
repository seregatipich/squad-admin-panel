# worker-metrics-sampler — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `REDIS_URL` | yes | — | ioredis connection string | yes |
| `BRIDGE_SOCKET` | no | `/run/panel-host-bridge.sock` | Path to the host bridge Unix socket | no |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Sample interval | 15 000 ms | `runSampler` default (`intervalMs`) |
| Stream MAXLEN | 5 760 | `HOST_METRICS_MAXLEN` in `packages/shared-config/src/metrics-pack.ts` |
| Stream name | `host:metrics` | `HOST_METRICS_STREAM` |
| Heartbeat interval | 5 000 ms | `startHeartbeat` |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |

## Compose user requirement

`user: "0:${PANEL_GID:-987}"` — primary GID `panel` is required for the host bridge `SO_PEERCRED` check. `group_add: panel` is not sufficient.

## Redis retry strategy

```
delay = min(2000, 200 * 2^min(attempt, 6))  ms
```
