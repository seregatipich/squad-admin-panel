# worker-backup

## Purpose

Placeholder for a future in-fleet backup worker. Backups themselves run in the restic `backup` compose service (see below).

## Current status — placeholder, not deployed

`apps/workers/backup/src/index.ts` is a `runWorker` call with no ticks. At startup it logs `worker-backup placeholder idle — not deployed; backups run in the restic compose service (profile backup)`, then publishes the `worker:heartbeat:backup` heartbeat with status `idle (P2)` when `REDIS_URL` is set (Redis is optional; without it there is no heartbeat). The worker has no compose service in `docker/compose.yml` or `docker/compose.stand.yml`, so nothing runs it, and it contains no restic logic.

## Backup is already live via the restic service (INFRA-8)

The scheduled backups the panel actually relies on today are **not** produced by this worker — they run in the `backup` service defined in `docker/compose.yml` (image built from `docker/restic.Dockerfile`). This worker is an unused placeholder until a later phase folds the schedule into the worker fleet.

- **What is backed up:** logical dumps, not raw data dirs. Before each snapshot the service's `PRE_COMMANDS` run `pg_dump -Fc` (Postgres → `admin.dump`) and `redis-cli --rdb` (Redis → `dump.rdb`) into the `backup_dump` volume, then `restic backup /data` snapshots that directory. `pg_dump`/`redis-cli` reuse `POSTGRES_PASSWORD`.
- **Archived Squad logs (LOG-3, #51):** for servers with `server_settings.archive_logs_to_backup` on, the host bridge copies a rotated `SquadGame*.log` into `${DATA_DIR}/backup-dump/log-archive/{uuid}/` (via `PANEL_BACKUP_DUMP_ROOT`) just before the LOG-1 10-day retention sweep deletes it. Because that path is already inside `RESTIC_BACKUP_SOURCES=/data`, the next snapshot captures it under the same 7d/4w/6m retention — no separate restic invocation.
- **Schedule + retention:** daily at 03:00 UTC; `--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune`.
- **Enable:** `docker compose --profile backup up -d backup` (requires `RESTIC_REPOSITORY` + `RESTIC_PASSWORD`; `docker/compose.yml` refuses to start at all while `RESTIC_PASSWORD` is empty). On the stand, run the backup through `docker/compose.stand.yml`, which carries the same service.
- **Restore:** `scripts/restore.sh` (dry run by default, `--apply` to restore). Full runbook and the manual `down -v` acceptance procedure: [`docs/operations/deployment.md`](../../../operations/deployment.md#backup-optional).
- **Automated test:** `scripts/test-backup-restore.sh` runs the whole backup → `down -v` → restore round-trip in CI's `docker` job.

## Code location

```
apps/workers/backup/
  src/
    index.ts    — placeholder lifecycle (worker:heartbeat:backup); no restic logic
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
