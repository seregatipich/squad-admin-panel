# worker-rcon — Testing

## Running tests

```bash
pnpm --filter @squad/worker-rcon test
# or from the repo root:
pnpm turbo run test --filter=@squad/worker-rcon
```

## Test files

All tests live under `apps/workers/rcon/test/`.

### `protocol.test.ts`

Unit tests for the Valve RCON encoder/decoder.

| Test | What it verifies |
|---|---|
| Encodes AUTH packet matching §0A.4 wire dump | Correct byte layout: size, id, type, body, double null terminator |
| Decodes the auth-ok double packet Squad sends | Empty `SERVERDATA_RESPONSE_VALUE` followed by `SERVERDATA_AUTH_RESPONSE` |
| Buffers partial packets across `push()` calls | `RconPacketStream` correctly reassembles split TCP frames |

### `parse-list-players.test.ts`

Unit tests for the `ListPlayers` response parser.

| Test | What it verifies |
|---|---|
| Returns empty list for an empty server | Both headers present, no player lines |
| Parses a single active player with all fields | `rcon_id`, `eos_id`, `steam_id64`, `name`, `team_id`, `squad_id`, `is_leader`, `role` |
| Handles `Squad ID: N/A` | `squad_id` is `null` |
| Ignores rows below the disconnected header | Recently-disconnected players are not returned |

### `parse-server-info.test.ts`

Unit tests for the `ShowServerInfo` JSON parser (Squad UE4 FName key convention).

### `supervisor.test.ts`

Unit tests for `RconSupervisor` reconcile lifecycle.

| Test | What it verifies |
|---|---|
| Starts a per-server supervisor on reconcile | `size()` increments when a target is added |
| Removes stopped target on reconcile | `size()` decrements when target removed from reconcile list |
| Does not re-add existing target on repeated reconcile | Idempotent reconcile does not double-count targets |

### `supervisor-diag.test.ts`

Unit tests for the diag-emit surface added in Task 11 of the diagnostic-bundle plan. Uses a `vi.fn()` `Diag` stub plus a small in-process `net.createServer()` fixture that speaks the Squad two-packet AUTH dance to drive the connect-loop.

| Test | What it verifies |
|---|---|
| Emits `rcon.targets.changed` on net delta with `added`/`removed`/`total` | Adds, additions, and removals each produce one emit with the right payload |
| Does not emit `rcon.targets.changed` when the polling set is unchanged | Repeated reconcile of the same target list emits exactly once (initial add) and stays silent thereafter |
| Omits diag emits entirely when no `diag` is provided | `SupervisorOptions.diag` is optional; absence is a clean no-op |
| Emits `rcon.connected` with `serverId` when AUTH succeeds | Real TCP fixture, payload `{ host, port }`, severity `info` |
| Emits `rcon.auth_failed` with `error` severity when AUTH is rejected | Real TCP fixture replies with id=-1, payload `{ host, port, err }` |

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:rcon` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

- `client.ts` is not unit-tested (requires a real TCP server or a mock). The new `supervisor-diag.test.ts` exercises it indirectly via a `net.createServer()` fixture for the connect/auth-fail paths; the e2e suite in `apps/api/test/e2e/install-lifecycle.e2e.test.ts` exercises it through the full stack.
- `persist.ts` has no isolated test; covered indirectly by e2e tests that verify player rows appear after a poll cycle.
- `rcon.disconnected` and `rcon.reconnect_attempt` diag emits are not asserted in unit tests because the connect loop's backoff sleep makes their timing brittle in fake-timer mode; the e2e suite exercises them end-to-end during graceful-stop.

## Test data

Tests use hardcoded Squad log line samples matching actual v10.3.1 output documented in `§0A.4` and `§0A.5` of the project spec. No external fixtures are required.
