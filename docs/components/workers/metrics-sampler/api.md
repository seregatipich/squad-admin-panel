# worker-metrics-sampler — API surface

No HTTP surface.

## Redis stream: `host:metrics`

Capped at `MAXLEN ~ 5760` entries (24 h at 15 s cadence, ~300 KB).

Each entry has a single field `v` containing a JSON-encoded array of 8 integers:

```json
[cpu_x100, ram_used_bytes, disk_used_bytes, net_rx_bps, net_tx_bps, la1_x100, la5_x100, la15_x100]
```

Encoding:

| Index | Meaning | Encoding |
|---|---|---|
| 0 | CPU usage % | `round(cpu_percent * 100)` |
| 1 | RAM used (bytes) | `round(ram_used_bytes)` |
| 2 | Disk used (bytes) | `round(disk_used_bytes)` |
| 3 | Net RX (bytes/s) | `round(net_rx_bytes_per_sec)` |
| 4 | Net TX (bytes/s) | `round(net_tx_bytes_per_sec)` |
| 5 | Load avg 1 m | `round(load_avg_1m * 100)` |
| 6 | Load avg 5 m | `round(load_avg_5m * 100)` |
| 7 | Load avg 15 m | `round(load_avg_15m * 100)` |

The Redis Stream entry id millisecond prefix is the sample timestamp — `ts` is not stored as a separate field.

Decode with `unpackHostMetrics(v)` from `packages/shared-config/src/metrics-pack.ts`.

## Heartbeat key: `worker:heartbeat:metrics-sampler`

Published every 5 s, TTL 30 s.

## Bridge RPC: `host_metrics`

Called every 15 s. Returns `HostMetrics` as defined in `packages/bridge-client`. See [`docs/components/bridge/api.md`](../../bridge/api.md) for the full RPC spec.
