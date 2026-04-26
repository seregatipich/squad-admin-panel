# worker-audit-archiver — Flows

## Current flow (P0 stub)

1. Start pino logger.
2. Connect to Redis if `REDIS_URL` is set.
3. Publish heartbeat (`worker:heartbeat:audit-archiver`, status `"idle (P1)"`).
4. Wait indefinitely; respond to `SIGTERM`/`SIGINT` by stopping heartbeat, closing Redis, and exiting 0.

## Planned Phase 1 flow

1. Connect to Postgres and Redis.
2. Run `ensureArchive()` immediately on startup.
3. Repeat `ensureArchive()` on an hourly cron.

### `ensureArchive()` (Phase 1)

1. `SELECT * FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days' ORDER BY id ASC LIMIT 10000`.
2. Verify the SHA-256 hash chain on selected rows using `pnpm verify:audit-chain` logic.
3. Serialise to JSONL and write to the configured archive path.
4. Update archive marker row.
5. `DELETE FROM audit_log_archive_view WHERE id IN (...)`.

## Graceful shutdown

Stop heartbeat → `redis.quit()` → `process.exit(0)`.
