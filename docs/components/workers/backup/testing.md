# worker-backup — Testing

## Running tests

```bash
REDIS_URL=redis://127.0.0.1:6379/14 pnpm --filter @squad/worker-backup test
```

## Test files

All tests live under `apps/workers/backup/test/`.

### `contract.test.ts`

Subprocess contract tests (Redis DB 14, spawns `dist/index.js`).

| Test | What it verifies |
|---|---|
| Publishes heartbeat within 30s of start | `worker:heartbeat:backup` key has TTL ≤ 30s |
| Exits 0 on SIGTERM within 5s | Graceful shutdown path |

### `compose-backup.test.ts`

Regression guard against silent drift of the INFRA-8 `backup` docker-compose service, sliced out of `docker-compose.yml` and asserted on as text (no YAML parser dependency). Verifies the service is gated behind the `backup` profile, builds the custom restic image, dumps Postgres/Redis via `PRE_COMMANDS` (`pg_dump -Fc`, `redis-cli --rdb`), backs up the `backup_dump` staging volume rather than the raw `postgres_data`/`redis_data` volumes, and waits for `postgres`/`redis` to be healthy before starting.

### `fullstack-down-v.test.ts`

Contract guard for the INFRA-8-P1 full-stack disaster-recovery script (`scripts/test-fullstack-down-v.sh`) and `scripts/restore.sh`'s `--snapshot` support. The script itself is run-deferred (it destroys the local stack and exceeds the CI runner — see #219), so this test asserts on the script's source instead of executing it: the fail-closed `RUN_FULLSTACK_DOWN_V` opt-in guard, the literal `docker compose down -v` volume destruction and bind-mount wipe, the `restore.sh --apply` restore step, the post-restore `/health` and seeded-data assertions, and that a snapshot is forced through the backup service before volumes are destroyed. It also checks that `restore.sh` accepts and validates a `--snapshot` id rather than always restoring `latest`.

### `index-import.test.ts`

Imports `../src/index.js` (with `ioredis`, `@squad/shared-config`, and `pino` mocked) and asserts the module loads without throwing.

## Coverage gaps

Restic snapshot/domain backup logic is not implemented in this worker — deferred to a later phase. The `backup` docker-compose service (INFRA-8) that performs real backups today is covered by `compose-backup.test.ts` and the run-deferred `fullstack-down-v.test.ts`, not by this package's unit/contract tests.
