# `bridge-client` — flows

Source: [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts)

## Connection lifecycle

```
BridgeClient.call(method)
  │
  ├─ if closed === true → throw BridgeError('transport', 'client is closed')
  │
  ├─ if socket is undefined → connect()
  │    └─ createConnection({ path: socketPath })
  │         ├─ on 'connect' → attachHandlers(sock); this.socket = sock
  │         └─ on 'error'   → reject promise; this.connecting = undefined
  │
  ├─ assign UUIDv7 id; build BridgeRequest
  ├─ register PendingCall (resolve, reject, onStream?, timer?)
  ├─ socket.write(encodeFrame(req))
  │
  └─ on incoming data → decodeFrames → handleFrame(frame)
       ├─ BridgeStreamFrame → pending.onStream(frame)
       └─ BridgeResponse    → pending.resolve / pending.reject; clearTimeout(timer)
```

Authentication is implicit: the Go bridge validates the caller's Unix credentials via `SO_PEERCRED`. The connecting process must belong to the `panel` group (`/run/panel-host-bridge.sock` is mode `0660 root:panel`). No token is transmitted over the wire.

## Unary call timeout

Every unary call sets a `setTimeout` for `defaultTimeoutMs` (default 15 s). If the timer fires before the response arrives, the pending entry is removed and the promise rejects with `BridgeError('timeout', ...)`. Streaming calls (`containerLogsFollow`, `depotUpdate`) pass `Infinity` to skip the timer entirely.

## Streaming calls

`container_logs_follow` and `depot_update` deliver output as a series of `BridgeStreamFrame` objects before the final `BridgeResponse`. The client dispatches each frame to `PendingCall.onStream` without resolving the outer promise. The promise resolves with `{ exit_code: number }` only when the final response arrives.

```
containerLogsFollow({ name: 'squad-01903f7d-...' }, (frame) => ws.send(frame.data))
  │
  ├─ [stream frames]  → onStream callback fires repeatedly
  │
  └─ [final response] → Promise<{ exit_code: 0 }> resolves
```

Because `container_logs_follow` holds a pending slot indefinitely, always use `app.makeBridgeClient()` (a dedicated connection) rather than the shared `app.bridge`. A shared-instance long stream prevented unary calls on the same socket from being dispatched — fixed by the per-WebSocket client pattern.

## Decode error — connection loss

When `decodeFrames` throws (stream out of sync, malformed frame), `attachHandlers` does:

1. Clears the receive buffer.
2. Rejects all in-flight pending calls with the frame error.
3. Destroys the socket and sets `this.socket = undefined`.
4. Does **NOT** set `this.closed = true`.

Result: the next RPC call transparently reconnects. If `closed` were set to `true` here, every subsequent caller would receive `BridgeError('transport', 'client is closed')` permanently — that was the original bug; the current code deliberately avoids it. This pattern is documented in [`CLAUDE.md`](../../../CLAUDE.md#key-gotchas-worth-knowing-upfront).

## Socket close / error

On `sock 'close'`: all pending calls are rejected with `BridgeError('transport', 'socket closed')` and `this.socket` is cleared — same reconnect path as decode error.

On `sock 'error'`: logged only; `'close'` follows immediately for TCP/Unix socket errors.

## `client.close()` (intentional teardown)

Sets `closed = true`, ends the socket, rejects all pending calls. Use for cleanup at the end of a WebSocket handler or a test:

```ts
const client = app.makeBridgeClient();
try {
  await client.containerLogsFollow({ name: 'squad-...' }, handler);
} finally {
  await client.close();
}
```

## Shared vs per-WebSocket clients

| Usage | Accessor | Notes |
|---|---|---|
| Background polling, status reconciler | `app.bridge` | Single long-lived instance |
| WebSocket log streaming | `app.makeBridgeClient()` | One connection per WS; closing it kills the bridge subprocess cleanly |
| Install flow | `app.makeBridgeClient()` | `depot_update` can run for up to 1 hour |

See [`apps/api/src/plugins/bridge.ts`](../../../apps/api/src/plugins/bridge.ts) for how both are registered on the Fastify instance.
