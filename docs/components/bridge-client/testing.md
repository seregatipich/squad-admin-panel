# `bridge-client` — testing

## Test locations

| File | Tier | What it covers |
|---|---|---|
| `packages/bridge-client/test/frame.test.ts` | Unit | Frame codec: encode/decode round-trip, multi-frame buffer, partial frame in remainder, oversized frame rejection |
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

## What is not covered by unit tests

- `BridgeClient` connection logic and pending-call map — covered by E2E.
- Decode-error reconnect path (the `closed !== true` invariant) — verified manually and documented in [`flows.md`](flows.md#decode-error--connection-loss).
- Streaming method callbacks — covered by E2E (`containerLogsFollow`, `depotUpdate`).
- All 17 RPC methods' param shapes — covered by E2E forbidden/success pairs.

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
