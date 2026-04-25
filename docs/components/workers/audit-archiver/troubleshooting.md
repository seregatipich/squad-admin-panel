# worker-audit-archiver — Troubleshooting

## Heartbeat missing from `/api/v1/health/workers`

**Cause:** `REDIS_URL` is not set in the container environment, so no heartbeat is published.

**Fix:** Add `REDIS_URL` to the compose environment for this worker.

## Container restarting in a loop

**Cause:** The `main()` function is simple; the only fatal path is an uncaught promise rejection. Check container logs:

```bash
docker compose logs worker-audit-archiver --since 5m
```

## Planned Phase 1 issues

When Phase 1 ships, add troubleshooting entries for:

- Archive path not writable.
- Hash chain verification failure on `audit_log` rows.
- `audit_log_archive_view` deletion blocked by Postgres permissions.
