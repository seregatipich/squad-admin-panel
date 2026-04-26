# worker-metrics-sampler — Data model

## Redis keys written

| Key | Retention | Description |
|---|---|---|
| `host:metrics` | MAXLEN ~5760 entries (auto-trim) | Packed host metrics samples |
| `worker:heartbeat:metrics-sampler` | TTL 30 s | Liveness heartbeat |

## `host:metrics` entry shape

Stream field: `v` → JSON array of 8 non-negative integers.

```
[cpu_x100, ram_used_bytes, disk_used_bytes, net_rx_bps, net_tx_bps, la1_x100, la5_x100, la15_x100]
```

Sample at CPU=50%, RAM=100 MB, load avg 0.5:

```json
[5000, 104857600, 0, 0, 0, 50, 0, 0]
```

Decoded by `unpackHostMetrics` in `packages/shared-config/src/metrics-pack.ts`.

## No Postgres access

This worker reads no Postgres tables and writes none.

## Log stream sink

Pino is configured with `redisSinkStream({ redis, defaultSource: 'worker' })`, meaning structured log entries also flow to the `panel:logs` Redis Stream for the panel's connector-logs UI.
