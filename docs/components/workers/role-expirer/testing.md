# Testing

Run the unit test:

```bash
pnpm --filter @squad/worker-role-expirer test
```

With local Postgres/Redis available, run API integration tests around role
assignment metadata:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm --filter @squad/api test -- player-role-assign.test.ts users-list.test.ts
```
