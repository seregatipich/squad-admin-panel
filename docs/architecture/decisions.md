# Architectural decisions

Meaningful architectural choices, recorded as we make them.

## 2026-04-26 — Server lifecycle: soft-delete with mandatory backup, restore via re-install + overlay, panel-wide live-bus

### Context

`DELETE /api/v1/servers/:id` previously did the bare minimum: `containerRm` (errors silently swallowed) + `db.delete(servers)`. Host directories under `/var/lib/squad-panel/{configs,saved}/{uuid}` were left behind. There was no audit trail beyond the route's `audit: { action }` entry, no way to recover a deleted server's tuned `.cfg`, and no way for the UI to know — without polling — that a status had changed or that the bridge had died.

The user requirement was that the panel own the destructive lifecycle end-to-end (delete files, but always back up `.cfg` first), expose the backup history click-through in the UI, and surface connectivity state without perceptible delay.

### Decision

1. **Soft-delete, not hard-delete.** Add `servers.deleted_at`, `servers.deleted_by_steam_id64`, `servers.deletion_backup_marker_id`. Replace the global unique slug index with a partial unique on `slug WHERE deleted_at IS NULL` so deleted slugs can be reused. All active-server queries get `WHERE deleted_at IS NULL`.

2. **Backup is mandatory and uses the existing `config_versions` table.** The orchestrator (`apps/api/src/lib/server-delete.ts`) reads each `.cfg` via the bridge, then inserts a row per file tagged `message LIKE 'deletion-backup-marker%'`. If zero files could be backed up, the deletion aborts and the server stays alive. `Rcon.cfg` is backed up with its real password (it has to be — otherwise restore can't reproduce a working RCON setup).

3. **Best-effort destructive phases after the backup.** Container stop+rm, `directory_delete configs`, `directory_delete saved`, ufw rule cleanup. Each phase records its own success/error in the response body and audit context. The DB soft-delete commits regardless — operators see exactly what succeeded and can finish the cleanup manually.

4. **New bridge RPC `directory_delete`** (Bundle A). Hard-allowlisted to exactly `${PANEL_CONFIGS_ROOT}/{uuid}` or `${PANEL_SAVED_ROOT}/{uuid}` (no trailing path components, no traversal, uuid regex). Idempotent — missing dir returns `{removed:false}`.

5. **Restore = re-install + overlay, not container-resurrection.** `POST /api/v1/servers/archive/:id/restore` mints a new server (UUIDv7, copies `serverSettings` from the archive, generates a fresh RCON password). Caller drives the standard install flow. Then `POST /api/v1/servers/:newId/restore-configs { from_archive_id }` reads the latest `deletion-backup-marker` rows and overlays them via `bridge.fileAtomicWrite`, skipping `Rcon.cfg`. Each overlaid file lands as a new `config_versions` row with `message = 'restored from server <id>...'`, so blame and history stay consistent.

6. **Live-bus replaces polling for status.** New plugin `apps/api/src/plugins/live-bus.ts` + route `GET /api/v1/ws/live`. Typed events: `server.status`, `server.deleted`, `server.restored`, `rcon.status`, `bridge.connection`, `worker.heartbeat`. Producers: status-reconciler emits on edge transitions, bridge-heartbeat on up/down flips, worker-rcon `PUBLISH`es on a separate Redis channel that the API re-emits. Web client uses `useSyncExternalStore` for instant card updates and renders a sticky `ConnectionBanner` when WS or bridge drop.

### Rationale

- **Why `config_versions` for backup storage and not a separate table?** The version-history table already has the right shape (server_id, filename, content, sha256, author, timestamp, message), CASCADE FK to servers, and an append-only DB trigger. A new table would have meant duplicating semantics and introducing a second blame source. The `message LIKE` filter is fast enough (we have an index on `(server_id, filename, created_at)` already).

- **Why soft-delete with cascade-friendly history?** Soft-delete keeps `config_versions` rows reachable for restore without inventing a new "orphaned configs" lifecycle. The partial unique slug index sidesteps the obvious downside (slug exhaustion) without weakening the active-server invariant.

- **Why best-effort instead of transactional rollback?** The destructive phases touch disk + Docker + ufw — none of those participate in our DB transaction. Trying to roll back partial state after a phase-3 failure (configs gone, saved still present) is harder and more error-prone than recording exactly what succeeded and leaving the operator a trail. Phase 1 (backup) is the only "all or nothing" gate.

- **Why a single live-bus WS instead of per-feature SSE / polling?** One WS per session is cheaper, lets us multiplex any future event type without API churn, survives proxy timeouts via the 10 s ping-pong, and gives the web client one place to detect "connection lost" instead of one detector per polling loop. The Redis fan-out lets us scale to multiple API replicas without invasive coordination.

- **Why DB-authoritative liveness for `bridge.connection` instead of relying on the bridge to emit?** The bridge has no event channel — it answers RPCs and that's it. The API's existing 5 s `bridge-heartbeat` ping is the natural source: it already knows up vs down and only emits on edge transitions, which is exactly what the UI needs.

### Consequences

- DELETE now returns a richer shape (`{ok, backup_marker_id, files_backed_up, container_removed, configs_dir_removed, saved_dir_removed, ufw_rules_removed, errors[]}`) — old clients that ignored extras keep working; new clients can surface partial-failure detail.
- `servers_slug_key` is gone. Anything that joined on it (none in our code) would break — but the new `servers_slug_active_key` covers the active-server uniqueness invariant.
- `config_versions` storage grows by the size of one full backup per deletion. Acceptable for P0; long-term retention/cleanup is a separate epic.
- Reverse-proxy WS upgrade must be allowed (Caddy default config in this repo already does).
- Workers that emit on Redis (currently rcon) now have a second consumer (the live-bus subscriber) — heartbeat or DLQ behavior unchanged.

### Alternatives considered

- **Hard-delete with separate `deleted_servers_archive` table** — would have required keeping configs in a parallel store, invented a new blame-and-restore flow that diverges from the live one, and made restore-configs a fresh feature to maintain. Rejected.
- **JSON-bundle backup on the host filesystem (`/var/lib/squad-panel/backups/...`)** — would have required adding another allowlisted path to the bridge, a worker to clean it up, and a separate file-fetch endpoint for the UI. The DB-resident backup gets free SQL access, ships with `pg_dump`, and reuses the version-history UI. Rejected.
- **Per-event WebSocket endpoints (`/ws/server-status`, `/ws/rcon`, `/ws/bridge`)** — simpler routing, but multiplies connection overhead, breaks bridge-detection-on-disconnect into N independent paths, and forces every new event type to be a new endpoint. Rejected in favor of the single `/ws/live` channel.
- **Server-Sent Events (SSE) instead of WS** — one-way is fine for these events, but loses the client → server pong needed to detect dead-but-not-closed connections behind aggressive proxies. WS pings are the proven pattern. Rejected.

## 2026-04-25 — Panel RBAC: single role per user, registry-objects, drop multi-tenancy

### Context

The panel had an RBAC schema that was never fully enforced: `player_role_assignments` was a M:N table, `role_server_scopes` existed but was never read, `organizations` and `organization_members` were scaffolded but multi-tenancy was never built, and `clearance_level` on roles was an integer column with no enforcement logic. The permission model was a flat string array with no metadata (no category, no danger flag, no unimplemented marker). The setup wizard (`/setup`) relied on `organizations.settings` for the first-Owner claim, adding a fragile boot dependency. Pre-launch was the correct time to pay this debt before real data was in the system.

### Decision

1. **Single role per player** — replace `player_role_assignments` M:N with `players.role_id uuid NULL`. `NULL` is the sole gate for "no panel access".
2. **Registry-objects** — `PERMISSIONS: readonly PermissionDef[]` in `packages/shared-config/src/permissions.ts`. Each entry carries `{key, category, label, dangerous?, unimplemented?}`. Adding a permission is a one-line append, no migration, no UI change required.
3. **Drop multi-tenancy** — `organizations`, `organization_members`, `role_server_scopes`, `audit_log.org_id` all removed in migration `0009_panel_rbac.sql`.
4. **Drop clearance levels** — `roles.clearance_level` column and all `hasServerPermission` / clearance-max logic removed.
5. **Five seeded roles in SQL** — Owner (system, `is_system_role = true`), Senior Admin, Admin, Moderator, Viewer — with full permission sets INSERTed in `0009`. No application-layer seeder.
6. **First-login Owner trick** — `claimFirstOwner()` in `apps/api/src/lib/first-owner.ts` uses `panel_meta.first_owner_claimed` and a Postgres advisory lock to assign the Owner role to the first Steam login on a fresh panel. Replaces the setup wizard.
7. **16-color palette** — `roles.color` constrained by a DB CHECK to 16 Tailwind slug names mirrored in `ROLE_COLORS`. Unit test asserts TS constant ↔ SQL constraint sync.
8. **Point-invalidated in-memory cache** — `loadUserPermissions` caches in Redis at `rbac:perms:{steam_id64}` with TTL 30 s. `invalidatePermissionCache` and `invalidatePermissionCacheForRole` clear entries immediately on role mutations; TTL is a safety-net only.

### Rationale

- **Single role over M:N**: The spec was written from the invariant "one role per user". A M:N table simulating 1:1 is tech debt from day one; pre-launch is the cheapest time to remove it.
- **Registry-objects over flat strings**: One source of truth; types are inferred; no migration needed for new keys; the role editor UI can display categories, danger warnings, and "в разработке" without any server-side logic.
- **Drop multi-tenancy**: Never used, never enforced, never planned for the foreseeable future. Removing it eliminates ~4 tables, one audit column, and a whole class of join complexity from every RBAC query.
- **SQL seeder over application seeder**: Idempotent by construction (migration runs exactly once). No boot-time race conditions. Roles are guaranteed present before the API starts.
- **Advisory lock for first-Owner**: Handles the race condition where two simultaneous first logins both see `first_owner_claimed = false`. The lock is advisory (no deadlock risk) and scoped to the transaction.
- **In-process cache + point-invalidation**: Multi-instance API is not a current requirement. Single process cache keeps permission checks sub-millisecond; explicit invalidation on every mutation means the TTL is never visible to the user.

### Consequences

- Migration `0009_panel_rbac.sql` is destructive and forward-only. Any pre-existing `player_role_assignments`, `organizations`, or `role_server_scopes` rows are gone. Acceptable at pre-launch.
- `player_api_tokens` is truncated in `0009` — no real tokens existed at migration time.
- `audit_log.org_id` is dropped; the hash chain is unaffected (column was always NULL).
- Operators who delete a preset role (e.g. Moderator) must re-create it manually — there is no auto-respawn. Documented in [`docs/components/rbac/troubleshooting.md`](../components/rbac/troubleshooting.md).
- In-process cache invalidation does not propagate across API instances. Horizontal scaling requires a Redis pub/sub invalidation layer (deferred).

### Alternatives considered

- **Keep M:N with UNIQUE constraint**: Simulates 1:1 but leaves the conceptual mismatch in the schema forever. Rejected.
- **Clearance levels instead of flat bag**: Spec explicitly says "no hierarchy, no clearance". Rejected.
- **Keep organizations as dormant schema**: Adds join noise and confusion for new contributors. Rejected.
- **Redis pub/sub invalidation now**: Multi-instance is not a current requirement; the TTL safety-net is sufficient. Deferred.
- **DB-table for permission registry**: Would require a migration for every new key and a round-trip to DB on every role edit page load. Rejected in favour of the in-code registry.

---

## 2026-04-25 — API tokens for integrations (Bearer auth, scopes ⊆ user permissions)

### Context

The panel is admin-facing and so far had only browser cookie sessions. Integrations (CI scripts, monitoring, Discord bots) had no way to authenticate without scraping HTML or running a full Steam OpenID handshake. The schema for `player_api_tokens` already existed (since `0008_steam_only_auth.sql`) but nothing minted, validated, or accepted them — `audit_log.actor_token_id` was always NULL.

### Decision

Mint per-user, long-lived bearer tokens at `/api/v1/me/tokens` (cookie-only management). Tokens are `sqp_<uuidv7>_<24-byte base64url>`, persisted as `sha256` only. Authentication is `Authorization: Bearer …`; effective permissions on every request are `currentRolePermissions ∩ token.scopes`. Soft revoke (`revoked_at`), no TTL. 25 active tokens per user maximum.

### Rationale

- **Reuse `PERMISSION_KEYS`** instead of inventing an `api_token:*` permission family: scopes are already a familiar set with first-class UI; users can't grant a token more power than they themselves have.
- **Live intersect, not snapshot**: revoking a role immediately shrinks a token's reach without an explicit revoke. Mirrors how cookie sessions react to role changes.
- **Cookie-only management**: a stolen token cannot rotate itself or mint a wider one.
- **Sha-256, not Argon2**: 24 bytes of entropy makes brute-force impossible; Argon2 is for low-entropy human secrets, not random API tokens. Same approach as session token storage.
- **Soft revoke**: keeps `audit_log.actor_token_id` referentially valid for forensic queries.

### Consequences

- `audit_log.actor_token_id` becomes non-null for the first time. Canonical-JSON hashing already includes the column, so chain integrity is unaffected — but the first row carrying a value will look "different" in audit dumps.
- The `useId`/scopes-checkbox UI implies the user must already have the permission to grant it; users with no permissions can only mint a `scopes=[]` introspection token (allowed).
- No expiry → operators must revoke leaked tokens manually. The `sqp_` prefix makes secret scanners catch the common case.

### Alternatives considered

- **Per-token expiry / refresh tokens**: deferred. Would add UI complexity and a daily prune job for what is fundamentally a list operators can already curate at `/settings/tokens`.
- **Admin-managed tokens for other users**: deferred. P1 use cases are user-owned automation; admin minting is a future RBAC question.
- **Separate `api_token:*` permission family**: rejected — duplicates the existing permission model and forces every gated route to opt in.

## 2026-04-25 — Panel observability via two capped Redis Streams + pino multistream sink

### Context

Operators needed a single place to see what every panel component (api, bridge, rcon supervisor, log-ingest tail, depot/install steps, all workers) was doing — including connection state of the host bridge and per-RPC latency — plus a 24 h history graph for the dashboard's CPU/RAM/Disk/Network cards and a one-click export bundle for off-host triage. The existing surfaces only showed live state: pino → stdout → journald, `rcon:status:{id}` (live), `bridge.host_metrics` (live).

### Decision

Two new capped Redis Streams plus a pino multistream sink that fans every log line into one of them:

- **`panel:logs`** (`MAXLEN ~ 100000`, ≈ 10 MB) — every pino line from api + every worker + every bridge `onLog` event, encoded with single-letter field names (`s` source code, `l` level code, `i` server uuid optional, `m` message, `c` ctx json optional). The Redis stream-id millisecond prefix is the timestamp, so `ts` is never duplicated. Source codes `B/R/L/W/D/I/A`. Encoder/decoder in [`packages/shared-config/src/log-stream.ts`](../../packages/shared-config/src/log-stream.ts), pino multistream `Writable` in [`log-stream-sink.ts`](../../packages/shared-config/src/log-stream-sink.ts).
- **`host:metrics`** (`MAXLEN ~ 5760` = 24 h × 4/min, ≈ 300 KB) — packed 8-int tuple per sample, written every 15 s by the new `worker-metrics-sampler`. Helpers in [`metrics-pack.ts`](../../packages/shared-config/src/metrics-pack.ts).

GET endpoints on top: `/api/v1/logs` (filter + cursor pagination), `/api/v1/logs/export` (gzip-streamed sectioned bundle, gated by `host:metrics`), `/api/v1/host/metrics/history` (paired arrays). UI: `/logs` page with live-tail polling and an export button, click-to-expand `MetricHistoryModal` on the four dashboard cards.

### Rationale

- **Existing infrastructure.** Redis was already the event/heartbeat hub; adding two streams costs nothing and reuses the rotation pattern (`MAXLEN ~`).
- **Per-record packing > gzip.** For sub-100-byte log records gzip's per-block overhead exceeds savings. Single-letter keys + 1-byte enum codes get ~70 % of gzip's ratio at zero CPU cost. The export endpoint is the right place for gzip — long repeated lines and the CSV block compress well.
- **Postgres stays the durable security record.** `audit_log` keeps its hash chain. `panel:logs` is diagnostic and ephemeral — losing it on a Redis restart is fine. The export bundle includes a recent slice of `audit_log` for convenience but the canonical record is unchanged.
- **No new datastore, no Prometheus, no Grafana.** Diagnostic-only, human-eyeballed. Histograms / alerting can be a future sub-project.

### Consequences

- New worker `worker-metrics-sampler` in compose; uses `user: "0:${PANEL_GID}"` (primary GID `panel`) because the bridge's `SO_PEERCRED` check only sees the peer's primary GID — supplementary groups added via `group_add` aren't visible across the host user namespace.
- The api's `buildLogger` switched to `pino.multistream([stdout, lateSink])`; the late-bound sink wires up after `redisPlugin` registers. The ≈ 7 plugin registrations of api logs that fire before the wire-up land in stdout/journald only — acceptable for boot noise.
- Pino-http meta keys (`req`, `res`, `responseTime`, `reqId`, `name`) are stripped from the encoded `ctx` to keep entries small and avoid leaking full HTTP request/response objects into a 100 k-cap stream.
- The web client cannot import `unpackHostMetrics` from `@squad/shared-config` because the package barrel re-exports the `node:stream`-using log-stream sink; the modal duplicates the unpack math (5 lines) instead. Sub-path exports were considered and rejected as scope creep — the duplicated math is trivial and obvious.

### Alternatives considered

- **A separate Prometheus scrape + Grafana dashboard.** Rejected — adds two services, an HTTP scrape endpoint, label cardinality decisions, and config maintenance for a feature that fits in two Redis streams plus one chart library.
- **Postgres `panel_logs` table.** Rejected — every connector log line would write to disk, and the existing `audit_log` is doing similar work for security; doubling it for diagnostic noise is wrong.
- **Per-source streams (`panel:logs:bridge`, `panel:logs:rcon:{id}`, …).** Rejected — bookkeeping overhead, harder export iteration, and natural per-source backfill isn't a real operational need versus a single filter parameter.

## 2025-11-15 — One Docker container per Squad server (replaces native systemd units)

### Context

The original Phase-0 design ran each Squad server as a native `squad-server-{uuid}.service` systemd unit under `/opt/squad-servers/{uuid}/`, with the bridge spawning `steamcmd`, `apt`, and `systemctl` operations directly. The bridge surface included `steamcmd_run`, `systemctl_action`, `systemctl_write_unit`, `apt_install`, `journalctl_follow`.

### Decision

Each Squad server now runs as a Docker container (`squad-server:latest`, debian-bookworm-slim base). The bridge no longer spawns systemd units, apt, or steamcmd directly; instead it has `container_run|start|stop|rm|inspect|logs_follow`, `depot_update`, and the file/ufw subset.

### Rationale

- **Lower bridge surface area.** The new method set is structured params only — there is no string-arg passthrough to `steamcmd` or `apt`. Image allowlist is two entries.
- **Reproducibility.** SteamCMD's depot is now a shared named volume populated once; per-server containers mount it `:ro`. Spinning up a new server takes seconds instead of minutes.
- **Cleaner upgrade path.** Updating Squad becomes "rerun `depot_update` and recycle containers" rather than touching every host's systemd state.
- **EAC + EOS work natively in the container** with `--network host` and no extra capabilities (verified during the migration risk-spike).

### Consequences

- The bridge dropped `steamcmd_run`, `systemctl_action`, `systemctl_daemon_reload`, `systemctl_write_unit`, `systemctl_read_unit`, `apt_install`, `journalctl_follow`.
- Host-level apt/install logic moved into [`scripts/install-host-bridge.sh`](../../scripts/install-host-bridge.sh) (one-time setup) instead of being on the runtime path.
- The `squad` host user is no longer used; the container runs as uid 1001 internally and `chown`s the bind mounts on entrypoint.
- All Phase-0 doc artifacts that referred to systemd-units / steamcmd / apt-install (the original flat `architecture.md`, `bridge-protocol.md`, and the `experiment/` research notes) became stale and were removed when the new nested `docs/` structure landed.

### Alternatives considered

- **Keep native systemd, harden bridge args further.** Rejected — apt + steamcmd are unbounded surfaces; whitelisting them safely is harder than removing them.
- **Run Squad in `network_mode: bridge` with explicit port mapping.** Rejected — Squad's EOS handshake misbehaves behind a NAT layer; `--network host` is the supported config.

## 2026-04-25 — Steam-only login + steam_id64 PK + dual-anchor first-owner trick

### Context

Email/password + TOTP login was scoped for Phase 0 but never shipped to users. Spec §1.1–§1.6 mandated Steam OpenID 2.0 as the only authentication path. The panel manages Squad servers; players already have a primary identity (Steam ID) that is captured automatically by `worker-rcon` and `worker-log-ingest`.

### Decision

- Steam OpenID 2.0 is the only login method. `/api/v1/auth/login` and TOTP endpoints are removed.
- Identity anchor moves from `users.id uuid` to `players.steam_id64 bigint`. The `users` table is dropped.
- "Pending users" UI is replaced by "players without panel role" — assignment lives in `/players/<steam_id64>` profile under "Доступ к панели".
- First Steam-login after fresh install becomes Owner exactly once via dual anchor:
  - `organizations.settings.first_owner_claimed: true`.
  - Bridge-managed sentinel file `/var/lib/squad-panel/.first-owner-claimed`.
  - `pg_advisory_xact_lock(hashtext('first_owner'))` serialises concurrent callbacks.
- audit_log gains discriminated actor union: `(actor_kind='steam', actor_steam_id64)` or `(actor_kind='system', actor_system_label)`. `actor_token_id` traces actions taken via API tokens (now wired up — see the 2026-04-25 "API tokens for integrations" decision).
- Sessions are sliding with 6h TTL and 60s touch throttle (Redis `SETNX session-touch:{id}`).

### Rationale

Steam ID is the universal Squad identity. Anchoring everything (sessions, audit, role assignments) on `players.steam_id64` removes the artificial split between "panel users" and "game players" — a moderator IS a player who happens to have a panel role.

The dual anchor for first-owner survives `DROP DATABASE` + restore: the sentinel file persists on the host. Deleting both the DB row and the sentinel file requires root + bridge access — i.e., a deliberate operator action, never accidental.

### Consequences

- Steam Web API key (`STEAM_API_KEY`) is optional. Without it, persona is `Player <last 4 of steam_id64>`; the player can update their canonical name when they next play on a server (RCON ListPlayers updates).
- Audit hash chain uses `action_type|target_type|target_id|context|created_at` — actor fields are NOT in the canonical payload, so the discriminated actor change does not break `pnpm verify:audit-chain`.
- e2e tests cannot fully exercise the OpenID 2.0 verifier without a real Steam account; they verify post-login state via `PANEL_TEST_COOKIE` env. The cookie-supply pattern is documented in `docs/components/api/testing.md`.

### Alternatives considered

- **Soft-cut behind a feature flag** — kept email/password as a backdoor. Rejected: doubled the auth attack surface and the spec explicitly required "единственный способ входа".
- **Discord OAuth as alternative** — rejected for Phase 1; Discord remains a linked identity for notifications/bot scope (P1+).
- **Steam OAuth instead of OpenID 2.0** — Steam has no OAuth endpoint. OpenID 2.0 is the only public auth surface Steam offers.
