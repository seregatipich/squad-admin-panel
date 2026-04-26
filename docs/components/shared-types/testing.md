# `shared-types` — testing

## Test locations

| File | Tier | What it covers |
|---|---|---|
| `packages/shared-types/test/events.test.ts` | Unit | `eventEnvelope` schema, `playerConnectedPayload`, `rconPlayersPolledPayload`, `validatePayload` dispatch |

## Running tests

```bash
pnpm --filter @squad/shared-types test
```

Or from the root:

```bash
pnpm turbo run test
```

## `events.test.ts` coverage

Four `describe` blocks:

**`event envelope schema`** (5 cases):
- Accepts a well-formed envelope.
- Rejects envelope missing `event_id`.
- Rejects unknown `type` value (`'player.teleported'`).
- Rejects `version: 0` (must be positive integer).
- Rejects strict extra properties (`.strict()` enforced).

**`player.connected payload schema`** (2 cases):
- Rejects `steam_id64` shorter than 17 digits.
- Allows `eos_id: null` (Steam-only join without EOS).

**`rcon.players_polled payload schema`** (1 case):
- Accepts an empty player list (server running, no players connected).

**`validatePayload dispatcher`** (2 cases):
- Returns `ok: true` for an event type with no registered schema (forward-compat).
- Returns `ok: false` with Zod issues when the payload doesn't match the registered schema.

## What is not covered by unit tests in this package

- `api.ts` schemas (`serverCreateInput`, `serverRow`, etc.) — validated by API route integration tests in `apps/api/test/`. Schema enforcement is proved through the real Fastify instance receiving invalid bodies.
- `paginated` factory — exercised by all paginated API endpoint tests.
- `matchStateChangedPayload`, `serverLifecyclePayload`, `playerDisconnectedPayload` — tested indirectly through `PAYLOAD_SCHEMAS` dispatch and producer code in worker tests.
- Stream/consumer group constants (`STREAM_NAME`, `CONSUMER_GROUP`, etc.) — used verbatim by workers; correctness is verified by E2E tests.

## Adding tests for new payload schemas

When adding a new entry to `PAYLOAD_SCHEMAS`, add a `describe` block in `events.test.ts` following the established pattern: one success case (valid payload passes) and at least one failure case (required field missing or wrong format). Example:

```ts
describe('match.started payload schema', () => {
  it('accepts valid state change', () => {
    expect(matchStateChangedPayload.safeParse({
      from_state: 'WaitingToStart', to_state: 'InProgress',
      layer: 'Fallujah_AAS_v1', game_mode: 'AAS',
    }).success).toBe(true);
  });
});
```
