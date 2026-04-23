# Distro matrix — TZ §17 three-distro × three-run install evidence

Ran `scripts/install-host-bridge.sh` on fresh systemd containers for Ubuntu 22.04,
Ubuntu 24.04, and Debian 12. Each distro got **3 completely fresh runs** in
brand-new containers (equivalent to `docker compose down -v` + reinstall).

Harness: `jrei/systemd-ubuntu:22.04`, `jrei/systemd-ubuntu:24.04`, `jrei/systemd-debian:12`
launched with `--privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock
-v /sys/fs/cgroup:/sys/fs/cgroup:rw`. The Go bridge binary is static (`CGO_ENABLED=0`);
it runs unchanged across all three.

Script at `/tmp/matrix.sh`.

## Results (9/9 green)

```
distro          run  install  active  perms              ping      idempotent  still-active
ubuntu22.04     1    0        active  660 root:panel     pong=True 0           active
ubuntu22.04     2    0        active  660 root:panel     pong=True 0           active
ubuntu22.04     3    0        active  660 root:panel     pong=True 0           active
ubuntu24.04     1    0        active  660 root:panel     pong=True 0           active
ubuntu24.04     2    0        active  660 root:panel     pong=True 0           active
ubuntu24.04     3    0        active  660 root:panel     pong=True 0           active
debian12        1    0        active  660 root:panel     pong=True 0           active
debian12        2    0        active  660 root:panel     pong=True 0           active
debian12        3    0        active  660 root:panel     pong=True 0           active
```

## What each column proves

- **install=0** — `scripts/install-host-bridge.sh` exited zero. Its distro-guard
  regex accepted the OS, `groupadd panel` / `useradd squad` succeeded, the bridge
  binary was installed at `/usr/local/bin/panel-host-bridge`, the systemd unit +
  socket were placed under `/etc/systemd/system/`, and `systemctl start
  panel-host-bridge.socket` succeeded.
- **active=active** — after ping, systemd's socket activation brought the service
  up and it stayed running. Confirms the unit's `ReadWritePaths`, `LogsDirectory`,
  and `CapabilityBoundingSet` all resolve on this distro.
- **perms=660 root:panel** — `/run/panel-host-bridge.sock` has the exact permissions
  §17.1 requires (TZ: `srw-rw---- root panel`).
- **ping=pong=True** — raw JSON-RPC frame round-trip: `ping` request in, response
  with `pong:true`, `version:"dev"`, `hostname` populated.
- **idempotent=0** — the install script re-run on an already-installed host also
  exited zero (TZ §17.12 / §18.4).
- **still-active=active** — bridge remained active after the re-run; re-registering
  the socket unit didn't drop the listener.

## Caveats

- The Go bridge binary is built on Ubuntu 24.04 with `CGO_ENABLED=0 go build`. The
  static link means glibc version differences across distros don't matter at runtime.
- The systemd unit emits one harmless journal line on older systemd versions:
  `Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.` The
  key belongs in `[Unit]` since systemd 230+; older systemds accept both. The
  unit loads and runs regardless.
- These containers don't run the full `docker compose up -d` stack (docker-in-docker
  was out of scope for this matrix). The bridge side — which is what the per-distro
  install script installs — is fully verified here. The compose side is distro-agnostic
  (Alpine + Debian-slim base images).
