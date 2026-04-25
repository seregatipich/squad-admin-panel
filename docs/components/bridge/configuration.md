# `bridge` — configuration

## Environment variables

The bridge itself reads no env vars at runtime — its allowlists are compiled in. Operational tunables live in the systemd unit.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `BRIDGE_SOCKET` | yes (clients) | `/run/panel-host-bridge.sock` | api / workers / docker compose | Path to the unix socket the bridge listens on. The compose file bind-mounts this into containers. | no |

## systemd unit

[`apps/bridge/deploy/panel-host-bridge.service`](../../../apps/bridge/deploy/panel-host-bridge.service). Hardening flags relevant to operators:

- `Type=notify` — bridge signals readiness to systemd.
- `ProtectHome=yes` — the bridge cannot read `/root/`. Harmless docker-CLI warnings about `/root/.docker/config.json` are expected.
- `CapabilityBoundingSet=CAP_NET_ADMIN` — only what `ufw` needs.
- `ReadWritePaths=` — limited to `/var/lib/squad-panel`, `/run`, and `/var/log/panel-host-bridge`.
- Socket activation via [`apps/bridge/deploy/panel-host-bridge.socket`](../../../apps/bridge/deploy/panel-host-bridge.socket): `SocketMode=0660`, `SocketGroup=panel`, owned by root.

`systemd-analyze security panel-host-bridge.service` target is **< 3.0**. Current score is **2.0 OK**.

## Filesystem layout

The bridge expects these paths on the host (created by [`scripts/install-host-bridge.sh`](../../../scripts/install-host-bridge.sh)):

```
/var/lib/squad-panel/
├── configs/         # one subdir per server uuid; RW host, RW container
└── saved/           # one subdir per server uuid; RW host, RW container

/var/lib/docker/volumes/squad-depot/
└── _data/SquadGame/...   # populated by depot_update; RO mount in containers
```

## Group membership

The `panel` group is the gate. The bridge's `SO_PEERCRED` check inspects the peer's **primary** GID — supplementary groups (those added via `usermod -aG` on the host or `group_add` in compose) **are not visible** across the user-namespace boundary that Docker establishes.

On the host (CLI access from a shell):

```bash
sudo usermod -aG panel $USER     # supplementary group; works for host CLI
newgrp panel                     # apply in current shell
sg panel -c '...'                # or run a one-off command with panel as the primary GID
```

For containers that need to call the bridge (`api`, `worker-rcon`, `worker-log-ingest`, `worker-metrics-sampler`), set the **primary GID** explicitly in compose:

```yaml
services:
  worker-metrics-sampler:
    user: "0:${PANEL_GID:-987}"   # uid 0, primary gid = panel
```

`PANEL_GID` is the host-side `panel` GID resolved by [`scripts/install-host-bridge.sh`](../../../scripts/install-host-bridge.sh) and exposed in `.env` after install. Using only `group_add: [panel]` will bind-mount the socket into the container but every connection attempt fails with `ECONNREFUSED` / `EPIPE` — the symptom and fix are documented in [`operations/troubleshooting.md`](../../operations/troubleshooting.md#worker-metrics-sampler-keeps-logging-socket-closed--write-epipe).

## Local rebuild

```bash
cd apps/bridge
make build           # CGO_ENABLED=0, stripped → bin/panel-host-bridge
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

`cp` over `/usr/local/bin/panel-host-bridge` while the bridge is running fails with "Text file busy" — use `install -m 0755` (atomic replace) instead.
