# `api` — public surface

Routes are registered in [`apps/api/src/server.ts`](../../../apps/api/src/server.ts) and split across files in [`apps/api/src/routes/`](../../../apps/api/src/routes/). Schemas are Zod via `fastify-type-provider-zod`. Interactive docs are served at `/api/docs`.

## Conventions

- **Authentication**: cookie `__Host-sid` (`Secure; HttpOnly; SameSite=lax; Path=/`). Set on `GET /api/v1/auth/steam/callback`. Cleared on `POST /api/v1/auth/logout`. As an alternative for programmatic access, requests may carry `Authorization: Bearer sqp_…` (an API token minted via `/api/v1/me/tokens`) — the cookie path takes precedence when both are present. Token-managing routes (`/api/v1/me/tokens*`) reject Bearer auth.
- **Identity anchor**: `players.steam_id64` (bigint). There are no email/password accounts. All sessions and permissions are keyed on Steam ID.
- **Authorisation**: every authed route declares `config.permissions: PermissionKey[]`. Anonymous → 401. Missing permission → 403.
- **Audit**: every mutation must declare `config.audit: { action, resource }`. The CI gate [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) fails the build otherwise.
- **bigserial IDs**: `audit_log.id` is serialized as a string to survive `JSON.stringify`.

## Authentication and account

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/auth/steam/login` | Generates a random nonce (base64url, 16 bytes), stores it in Redis (`steam-nonce:{nonce}`, TTL 300 s) and a `__Host-steam-nonce` cookie, then redirects to `steamcommunity.com/openid/login`. | none |
| GET | `/api/v1/auth/steam/callback` | Validates nonce cookie↔query match, single-use Redis nonce, `return_to` host-binding to `PANEL_PUBLIC_URL`, Steam `check_authentication`, and `openid.response_nonce` replay guard (`steam-response-nonce:{nonce}`, TTL 3600 s, NX). On success: upserts `players` row, runs `claimFirstOwner`, checks permissions; redirects to `/` with `__Host-sid` cookie on success or `/no-access?steam_id64=…` when no role is assigned. | none |
| POST | `/api/v1/auth/logout` | Revoke current session, clear `__Host-sid` cookie. | session |
| GET | `/api/v1/me` | Current player, permissions array, clearance. Returns `{ steam_id64, canonical_name, avatar_url, permissions, clearance }`. | session |
| GET | `/api/v1/me/sessions` | List own active sessions; `current: true` on the request's session. | session |
| DELETE | `/api/v1/me/sessions/:id` | Revoke own session by id. 404 for foreign session. | session |
| DELETE | `/api/v1/me/sessions` | Revoke all own sessions. | session |
| GET | `/api/v1/me/tokens` | List own API tokens (id, name, scopes, created_at, last_used_at, revoked_at). Never returns plaintext or hash. | session |
| POST | `/api/v1/me/tokens` | Mint a new API token. Body: `{ name: string (1..100), scopes: string[] }`. `scopes ⊆ caller.permissions` (422 `invalid_scopes` otherwise). Hard cap of 25 active tokens per user (409 `too_many_active_tokens`). Returns `{ id, name, scopes, created_at, plaintext: 'sqp_<uuid>_<random>' }` — plaintext appears **once**. | session |
| DELETE | `/api/v1/me/tokens/:id` | Soft-revoke own token (sets `revoked_at`). Idempotent — second call returns `{ ok: true, already_revoked: true }`. 404 for foreign token. | session |

Removed surfaces (no longer exist): `POST /api/v1/auth/login`, `POST /api/v1/me/totp/*`, `GET /api/v1/auth/discord/*`, `POST /api/v1/setup/{org,owner,finalize}`, `GET /api/v1/setup/check-env`, `POST /api/v1/setup/init`.

## First-time setup

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/setup/status` | Returns `{ setup_completed, first_owner_claimed }`. Used by `/setup` and the dashboard layout to decide whether the panel should collect organization metadata before entering the dashboard. | none |
| POST | `/api/v1/setup/complete` | Owner-only finalization. Body: `{ organization_name }`. Sets `panel_meta.setup_completed=true` and persists the organization name. Returns 410 when setup is already complete, 401 without a session, and 403 when the session is not Owner. | Owner session |

## Service integrations

### VIP lifecycle

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/integrations/vip/lifecycle` | Signed service endpoint for `vip-user-service` to assign, extend, expire or refund VIP panel roles. Disabled unless `VIP_LIFECYCLE_WEBHOOK_SECRET` is set. | HMAC only |

Required headers:

- `x-vip-timestamp`: ISO timestamp used in the signature payload.
- `x-vip-signature`: `sha256=<hex>` HMAC-SHA256 of `<x-vip-timestamp>.<canonical-json-body>` using `VIP_LIFECYCLE_WEBHOOK_SECRET`.

Body:

```json
{
  "event_id": "purchase-123",
  "event_type": "vip.purchased",
  "player_id": "0190abcd-0000-7000-8000-000000000001",
  "role_id": "0190abcd-0000-7000-8000-000000000002",
  "tier": "vip2",
  "purchase_id": "purchase-123",
  "expires_at": "2030-01-02T03:04:05.000Z"
}
```

`event_type` values: `vip.purchased`, `vip.extended`, `vip.expired`, `vip.refunded`. Purchase/extension events require a future `expires_at`; expiry/refund events revoke only when the current player role still matches `role_id`. `event_id` is stored in `vip_lifecycle_events` and makes retries idempotent: duplicate delivery returns `200 { ok: true, duplicate: true }` without another Admins.cfg sync. First application returns `202` with `action` (`assigned`, `revoked`, `ignored`) and `enqueued`.

Ownership boundary: `vip-user-service` owns wallet ledger, purchase idempotency and economic rollback. This panel owns role membership, `role_expires_at` and Admins.cfg sync. Discord role sync is handled outside this API.

### Team balancer proposals

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/integrations/balancer/proposals` | Signed service endpoint the SquadJS team-balancer exporter pushes one dry-run proposal snapshot to. Disabled (503 `balancer_webhook_disabled`) unless `BALANCER_WEBHOOK_SECRET` is set. | HMAC only |

Required headers:

- `x-balancer-timestamp`: ISO timestamp used in the signature payload.
- `x-balancer-signature`: `sha256=<hex>` HMAC-SHA256 of `<x-balancer-timestamp>.<canonical-json-body>` using `BALANCER_WEBHOOK_SECRET`.

Body:

```json
{
  "source_snapshot_id": "balancer-snapshot-001",
  "server_id": "0190abcd-0000-7000-8000-0000000000a1",
  "mode": "squad",
  "generated_at": "2026-07-27T08:55:00.000Z",
  "layer": "Yehorivka_RAAS_v1",
  "gamemode": "RAAS",
  "schema_version": 1,
  "signals": { "win_streak": 4, "ticket_diff": -320, "one_sided_rounds": 3 },
  "proposal": [
    {
      "subject_type": "squad",
      "subject_id": "sq-alpha",
      "label": "Alpha",
      "current_team": 1,
      "target_team": 2,
      "state": "should_move"
    }
  ]
}
```

`mode` is `squad` or `player`; `state` is `on_target`, `no_change` or `should_move` and is the only thing the review UI derives its green/gray/red colouring from. `signals` and `proposal` are stored verbatim as `jsonb` and versioned by `schema_version`, so an exporter payload change needs no migration; unknown extra fields inside a proposal entry are preserved. `source_snapshot_id` is the idempotency key: redelivering the same id refreshes the stored row and returns `200 { ok: true, duplicate: true }`, while a new snapshot returns `202` and flips the previous still-`open` snapshot for the same `(server_id, mode)` pair to `superseded`. Unknown `server_id` → 404 `server_not_found`; bad signature → 401 `invalid_signature`.

Ownership boundary: SquadJS owns the planner, the ELO/history weighting and any runtime chat vote. This panel owns the review surface, the threshold rules and the operator decision history. **The panel never executes a team change** — `RCON_OPERATOR_COMMANDS` contains no team-change verb and this slice adds none.

### Team balancer review and rules

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/balancer/settings` | Singleton threshold/rules row (snake_case) under `{ settings }`. Returns the column defaults when no row exists yet. | `balancer:view` |
| PUT | `/api/v1/balancer/settings` | Partial upsert of the singleton. Body accepts any subset of `enabled`, `win_streak_threshold` (≥1), `ticket_diff_threshold` (≥0), `one_sided_rounds_threshold` (≥1), `quorum` (≥0), `pass_threshold_pct` (0–100), `require_moderator_veto`, `prefer_squad_grouping`, `player_level_enabled`; an empty body is 400. Audit: `balancer.settings.update`. | `balancer:edit` |
| GET | `/api/v1/balancer/proposals` | Cursor page of stored snapshots, newest `generated_at` first. Query: `server_id` (uuid or `all`), `status`, `mode`, `cursor`, `limit` (≤100). Each item carries the raw `signals`/`proposal` blobs plus an `evaluation` verdict (`{triggered, reasons[]}`) computed from the current thresholds. Returns `{ items: [], next_cursor: null }` with HTTP 200 when no snapshot has ever arrived. Malformed cursor → 400 `invalid_cursor`. | `balancer:view` |
| GET | `/api/v1/balancer/proposals/:id` | One snapshot plus its `decisions[]` history, newest first. 404 `proposal_not_found`. | `balancer:view` |
| POST | `/api/v1/balancer/proposals/:id/decision` | Records an operator verdict: `{ decision: 'acknowledge'\|'veto'\|'dismiss', veto_reason_kind?, veto_reason? }`. A `veto` without `veto_reason` is 400 `veto_reason_required`. `acknowledge`/`veto` set the snapshot to `reviewed`, `dismiss` to `dismissed`. Returns 201. Audit: `balancer.proposal.decision`. | `balancer:edit` |

## RBAC reference

### Permissions

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/permissions` | Full registered permission registry from `@squad/shared-config` — array of `{key, category, label, dangerous?, unimplemented?}`. Used by the role-management UI. | `role:view` |

### Roles

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/roles` | List all roles with `permissions[]` and `assigned_users_count`. Sorted `is_system_role DESC, name ASC`. | `role:view` |
| GET | `/api/v1/roles/:id` | Single role detail. 404 if not found. | `role:view` |
| POST | `/api/v1/roles` | Create role. Body: `{name, color, description?, permissions: PermissionKey[]}`. 409 `role_name_taken` on duplicate name. Returns 201 with the new role object. Audit: `role.create`. | `role:create` |
| PUT | `/api/v1/roles/:id` | Update role (name, color, description, permissions). 400 `owner_role_immutable` for the system Owner role. 409 `role_name_taken` on duplicate name. Invalidates permission cache for all role carriers. Audit: `role.update`. | `role:edit` |
| DELETE | `/api/v1/roles/:id` | Delete role. Cascades `players.role_id` to NULL. 400 `owner_role_immutable` for Owner. Invalidates permission cache before deletion. Audit: `role.delete`. | `role:delete` |

### Users

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/users` | Players with a non-NULL `role_id`, joined to `roles`. Sorted `last_seen_at DESC`. Returns `{steam_id64, canonical_name, last_seen_at, role: {id, name, color, is_system_role}, assigned_at, assigned_by}`. `assigned_at`/`assigned_by` are NULL in this iteration. | `user:view` |

## Servers

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers` | List + per-server `rcon_state` / `player_count` / `last_poll_at` from Redis. | `server:view` |
| POST | `/api/v1/servers` | Create row in `pending`. Allocates ports, generates RCON password, encrypts and stores. | `server:create` |
| GET | `/api/v1/servers/:id` | Full detail: settings, RCON status, container inspect+stats, host info. | `server:view` |
| DELETE | `/api/v1/servers/:id` | **Soft-delete + backup orchestrator**. Phase 1 reads every allowed `.cfg` via `bridge.fileRead` and inserts one `config_versions` row per file with `message = 'deletion-backup-marker <iso>'`. If 0 files were read the route returns 500 `delete_failed` and leaves the server alive. Phase 2-4 are best-effort: `container_stop` (30 s) + `container_rm`, `directory_delete` on `configs/{uuid}` and `saved/{uuid}`, `ufw_rule remove` × 4 (game/query/beacon/rcon). Phase 5 sets `servers.deleted_at = now()`, `deleted_by_steam_id64 = <actor>`, `deletion_backup_marker_id = <first-row-id>`. Audit row written by the route (`server.delete`). On success emits a `server.deleted` LiveEvent. Response: `{ ok, backup_marker_id, files_backed_up, files_attempted, container_removed, configs_dir_removed, saved_dir_removed, ufw_rules_removed, errors[] }`. Repeating the call on an already-soft-deleted server returns 404. | `server:delete` |
| POST | `/api/v1/servers/:id/start` | If container exists → `container_start`; otherwise `container_run`. | `server:start` |
| POST | `/api/v1/servers/:id/stop` | Sets `servers.status='stopping'` and emits `server.status` LiveEvent **before** the RCON sequence so the UI updates instantly and a process crash mid-stop leaves a state the reconciler can resolve. Then worker-rcon queued `AdminBroadcast` when connected, direct RCON fallback only if the command was not accepted → 15 s wait → worker-rcon queued `AdminEndMatch` or direct fallback → `container_stop` (60 s grace). | `server:stop` |
| POST | `/api/v1/servers/:id/restart` | `container_stop` then `container_start`. | `server:restart` |
| POST | `/api/v1/servers/:id/reconcile` | Forces a single-server reconciliation: calls `container_inspect` once, maps the docker state, updates `servers.status` if it changed, and emits `server.status` LiveEvent. Returns `{ inspected_state, inspected_running, previous_status, new_status, changed }`. 502 `bridge_unavailable` when the bridge throws — the next call can recover. 404 for unknown/soft-deleted servers. Audit `server.reconcile`. Use this when ops sees a server stuck in `starting`/`stopping`/`installing` longer than expected. | `server:view` |
| GET | `/api/v1/servers/:id/events` | Recent envelopes from `events:server:{id}` (XREVRANGE, default 100). Used by the live-events UI. | `server:view` |
| GET | `/api/v1/servers/:id/seed-call` | Returns the manual “need seeders” availability, cooldown seconds, and a `steam://connect/<host>:<game-port>` join link. | panel access |
| POST | `/api/v1/servers/:id/seed-call` | Emits `seed.call_sent`, materializes AUTO-3 alerts for subscribed players, and fans out to DISCORD-2. Limited to once per server per two hours. Requires `chat` or `manageserver`. | session + `chat`/`manageserver` |
| GET | `/api/v1/seed-subscriptions` | Lists the current player’s per-server `email`/`webpush` seed subscriptions. | panel access |
| PUT | `/api/v1/servers/:id/seed-subscription` | Idempotently enables or disables one seed notification channel for the current player and server. | panel access |

## Server archive (soft-deleted servers)

Backed by [`apps/api/src/routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts). All `WHERE deleted_at IS NOT NULL` queries — the active-server routes above filter `deleted_at IS NULL` so a soft-deleted server returns 404 from those endpoints.

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers/archive` | List soft-deleted servers ordered `deleted_at DESC`. Returns `{ items: ArchiveServer[], total }`. | `server:view` |
| GET | `/api/v1/servers/archive/:id` | Archive detail: server meta + `serverSettings` snapshot + deduped list of backup `config_versions` rows (latest per filename, `WHERE message LIKE 'deletion-backup-marker%'`). Returns `{ server, settings, backups[] }`. 404 if not soft-deleted. | `server:view` |
| GET | `/api/v1/servers/archive/:id/configs/:filename` | Read content of the most recent backup version of one cfg file. Returns `{ id, filename, content, sha256_hex, created_at, message }`. 404 if no backup row exists. | `config:view` |
| POST | `/api/v1/servers/archive/:id/restore` | Create a NEW server row (UUIDv7) with metadata copied from the archive. Body: `{ slug: ^[a-z0-9-]+$ (1-64), display_name? }`. 409 `slug_in_use` when an active row already owns the slug (partial unique index `servers_slug_active_key`). 404 when the archive is missing. Audit `server.restore`. Emits `server.restored` LiveEvent. Returns 201 `{ id, archive_id, slug, display_name, status:'pending', next_steps[] }`. **Does NOT install or copy configs** — operator must continue with `POST /servers/:id/install`, then `POST /servers/:id/restore-configs`. | `server:install` |
| POST | `/api/v1/servers/:id/restore-configs` | Overlay backup configs from an archive onto a freshly-installed server. Body: `{ from_archive_id: uuid }`. Reads `config_versions` rows with `message LIKE 'deletion-backup-marker%'` for the archive, skips `Rcon.cfg` (preserves the new server's password), `bridge.fileAtomicWrite`s each onto `configs/{newId}/ServerConfig/`, then inserts one fresh `config_versions` row per restored file (`message = "restored from server <archiveId> backup <iso>"`). Audit `server.restore_configs`. 404 if either the new server or the archive is missing. Returns `{ ok, archive_server_id, files_restored, files_skipped[], files_missing[], config_version_ids[], errors[] }`. | `config:edit` |

Example: list archive

```bash
curl -sS -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/archive | jq .
```

Example: restore

```bash
curl -sS -X POST -H "Cookie: __Host-sid=$SID" -H 'content-type: application/json' \
  -d '{"slug":"alpha-restored","display_name":"Alpha (restored)"}' \
  https://panel.local/api/v1/servers/archive/<archiveId>/restore
# → 201 { id: <newId>, archive_id: <archiveId>, ... }
curl -sS -X POST -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/<newId>/install
# wait for /install to finish (status=ready)
curl -sS -X POST -H "Cookie: __Host-sid=$SID" -H 'content-type: application/json' \
  -d '{"from_archive_id":"<archiveId>"}' \
  https://panel.local/api/v1/servers/<newId>/restore-configs
curl -sS -X POST -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/<newId>/start
```

Errors:

| Code | Where | Meaning |
|---|---|---|
| 404 `not_found` | GET archive, GET detail, GET single config, POST restore, POST restore-configs | Archive id is not soft-deleted, or no matching cfg backup row, or new server not installed yet. |
| 404 `archive_not_found` | POST restore-configs | The `from_archive_id` body field does not point at a soft-deleted server. |
| 409 `slug_in_use` | POST restore | An ACTIVE server (deleted_at IS NULL) already owns this slug; the partial unique index blocks the insert. Pick a different slug. |

## Server install

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/servers/:id/install` | Kicks off the async install pipeline (depot → seedConfigs → ufw → container_run). Returns immediately with `{ status: 'installing', server_id }`. | `server:install` |
| GET | `/api/v1/servers/:id/install/progress` | Polling-friendly snapshot of the in-memory progress buffer (`app.installProgress`). | `server:view` |
| WS | `/api/v1/servers/:id/install/ws` | Live progress: replays the in-memory buffer, then streams `{ts, step, message}` lines until `done`/`error`. | `server:view` |

## Server configs

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers/:id/configs` | List 19 allowed cfg files with `{name, size, sha256, behavior, exists}`. `behavior` is `hot_reload` / `rotation` / `requires_restart`. | `server:view` |
| GET | `/api/v1/servers/:id/configs/:name` | Tip content + sha256 + behavior class. | `server:view` |
| PUT | `/api/v1/servers/:id/configs/:name` | Atomic write + INSERT into `config_versions`. No-op (sha unchanged) short-circuits without touching disk or DB. After write, the RCON reload fires **only for `hot_reload` files** (Admins/Bans/RemoteAdmin/RemoteBan): best-effort `AdminReloadServerConfig` through worker-rcon when connected, direct RCON fallback only if the command was not accepted. For `rotation` / `requires_restart` files no RCON is sent — the outcome is `reload: { applied:false, reason:'not_hot_reload' }`. Outcome surfaced as `reload: { applied, via?, reason? }` so UI can warn that a restart is still needed (e.g. `requires_restart` files). Container sees the new content the instant `rename(2)` completes — the cfg directory is bind-mounted, so no copy/sync. Body: `{ content, message? }`. Audit `config.write` (sha-only, content never persisted). See [flows.md → Config edit](flows.md#config-edit-put-apiv1serversidconfigsname). | `config:edit` |
| GET | `/api/v1/servers/:id/configs/:name/history` | Versions (newest first). Includes `author_email`, `author_ip`, `message`, `sha256`, `size`. Query: `limit` (≤500). | `config:view` |
| GET | `/api/v1/servers/:id/configs/:name/versions/:vid` | Full content of a single past version. | `config:view` |
| GET | `/api/v1/servers/:id/configs/:name/diff?from=:vid&to=:vid` | Unified-diff patch text between two versions. | `config:view` |
| GET | `/api/v1/servers/:id/configs/:name/blame` | Tip content with per-line attribution. Cached in Redis (`config-blame:{tip_id}`, TTL 24 h, key auto-invalidates because the tip id changes on the next write). | `config:view` |
| POST | `/api/v1/servers/:id/configs/:name/restore/:vid` | Creates a NEW version with the old content (never destructive). Body: `{ message? }`. | `config:rollback` |

## Server logs (per-server)

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| WS | `/api/v1/servers/:id/logs/ws` | Live `docker logs -f` via dedicated bridge connection. `?lines=<N≤5000>` for backfill (default 200). 20 s heartbeat frame so proxies don't kill idle sockets. | `server:view` |
| GET | `/api/v1/servers/:id/logs/files` | Lists on-disk `SquadGame*.log` files under `<saved>/<id>/SquadGame/Saved/Logs` via `bridge.squad_log_list`: `{ files: [{ name, size, mtime (RFC3339), is_live }] }`. `is_live` marks the active `SquadGame.log`. | `server:download_logs` |
| GET | `/api/v1/servers/:id/logs/files/:name/download` | Streams the chosen log (`Content-Disposition: attachment`) by piping `bridge.file_read_stream` chunk frames straight to the reply — a multi-hundred-MB file is never buffered whole. `:name` must match `SquadGame*.log` (else 400). | `server:download_logs` |

## Server scheduled tasks

AUTO-2 (#73) task definitions run out-of-band by `@squad/worker-scheduler`
(`runScheduledTaskTick`); this route only manages definitions and surfaces run
history. A task fires on a one-off `scheduled_at` instant or a recurring 5-field
UTC cron `recurrence`. Reads are gated on panel access; mutations are gated per
`task_type` (`restart` → `server:restart`; `set_next_layer`/`change_layer` →
Squad `changemap`; `broadcast` → Squad `chat` **and** `role:edit`, MSG-4 #187).

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers/:id/scheduled-tasks` | Lists tasks (newest first) plus per-type `capabilities` so the UI can hide actions the caller cannot schedule. | panel access |
| GET | `/api/v1/servers/:id/scheduled-tasks/history` | Execution runs (newest first). Query: `from`, `to`, `limit` (≤500). | panel access |
| POST | `/api/v1/servers/:id/scheduled-tasks` | Creates a task. Body: `{ name, task_type, params?, scheduled_at?, recurrence?, enabled?, server_ids? }`. `broadcast` `params` accepts `message` (single) OR `messages: string[1..10]` (rotation, each ≤300 chars) with optional `template_ids`; a 1-element `messages` normalises to `{message}`. `server_ids` (≤50) fans the task out to one row per unique target (path server always included) in a single transaction — the response is the path-server row plus additive `also_created: [{id, server_id}]`, with one audit row per created row; an unknown/soft-deleted target 404s and rolls back. A recurring `broadcast` firing more often than every 5 minutes is rejected `400 {error:'interval_too_short', min_interval_minutes:5}`. Audit `server.scheduled_task.create`. | per `task_type` |
| PATCH | `/api/v1/servers/:id/scheduled-tasks/:taskId` | Updates `name`/`params`/`scheduled_at`/`recurrence`/`enabled`. Setting `enabled:false` stops firing without deleting the rule. The 5-minute broadcast floor is re-checked. Audit `server.scheduled_task.update`. | per `task_type` |
| DELETE | `/api/v1/servers/:id/scheduled-tasks/:taskId` | Deletes the task (cascades its run history). Audit `server.scheduled_task.delete`. | per `task_type` |

## Direct player message

MSG-2 (#185). One addressed in-game message to a single panel player, delivered
as RCON `AdminWarn <target> <message>` through the worker-rcon command queue.
The addressee is resolved from the `players` row — EOS id first, SteamID64 as
fallback — so a row carrying neither is rejected rather than mis-addressed.

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/servers/:id/players/:playerId/message` | Sends one `AdminWarn` addressed to `:playerId` via the worker-rcon queue. Body: `{ message (2..300 after trim), log_to_card? (default false) }` — 300 is the worker's `BROADCAST_MAX_CHARS`, re-asserted when the command is built, so a longer body would be rejected at execution time. `log_to_card: true` also writes one `chat_messages` row keyed on the **addressee** (`player_id` = target, `scope: 'direct'`, `source: 'panel'`), which is what makes it appear in that player's card chat history via `GET /api/v1/chat/messages?playerId=…`; omitted, nothing is stored. Errors: 401 `unauthenticated`, 403 `{error:'forbidden', required_squad_permission:'chat'}`, 404 `player_not_found` (no such row) / `player_not_addressable` (row has neither eos id nor steam id), 400 from the body schema, 502 `{error:'message_failed', reason, detail}` when the worker is not connected (nothing is stored). Success: `{ ok: true, request_id, response }`. Audit `server.player_message` on target type `server`, with the addressee, resolved target, text and `log_to_card` in `after_snapshot`. | Squad `chat` |

## Live event bus (panel-wide)

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| WS | `/api/v1/ws/live` | Push channel for typed `LiveEvent` frames (`server.status`, `server.deleted`, `server.restored`, `rcon.status`, `bridge.connection`, `worker.heartbeat`). Server pings every 10 s; clients must reply `{"type":"pong"}` within 30 s or the socket is closed (code 4000). See [live-bus component](../live-bus/README.md) for wire formats and producer fan-out. | `server:view` |

## Players

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/players` | Up to 200 players (the cap is unchanged). `?sort=` accepts `nickname` (`canonical_name_normalized`), `last_seen` (`last_seen_at`, default), `created` (`first_seen_at`), `total_time` (`total_time_played_seconds`); `?dir=` accepts `asc` / `desc` (default `desc`); `players.id` ascending is the stable tiebreak. `?filter=new` restricts the result to `first_seen_at >= now() - interval '7 days'` (database clock) and composes with `?q=` rather than replacing it; an active-bans filter is tracked in #59. Example: `?sort=nickname&dir=asc`. An unrecognised `sort`, `dir`, or `filter` value is rejected with 400 by the Zod querystring schema (`?sort=bogus` → 400). Optional `?q=` filter (unchanged): `q` is normalized with `normalizePlayerName` (clan tags stripped) and matched as a substring against `canonical_name_normalized` and historic `player_name_history.name_normalized` (so a player is found by a past nickname without its clan tag), or exactly against `steam_id64::text` / `eos_id`. | `player:view` |
| GET | `/api/v1/players/:steamId` | Full detail with name history; IP history is gated by `player:view_ips` (returned as empty array + `ips_visible:false` otherwise). | `player:view` |
| GET | `/api/v1/players/:playerId/external-bans` | External-ban records grouped by source for the player card, including active/permanent status. | panel access |
| POST | `/api/v1/players/:playerId/external-bans/:externalBanId/local-ban` | Sends `AdminBan` to the selected server for an active external-ban match. Body: `{ server_id, reason, ban_length }`. Writes moderation history, audit, and `moderation.ban`; rejects mismatched/inactive records and unavailable RCON without writing the ledger. | panel access + Squad `ban` |
| GET | `/api/v1/players/:playerId/weapon-stats` | DOSSIER-2 per-weapon aggregates from `player_weapon_stats` (uuid key). Returns `{ weapons: [{ weapon, kills, teamkills, damage, shots_events, last_used_at }] }`, ordered by `kills DESC, shots_events DESC`. `damage` is `null` when the source carried no magnitude (UI renders "—"). | panel access |
| GET | `/api/v1/players/:playerId/vehicle-stats` | DOSSIER-2 per-vehicle aggregates. Returns `{ from_vehicle: [{ vehicle_asset_id, kills, damage }], destroyed: [{ victim_vehicle_asset_id, weapon, destroyed_count }] }` — kills/damage dealt _from_ a vehicle (ordered by `kills DESC`) and vehicles _destroyed_ per (vehicle, weapon) (ordered by `destroyed_count DESC`). `damage` may be `null`. | panel access |
| GET | `/api/v1/players/:playerId/combat-summary` | DOSSIER-4 combat summary + monthly K/D trend. Query: `?from=&to=` (`YYYY-MM-DD`) and `serverId=<uuid\|all>` (default `all`). Returns `{ skill, kd_trend, period }`: `skill` aggregates `match_players ⋈ matches` (kills/deaths/kd/teamkills/revives, `damage_dealt` always `null`, matches, wins/losses/draws, `winrate = wins/(wins+losses)` — `null` when no decided matches); `kd_trend` lists materialised `player_stat_periods` month rows (`[{ month, kills, deaths, kd, matches }]`), months without matches are absent (UI draws zeros). 404 `player_not_found` for an unknown id; cached 60 s (`x-cache: hit\|miss`). | panel access |
| GET | `/api/v1/players/:playerId/dossier` | DOSSIER-5 consolidated dossier: one payload with `skill` + `kd_trend` (same sources and rules as `/combat-summary`; `kd_trend` entries are `[{ month, kills, deaths }]`), `weapons` (top `weaponsLimit`, default 20, max 100) + `weapons_total`, `vehicles` + `vehicle_kills` (LEFT-JOIN-enriched from `vehicle_catalog` with `name_en`/`name_ru`/`vehicle_class`; uncatalogued asset ids get `unlocalized: true` + null names), and `kits` from `player_kit_time`. Query: `?from=&to=`, `serverId=<uuid\|all>` (default `all`), `weaponsLimit=`. Caveat: `serverId=<uuid>` filters only `kits` and `skill`/`kd_trend` — the weapon/vehicle aggregate tables carry no server dimension and always report lifetime totals (`period: "all"`). `damage`/`damage_dealt` serialize as `null`, never 0; a player without history → 200 with zeros/empty arrays. 404 `player_not_found` for an unknown id; cached 60 s (`x-cache: hit\|miss`). | `combat:view` |
| GET | `/api/v1/players/:steamId/role` | Returns current role or `{role: null}`. Single-role model — each player has at most one panel role. | `user:view` |
| PUT | `/api/v1/players/:steamId/role` | Assign or clear a role. Body: `{role_id: uuid \| null}`. 404 `role_not_found` if the role UUID doesn't exist. 409 `cannot_remove_last_owner` when the change would leave zero Owners. Invalidates the player's permission cache. Audit: `player.role.assign`. | `user:manage_roles` |

## Whitelist applications

WL-3 (#67) public application portal + panel approval. The public half is
unauthenticated and rate limited; anyone can read whether the portal is open and
submit one **pending** application per SteamID64 (a partial-unique index enforces
the single-pending rule). Approving grants the resolved role to the matching
`players` row, time-bounded via `players.role_expires_at` — the existing
`worker-role-expirer` (VIPSUB-1) clears it automatically when the term lapses,
and the grant fans out to every active server's `Admins.cfg` via the durable
outbox. WL-3 adds no new expiry mechanic.

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/public/whitelist/settings` | Portal open/closed flag `{ enabled }`. Rate limit 60/min. | none (public) |
| POST | `/api/v1/public/whitelist/applications` | Submit an application. Body: `{ steam_id64 (17 digits), body (1..2000), contact? (≤128) }`. `404 applications_disabled` when closed; `409 application_already_pending` on a duplicate pending SteamID64; else `201 {id, status:'pending'}`. Best-effort player resolution; audit `whitelist.application.create` (anonymous `actor_kind='system'`, label `http-anonymous`). Rate limit 5/hour. | none (public) |
| GET | `/api/v1/whitelist/applications?status=&page=&page_size=` | Paginated review queue (newest first), joined to player/role/reviewer names. | `whitelist:view` |
| GET | `/api/v1/whitelist/applications/settings` | Panel view of `{ enabled, default_days }`. | `whitelist:view` |
| PUT | `/api/v1/whitelist/applications/settings` | Set `{ enabled, default_days (1..3650 \| null) }` (null = permanent grants). Audit `whitelist.application.settings.update`. | `whitelist:edit` |
| PATCH | `/api/v1/whitelist/applications/:id` | Approve or reject. Body: `{ status:'approved'\|'rejected', review_note?, role_id?, expires_at? }`. Approve resolves the role as `role_id ?? requested_role_id ?? whitelist_role_id`, computes the term as `expires_at ?? now+default_days` (null = permanent), grants + fans out in one transaction, and invalidates the permission cache. Errors: `404 application_not_found`/`player_not_found`/`role_not_found`, `409 application_not_pending`/`whitelist_role_not_configured`, `400 role_expiry_must_be_future`, `403 self_approval_forbidden`. Both branches audit `whitelist.application.review`. | `whitelist:edit` |

## Audit

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/audit?page=&page_size=` | Page-paginated list (default 50, max 200). `id` is stringified bigserial. | `audit:view` |

## Host

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/host/info` | `bridge.host_info` snapshot. | `host:view` |
| GET | `/api/v1/host/metrics` | `bridge.host_metrics` (live sample). | `host:metrics` |
| GET | `/api/v1/host/metrics/history?seconds=<≤86400>` | 24 h history from the `host:metrics` Redis Stream populated by [`worker-metrics-sampler`](../workers/README.md#worker-metrics-sampler). Returns `{ts: number[], v: number[][]}` packed for the [`MetricHistoryChart`](../web/README.md#components). | `host:metrics` |
| GET | `/api/v1/host/disk-usage` | `bridge.panel_disk_usage` snapshot (cached 5 min by the bridge) plus two derived percentages: `panel_pct = total_panel_bytes / host_total_bytes * 100` and `other_pct = max(0, host_used_bytes / host_total_bytes * 100 - panel_pct)`. Both clamp to `0` when `host_total_bytes <= 0`. Response shape is `PanelDiskUsage` (see [`bridge-client/api.md`](../bridge-client/api.md#paneldiskusage-promisepaneldiskusage)) with `panel_pct` and `other_pct` appended. Optional `?refresh=1` (Zod-coerced boolean) forwards `{ force: true }` to `bridge.panelDiskUsage`, which skips the 5-min cache and re-runs the `du -sb` / `docker system df` / `statvfs` probes. The bridge still writes the fresh value back into its cache, so subsequent non-force calls benefit immediately. No API-side cache; no audit. | `host:view` |
| GET | `/api/v1/host/bridge-status` | Bridge ping with round-trip latency. Always 200 (no permissions); response carries `connected: true|false`. | none |
| POST | `/api/v1/host/restart` | `bridge.host_agent_restart`. Treats post-call EPIPE/ECONNRESET as success because the socket dies during restart. | `host:bridge_control` |

## Depot

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/depot` | Volume populated? + `build_id` parsed from `appmanifest_403240.acf` + `last_update` JSON from Redis. | `server:view` |
| POST | `/api/v1/depot/update` | Kicks off `bridge.depot_update` in the background. Sets `depot:updating` lock; concurrent calls return `{status:'already_in_progress'}`. Streams output to `depot:progress` Redis Stream. | `server:install` |
| WS | `/api/v1/depot/progress/ws` | Replays last 500 entries from `depot:progress` then tails. Multiple tabs can subscribe to the same update. | `server:view` |

## Connector logs (panel-wide)

Aggregated logs from every panel component (api, workers, bridge events, depot/install steps) are streamed to the `panel:logs` Redis Stream via [`packages/shared-config/src/log-stream-sink.ts`](../../../packages/shared-config/src/log-stream-sink.ts) as a pino multistream sink. Encoding/decoding helpers live in [`log-stream.ts`](../../../packages/shared-config/src/log-stream.ts).

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/logs?src=&lvl=&srv=&q=&before=&after=&limit=` | Cursor-paginated read from `panel:logs`. Filters: `src` is comma-separated source codes (`B/R/L/W/D/I/A` for bridge/rcon/log-ingest/worker/depot/install/api), `lvl` minimum level (`debug|info|warn|error`), `srv` server uuid, `q` substring of `msg`, `before`/`after` Redis stream IDs (`<ms>-<seq>`), `limit` (≤2000, default 500). | `host:view` |
| GET | `/api/v1/logs/export` | Streamed `Content-Encoding: gzip` `text/plain` bundle for off-host triage. Sections in order: `BRIDGE`, `RCON server "<name>" (<uuid>)` × N, `LOG-INGEST server "<name>" (<uuid>)` × N, `WORKERS`, `DEPOT / INSTALL`, `API`, `HOST METRICS 24h (CSV)` (`ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15`), `AUDIT (last 24h)` (capped at 50 000 rows; truncation marker emitted if hit), `SQUAD GAME LOGS server "<name>" (<uuid>)` × N (one-shot tail of `bridge.container_logs_follow squad-<uuid>` raced against a 1500 ms deadline). Filename `panel-logs-<iso>.txt.gz`. | `host:metrics` |

## Health and metrics (no auth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness — DB + Redis ping. |
| GET | `/ready` | Readiness — also requires bridge ping success. |
| GET | `/metrics` | Prometheus metrics from `prom-client`. |
| GET | `/api/v1/health/workers` | Per-worker `worker:heartbeat:{name}` aggregate (alive / age_ms / details). |
| GET | `/api/v1/health/reconciler` | Status-reconciler diagnostics — `last_tick_at`, `last_tick_duration_ms`, `last_tick_servers_inspected`, `consecutive_tick_errors`, `stuck_servers[]` (rows in `starting`/`stopping`/`installing` with `updated_at` older than 90 s — `{id, status, updated_at, age_ms}`), `bridge_failures_by_server` (per-id consecutive `container_inspect` failures), and a derived `healthy` boolean (true ⇔ last tick within 12 s, no consecutive errors, no stuck rows). Unauthenticated, no permission gate — same threat model as `/health`. |

## Decorations

Plugins decorate the Fastify instance and `FastifyRequest` so route handlers can reach shared infra without imports. The full type augmentation lives in [`apps/api/src/plugins/types.ts`](../../../apps/api/src/plugins/types.ts) and [`apps/api/src/lib/diag.ts`](../../../apps/api/src/lib/diag.ts).

| Decoration | Type | Source | Purpose |
|---|---|---|---|
| `app.db` | `DatabaseClient` | [`plugins/database.ts`](../../../apps/api/src/plugins/database.ts) | Drizzle client. |
| `app.redis` | `Redis` (ioredis) | [`plugins/redis.ts`](../../../apps/api/src/plugins/redis.ts) | Singleton ioredis. |
| `app.bridge` / `app.makeBridgeClient()` | `BridgeClient` / `() => BridgeClient` | [`plugins/bridge.ts`](../../../apps/api/src/plugins/bridge.ts) | Shared host-bridge RPC client and per-WebSocket factory. |
| `app.diag` | `Diag` (`{ emit(ev): Promise<void> }`) | [`lib/diag.ts`](../../../apps/api/src/lib/diag.ts) | Module-side diagnostic emitter. Pushes to Redis Stream `diag:queue`. See [`@squad/diag` API](../diag/api.md). |
| `request.diag` | `Diag` | [`lib/diag.ts`](../../../apps/api/src/lib/diag.ts) | Per-request wrapper that auto-injects `requestId = req.id` into every emitted event unless the caller already set `requestId`. Set by an `onRequest` hook. |
| `request.requestId` | `string` | [`plugins/request-context.ts`](../../../apps/api/src/plugins/request-context.ts) | UUIDv7 (or `x-request-id` header passthrough), echoed back as `x-request-id` response header. |
| `request.user` / `request.session` / `request.apiTokenId` | see [`plugins/types.ts`](../../../apps/api/src/plugins/types.ts) | [`plugins/auth.ts`](../../../apps/api/src/plugins/auth.ts) | Authenticated identity (cookie session or API token). |
| `app.encryptionKey` | `Buffer` (32 B) | server bootstrap | Symmetric key for `crypto.ts`. |
| `app.config` | `AppConfig` | server bootstrap | Validated env. |
| `app.statusReconciler` | reconciler stats handle | [`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts) | Polls `container_inspect` every 4 s. |

The diag decoration is registered in [`server.ts`](../../../apps/api/src/server.ts) immediately after `redisPlugin` so it sees a live ioredis connection. Inside route handlers prefer `req.diag.emit(...)` so the request id is threaded automatically; module-level code (plugins, workers reused inside the API) may call `app.diag.emit(...)` directly with an explicit `requestId` or none.

Example handler usage:

```ts
app.post('/some-route', { config: { permissions: ['server:start'], audit: { action: 'server.start', resource: 'server' } } }, async (req, reply) => {
  await req.diag.emit({ component: 'api', kind: 'server.start.requested', severity: 'info', serverId, message: 'start requested' });
  // ...
});
```

### Lifecycle event kinds emitted by API routes

Server-lifecycle routes emit a fixed set of `server.*` diag events into the `diag:queue` Redis Stream. Each event carries `component='api'`, the affected `serverId`, the requesting `actorSteamId64` (if authenticated), and a `requestId` threaded from `req.id`. Source files are listed for traceability — they are the source of truth for ordering and payload shape.

| Route | Source | Kinds emitted (in order on the success path) |
|---|---|---|
| `POST /servers/:id/install` | [`routes/server-install.ts`](../../../apps/api/src/routes/server-install.ts) | `server.install.requested` → `server.install.depot_seed` → `server.install.ufw_rule` (×4, one per port) → `server.install.container_run` → `server.install.verify` → `server.install.done`. Failures emit `server.install.failed` with `payload.stage` + `payload.errorMessage`; ufw step emits `severity: 'error'` per failed rule. |
| `POST /servers/:id/start` | [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts) | `server.start.requested` → `server.start.done` (`payload.container_id`, `durationMs`). On failure emits `server.start.failed`. |
| `POST /servers/:id/stop` | [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts) | Sets Redis key `stop:requested:{server_id}` (TTL 300 s) at request time so the reconciler can distinguish requested-vs-unexpected exits. Then: `server.stop.requested` → `server.stop.broadcast` (worker-rcon/direct RCON `AdminBroadcast`) → `server.stop.end_match` (worker-rcon/direct RCON `AdminEndMatch`) → `server.stop.container_stop` (bridge `containerStop`) → `server.stop.done`. RCON sub-steps emit `severity: 'error'` with `payload.ok=false`, `payload.via`, and optional `payload.requestId` if the RCON command fails (the stop continues). The reconciler — not this route — emits `server.stop.reconciler_confirmed` once Docker reports `Status=exited`. |
| `DELETE /servers/:id` (soft-delete) | [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts) | `server.soft_delete.requested` → `server.soft_delete.done` (`payload.backup_id`, `files_backed_up`, `durationMs`). On failure emits `server.soft_delete.failed`. |
| `POST /servers/archive/:id/restore` | [`routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts) | `server.restore.requested` (carries old archive id as `serverId`) → `server.restore.done` (carries new server id as `serverId`, `payload.archive_id` + `new_server_id`). |

`payload.durationMs` is wall-clock duration of the immediate phase; `totalDurationMs` (on `done`/`failed`) is the duration of the entire route handler.

### Lifecycle event kinds emitted by the status reconciler

The reconciler ([`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts)) emits its own diag events on every observed `running → stopped` transition. Each event carries `component='reconciler'` and the affected `serverId`. The reconciler does **not** thread an `actorSteamId64` because it runs out-of-band of any HTTP request.

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `container.exited` | Reconciler observed Docker `Status=exited` AND the Redis fence `stop:requested:{server_id}` was present (planned stop). | `info` if `exit_code === 0`, else `error`. | `{ exit_code, oom_killed, signal, finished_at, started_at }`. `signal` is the Docker `State.Error` string (e.g. `"signal: killed"`) or `null`. `oom_killed` defaults to `false` when the bridge omits the field. |
| `container.unexpected_exit` | Reconciler observed Docker `Status=exited` AND no fence (process crash, OOM kill, manual `docker stop` outside the panel). | `info` if `exit_code === 0`, else `error`. | Same shape as `container.exited`. |
| `server.stop.reconciler_confirmed` | Cap-off emitted right after `container.exited` when the fence was found — proves the panel-initiated stop completed end-to-end. | `info` | `{ exit_code }` |

The reconciler does **not** consume the fence on observation; it leaves it to expire naturally at TTL 300 s. The next `POST /servers/:id/stop` resets the TTL, so a stop→start→stop cycle within 5 min still produces correct `container.exited` (vs `container.unexpected_exit`) classification.

### Bridge listener event kinds

The bridge plugin ([`apps/api/src/plugins/bridge.ts`](../../../apps/api/src/plugins/bridge.ts)) attaches four listeners to the singleton `BridgeClient` and translates each `BridgeClient` event into a diag emit. All four events carry `component='api'`, no `serverId` (the bridge connection is process-global, not per-server), and no `actorSteamId64`. Listener-side `app.diag.emit` rejections are swallowed via `.catch(() => undefined)` so a Redis hiccup never propagates back into the bridge layer. The underlying `BridgeClient` event surface is documented in [`docs/components/bridge-client/api.md`](../bridge-client/api.md#events).

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `bridge.client.connected` | First successful `ping()` response on a freshly-opened socket. Fires at most once per socket lifetime. | `info` | `{ rttMs, version, hostname }` |
| `bridge.client.disconnected` | Underlying socket closed/errored, or `BridgeClient.close()` called on a previously-connected client. Fires only if a `bridge.client.connected` was previously emitted for that socket. | `error` | `{ reason }` where `reason ∈ { 'socket-error', 'socket-closed', 'frame-decode-error', 'client-closed' }` |
| `bridge.rpc.error` | Any RPC response with `ok: false` (path/image allowlist violation, runtime error, etc.). | `warn` | `{ method, code, message }` mirrors the `BridgeError` thrown to the caller. |
| `bridge.rtt.outlier` | Successful RPC where `rttMs > 50`. The threshold is fixed in `apps/api/src/plugins/bridge.ts` (`RTT_OUTLIER_THRESHOLD_MS`). | `warn` | `{ rttMs, thresholdMs }` |

### Connector listener event kinds

The redis plugin ([`apps/api/src/plugins/redis.ts`](../../../apps/api/src/plugins/redis.ts)) attaches three listeners to the singleton `ioredis` client and translates each into a diag emit. The db-health plugin ([`apps/api/src/plugins/db-health.ts`](../../../apps/api/src/plugins/db-health.ts)) runs a 30 s `SELECT 1` loop and emits on transitions. All five kinds carry `component='api'`, no `serverId`, no `actorSteamId64`. Listener-side `app.diag?.emit(...)` rejections are swallowed via `.catch(() => undefined)` (redis listeners) and never thrown out of the tick (db-health) so a Redis hiccup never propagates back into the connector layer. The redis plugin is registered BEFORE the diag plugin, so it uses optional chaining (`app.diag?.emit`) — the diag handle binds at emit time, not at listener registration.

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `redis.ping.fail` | ioredis `error` event fires (connection refused, READONLY, socket reset, etc.). Fires on every error, no de-duplication. | `error` | `{ err }` — the error message string. |
| `redis.reconnect.attempt` | ioredis `reconnecting` event fires (the retry-strategy is about to re-dial). | `warn` | `{ delayMs }` — the backoff delay in milliseconds the retry-strategy chose. |
| `redis.reconnect.success` | ioredis `ready` event fires AFTER a prior `error`. The first `ready` of clean startup is silent. The internal `redisDown` flag is reset to `false` on each successful re-arm. | `info` | `{}` |
| `pg.ping.fail` | The 30 s `SELECT 1` health-check throws (postgres-js wraps connection refused / timeout / query error). Fires on every failed tick. | `error` | `{ err }` — the error message string. |
| `pg.ping.ok` | First successful `SELECT 1` AFTER a prior `pg.ping.fail`. Subsequent OK ticks are silent until the next failure. Clean startup is silent. | `info` | `{}` |

### Worker heartbeat-watch event kinds

The heartbeat-watch plugin ([`apps/api/src/plugins/heartbeat-watch.ts`](../../../apps/api/src/plugins/heartbeat-watch.ts)) polls `worker:heartbeat:<name>` keys every 30 s for the six known workers (`rcon`, `log-ingest`, `audit-archiver`, `event-partition`, `diag-flush`, `metrics-sampler`). The tick uses an `inFlight` guard (mirroring `pgHealthTick`) so a slow Redis tick never overlaps a previous one. Both kinds carry `component='api'`, no `serverId`, no `actorSteamId64`. Listener-side `app.diag.emit(...)` rejections are caught and logged at `warn` (`heartbeat-watch tick failed`) so a Redis hiccup never propagates out of the interval.

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `worker.heartbeat_lost` | A worker's heartbeat key has been absent for more than 30 s AND the plugin has not yet reported the outage. Emitted exactly once per outage — the worker name is held in an internal `reported: Set<string>` until the key reappears. | `error` | `{ worker: string }` |
| `worker.heartbeat_recovered` | A worker's heartbeat key reappears (via `pttl >= 0`) AFTER the plugin previously reported a `worker.heartbeat_lost` for it. Subsequent ticks while the key is healthy are silent until the next outage. | `info` | `{ worker: string }` |

### WebSocket lifecycle event kinds

Each WebSocket route ([`apps/api/src/routes/live.ts`](../../../apps/api/src/routes/live.ts), [`apps/api/src/routes/server-logs.ts`](../../../apps/api/src/routes/server-logs.ts), [`apps/api/src/routes/server-install.ts`](../../../apps/api/src/routes/server-install.ts)) emits diag events on connection lifecycle so the bundle's per-server brief can correlate disconnect storms with backend errors. All three kinds carry `component='api'`. The two per-server routes (`/api/v1/servers/:id/logs/ws`, `/api/v1/servers/:id/install/ws`) populate `serverId` from the URL params; `/api/v1/ws/live` is global so `serverId` stays unset. Each `app.diag.emit(...)` is wrapped with `.catch(() => undefined)` so a Redis hiccup never propagates back into the WebSocket handler. The `reason` buffer on `ws.disconnected` is sliced to 200 chars to keep `diag:queue` payloads small.

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `ws.connected` | A client has completed the WebSocket upgrade handshake. Emitted before any application-level frame is sent. For the per-server routes, an invalid `:id` URL param produces NO emit at all — neither `ws.connected` nor `ws.disconnected` — so the connect/disconnect pairing invariant holds for every emitted lifecycle. | `info` | `{ url, [serverId] }` |
| `ws.disconnected` | The underlying socket fired `close`. Always paired with a prior `ws.connected` for the same connection. | `info` | `{ code, reason, url, [serverId] }` — `code` is the WebSocket close code (1000 normal, 1006 abnormal, 4000 panel pong-timeout, etc.); `reason` is `Buffer.toString().slice(0, 200)` (empty string when the client did not provide one). |
| `ws.error` | The underlying socket fired `error` (transport fault, malformed frame, etc.). Does NOT replace `ws.disconnected` — both fire when the error also drops the socket. | `warn` | `{ errorMessage, url, [serverId] }` |

### HTTP error layer event kinds

The `error-diag` plugin ([`apps/api/src/plugins/error-diag.ts`](../../../apps/api/src/plugins/error-diag.ts)) registers a Fastify `setErrorHandler` and a `process.on('unhandledRejection', ...)` listener so any thrown 5xx and any orphaned promise rejection becomes a diag event. Both kinds carry `component='api'`. The 5xx emit threads `requestId = req.id` and `actorSteamId64 = req.user?.steamId64?.toString()` when an authenticated identity is attached to the request; the unhandled-rejection emit cannot bind to a request and leaves both unset. Each `app.diag?.emit(...)` is wrapped with `.catch(() => undefined)` so a Redis hiccup never propagates back into the error path. The error handler preserves Fastify's default reply behaviour by calling `reply.send(err)` after the diag emit — the JSON envelope (`{ statusCode, error, message }`) shape is unchanged. The `unhandledRejection` listener is registered exactly once per process via a module-level `unhandledRejectionListenerAttached` guard so a second `errorDiagPlugin` registration (e.g. inside the integration harness) does not duplicate the global handler.

| Kind | When | `severity` | Payload |
|---|---|---|---|
| `http.5xx` | A route handler threw, OR `reply.send(err)` was called with `statusCode >= 500`. Status is computed as `reply.statusCode || err.statusCode || 500`. 4xx errors (400/401/403/404/422) are **not** emitted — only true server-side faults. | `error` | `{ method, url, status, err, stack }` — `method` is the HTTP verb, `url` is `req.url` including the query string, `status` is the resolved status code, `err` is `err.message`, `stack` is `err.stack?.slice(0, 2000)`. The 2000-char truncation prevents oversized `diag:queue` payloads from very deep stacks. |
| `http.unhandled_rejection` | Node's `process.on('unhandledRejection')` fires (a promise rejected without a `.catch()` and without an `await` upstream that would have surfaced it). Survives even if no Fastify request was in flight. | `fatal` | `{ reason }` — `String(reason).slice(0, 2000)`. The `message` field is `String(reason).slice(0, 200)` so the bundle's per-event header line stays compact. |

## Adding a route

1. Register in the relevant file under [`apps/api/src/routes/`](../../../apps/api/src/routes/).
2. Set `config.permissions: ['some:key']` (use [`packages/shared-config/src/permissions.ts`](../../../packages/shared-config/src/permissions.ts) or extend it).
3. If it mutates state (`POST`/`PUT`/`PATCH`/`DELETE`), set `config.audit: { action, resource }`. The CI gate fails the build otherwise.
4. Update this file's table.
