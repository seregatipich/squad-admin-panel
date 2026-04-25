# worker-metrics-sampler — Troubleshooting

## Host metrics history shows no data

**Symptom:** `GET /api/v1/host/metrics/history` returns an empty array.

**Diagnostic:**

```bash
redis-cli XLEN host:metrics
redis-cli GET worker:heartbeat:metrics-sampler
docker compose logs worker-metrics-sampler --since 5m | grep -E 'failed|warn|error'
```

**Possible causes:**

1. Worker is not running (`worker:heartbeat:metrics-sampler` key absent).
2. Bridge is unavailable — log shows `metrics sample failed: …` on every tick.

## `metrics sample failed` repeating in logs

**Cause:** `bridge.hostMetrics()` is failing — bridge process is down or the worker is not in the `panel` group.

**Fix:**

1. Verify the bridge is active: `sudo systemctl status panel-host-bridge`.
2. Confirm the container user: `docker inspect worker-metrics-sampler | grep User`. It must be `0:<panel_gid>`.
3. Confirm `PANEL_GID` is set correctly in `.env` and matches `getent group panel | cut -d: -f3` on the host.

## `group_add: panel` does not fix bridge auth

**Root cause:** The bridge checks `SO_PEERCRED` on the Unix socket. Only the process's primary GID is visible across the host user namespace boundary. Supplementary groups added inside the container via `group_add` are not propagated.

**Fix:** Use `user: "0:${PANEL_GID:-987}"` in `compose.yml` (already set for this worker).

## Stream growing beyond expected size

**Symptom:** `XLEN host:metrics` is significantly above 5760.

**Cause:** The `MAXLEN ~ 5760` in `XADD` is approximate (`~` prefix). Redis trims at the next housekeeping opportunity. A spike in entries above this threshold during a Redis restart is expected and self-correcting.

## Useful commands

```bash
# Current stream length
redis-cli XLEN host:metrics

# Last 3 samples
redis-cli XREVRANGE host:metrics + - COUNT 3

# Worker logs
docker compose logs worker-metrics-sampler -f --since 2m
```
