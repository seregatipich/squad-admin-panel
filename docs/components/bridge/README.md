# `bridge` — host daemon

The only privileged component. A Go binary listening on `/run/panel-host-bridge.sock` (systemd socket-activated, `0660 root:panel`). Containers reach it through the bind-mounted socket; the API decorates Fastify with `app.bridge` (singleton) and `app.makeBridgeClient()` (per-WebSocket dedicated connection).

## Responsibilities

- Compose `docker run` from structured params, never accepting raw flags.
- Read/write files under hard-allowlisted roots.
- Add/remove `ufw` rules for game/query/beacon/RCON ports.
- Run `depot_update` (transient `squad-panel/depot-init` container into the shared `squad-depot` volume).
- Surface live host metrics and process info.

## What this component does NOT do

- It does **not** spawn `apt`, `systemctl`, or `steamcmd` directly anymore. That code was removed in the [container migration](../../architecture/decisions.md#2025-11-15--one-docker-container-per-squad-server-replaces-native-systemd-units). Host-level apt installs happen once via [`scripts/install-host-bridge.sh`](../../../scripts/install-host-bridge.sh).
- It does **not** mediate auth between callers — group membership in `panel` is treated as a coarse capability. Per-user authorisation lives in the API layer.
- It does **not** parse Squad logs or talk RCON. Those are worker concerns.

## Code location

- Entrypoint: [`apps/bridge/cmd/panel-host-bridge/main.go`](../../../apps/bridge/cmd/panel-host-bridge/main.go)
- Handlers: [`apps/bridge/internal/handlers/handlers.go`](../../../apps/bridge/internal/handlers/handlers.go)
- Validators: `apps/bridge/internal/validate/`
- systemd unit: [`apps/bridge/deploy/panel-host-bridge.service`](../../../apps/bridge/deploy/panel-host-bridge.service)
- Build: `apps/bridge/Makefile` (CGO disabled, stripped binary)

## Dependencies

- Go 1.25
- `github.com/coreos/go-systemd/v22` for socket activation
- `golang.org/x/sys` for `getsockopt(SO_PEERCRED)`

Runtime dependencies on the host:

- Docker Engine (the bridge calls `docker` via `os/exec`).
- `ufw` (only used when callers invoke `ufw_rule`).

## Components that depend on it

- [`api`](../api/README.md) — every privileged action goes through `app.bridge` or `app.makeBridgeClient()`.
- [`worker-rcon`](../workers/README.md#worker-rcon) — uses `container_inspect` to discover RCON ports.
- [`worker-log-ingest`](../workers/README.md#worker-log-ingest) — uses `container_logs_follow`.
- [`bridge-client`](../bridge-client/README.md) — TS wrapper.

## Components it depends on

- [`shared-config`](../shared-config/README.md) — bridge-method names are pinned there. Both sides import the same constants.

## Basic usage from a container

```ts
import { createBridgeClient } from '@squad/bridge-client';

const client = await createBridgeClient({
  socketPath: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge.sock',
});

const info = await client.call('host_info', {});
console.log(info.hostname);

await using stream = client.stream('container_logs_follow', {
  container_name: 'squad-019dbb45-3556-751f-9124-d4cf0e6b0053',
  since: '5m',
});
for await (const chunk of stream) {
  console.log(chunk.data);
}
```

## See also

- [API reference](api.md) — every method, with success and forbidden paths.
- [Configuration](configuration.md) — env vars, paths, group membership.
- [Flows](flows.md) — install/run/stop sequences, `depot_update` lifecycle.
- [Testing](testing.md) — Go unit tests, `verify-bridge.sh` smoke, e2e.
- [Troubleshooting](troubleshooting.md) — "bridge: disconnected" banner, peer-credentials failures.
- [Changelog](changelog.md) — recent surface changes.
