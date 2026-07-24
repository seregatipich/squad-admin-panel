# worker-backup

## Purpose

Will create restic-based snapshots of the Postgres database and all server config files on a configurable schedule.

## Current status — P2 stub

No-op process. Logs `"worker-backup idle — deferred to later phase"` and loops with a 60 s internal heartbeat log. Does not publish a Redis heartbeat.

## Backup is already live via the restic service (INFRA-8)

The scheduled backups the panel actually relies on today are **not** produced by this worker — they run in the `backup` service defined in `docker-compose.yml` (image built from `docker/restic.Dockerfile`). This worker stays a stub until a later phase folds the schedule into the worker fleet.

- **What is backed up:** logical dumps, not raw data dirs. Before each snapshot the service's `PRE_COMMANDS` run `pg_dump -Fc` (Postgres → `admin.dump`) and `redis-cli --rdb` (Redis → `dump.rdb`) into the `backup_dump` volume, then `restic backup /data` snapshots that directory. `pg_dump`/`redis-cli` reuse `POSTGRES_PASSWORD`.
- **Archived Squad logs (LOG-3, #51):** for servers with `server_settings.archive_logs_to_backup` on, the host bridge copies a rotated `SquadGame*.log` into `${DATA_DIR}/backup-dump/log-archive/{uuid}/` (via `PANEL_BACKUP_DUMP_ROOT`) just before the LOG-1 10-day retention sweep deletes it. Because that path is already inside `RESTIC_BACKUP_SOURCES=/data`, the next snapshot captures it under the same 7d/4w/6m retention — no separate restic invocation.
- **Schedule + retention:** daily at 03:00 UTC; `--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune`.
- **Enable:** `docker compose --profile backup up -d backup` (requires `RESTIC_REPOSITORY` + `RESTIC_PASSWORD`).
- **Restore:** `scripts/restore.sh` (dry run by default, `--apply` to restore). Full runbook and the manual `down -v` acceptance procedure: [`docs/operations/deployment.md`](../../../operations/deployment.md#backup-optional).
- **Automated test:** `scripts/test-backup-restore.sh` runs the whole backup → `down -v` → restore round-trip in CI's `docker` job.

## Code location

```
apps/workers/backup/
  src/
    index.ts    — P2 stub
```

## Related docs

- [api.md](./api.md)
- [data-model.md](./data-model.md)
- [flows.md](./flows.md)
- [configuration.md](./configuration.md)
- [testing.md](./testing.md)
- [troubleshooting.md](./troubleshooting.md)
- [changelog.md](./changelog.md)
