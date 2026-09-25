# Architectural decisions

Meaningful architectural choices, recorded as we make them.

## 2026-07-29 — #246: invert the auth hook to fail-closed; explicit `config.public` allowlist

### Context

The global `onRequest` hook (`apps/api/src/plugins/auth.ts`) gates every route on `config.permissions`. It returned early — no session required — whenever a route declared no `config.permissions` at all, treating "nobody added permissions" as "this route is public". Most routes in this codebase authorise through an in-handler `Guard()` helper instead of `config.permissions`, so the gap was usually masked by that second layer. It was not always: `GET /api/docs*` (the full 298-route OpenAPI schema and Swagger UI) and `GET /api/v1/host/bridge-status` shipped to production reachable by anyone with the URL, no session or permission required. Auditing every route/plugin file under `apps/api/src/{routes,plugins}/*.ts` (`perms=0 guard=0 requser=0`) found three more live instances: `GET /api/v1/health/workers`, `GET /api/v1/health/reconciler`, and the two newer webhook route files `integrations-balancer.ts` and `integrations-vip.ts`.

### Decision

1. **Invert the default.** `apps/api/src/plugins/auth.ts`'s hook now requires `req.user` to be set — 401 otherwise — unless the route declares `config.public: true`. `config.permissions` still narrows further to specific permission keys, exactly as before; only the *no permissions declared* case changes meaning, from "public" to "authenticated, no permission required".
2. **`config.public` is a new, explicit field** on `FastifyContextConfig` (`apps/api/src/plugins/types.ts`), documented alongside the existing `selfService` opt-in. It is reserved for a short, reviewed allowlist rather than a general escape hatch.
3. **Every currently-unguarded route gets an explicit decision**, not a default:
   - `host:view` (existing `PermissionKey`, already gating `GET /api/v1/host/info`) — `GET /api/v1/host/bridge-status`, `GET /api/v1/health/workers`, `GET /api/v1/health/reconciler`.
   - `config.public: true` — `GET /health`, `GET /ready`, `GET /metrics`, the signature/token-gated webhooks (`integrations-balancer.ts`, `discord-interactions.ts`, `public-media.ts`'s upload-token redemption), the public data portals (`public-stats.ts`, `public-clans.ts`, `public-appeals.ts`), the pre-login Steam OpenID round-trip (`auth-steam.ts`), and `setup.ts`'s `GET /status` probe.
   - `permissions: ['banlist:read']` — `public-banlist.ts`'s `GET /api/v1/public/banlist`, a drift correction: the handler already enforced `req.user` + the permission in-handler, so this only makes the existing gate declarative.
   - `GET /api/docs*` needs no route-level change at all: `authPlugin` is registered with `fastify-plugin` (`fp()`), so its hook is not encapsulated to its registration point and Fastify applies it at the root scope to every descendant route, including the swagger-ui routes, regardless of registration order.
4. **`POST /api/v1/setup/complete` is deliberately left undecorated.** Its in-handler `if (!req.user)` check already matches the new default, so no route change is needed there — but this does change one pre-existing behavior: an anonymous caller now gets `401` from the global hook before the handler's own "setup already completed → 410" precedence check ever runs, instead of leaking `setup_already_completed` to an unauthenticated caller. An authenticated non-owner is unaffected. This is strictly more restrictive, not a regression, and `apps/api/test/integration/setup.test.ts` was updated to assert it.

### Rationale

- **Fail-closed is the correct default for an admin panel.** A route with neither `config.permissions` nor a considered public decision should require a session, not silently serve anonymous traffic. The old default made "public" the path of least resistance for a route file that forgot to declare anything.
- **An explicit `public: true` is reviewable.** `git grep 'public: true'` now enumerates every intentionally anonymous route in one pass; a reviewer sees the decision in the diff instead of inferring "nothing declared → presumably fine" from silence.
- **In-handler `Guard()` routes are unaffected and stay in scope.** The majority of the API authorises via an in-handler `Guard()` helper with no `config.permissions` at all. Under the new default those routes require a session (correct — they always required one in practice) and are otherwise unchanged; converting them to declarative `config.permissions` is a decentralization cleanup deliberately deferred out of scope.

### Consequences

- `apps/api/test/security/fail-open-default.test.ts` (new) pins the fail-closed floor, the `config.public` opt-out, and the five newly-decided routes; verified red-before-fix (the four failure-path assertions genuinely fail on the pre-fix hook) and green after.
- `apps/api/test/security/permission-matrix.test.ts`'s dead `if (route.url.startsWith('/api/docs')) return;` carve-out is removed — the route collector never imports swagger, so the line never fired; `GET /api/v1/host/bridge-status` is now automatically covered by the matrix's generic 403-without/not-403-with sweep since `host.ts` was already imported there.
- Runtime-verified: unauthenticated `curl` against a running `api` instance returns `401` for both `GET /api/docs/json` and `GET /api/v1/host/bridge-status`.
- No new `PermissionKey` was added; every newly-gated route reuses `host:view` or `banlist:read`.

### Alternatives considered

- **Add a `uiHooks.onRequest` gate directly on the `swaggerUi` registration.** Rejected as the primary mechanism — redundant with the already-inverted global hook once encapsulation is understood correctly, and would have hidden the real bug (the hook's default) behind a route-local patch. Kept as a documented fallback only if the runtime check had disagreed with the encapsulation model (it did not).
- **Extend `permission-matrix.test.ts` into a blanket "every route must declare permissions or public" assertion.** Rejected — most of the API authorises via in-handler `Guard()` helpers with no `config.permissions`, which remains a correct and safe pattern under the new fail-closed default; a blanket assertion would force a mechanical, out-of-scope migration of those routes just to satisfy a lint-shaped test.

## 2026-07-25 — WL-2: no per-server whitelist group template; roles are global

### Context

WL-2 ([#66](https://github.com/breaking-squad/squad-admin-panel/issues/66)) asked to first *decide* whether the panel still needs a per-server "whitelist-group template" — a construct that would let an operator define a whitelist group once and push it to every server in a single action. The task flagged the item as a probable duplicate (spec §2.1, "роли и так глобальны") and gave a two-branch acceptance: (a) record the decision; only (b) build the template if it is kept. This entry records branch (a).

### Decision

WL-2 is a structural duplicate of the model the panel already ships. **No new schema, route, or UI is added.** The "apply a whitelist group to every server in one action" criterion is already satisfied by the existing global-role + Admins.cfg-sync design:

1. **Roles are global.** [`packages/db/src/schema/roles.ts`](../../packages/db/src/schema/roles.ts) has no `server_id` column and `players.role_id` is a single global FK — a role (including the designated whitelist role at `panel_meta.whitelist_role_id`) is never scoped to one server.
2. **One global snapshot, written identically to every server.** The Admins.cfg managed segment is generated once from a single DB snapshot (`snapshotRolesAndAdmins` in [`apps/workers/config-sync/src/db-snapshot.ts`](../../apps/workers/config-sync/src/db-snapshot.ts)) rendered by [`buildManagedSegmentBody`](../../packages/shared-config/src/admins-config.ts), then written into every active server's file between the `//SQUAD-PANEL` markers.
3. **One action fans out to every active server.** Every whitelist/role mutation calls [`publishAdminsCfgSyncForAllServers`](../../apps/api/src/lib/admins-cfg-sync.ts), which — in the same transaction as the mutation — inserts one durable outbox row per active server (`WHERE deleted_at IS NULL`). Adding or removing a whitelist member (`POST`/`DELETE /api/v1/whitelist/members`) is therefore already a single action that reaches every server; soft-deleted servers are excluded.

### Rationale

- **The template is the model we already have.** A per-server template only makes sense if roles or whitelists could diverge per server; they cannot. Building a second grouping construct on top of global roles would duplicate the fan-out the transactional outbox already guarantees, and re-introduce the server-scoped grouping the RBAC redesign deliberately dissolved.
- **Decision over code.** The acceptance criterion is met by recording the duplicate and locking the existing behaviour with a regression test, not by shipping a redundant endpoint.

### Consequences

- No migration, no route, no permission, no UI change. The RBAC surface and the Admins.cfg-sync pipeline are unchanged.
- The whitelist fan-out invariant is now pinned by an integration test (`apps/api/test/integration/whitelist.test.ts`, the "whitelist mutations fan out to every active server (WL-2)" block): a member add/remove enqueues exactly one `admins_cfg_sync_outbox` row per active server, never for a soft-deleted server, and a no-op re-add enqueues none. A future refactor that narrows the fan-out will fail the suite.

### Alternatives considered

- **Build a per-server whitelist-group template.** Rejected — duplicates the global-role model and its existing all-servers fan-out; see the 2026-04-25 "Panel RBAC" and 2026-05-01 "Roles unified" decisions.
- **Close the issue with no artifact.** Rejected — the decision needs a durable record (this ADR) and a test that prevents silent regression of the "one action → all servers" property the task cared about.

## 2026-05-01 — Roles unified with Squad permissions; Admins.cfg synthesized from DB

### Context

The panel's RBAC was a 47-key fine-grained per-role permission matrix. In parallel, every Squad server has its own `Admins.cfg` file with 21 in-game permission keys (`startvote`, `kick`, `ban`, …) hand-edited by SSH. Operators with five or six servers had to keep those files in sync by hand on every group change. The Эпик 2 Phase 2 spec called for: a single role concept covering both panel-side access *and* in-game `Admins.cfg`, an inline editor at `/settings/groups`, members listing per role, force-sync + drift detection, and a managed segment in `Admins.cfg` so co-existing tools (sqstat, manual edits) are preserved.

### Decision

1. **Roles carry both axes.** Add three boolean access flags (`panel_access`, `can_assign_roles`, `can_edit_roles`) to `roles`. Add a separate M2M `role_squad_permissions(role_id, squad_permission_key)` for the 21 in-game keys. Hex colors for spec roles; back-compat with palette names for existing rows. Single Owner system role hardcoded to all flags + all 21 squad perms. `Никаких отдельных panel-permissions, никаких clearance levels` per the spec — panel permissions are derived from the flags by `loadUserPermissions`. Legacy rows in `role_permissions` remain honoured (unioned with the derived set) so existing tests and fine-grained overrides keep working.

2. **Login gate flips to `panel_access`.** The Steam OpenID callback used to redirect to `/no-access` when `permissions.size === 0`; it now redirects when `panelAccess === false`. A role like `QueuePriority` (only `reserve`, no panel access) can be assigned to a player and lands them in `Admins.cfg` without granting them panel login.

3. **Mutations enqueue, the worker writes.** Every role / player-role mutation writes one `admins_cfg_sync_outbox` row per active server inside the same PostgreSQL transaction. A post-commit relay publishes pending rows to `events:admins-cfg-sync:<server_id>` with stable `_outbox_id`; the API has no direct Redis fast path. `worker-config-sync` consumes the streams via consumer group `config-sync`, regenerates the marker-fenced managed segment from a fresh DB snapshot, compares sha256 against the file's current segment, and atomically writes via `bridge.fileAtomicWrite` only if the hash differs. Idempotent on repeat events.

4. **Marker-fenced managed segment.** The worker only writes between `//SQUAD-PANEL BEGIN` and `//SQUAD-PANEL END`. Bytes outside the markers — including other tools' fenced sections like `//SQSTAT DELIMETER` — are preserved verbatim. CRLF inside the segment, untouched line endings outside.

5. **Drift detection is a periodic sweep.** Every 5 min the worker re-reads each server's file, hashes the managed segment, and compares against the DB-derived hash. On mismatch it publishes `state='drift'` and does **not** silently overwrite the file; the operator either copies the intended change into the panel UI or clicks Force-sync to restore the DB-derived segment. Event-driven mutations and explicit force-sync write through after their committed outbox row reaches the worker. The worker also pushes status (`in_sync` / `drift` / `unreachable` / etc.) to `admins-cfg:status:<server_id>` so the UI banner on `/servers/<id>` can offer the operator a Force-sync button when needed.

6. **No new bridge RPC.** The Go bridge already allows `file_read` and `file_atomic_write` on `/var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg`. The whole feature ships without touching the bridge surface or its allowlist.

### Rationale

- **Single role concept** — operators thought of "Admin" as one entity; splitting it into "panel role" and "in-game role" was the friction the spec set out to remove.
- **Async sync via Redis Streams** — keeps the API mutation path fast and decouples the file write from the request lifecycle. Stream's at-least-once delivery + sha256 idempotency means a redelivered message never corrupts the file.
- **Markers + drift sweep** — co-exists with sqstat / manual ops without us writing a parser for `Admins.cfg`. Passive sweeps surface manual edits instead of erasing them; Force-sync from UI is the escape hatch when the spec's "оператор паникует и правит руками" scenario occurs.
- **Derived panel permissions** — keeps every existing route's `permissions: ['server:install']` guard valid. Nothing in the route layer had to change.

### Consequences

- The 47-key panel permission catalogue is now mostly informational — every panel_access role gets the full set minus `role:*` and `user:manage_roles`. The catalogue remains as the canonical list of permission keys for API token scoping (`me-tokens.ts`) and route-config typing.
- The first-login Owner trick is unaffected; it now also seeds `panel_access=true` because the Owner row carries that flag (and code hardcodes it regardless).
- One new worker dependency surface (DB + Redis Streams + bridge), one new component to operate. Heartbeat exposes liveness via `/api/v1/health/workers`.
- One new audit action type pair: `admins_cfg.synced` and `admins_cfg.force_synced`. The chained-hash invariant is preserved because the worker uses the same canonical-JSON pre-hash.
- The legacy "Senior Admin" seeded role is deleted; "Viewer" is preserved for back-compat with existing fixture-driven tests but is no longer in the spec set.

### Alternatives considered

- **Inline write from API request handler.** Rejected — would couple request latency to bridge round-trips on every mutation; under bridge stalls, role edits would block. Stream + worker decouples cleanly.
- **Vendoring RNSquadJS.** Already-rejected per CLAUDE.md "RNSquadJS stance"; not revisited.
- **Bidirectional sync (parse `Admins.cfg` back into DB).** Out of P0 scope — the spec calls it a P0-deferred item; force-sync is the deliberate escape hatch instead.
- **Splitting roles into "panel role" + "squad group" entities.** Rejected — that's exactly the model the spec set out to dissolve.

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
6. **First-login Owner trick** — `claimFirstOwner()` in `apps/api/src/lib/first-owner.ts` uses `panel_meta.first_owner_claimed` and a Postgres advisory lock to assign the Owner role to the first Steam login on a fresh panel. The Owner claim no longer belongs to setup routes; the current `/setup` page only finalizes panel metadata after the Owner session exists.
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

## 2026-06-12 — RNSquadJS sidecar replaces the in-house log parser; worker-rcon retained

- Per-server RNSquadJS sidecar containers (pinned upstream SHA, panelBridge plugin compiled in) publish log-derived events to `events:server:{id}`; cutover is per-server via the `rnsquadjs:cutover-servers` Redis set, with `worker-log-ingest` skipping cutover members.
- `worker-rcon` is NOT replaced: since the April spec it grew A2S polling, realtime tickrate, lag-spike detection and the `rcon:status:changed` live bus. The sidecar publishes its own `rnsquadjs:status:{id}` key and never touches `rcon:status:{id}`.

### Rationale

The in-house SquadGame.log parser is the most fragile part of the pipeline (regex drift across Squad updates); RNSquadJS's parser is battle-tested by the community. Replacing only the log pipeline bounds the migration risk: a 24h shadow soak with an event-parity gate (≥99%) precedes any cutover, and rollback is one API call (`POST /servers/:id/rnsquadjs {mode:'shadow'}`).

### Consequences

- The sidecar image is launchable only via the dedicated `container_run_rnsquadjs` bridge RPC (hardened: fd-anchored dir creation, env-key allowlist, fixed mounts) — not via the generic `container_run`.
- Production-mode sidecars publish only the legacy-parity event types; the 13 additional mapped types stay shadow-only until the shared EVENT_TYPES enum is deliberately extended.
- Known follow-up before fleet rollout: per-server transition lock for the cutover endpoint (concurrent opposite transitions in a sub-second window can race; single-operator canary use is safe).

### Alternatives considered

- **Full worker-rcon replacement (April spec §3.6)** — rejected for now: two more months of in-house rcon features would need porting into the plugin, ballooning scope and risk.
- **Loopback HTTP config endpoint (April spec §3.5)** — impossible from a host-network sidecar against a loopback guard; file-based config via bind mount (D1).

## 2026-09-08 — SquadJS2 replaces RNSquadJS as the sidecar engine

> **Superseded (2026-09-16)** by "RNSquadJS is the only sidecar engine" below. SquadJS2 was never built or rolled out; its code was removed.


- The per-server sidecar engine moves from the third-party fork `lACTEPUKCl/RNSquadJS` to our own `breaking-squad/squadjs2` (a fork of SquadJS 4.1.0). The panel-facing contract is unchanged: same `EventEnvelope`, same `events:server:{id}[:shadow]` streams, same `rnsquadjs:cutover-servers` semantics in `worker-log-ingest`.
- The image is *derived*, not rebuilt: `FROM ghcr.io/breaking-squad/squadjs@sha256:<digest>` plus a `COPY` of the `PanelBridge` plugin. SquadJS2 auto-discovers `squad-server/plugins/*.js`, so no upstream patch is needed (RNSquadJS required one — deviation D6).
- Which engine serves a server is desired state in the Redis set `squadjs2:engine-servers`; `GET/POST /api/v1/servers/:id/sidecar` reports and switches it. The old `/rnsquadjs` routes stay as deprecated aliases until cleanup.
- Status and heartbeat move to engine-neutral keys `sidecar:status:{id}[:shadow]` and `worker:heartbeat:sidecar:{id}`; the route dual-reads the legacy `rnsquadjs:status:*` keys during the migration.
- The production event set grows to five types: `player.name_changed` joins it, derived by the plugin from `UPDATED_PLAYER_INFORMATION` polling. RNSquadJS never produced the type at all, so banned-name-on-rename enforcement was silently dead on cutover servers.

### Rationale

RNSquadJS is someone else's fork pinned to a commit, and every bump needs a manual compatibility review. SquadJS2 is our code with its own CI, verified-release pipeline and digest pinning, and the org's standalone instances (`squad1/2/3/6`) already run it — one codebase instead of two diverging forks.

### Consequences

- The Unix-socket RCON server in the old plugin is **not** carried over: it was dead code (`app.rcon` had no callers). The SquadJS2 container therefore has no writable mount at all, and its env allowlist shrinks to `{SERVER_ID, LOG_FILE}` — mode, Redis URL and server id travel in the rendered config, keeping them out of `docker inspect`.
- `directory_delete` now accepts `/run/squad-panel/{rnsquadjs,squadjs2}/{uuid}`, and deleting a server removes both. Before this the rendered config — which carries the server's plaintext RCON password — outlived the server forever.
- Payloads get richer rather than byte-identical: RNSquadJS forwarded raw `squad-logs` events, so `player.connected` carried no `name`, `player.revived` was empty, and `player.disconnected` had no `steam_id64`. SquadJS2 resolves players first, so these fields are populated. The parity gate compares types and timestamps, not payload bytes.
- **Rollout blocker at the starting pin (`258440d0`)** ([#307](https://github.com/breaking-squad/squad-admin-panel/issues/307)): SquadJS2's `player-disconnected` log rule matches `Name: EOSIpNetConnection_…, Driver: GameNetDriver EOSNetDriver_…`, while current Squad writes `RedpointEOSIpNetConnection` / `Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver`. Zero matches across every production log, so `PLAYER_DISCONNECTED` never fires. Shadow soaks are safe (the parity gate catches it); a production cutover would silently drop disconnects and must wait for an upstream fix and a pin bump.

### Alternatives considered

- **Installing the plugin deps with `yarn add -W` into `/app/node_modules`** — rejected: it re-resolves upstream's whole dependency graph inside the derived image, so the result is no longer the verified build. The deps go to `squad-server/plugins/node_modules`, which Node resolves for the plugin and nothing else.
- **Keeping payload parity byte-for-byte** — rejected: it would mean deliberately discarding fields SquadJS2 resolves (player names on connect, revive participants). The contract that matters is the type set and key names.
## 2026-09-16 — RNSquadJS is the only sidecar engine

- The per-server sidecar is [`lACTEPUKCl/RNSquadJS`](https://github.com/lACTEPUKCl/RNSquadJS), built from source at a pinned commit in `docker/rnsquadjs.Dockerfile`. The SquadJS2 engine, its image, plugin, bridge RPC (`container_run_squadjs2`), engine-selection set (`squadjs2:engine-servers`) and the `GET/POST /api/v1/servers/:id/sidecar` routes are removed.
- Status and heartbeat stay on the keys the RNSquadJS plugin writes, `rnsquadjs:status:{id}[:shadow]` and `worker:heartbeat:rnsquadjs:{id}`; `GET/POST /api/v1/servers/:id/rnsquadjs` report and switch the mode, and the settings page reads the same route.
- `directory_delete` accepts only `/run/squad-panel/rnsquadjs/{uuid}` for sidecar config; deleting a server still removes it.
- The shadow-diff gate compares `player.name_changed` pairwise again, as it did before SquadJS2 introduced a poll-derived variant.

### Rationale

SquadJS2's base image lived in a private GHCR package of the `breaking-squad` organization, which the project no longer has access to, and the engine never reached production (no image was ever built). Keeping two engines behind a switch cost API, bridge and UI complexity for a path that could not run.

### Consequences

- Upgrading RNSquadJS past the pinned commit is separate work: upstream `master` registers plugins through `src/plugins/registry.ts` and requires numeric config keys, so `docker/rnsquadjs/upstream.patch` and the UUID-keyed config rendered by `apps/api/src/lib/rnsquadjs.ts` must change together with a shadow soak.
- GHCR is not used anywhere; images are built from this repository.

