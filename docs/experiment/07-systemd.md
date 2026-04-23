# §0A.7 — systemd unit prototype and security analysis

## Final hardened unit (tested on Ubuntu 24.04, Squad v10.3.1)

File: `/etc/systemd/system/squad-server-<uuid>.service`

```ini
[Unit]
Description=Squad Dedicated Server (<uuid>)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=squad
Group=squad
WorkingDirectory=/opt/squad-servers/<uuid>
EnvironmentFile=/etc/squad-server/instance-<uuid>.env

ExecStart=/opt/squad-servers/<uuid>/SquadGameServer.sh \
  Port=${PORT} \
  QueryPort=${QUERY_PORT} \
  BeaconPort=${BEACON_PORT} \
  FIXEDMAXPLAYERS=${MAX_PLAYERS} \
  FIXEDMAXTICKRATE=${TICKRATE} \
  MULTIHOME=${MULTIHOME} \
  RANDOM=ALWAYS \
  -log

Restart=on-failure
RestartSec=10s
TimeoutStartSec=300s
TimeoutStopSec=60s

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
PrivateUsers=yes
ProtectHostname=yes
ProtectClock=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@debug @mount @swap @reboot @obsolete @cpu-emulation @raw-io @privileged
SystemCallErrorNumber=EPERM

CapabilityBoundingSet=
AmbientCapabilities=

ReadWritePaths=/opt/squad-servers/<uuid>

MemoryDenyWriteExecute=true
TasksMax=infinity
UMask=0027

StandardOutput=journal
StandardError=journal
SyslogIdentifier=squad-<uuid>

[Install]
WantedBy=multi-user.target
```

## systemd-analyze security

```
→ Overall exposure level: 1.3 OK 🙂
```

Target per TZ §18C.4 is < 3.0. **Passed with headroom.** Remaining flag is `UMask=0027` → files are group-readable by default; tightening to `0077` gives a single private-user tree but requires the panel to distinguish per-server users (future). Leaving at `0027` for Phase 0.

Notable hardening decisions:

- **`CapabilityBoundingSet=`** empty, **`AmbientCapabilities=`** empty. Squad binds game/query/beacon/RCON on ports ≥ 1024 → no `CAP_NET_BIND_SERVICE` needed. The standalone binary does not need any capability.
- **`MemoryDenyWriteExecute=yes`** — UE5 does not JIT at runtime; it `dlopen`s `libboost_*.so` and `libEOSSDK-Linux-Shipping.so` which are file-backed PROT_EXEC and are permitted by MDWE. Verified: server reaches ready state + passes RCON queries under MDWE.
- **`PrivateUsers=yes`** — service runs in its own user namespace; can't see other users.
- **`ProtectHome=read-only`** instead of `yes` — Phase 0 experiment uses `/home/squad/squad-experiment/` as the install root because `/opt/squad-servers/` is a symlink to it. In production where the install is at `/opt/squad-servers/<uuid>/`, this can tighten to `ProtectHome=yes`.
- **`ReadWritePaths=/opt/squad-servers/<uuid>`** — Squad writes to `SquadGame/Saved/` (logs, crash dumps, persistent download). No other writable paths needed.
- **`TasksMax=infinity`** — UE5 spawns 150–300 worker threads. Distro default (usually 512) is plenty, but we match TZ §8 and set `infinity` to remove the risk of weird per-distro limits.
- **`SystemCallFilter=@system-service ~@debug ...`** — deny-list extends the `@system-service` allow-list. Confirmed Squad boots cleanly under this filter.

## Runtime verification (observed)

| Test | Outcome |
|---|---|
| `systemctl daemon-reload` | no warnings |
| `systemd-analyze verify squad-server-<uuid>.service` | clean |
| `systemctl start squad-server-<uuid>.service` | active in <1 s; beacon listening ~25 s later |
| `systemctl is-active` | `active` |
| `ss -tulnp` inside cgroup | 7787/udp, 15000/udp, 27165/udp, 21114/tcp bound by SquadGameServer |
| RCON `ShowCurrentMap` | `"Current level is Al Basrah..."` — server fully operational under hardening |
| Memory at steady state | ~3.7 GB RSS (WaitingToStart match, no players) |
| Tasks (threads) | 37 (main + 36 workers — well under `TasksMax=infinity`) |
| `systemctl show -p NRestarts` | `0` initially, `1` after SIGKILL test |

## Crash recovery test (SIGKILL to main PID)

Sent `kill -KILL` to the SquadGameServer.sh shell wrapper (MainPID per `systemctl show`):

| Event | Time |
|---|---|
| SIGKILL sent | t = 0 |
| systemd detects death → `deactivating (stop-sigterm)` | t + 0.01 s |
| systemd waits `RestartSec=10s` | 10 s |
| New MainPID assigned | t + ~12.0 s |
| `systemctl is-active` → `active` | t + 12.07 s |
| Beacon port re-bound | t + ~36 s |

Meets TZ §18C.6 target ("crash recovery within 15 s" for systemd-level detection, beacon-port availability depends on Squad's own boot).

## Graceful stop test (`systemctl stop`)

With the process mid-boot (not yet in main game loop): stop completed in 0.01 s. With a fully-booted server (tested earlier in §0A.3 using raw `kill -TERM`): ~16 s for clean shutdown. `TimeoutStopSec=60s` gives 3–4× headroom.

## Applicability to `panel-host-bridge` unit (TZ §7.6)

The bridge daemon runs as `root` to keep `systemctl`/`apt`/`steamcmd` privileges, so its hardening shape is different: it needs `CapabilityBoundingSet` with `CAP_SYS_ADMIN`, `CAP_CHOWN`, etc., and cannot use `PrivateUsers`. The shape in TZ §7.6 is correct; we'll verify the score when the Go binary is built in `apps/bridge/`. Expected score: 2–3 (MEDIUM/OK) — root daemons inherently cannot reach 1.x.

## Applicable drop-in for optional resource limits

When the panel's wizard includes any resource-limit field, it writes a drop-in `/etc/systemd/system/squad-server-<uuid>.service.d/limits.conf` containing **only** the non-null fields. Example for a user who set `MemoryMax=12G` and `CPUAffinity=0-7`:

```ini
[Service]
CPUAffinity=0 1 2 3 4 5 6 7
MemoryMax=12G
```

Other directives are absent — cgroup defaults apply. `systemctl daemon-reload` picks up the drop-in; `systemctl restart` applies it.

## Cleanup commands used in experiment

```bash
systemctl stop squad-server-<uuid>.service
systemctl disable squad-server-<uuid>.service
rm /etc/systemd/system/squad-server-<uuid>.service
rm /etc/squad-server/instance-<uuid>.env
rm /opt/squad-servers/<uuid>  # symlink in experiment
systemctl daemon-reload
```

These mirror the `scripts/uninstall.sh` we will generate in implementation.
