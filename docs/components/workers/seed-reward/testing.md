# Testing

Provision an isolated migrated database, build the worker, and run its
integration and heartbeat contracts:

```bash
eval "$(bash scripts/new-test-db.sh seed-reward)"
pnpm --filter @squad/worker-seed-reward build
pnpm --filter @squad/worker-seed-reward test
```

The integration test grants at the exact threshold, revokes below it, and
asserts both audit actions and ROLE-2 side effects.
