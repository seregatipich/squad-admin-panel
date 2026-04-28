# `bridge-client` — testing

## Test locations

| File | Tier | What it covers |
|---|---|---|
| `packages/bridge-client/test/frame.test.ts` | Unit | Frame codec: encode/decode round-trip, multi-frame buffer, partial frame in remainder, oversized frame rejection |
| `packages/bridge-client/test/lifecycle.test.ts` | Unit | `BridgeClient` lifecycle against a fake Unix socket: connect/response, split-frame reassembly, decode-error recovery, oversized header rejection, streaming callbacks, independent client teardown |
| `apps/api/test/e2e/bridge-rpc.e2e.test.ts` | E2E | Every whitelisted RPC method's success path and forbidden path against a live socket |

## Running unit tests

```bash
pnpm --filter @squad/bridge-client test
```

Or from the root:

```bash
pnpm turbo run test
```

## Frame codec test coverage (`frame.test.ts`)

Four cases in `describe('frame codec')`:

1. **Encode + decode single frame** — verifies the 4-byte length header and JSON round-trip.
2. **Two concatenated frames** — verifies the accumulation loop in `decodeFrames` processes both frames and leaves zero remainder.
3. **Partial frame in remainder** — truncates the last 3 bytes; verifies the decoder buffers it and returns no complete frames.
4. **Oversized encode** — a 17 MiB payload; verifies `FrameTooLargeError` is thrown.

## `BridgeClient` lifecycle tests (`lifecycle.test.ts`)

The test spins up a `node:net` TCP server on a temporary Unix socket path before each test and tears it down after. The server acts as a fake bridge daemon: it reads the framed request, deserializes the JSON, and writes a crafted framed response.

Seven cases:

1. **Connect → request → response** — `client.ping()` sends a framed request; fake server reads the id and responds with `{pong: true}`; client resolves.
2. **Split-frame reassembly** — server writes the first 3 bytes of the response frame, then the rest via `setImmediate`; client reassembles correctly.
3. **Decode-error recovery** — server sends a frame header claiming 5 bytes then 5 garbage bytes, then closes the connection. Client rejects the in-flight call, drops the socket, and `closed` stays `false`. A second `ping()` reconnects and succeeds.
4. **Oversized frame rejection** — server sends a 4-byte header with `BRIDGE_MAX_FRAME_BYTES + 1`. `decodeFrames` throws `FrameTooLargeError`; client rejects with `BridgeError`.
5. **Streaming callbacks** — fake server sends two `stream` frames followed by a final response frame for `containerLogsFollow`. Callback is invoked for each stream frame; the call resolves with `{exit_code: 0}`.
6. **`panelDiskUsage` round-trip** — fake server asserts `req.method === 'panel_disk_usage'` then replies with a fully-populated `PanelDiskUsage` body; client decodes it and the test asserts on `total_panel_bytes`, `saved_per_server`, `host_used_bytes`, and `computed_at`.
7. **Independent client teardown** — `clientA.close()` does not affect `clientB`; `clientB.ping()` succeeds after `clientA` is closed.

## What is not covered by unit tests

- All 19 RPC method param shapes — covered by E2E forbidden/success pairs.
- `depotUpdate` streaming — structurally identical to `containerLogsFollow`; covered by E2E.
- The Go-side computation behind `panel_disk_usage` (du-walks, `docker system df`) — covered by the bridge's own Go tests and by the E2E success/forbidden case.

## Mock socket pattern

Unit tests for callers that use `BridgeClient` (e.g. `apps/api/test/server-logs.test.ts`) inject a fake bridge client by replacing `app.bridge` with an object that implements the same method signatures. This avoids any real socket connections in Tier-2 integration tests.

## E2E prerequisites

See [`docs/development/testing.md`](../../development/testing.md) and the root `CLAUDE.md` testing section. Requires:

- Docker Compose stack running
- Bridge daemon active at `/run/panel-host-bridge.sock`
- `PANEL_TEST_URL` and `PANEL_TEST_COOKIE` environment variables set

```bash
pnpm --filter @squad/api test:e2e
```
