# Testing

Run the package checks:

```bash
pnpm --filter @squad/steam-api test
pnpm --filter @squad/worker-steam-refresh typecheck
pnpm --filter @squad/worker-steam-refresh build
pnpm --filter @squad/worker-steam-refresh test
```

`tick.test.ts` covers disabled mode, bounded selection, shared batch reads,
complete writes, partial responses, and failed shared requests.
`contract.test.ts` starts the built process and verifies heartbeat publication
and clean repeated `SIGTERM` handling.
