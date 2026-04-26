# `api` — troubleshooting

## API container is unhealthy after `docker compose up -d`

```bash
docker compose logs api --since 2m
```

Most common causes:

- `APP_ENCRYPTION_KEY` missing or < 32 bytes (base64-decoded).
- `PANEL_PUBLIC_URL` not set — required for Steam OpenID `return_to` host-binding. The callback will fail with a host-mismatch error without it.
- `DATABASE_URL` / `REDIS_URL` unreachable. Check `docker compose ps postgres redis` first.
- `BRIDGE_SOCKET` not bind-mounted into the container (compare `compose.yml` `volumes:` for the `api` service).
- `panel` group missing inside the container (check `group_add: [panel]`).

## 429 on Steam callback after a single attempt

`@fastify/rate-limit` keys on IP. If you are behind Caddy and the panel sees `X-Forwarded-For` correctly, this is intentional after 5 wrong attempts. Otherwise check the `trustProxy` config in [`apps/api/src/server.ts`](../../../apps/api/src/server.ts).

## `/health` 200 but install WS fails immediately

Almost always a bridge / `panel`-group issue. See [`components/bridge/troubleshooting.md`](../bridge/troubleshooting.md).

## `DELETE /servers/:id` returns 500 `delete_failed: no config files could be backed up`

**Cause**: Phase 1 of [`server-delete.ts`](../../../apps/api/src/lib/server-delete.ts) tried `bridge.fileRead` on every `ALLOWED_CONFIG_FILES` entry under `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/` and got zero hits. Either the directory is missing entirely (server was never installed, or files were already wiped manually), or the bridge can't read them (permissions, allowlist mismatch).

**Diagnostics**:

```bash
ls -la /var/lib/squad-panel/configs/<server-id>/ServerConfig/   # do the files exist?
docker compose logs api --since 2m | grep server-delete         # bridge fileRead errors?
sg panel -c 'bash scripts/verify-bridge.sh'                     # bridge healthy at all?
```

**Action**: do NOT add a `force=true` flag — phase 1 protects the operator from data loss. If the server is genuinely abandoned, verify the directory really is empty, then drop the row directly: `DELETE FROM servers WHERE id='<id>';` followed by manual `docker rm -f squad-<id>` and `sudo rm -rf /var/lib/squad-panel/{configs,saved}/<id>`. The audit log records nothing for this manual path; document the operation in the runbook.

## DELETE returned `ok:true` but the container is still running

**Cause**: Phase 2 (`container_stop` + `container_rm`) is best-effort. A non-empty `errors[]` in the response (and in `audit_log.context`) shows the failure; phase 5 still flipped `deleted_at` so the row is gone from active lists.

**Action**:

```bash
docker rm -f squad-<id>                              # finish the job
psql -c "SELECT context FROM audit_log WHERE action_type='server.delete' AND target_id='<id>' ORDER BY id DESC LIMIT 1"
```

## DELETE returned `ok:true` but `/var/lib/squad-panel/configs/<id>` still exists

**Cause**: Phase 3 `directory_delete` returned an error (recorded in `errors[]`). The bridge's path validator (`PanelConfigsServerRoot`/`PanelSavedServerRoot`) requires an exact root match — if a manual `chmod` made the dir partially un-removable the bridge reports `runtime_error`.

**Action**: `sudo rm -rf /var/lib/squad-panel/{configs,saved}/<id>`. Future `directory_delete` calls on the same id will already hit the new partial unique index — no risk of accidentally re-creating a hole.

## Restore wizard fails with 409 `slug_in_use`

**Cause**: The partial unique index `servers_slug_active_key` on `servers(slug) WHERE deleted_at IS NULL` prevents two ACTIVE rows from sharing a slug. The archive row's slug doesn't conflict (it has `deleted_at`), but if you tried to restore with the same slug while a different active server already owns it, the insert fails.

**Action**: pick a different slug in the restore wizard (`<old>-restored-1` is the conventional pattern). If you genuinely want to "take back" the slug, soft-delete the conflicting active server first.

## Restore-configs reports `files_missing[]` on every cfg

**Cause**: `POST /servers/:newId/restore-configs` reads `config_versions WHERE message LIKE 'deletion-backup-marker%' AND server_id = from_archive_id`. If the archive's `from_archive_id` corresponds to a server whose deletion happened before Bundle C shipped (i.e. before `deletion-backup-marker` rows were emitted), no rows match. The new server keeps its install-time defaults.

**Action**: there is no fallback — pre-Bundle-C deletions did not back up configs. Manually re-edit the cfg files via the editor at `/servers/:newId/configs`.

## Server is stuck on "Остановка" / "Запускается" / "Установка"

**Symptom**: a row sits in `stopping`, `starting`, or `installing` for more than ~90 s and the UI never moves on.

**Diagnosis**:

```bash
curl -sk https://${APP_DOMAIN}/api/v1/health/reconciler | jq
```

Look at the response:

- `last_tick_at` older than ~12 s → the reconciler loop is wedged. Check `docker compose logs api --since 2m | grep reconciler:` for `tick failed` lines.
- `consecutive_tick_errors > 0` → the SELECT itself is failing (DB outage or schema mismatch). The DB connection is unhealthy.
- `bridge_failures_by_server[<id>] >= 5` → the bridge can't inspect that server's container. Run `sg panel -c 'bash scripts/verify-bridge.sh'` and `sudo systemctl status panel-host-bridge`.
- `stuck_servers[]` non-empty → reconciler is alive but couldn't resolve the row, usually because `docker inspect` returned an unmapped state string (see `mapState` in [`status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts)). `docker compose logs api --since 5m | grep 'unknown docker state'` shows the raw state.

**Action**: force a single-server reconcile.

```bash
curl -skX POST https://${APP_DOMAIN}/api/v1/servers/<id>/reconcile \
  -H "Cookie: __Host-sid=<your-session>" | jq
```

The response includes `inspected_state`, `inspected_running`, and the resulting `new_status`. If 502 `bridge_unavailable` comes back, fix the bridge first; the row will move on its own once the next tick succeeds. If a never-before-seen docker state is reported (the `unknown docker state` warning above), add it to `mapState`'s switch statement and ship a patch — the reconciler is intentionally conservative and will not guess.

If the row was wrongly stuck on a UUID that no longer has a container at all (`inspected_state: 'not_found'`), the reconcile will flip it to `stopped`. The UI will catch up on the next live-bus event.

## Audit chain shows a gap

See [`operations/troubleshooting.md`](../../operations/troubleshooting.md#audit-log-shows-a-gap-or-hash-mismatch).

## Useful logs / metrics

```bash
docker compose logs api --since 5m
docker compose logs api -f --tail=50
curl -sk https://${APP_DOMAIN}/metrics | grep '^http_'
```

`prom-client` ships HTTP duration buckets, route-level counters, and pool stats for Postgres and Redis under `/metrics`.
