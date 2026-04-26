# worker-scheduler — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-scheduler test
```

## Test files

All tests live under `apps/workers/scheduler/test/`.

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:scheduler` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

## Coverage gaps

Domain logic is not implemented — deferred to Phase 2.
