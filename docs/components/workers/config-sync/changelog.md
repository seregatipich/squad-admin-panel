# Changelog — worker-config-sync

## 2026-07-25 — RCON reload after write (SYNC-3, #36)

### Added

- **`AdminReloadServerConfig` after every successful `Admins.cfg` write** (`src/rcon-reload.ts` → `requestAdminsCfgReload`). Closes SYNC-3 correction №1 (`ai_docs/plans/2026-07-04-task-decomposition.md`): Squad does **not** passively re-read `Admins.cfg`, so the panel must issue the RCON reload for permission changes to take effect without a container restart. The command is `XADD`'d onto worker-rcon's `rcon:commands:<server_id>` stream (`MAXLEN ~ 500`), byte-identical to the clan-guard / log-ingest / scheduler `sendRconCommand` helpers.
- The reload is **gated** on `rcon:status:<server_id>.state === 'connected'` (one Redis `GET`) — skipped otherwise, so commands don't pile up on a stopped server — and **strictly best-effort**: it never throws and never rolls back the committed write. Its outcome (`enqueued` | `skipped_rcon_disconnected` | `failed`) is exposed on `SyncResult.reload` and recorded in the `admins_cfg.synced` / `admins_cfg.force_synced` audit `context.reload`.
- Fired **only on the successful-write branch** — not on `in_sync` (no write), `drift`, or failure (`unreachable`) branches.
- `test/rcon-reload.test.ts` (pure unit, fake Redis) and reload coverage in `test/syncer.test.ts`. New run-deferred live e2e `apps/api/test/e2e/admins-cfg-reload-live.e2e.test.ts` (tier-3).

### Changed

- `package.json`: added deps `@squad/shared-types` (`rconCommandRequestSchema` / `rconCommandStream`) and `uuid` (v7 `request_id`).

## 2026-04-28

### Changed

- The drift banner in `apps/web/src/components/AdminsCfgDriftBanner.tsx` is now suppressed for the first 30 s of any `state: 'unreachable'` window (`UNREACHABLE_DEBOUNCE_MS`). The status keeps polling underneath, and the banner appears only if the outage genuinely outlives one auto-retry of the bridge plus one reclaim sweep.

### Fixed

- **Root cause of `Admins.cfg недоступен / socket closed`**: `docker-compose.yml` had the worker on `group_add: [${PANEL_GID:-987}]` instead of `user: "0:${PANEL_GID:-987}"`. The container therefore ran with `gid=0(root)` as primary GID and 987 only in supplementary groups. The bridge's SO_PEERCRED auth check looks at the primary GID and rejected every connection with `rejected untrusted peer ... uid:0, user:root`. Every `file_read` and `file_atomic_write` failed with `socket closed` / `write EPIPE`, the syncer published `state: 'unreachable'`, and the drift banner surfaced to the operator. The same regression also affected `worker-log-ingest`. Fixed by replacing `group_add` with `user:` in both compose entries (matching the precedent set in commit 11cee5a for `worker-metrics-sampler`).
- The combination of `bridge-client` transport retry (see `docs/components/bridge-client/changelog.md`) + the 30 s UI debounce makes routine `panel-host-bridge` restarts invisible to operators. Previously: any single dropped bridge call → `state: 'unreachable'` → user-facing "Admins.cfg недоступен на этом сервере" banner with a "Повторить синхронизацию" button for ≥ 60 s, until the worker's `reclaimPendingMessages` sweep eventually replayed the unacked event.

### Verification

- End-to-end against the live stack on `squad-panel.lan`:
  1. After GID fix the worker boot reclaim auto-recovers all unacked events from the outage window: `state: 'unreachable'` → `'in_sync'` within 1 s of worker restart.
  2. `systemctl restart panel-host-bridge` mid-`force_sync` no longer transitions the status to `unreachable` — the bridge-client transport-retry catches the dropped socket and reconnects in <2 ms.
  3. Hard outage (`stop panel-host-bridge.socket panel-host-bridge.service`) leaves status `unreachable` with `unreachable_since` set; banner stays hidden for the first 30 s, then surfaces once the outage is real. Restoring the bridge auto-recovers via `XAUTOCLAIM` reclaim sweep within 60–90 s.

## 2026-05-02 — Spec compliance round 2

### Added

- `admins_cfg.sync_failed` audit row written on every bridge error (read or atomic-write phase). Spec §2.7.7 — "audit пишет failed sync attempts". Includes `phase`, `error`, and counts in the row context.
- **Pending-message reclaim** via `XAUTOCLAIM` (`apps/workers/config-sync/src/index.ts`): runs once at boot and every `ADMINS_CFG_RECLAIM_INTERVAL_MS` (default 30 s) per active server. Takes ownership of any pending message older than `ADMINS_CFG_RECLAIM_MIN_IDLE_MS` (default 60 s) and replays it. Closes the spec §2.7.7 "retry until success" guarantee — handles previous-consumer crashes, process restarts (consumer name regeneration), and persistently-unreachable bridges.
- Two new env vars: `ADMINS_CFG_RECLAIM_INTERVAL_MS`, `ADMINS_CFG_RECLAIM_MIN_IDLE_MS` (see `configuration.md`).

### Changed

- Worker no longer `XACK`s a stream message when the result is `state: 'unreachable'`. The message is left pending so the reclaim cycle (or another consumer) redelivers it. Spec §2.7.7 — temporary unreachability must retry until success.

## 2026-04-27

### Added

- Full Admins.cfg synthesis: managed-segment generator (`src/segment.ts`) + DB snapshot helper (`src/db-snapshot.ts`).
- Sync engine (`src/syncer.ts`): bridge `file_read` + `file_atomic_write` round-trip with `//SQUAD-PANEL BEGIN/END` markers, CRLF preservation, sha256 idempotency, status publishing to `admins-cfg:status:<server_id>` and audit-trail rows (`admins_cfg.synced` / `admins_cfg.force_synced`).
- Stream consumer in `src/index.ts`: subscribes to `events:admins-cfg-sync:<server_id>` per active server via consumer group `config-sync`. Periodic drift sweep every 5 min (configurable via `ADMINS_CFG_DRIFT_INTERVAL_MS`).
- Per-server exponential-backoff retry (max 5 min) on bridge failures.
- New test `test/segment.test.ts` — unit coverage of generator/parser/splicer.
- Worker now requires `DATABASE_URL` and `PANEL_BRIDGE_SOCKET` envs in addition to `REDIS_URL`.

### Changed

- `package.json`: added deps `@squad/db`, `@squad/bridge-client`, `drizzle-orm`.

## 2026-04-26

### Added

- Added `startHeartbeat` to `src/index.ts` so the worker publishes `worker:heartbeat:config-sync` to Redis.
- Added `@squad/shared-config` dependency.
- Added `test/contract.test.ts`: subprocess contract tests — heartbeat + SIGTERM exit 0.

## 2026-04-25

### Added

- P2 stub: no-op loop, graceful shutdown.
