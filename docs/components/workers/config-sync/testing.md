# worker-config-sync — Testing

## Running tests

```bash
# Unit tests (pure, no infra)
pnpm --filter @squad/worker-config-sync exec vitest run test/segment.test.ts

# Contract tests (need Redis + DB + the dist/ build)
pnpm --filter @squad/worker-config-sync build
REDIS_URL=redis://127.0.0.1:6379/14 \
  DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin \
  pnpm --filter @squad/worker-config-sync test
```

## Test files

All tests live under `apps/workers/config-sync/test/`.

### `segment.test.ts` — unit (pure)

Covers the deterministic generator, parser, and splicer in `src/segment.ts`:

| Test | What it verifies |
|---|---|
| `Group=` per role with squad perms; `Admin=` per assignment | sort order (role, then steam_id64), exclusion of roles with 0 perms |
| CRLF line endings | `\r\n` only inside the segment, no stray `\n\n` |
| Stable sha256 across permutations | hash invariant when input order changes |
| Empty body with markers | works for first-sync (no roles, no admins) |
| Optional `// commentary` after `Admin=` line | for P1 comment support |
| `findManagedSegment` | returns null when no markers, finds the slice when present |
| `spliceManagedSegment` | replaces in place, prepends to non-empty file with no markers, leaves outside-segment bytes untouched |
| `hashSegment` | 64-char lowercase hex |

### `rcon-reload.test.ts` — unit (pure, fake Redis)

Покрывает старый `requestAdminsCfgReload` и новый
`confirmAdminsCfgReload` в изоляции:

| Test | What it verifies |
|---|---|
| connected RCON | exactly one `XADD` to `rcon:commands:<id>` whose `request` parses to `command: 'AdminReloadServerConfig', args: []`; returns `enqueued` |
| status absent / `connecting` / `disconnected` / malformed JSON | no `XADD`, returns `skipped_rcon_disconnected`, never throws |
| `xadd` rejects | returns `failed`, never throws, logs one warn |
| correlated request | детерминированный `admins-cfg-sync:<outbox_id>` и только точный валидный `ok=true` |
| mismatched/rejected/timeout | безопасные `invalid_result`, `rejected`, `timeout` без сырых ответов |

### `delivery.test.ts` и `delivery.integration.test.ts`

- переходы `stopped -> running` и `running -> stopped` проверяют два свежих
  чтения состояния и обязательную RCON-ветку для живого итога;
- crash/reclaim до результата, до `applied_at` и после `applied_at` не повторяет
  уже подтверждённый файловый/RCON эффект;
- настоящий PostgreSQL+Redis подтверждает порядок durable DB → атомарные
  `XACK`/точный `XDEL`, сохранение failed/unacked записи и детерминированный
  RCON round-trip;
- `superseded`, `server_removed`, старые и повреждённые сообщения очищаются без
  бесконечного ACKed-хвоста; failed/unacked никогда не удаляется.

### `syncer.test.ts` — unit (fake Redis/DB/bridge)

Beyond the read-modify-write branches, guards the reload wiring:

| Test | What it verifies |
|---|---|
| `not_found → write` and `forceWrite` paths | enqueue exactly one reload; `SyncResult.reload === 'enqueued'` |
| `in_sync` (no write), `drift`, read-fail, write-fail paths | enqueue **zero** reloads |
| reload `xadd` rejects | sync still returns `state: 'wrote'` (reload is strictly best-effort), `reload === 'failed'` |
| RCON not connected | `reload === 'skipped_rcon_disconnected'`, no enqueue |
| audit context | the `admins_cfg.synced` row `context` carries `reload` |

### `index-import.test.ts` — module-import (all deps mocked)

Imports `src/index.ts` with `ioredis`, `@squad/db`, `@squad/bridge-client`, `@squad/shared-config`, and `pino` mocked, and drives the running `main()` loop:

| Test | What it verifies |
|---|---|
| importable + calls syncer | the module boots and wires the syncer |
| passive drift logs "awaiting force-sync" | the `drift` branch surfaces the warn, does not overwrite |
| **NOGROUP xreadgroup → immediate refresh (SYNC-5)** | a one-shot `mockImplementationOnce` rejects `XREADGROUP` with `NOGROUP …`; the worker calls `refreshServerList()` at once (observed as an extra `db.select` call) and keeps polling afterwards — proving the destroyed-stream case self-heals within one loop iteration rather than stalling |

### `contract.test.ts` — subprocess

Spawns `dist/index.js` with a real Redis (DB 14) and a real Postgres test DB; verifies:

- `worker:heartbeat:config-sync` key appears within 30 s of start with TTL ≤ 30 s.
- SIGTERM causes exit code 0 within 5 s.

## Live e2e (run-deferred, tier-3)

`apps/api/test/e2e/admins-cfg-reload-live.e2e.test.ts` выполняет force-sync живого
сервера и требует устойчивый outbox-итог `reload_outcome=confirmed` с
`applied_at`; длина RCON stream остаётся лишь вспомогательным сигналом. Тест
run-deferred и требует настоящие panel, config-sync, worker-rcon и Squad.

## Integration coverage from API side

Cross-component coverage that the API publishes the right events:

- API role/whitelist/clan/VIP tests assert a pending outbox row per active server and zero early Redis entries before an explicit post-commit relay.
- The API permission-matrix tests guard that `/api/v1/admins-cfg/drift` and `/api/v1/admins-cfg/drift/all` require `admin_group:view`, while `/api/v1/admins-cfg/sync` requires `admin_group:edit`.
- `apps/api/test/server-delete.test.ts > softDeleteServer — Redis sync-queue cleanup (SYNC-5)` — DB + real-Redis coverage that soft-delete destroys the per-server stream, consumer group, and `admins-cfg:status:<id>` key, completes every unapplied outbox row as `server_removed` while preserving an existing `relayed_at`/`stream_id`, stays idempotent, and records Redis cleanup failure without undoing the DB result.
- `apps/api/test/integration/admins-cfg-outbox.test.ts` covers commit/rollback visibility, stable `_outbox_id` after relay crash, bounded/null `XADD`, group creation after relay, a backlog above the old cap without trim, and deleted-server terminal drain without stream resurrection.
- `apps/workers/config-sync/test/index-import.test.ts` proves relay interval single-flight while delivery is stalled.

## What is explicitly NOT covered yet

- An e2e test that spawns the worker and verifies a real `Admins.cfg` write through the bridge — would require the bridge socket. Tier-3 e2e (`apps/api/test/e2e/install-lifecycle.e2e.test.ts`) covers the install path through the bridge but does not yet assert managed-segment content; this is a follow-up.
- A test that intentionally corrupts the file outside the markers and asserts the worker leaves those bytes alone after a sync — covered indirectly by `spliceManagedSegment` unit tests, but not end-to-end.
- An XAUTOCLAIM regression test that simulates a crashed prior consumer (manually adds a PEL entry under a stale consumer name, runs the reclaim pass, asserts the entry moves) — would tighten the spec §2.7.7 retry guarantee. Currently the reclaim path is exercised only by a real failed-bridge scenario.

## Important edge cases the unit tests guard

- A role with 0 squad permissions does NOT emit an `Admin=` line for any of its members (it's panel-only).
- Players with `role_id = NULL` are absent from the managed segment.
- Empty file (first-sync) produces a segment-only file ending with `\r\n`.
- Re-running with identical inputs produces an identical hash → no write happens.
