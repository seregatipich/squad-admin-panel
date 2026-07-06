# worker-config-sync — Troubleshooting

## Common problems

### `admins-cfg:status:<server_id>` stuck at `state: 'unreachable'`

**Symptom**: drift banner on `/servers/<id>` shows "Admins.cfg недоступен на этом сервере".

**Note on transient errors** — the banner is debounced by `UNREACHABLE_DEBOUNCE_MS = 30 s`, and `bridge-client` retries idempotent calls (including `file_read` / `file_atomic_write`) once on transport errors. If you see this banner at all, the outage already survived: (a) the bridge-client in-call retry, (b) the worker's per-server backoff replay, and (c) the 30 s UI debounce. Treat it as a real condition, not a one-off blip.

**Likely causes**:

1. **`worker-config-sync` is connecting to the bridge with the wrong primary GID** (`gid=0(root)` instead of `gid=987(panel)`). `journalctl -u panel-host-bridge` will show `rejected untrusted peer ... uid:0, user:root, pid:<worker-pid>` for every attempt. Cause: `docker-compose.yml` declares `group_add: [${PANEL_GID}]` instead of `user: "0:${PANEL_GID:-987}"`. The bridge's SO_PEERCRED check inspects only the primary GID, never the supplementary list. Fix in `docker-compose.yml`:
   ```yaml
   worker-config-sync:
     ...
     user: "0:${PANEL_GID:-987}"   # ← required for SO_PEERCRED
     volumes:
       - /run/panel-host-bridge:/run/panel-host-bridge   # ← bind-mount the DIRECTORY, never the .sock file
   ```
   Then `docker compose up -d worker-config-sync`. Verify with `docker compose exec worker-config-sync id` — must show `gid=987` (not in `groups=`). Same applies to **every** worker that uses `bridge.fileRead/fileAtomicWrite/containerLogsFollow/etc.` — currently `worker-log-ingest`, `worker-config-sync`, `worker-metrics-sampler`. See [`docs/components/bridge/troubleshooting.md`](../../bridge/troubleshooting.md).
2. Bridge socket missing (`/run/panel-host-bridge/bridge.sock`): worker container can't reach the host daemon.
3. The Go bridge is rejecting the path (allowlist mismatch — the file should live at `/var/lib/squad-panel/configs/<uuid>/ServerConfig/Admins.cfg`).
4. The configs directory was never created (server install never finished).

**Diagnostics**:

```bash
docker compose logs worker-config-sync --since 5m
# Look for "admins.cfg read failed" or "admins.cfg atomic write failed".

ls -ld /var/lib/squad-panel/configs/<server_id>/ServerConfig/
sudo -u squad bash scripts/verify-bridge.sh   # full RPC smoke test
```

**Fixes**: re-run `sudo systemctl restart panel-host-bridge`, or finish the server install. Then click "Повторить синхронизацию" in the UI banner — the worker will re-read.

### Drift banner says "Admins.cfg на этом сервере изменён вне панели"

**Symptom**: Last segment hash in the file ≠ last DB hash.

**Likely cause**: someone SSH'd in and edited a `Admin=` line by hand (e.g. emergency kick).

**Fix**: click "Force sync". This enqueues a `force_sync` event; the worker overwrites the managed segment with the DB-derived one and writes an `admins_cfg.force_synced` row to `audit_log`. If the manual edit was meant to stick, copy the values into the panel UI (`/settings/groups` or the player card) **before** force-syncing — accepting drift back into the DB is not implemented in P0.

### Worker doesn't appear in `/api/v1/health/workers`

**Symptom**: missing heartbeat key.

**Causes**: process crashed at boot — likely missing `DATABASE_URL`, `REDIS_URL`, or unable to dial the bridge socket.

**Diagnostics**: `docker compose logs worker-config-sync --since 2m`. The very first lines tell you which env var was missing or whether the bridge connect failed.

### Sync events never get acked

**Symptom**: `XLEN events:admins-cfg-sync:<id>` keeps growing; per-server backoff stays maxed at 300 s.

**Cause**: every sync attempt is failing with the same persistent bridge / DB error.

**Diagnostics**:

```bash
redis-cli xinfo groups events:admins-cfg-sync:<server_id>
redis-cli xpending events:admins-cfg-sync:<server_id> config-sync
```

**Fix**: resolve the underlying error (bridge socket, DB connectivity); the worker will pick up the pending entries on its next read. If a stuck entry is malformed JSON, the worker logs `malformed admins-cfg-sync event` and `XACK`s it — that path is normally self-healing.

### Squad doesn't pick up new admins

**Symptom**: file written, hash matches, but in-game `/admin` commands still don't work for the user.

**Causes**: Squad re-reads `Admins.cfg` only every ~60 s. Wait a minute. If still broken, the role likely has 0 Squad permissions (it's a panel-only role) — check the role on `/settings/groups`.

**Useful commands**:

```bash
sudo cat /var/lib/squad-panel/configs/<server_id>/ServerConfig/Admins.cfg | sed -n '/SQUAD-PANEL BEGIN/,/SQUAD-PANEL END/p'
docker exec squad-<server_id> rcon AdminListAdmins  # if you have rcon-cli
```

### Multiple workers fighting over the same stream

By design they share the `config-sync` consumer group — each entry is delivered to **one** consumer, so two pods are safe (and improves redundancy). Heartbeat keys overlap on the same key but each refresh extends the TTL, which is fine.

### Pending list (PEL) keeps growing for a server

**Symptom**: `XPENDING events:admins-cfg-sync:<server_id> config-sync` returns a non-zero pending count that never decreases, often pinned to a `consumer-<oldpid>-...` that no longer exists.

**Likely cause**: the server has been bridge-unreachable for an extended window AND new mutations keep arriving, so each new event also enters PEL on top of the previous ones.

**Diagnostics**:

```bash
redis-cli xpending events:admins-cfg-sync:<server_id> config-sync
redis-cli xinfo consumers events:admins-cfg-sync:<server_id> config-sync
```

**Expected behaviour**: every `ADMINS_CFG_RECLAIM_INTERVAL_MS` (30 s default) the live worker should run `XAUTOCLAIM ... MIN-IDLE-TIME=60000 ... COUNT 50` and migrate up to 50 pending messages onto its own consumer name. Run `redis-cli xinfo consumers ...` after a minute and you should see the pending count flow toward the live consumer.

**Fix paths**:

- If the live worker is healthy but PEL stays huge: the bridge is still failing. Check `docker compose logs worker-config-sync` for `admins.cfg sync_failed` audits and `unreachable` log lines, then fix the bridge.
- If you want to drain the PEL manually: `redis-cli xack events:admins-cfg-sync:<server_id> config-sync <id>` will discard one entry. Use sparingly — the periodic drift sweep will only mark the server as `drift` if the managed segment differs; it will not rewrite the file until an active mutation or Force-sync event is processed.

### Reclaim sweep doesn't seem to fire

**Symptom**: log lines `'reclaimed pending admins-cfg-sync messages'` never appear despite a populated PEL.

**Likely causes**:

- `RECLAIM_MIN_IDLE_MS` is too high — messages haven't aged past the threshold yet.
- The worker container hasn't been running long enough to see `RECLAIM_INTERVAL_MS` pass.
- An older Redis (pre-6.2) where `XAUTOCLAIM` is not available — log shows `Unknown command 'xautoclaim'`. The worker swallows that error silently; check for `xautoclaim failed` warns.

**Fix**: upgrade to Redis ≥ 6.2 (`docker compose pull redis && docker compose up -d redis`).

## Useful metrics / log lines

- `admins.cfg sync` log line: per-event success/skip. Includes `state`, `groups`, `admins`, `reason`.
- `admins.cfg drift detected — awaiting force-sync`: warn-level log emitted when the periodic sweep sees that the managed segment no longer matches the DB-derived hash.
- `worker:heartbeat:config-sync`: liveness key.
- `audit_log` rows with `action_type LIKE 'admins_cfg.%'`: full history.
