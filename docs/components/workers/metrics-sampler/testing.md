# worker-metrics-sampler — Testing

## Running tests

```bash
pnpm --filter @squad/worker-metrics-sampler test
# or from the repo root:
pnpm turbo run test --filter=@squad/worker-metrics-sampler
```

## Test files

### `sampler.test.ts`

Unit tests for `runSampler` using fake timers and mock bridge/Redis.

| Test | What it verifies |
|---|---|
| XADDs one packed sample per tick to `host:metrics` | Correct stream name, field `v`, 3 ticks in 305 ms with interval=100 ms |
| Packed array matches expected encoding | `cpu_percent=50 → 5000`, `load_avg_1m=0.5 → 50`, etc. |
| Continues sampling after a bridge error | First call throws; subsequent calls succeed; at least 2 XADD calls |

## Coverage gaps

- `index.ts` startup/shutdown wiring is not unit-tested.
- Bridge reconnection after socket failure is covered by the e2e suite in `apps/api/test/e2e/bridge-rpc.e2e.test.ts`.

## Test data

Tests use vitest fake timers (`vi.useFakeTimers`) to advance time without wall-clock delay. Mock bridge returns a full `HostMetrics` struct; mock Redis records `xadd` calls in an array for assertions.
