# worker-scheduler — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-scheduler test
```

## Test files

All tests live under `apps/workers/scheduler/test/`.

### Scheduler tick tests

The unit tests cover SEED-3 and ROT-4 scheduling without external services:

- `seed-schedule-tick.test.ts` covers recurring/one-off seed execution,
  seeding liveness, depot windows, and command selection.
- `rotation-schedule-tick.test.ts` covers due-entry execution, command
  selection, depot skips, and audit behavior.
- `rotation-profile-tick.test.ts` covers weekday/default selection, the
  configurable apply hour, once-per-day behavior, and managed-segment
  preservation.

## Integration coverage

`apps/api/test/integration/rotation-calendar.test.ts` exercises the API route,
database tables, permission gate, seed-overlap warning, and audit rows.
