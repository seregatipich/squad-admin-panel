# `bridge-client` — TypeScript client for the host bridge

Wraps the unix socket and JSON-RPC framing. Importable as `@squad/bridge-client`.

## Responsibilities

- Open a unix socket to `BRIDGE_SOCKET` (default `/run/panel-host-bridge/bridge.sock`).
- Frame requests as 4-byte BE length + UTF-8 JSON.
- Multiplex by `id` (UUIDv7) — each call gets its own promise.
- Expose `call(method, params)` and `stream(method, params)` for streaming methods.
- Reconnect transparently after a decode error (without permanently closing — that path is load-bearing).

## Code

[`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts).

## Usage

Singleton (decorated onto Fastify as `app.bridge`):

```ts
const info = await app.bridge.call('host_info', {});
```

Per-WebSocket (closing tears down the bridge subprocess on the host):

```ts
app.get('/api/v1/servers/:id/logs', { websocket: true }, async (sock, req) => {
  await using client = app.makeBridgeClient();
  const stream = client.stream('container_logs_follow', { name: `squad-${req.params.id}` });
  for await (const chunk of stream) sock.send(chunk.data);
});
```

## Important

- `attachHandlers` deliberately does NOT set `closed=true` on a decode error. Permanently closing wedges every subsequent caller. This pattern is called out in [`CLAUDE.md`](../../../CLAUDE.md#key-gotchas-worth-knowing-upfront) and [`components/bridge/flows.md`](../bridge/flows.md#decode-error--connection-loss).
- Long-running streams (`container_logs_follow`, `depot_update`) MUST use `app.makeBridgeClient()`, not `app.bridge`. The shared instance was starving sibling calls during long streams.
