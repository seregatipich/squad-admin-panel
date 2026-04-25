# `bridge` — troubleshooting

## "bridge: disconnected" banner in the dashboard

1. On the host: `systemctl status panel-host-bridge.socket` — should be `active (listening)`.
2. `ls -l /run/panel-host-bridge.sock` — must be `srw-rw---- root panel`.
3. From inside an api container: `getent group panel` should list the container's UID. If it doesn't, the compose service is missing `group_add: [panel]`.
4. `sudo systemctl restart panel-host-bridge.socket panel-host-bridge.service`.

Useful logs:

```bash
sudo journalctl -u panel-host-bridge.service -n 100
docker compose logs api --since 2m
```

## All `forbidden` even for legitimate calls

Almost always a path/image-allowlist mismatch.

```bash
sudo journalctl -u panel-host-bridge.service -n 50 | grep forbidden
```

Each rejection logs the peer PID, UID, method, and the rejected argument. Compare the rejected path against `apps/bridge/internal/validate/`.

## "Text file busy" when redeploying the bridge

`cp /tmp/panel-host-bridge /usr/local/bin/panel-host-bridge` fails while the bridge is running. Use `install` (atomic):

```bash
sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

## `container_run` exits zero but `container_inspect` says the container is missing

Either:

- Squad's entrypoint failed during the first second and the container exited. `bridge.container_logs_follow` with `--since 1m` shows why; common causes are bind-mount permission errors (entrypoint `chown -R 1001:1001 /squad/SquadGame/{Saved,ServerConfig}` failing because the host dir doesn't exist).
- A previous container with the same name is in `Exited` state. `container_inspect` returns `{exists: true, state: 'exited'}` — check for that, then `container_rm` before retrying.

## `depot_update` hangs / no progress for minutes

First run is ~25 min and prints chunks every 30–60 s; "no progress" is often actual progress. Check:

```bash
docker exec $(docker ps -q --filter ancestor=squad-panel/depot-init) du -sh /squad
```

If the byte count is climbing, wait. If it isn't, kill the depot-init container; the bridge's `depot_update` returns `runtime_error` and the operator can retry.

## `pnpm verify:audit-chain` reports a hash break

Treat as an incident — the bridge is not the root cause, but verify it for completeness:

```bash
sudo journalctl -u panel-host-bridge.service --since '24h ago' | grep audit
```

Then follow the runbook in [`operations/troubleshooting.md`](../../operations/troubleshooting.md#audit-log-shows-a-gap-or-hash-mismatch).

## Squad container starts but RCON `not_polled` stays for 5+ min

If the server status is `running` but `rcon_status.state` is `not_polled` past the 30 s `worker-rcon` reconcile, suspect the worker:

```bash
docker compose logs worker-rcon --since 5m
redis-cli GET worker:heartbeat:rcon
```

A missing heartbeat key means `worker-rcon` died; restart it:

```bash
docker compose restart worker-rcon
```

## Useful commands

```bash
sg panel -c 'bash scripts/verify-bridge.sh'                 # smoke
sudo systemctl status panel-host-bridge                     # service state
sudo systemd-analyze security panel-host-bridge             # hardening score
journalctl -u panel-host-bridge -f                          # live tail
ls -l /var/lib/squad-panel/configs                          # per-server config dirs
docker volume inspect squad-depot                           # depot volume state
```
