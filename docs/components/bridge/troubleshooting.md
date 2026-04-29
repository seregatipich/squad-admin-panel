# `bridge` — troubleshooting

## "bridge: disconnected" / "Admins.cfg недоступен" / `rejected untrusted peer` in journal

1. On the host: `systemctl status panel-host-bridge.socket` — should be `active (listening)`.
2. `ls -l /run/panel-host-bridge/` — must show `bridge.sock` as `srw-rw---- root panel`. Directory itself is `drwxr-x--- root panel 0750`. Maintained by `tmpfiles.d` snippet at `/etc/tmpfiles.d/panel-host-bridge.conf`.
2a. **Verify containers see the live inode**:
   ```bash
   stat -c "host:%i" /run/panel-host-bridge/bridge.sock
   docker compose exec api stat -c "api:%i" /run/panel-host-bridge/bridge.sock
   ```
   The two must be equal. If they differ, the container is bind-mounting a stale inode — only happens if a container was created with the **legacy single-file mount** (`/run/panel-host-bridge.sock:/run/panel-host-bridge.sock`). Fix: ensure `docker-compose.yml` mounts the **directory** (`/run/panel-host-bridge:/run/panel-host-bridge`) and `docker compose up -d --force-recreate` the affected services. The `apps/api/test/compose-bridge-perms.test.ts` contract test guards this.
3. **Inside the misbehaving container, `id` must report `gid=987(panel)` as the *primary* GID, not in `groups=`.** SO_PEERCRED in `apps/bridge/internal/server.go` reads `(uid, gid)` from the kernel and matches the primary GID against the `panel` group; supplementary group membership is **not** checked. In `docker-compose.yml`, that means the service must use `user: "0:${PANEL_GID:-987}"` — **not** `group_add: [${PANEL_GID:-987}]`. The `group_add` form leaves the primary GID as `0` (root) and the bridge will log `rejected untrusted peer ... uid:0, user:root` for every call. This was the original cause of the `Admins.cfg недоступен / socket closed` UX bug; the worker's bridge-client retry kicks in but the second attempt is rejected for the same reason, so the worker publishes `state: 'unreachable'`.
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
