# `bridge-client` — configuration

## Constructor options

`BridgeClient` is configured programmatically via `BridgeClientOptions`. There are no environment variables read directly by the package — the API layer passes environment values in.

| Option | Default | Description |
|---|---|---|
| `socketPath` | `BRIDGE_SOCKET_DEFAULT` = `/run/panel-host-bridge.sock` | Unix socket path to the host bridge daemon |
| `defaultTimeoutMs` | `15_000` | Timeout in milliseconds for unary calls. Streaming calls override this per method. |
| `onLog` | no-op | Structured log callback; the API wires in the Fastify logger here |

## Socket path constant

`BRIDGE_SOCKET_DEFAULT` is exported from `@squad/shared-config` (`packages/shared-config/src/bridge-methods.ts`):

```ts
export const BRIDGE_SOCKET_DEFAULT = '/run/panel-host-bridge.sock';
```

The bridge daemon is activated by systemd socket at that path, mode `0660 root:panel`. The Node process must belong to the `panel` group for `connect()` to succeed.

## Frame size limit

`BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024` (16 MiB), also from `@squad/shared-config`. Payloads exceeding this limit throw `FrameTooLargeError` on both encode and decode. The limit is hardcoded on the Go side as well — the two values must stay in sync.

## Method-specific timeouts

Hardcoded in `client.ts`:

| Method | Timeout |
|---|---|
| `containerRun` | 60 s |
| `containerStart` | 30 s |
| `containerStop` | 120 s |
| `containerRm` | 30 s |
| `containerInspect` | 10 s |
| `containerStats` | 10 s |
| `hostAgentRestart` | 5 s |
| `containerLogsFollow` | `Infinity` |
| `depotUpdate` | 3 600 s (1 hour) |
| all others | `defaultTimeoutMs` (15 s) |

## Environment variables (API layer)

These are consumed by `apps/api`, not by the package itself, but affect how `BridgeClient` is wired:

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_SOCKET_PATH` | `/run/panel-host-bridge.sock` | Override the socket path in the API container |

See [`docs/components/api/configuration.md`](../api/configuration.md) and [`docs/operations/environment-variables.md`](../../operations/environment-variables.md).
