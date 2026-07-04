# RNSquadJS Migration — Design

- **Date:** 2026-04-24
- **Author:** Squad Panel Dev (Sergei P.)
- **Status:** Draft, awaiting approval
- **Upstream:** https://github.com/lACTEPUKCl/RNSquadJS (branch `master`, pinned by SHA)

## 1. Goal

Replace the panel's in-house RCON client (`apps/workers/rcon/`) and log parser (`apps/workers/log-ingest/src/parser/`) with **RNSquadJS** running as a per-server sidecar container. The panel keeps full ownership of lifecycle (install/update/start/stop/configs/audit/RBAC) and event storage; RNSquadJS becomes the only process that talks Valve-RCON to the Squad server and the only process that tails `SquadGame.log`.

This supersedes the current "RNSquadJS is an external black box we neither fork, patch, nor vendor" stance in `CLAUDE.md`.

## 2. Final topology

One Squad container ↔ one `rnsquadjs-{uuid}` sidecar, both managed by the existing Go bridge.

```
host
├── squad-{uuid}                 (image: squad-server:latest, --network host)
│     ├── /squad/SquadGame/ServerConfig  ← RW bind from /var/lib/squad-panel/configs/{uuid}/ServerConfig
│     └── /squad/SquadGame/Saved         ← RW bind from /var/lib/squad-panel/saved/{uuid}
│
└── rnsquadjs-{uuid}             (image: squad-panel/rnsquadjs:<sha>, --network host, --user 1001:1001, --read-only)
      ├── /squad/SquadGame.log            ← RO bind of saved/{uuid}/SquadGame/Saved/Logs/SquadGame.log
      ├── /app/config.json                ← rendered at start from API
      └── plugins/panelBridge/            ← our overlay, baked into the image
                ├── XADD events:server:{id}            (Redis Streams)
                ├── SET  rcon:status:{id} EX 300       (Redis)
                ├── SET  worker:heartbeat:rnsquadjs:{id} EX 30
                └── HTTP POST /rcon  (loopback only — API → sidecar)
```

Both containers are launched, inspected, and stopped through the existing bridge RPC surface (`container_run` / `container_inspect` / `container_stop` / `container_rm`). No new bridge RPC methods are required — only an image-allowlist entry.

## 3. Components

### 3.1. `docker/rnsquadjs.Dockerfile` (new)

```dockerfile
ARG RNSQUADJS_REPO=https://github.com/lACTEPUKCl/RNSquadJS.git
ARG RNSQUADJS_SHA          # full 40-char commit SHA, no tags
FROM node:18.18-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone "$RNSQUADJS_REPO" . && git checkout "$RNSQUADJS_SHA"
COPY docker/rnsquadjs/plugins/panelBridge ./src/plugins/panelBridge
RUN corepack enable && yarn install --frozen-lockfile && yarn build
FROM node:18.18-bookworm-slim
COPY --from=build /src /app
COPY docker/rnsquadjs/entrypoint.sh /usr/local/bin/entrypoint.sh
USER 1001:1001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
```

`entrypoint.sh`:
1. `curl -fsS http://api:3000/internal/rnsquadjs/config/$SERVER_ID > /app/config.json`
2. `exec node lib/index.js`

### 3.2. `docker/rnsquadjs/plugins/panelBridge/` (new — our code, copied into the image)

Single overlay plugin. Three responsibilities, no business logic.

- **Event mapping.** Subscribes to RNSquadJS EventEmitter (`PLAYER_CONNECTED`, `PLAYER_DISCONNECTED`, `PLAYER_DAMAGED`, `PLAYER_DIED`, `PLAYER_WOUNDED`, `PLAYER_REVIVED`, `PLAYER_POSSESS`, `PLAYER_UNPOSSESS`, `NEW_GAME`, `ROUND_ENDED`, `SQUAD_CREATED`, `DEPLOYABLE_DAMAGED`, `TICK_RATE`, `ADMIN_BROADCAST`, `CHAT_MESSAGE`, `LIST_PLAYERS`, `LIST_SQUADS`, `SHOW_SERVER_INFO`, `POSSESSED_ADMIN_CAMERA`, `UNPOSSESSED_ADMIN_CAMERA`, `WARN`, `KICK`, `BAN`). Each event is wrapped in `EventEnvelope { id: uuidv7(), serverId, type, version, ts, payload }` from `packages/shared-types/src/events.ts` and pushed via `XADD events:server:{id} *`.
- **RCON status.** On `connected` / `disconnected` from `squad-rcon`, write `SET rcon:status:{id} '{"state":"connected"|"disconnected", "lastChange": <iso>}' EX 300`. Same key contract as today's `apps/workers/rcon/src/supervisor.ts`.
- **RCON command HTTP.** `POST /rcon { method, args }` on `127.0.0.1:8765`, executes via `squad-rcon`, returns `{ ok, response }`. The only consumer is the panel API.
- **Heartbeat.** `SET worker:heartbeat:rnsquadjs:{id} '<iso>' EX 30` every 10 s — matches `packages/shared-config/src/heartbeat.ts` contract.

### 3.3. Mongo / MariaDB stance

`rnsdb.ts` and any plugin that requires a database are kept **disabled** in the rendered `config.json` (`enabled: false` for `autoUpdateMods`, statistics, etc.). No Mongo or MariaDB service is added to `docker-compose.yml`. Postgres remains the only datastore for the panel.

### 3.4. Bridge changes (`apps/bridge/internal/runner/docker.go`)

Add `squad-panel/rnsquadjs:*` to the image allowlist. No other changes — same `container_run` spec format, same `--network host`, same `--read-only`.

### 3.5. API changes

| File | Change |
|---|---|
| `apps/api/src/routes/server-install.ts` | After Squad `container_run`: second `container_run` for `rnsquadjs-{uuid}` with bind-mount of the single log file and `SERVER_ID` env. |
| `apps/api/src/routes/servers.ts` (stop / delete) | Symmetric: stop and remove sidecar before / together with Squad container. |
| `apps/api/src/routes/internal/rnsquadjs-config.ts` (new) | `GET /internal/rnsquadjs/config/:id` — loopback only (Fastify `onRequest` guard on `req.ip === '127.0.0.1'`). Renders single-server `config.json` from `servers` row + `Rcon.cfg` (host=`127.0.0.1`, port from DB, password from cfg). |
| `apps/api/src/lib/rcon.ts` (new) | `rcon.exec(serverId, method, args)` → `POST http://rnsquadjs-{uuid}:8765/rcon`. Replaces direct RCON socket usage everywhere in the API. |
| `apps/api/src/plugins/status-reconciler.ts` | No code change — already reads `rcon:status:{id}`. Add the sidecar to `container_inspect` polling so the same reconciler flips DB state for both. |

### 3.6. Worker / compose removals (after Phase 4 below, not before)

- Delete `apps/workers/rcon/` (entire package).
- Delete `apps/workers/log-ingest/` (entire package — parser, tail, publish, index). With `panelBridge` publishing `EventEnvelope` directly, nothing else uses this worker.
- Move the regression fixture from `apps/workers/log-ingest/test/fixtures/SquadGame.log` to `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log` before deletion. It is the input for parity tests in §7.1 and §8 Tier 1, and must survive Phase 5.
- Remove `worker-rcon` and `worker-log-ingest` services from `docker-compose.yml`.
- Drop `worker:heartbeat:rcon` / `worker:heartbeat:log-ingest` from `/api/v1/health/workers`; replace with `worker:heartbeat:rnsquadjs:{id}` aggregated per server.

## 4. Data and contract surface (must not change)

These contracts are read by the UI, status-reconciler, audit, and `worker-event-partition`. They are the public surface of this migration — every artifact below stays byte-compatible:

- `events:server:{id}` Redis Stream, payload = `EventEnvelope` from `packages/shared-types/src/events.ts`.
- `rcon:status:{id}` Redis key, JSON `{state: 'connected'|'disconnected'|'not_polled', lastChange}`, TTL 300 s. `'not_polled'` is still produced by status-reconciler when the DB row is `stopped`.
- `worker:heartbeat:rnsquadjs:{id}` Redis key, ISO timestamp, TTL 30 s — surfaced by `/api/v1/health/workers`.
- `audit_log` rows, append-only with sha256 chain — unchanged.
- `config_versions` rows, RCON.cfg / Server.cfg edits — unchanged.

## 5. Lifecycle flows

### 5.1. Install (`POST /servers/:id/install`)
1. `seedConfigs` (unchanged) copies 19 default `.cfg` from depot volume.
2. `ufw_rule` adds game/query/beacon/rcon ports (unchanged).
3. `container_run squad-{uuid}` (unchanged).
4. **NEW:** Before sidecar `container_run`, the API issues `bridge.file_atomic_write` to ensure `/var/lib/squad-panel/saved/{uuid}/SquadGame/Saved/Logs/` exists (bridge `MkdirAll`s up through the allowed root). Bind-mounting a non-existent file would otherwise create an empty *directory* on the host and break the tail.
5. **NEW:** `container_run rnsquadjs-{uuid}` with:
   - image `squad-panel/rnsquadjs:<current-sha>`,
   - `--network host`, `--user 1001:1001`, `--read-only`,
   - bind the **directory** `/var/lib/squad-panel/saved/{uuid}/SquadGame/Saved/Logs:/squad/Logs:ro` (directory, not file — survives Squad's first-boot creation of `SquadGame.log`),
   - env `SERVER_ID={uuid}`, `API_URL=http://api:3000`, `LOG_FILE=/squad/Logs/SquadGame.log`,
   - `--restart unless-stopped`.
6. Sidecar entrypoint polls `LOG_FILE` for up to 60 s before launching RNSquadJS (Squad creates the file on first boot, ordering is not guaranteed).
7. status-reconciler flips `servers.status` → `running` once the Squad container is up.
8. RNSquadJS authenticates RCON, `panelBridge` writes `rcon:status:{id}=connected`, `worker:heartbeat:rnsquadjs:{id}` starts pulsing.

### 5.2. Stop (`POST /servers/:id/stop`)
1. API issues `AdminBroadcast` + `AdminEndMatch` via `rcon.exec` (i.e. HTTP into sidecar).
2. `container_stop squad-{uuid}` (unchanged).
3. **NEW:** `container_stop rnsquadjs-{uuid}` immediately after.
4. status-reconciler flips both rows; `rcon:status:{id}` ages out → UI renders `"— (сервер не запущен)"` (unchanged copy).

### 5.3. Delete (`DELETE /servers/:id`)
1. **NEW:** `container_rm rnsquadjs-{uuid}` first (so it stops trying to RCON a dying server).
2. `container_rm squad-{uuid}` (unchanged).
3. DB row + configs dir cleanup (unchanged).

### 5.4. Upgrade RNSquadJS (no Squad restart)
1. Pick upstream commit. Read diff `https://github.com/lACTEPUKCl/RNSquadJS/compare/<old>...<new>`.
2. Run **§7 compatibility checklist**.
3. PR: bump `ARG RNSQUADJS_SHA` in `docker/rnsquadjs.Dockerfile`, one-line changelog in commit body.
4. CI builds the image with the new SHA; `pnpm --filter @squad/api test:e2e` must stay green.
5. Tag `is_canary=true` server: API recreates only the sidecar (`container_stop` → `container_rm` → `container_run` with new image). Squad container untouched, no player drop.
6. Observe 30 min: heartbeat live, `rcon:status:connected`, events flowing.
7. `POST /admin/rnsquadjs/rollout {image: <new-tag>}` — recreates sidecars in batches of 5, 30 s pause. Auto-halt + audit row if any sidecar fails to publish `connected` within 60 s after recreate.
8. Rollback = revert the SHA-bump commit and re-run rollout. No DB migrations.

## 6. Persistence

- **Postgres stays the only relational store.** Drizzle schema unchanged. Audit chain unchanged.
- **No Mongo, no MariaDB.** Even though RNSquadJS depends on `mongodb` and `sequelize`, no plugin that touches them is enabled. The drivers ship in the image but never connect.
- **No new migration.** Only schema-adjacent change: a single `is_canary boolean default false` column on `servers` for the rollout flow (separate small migration via `pnpm db:generate`).

## 7. Compatibility checklist (run before every SHA bump)

Diff upstream and confirm:

1. **`squad-logs` regexes.** Replay `apps/workers/log-ingest/test/fixtures/SquadGame.log` (kept as a regression fixture even after the parser is deleted) through the new `squad-logs` and assert the produced event set matches the previous run. Any divergence = file an upstream PR or hold the bump.
2. **EventEmitter event names and payload shapes.** `panelBridge/eventMap.ts` is a flat map from RNSquadJS event → `EventEnvelope`. A renamed event = recompile = diff visible at typecheck.
3. **`squad-rcon` two-packet AUTH workaround.** Squad's RCON quirk requires sending a junk packet after AUTH. Verify the workaround is still present in `squad-rcon`. If removed, hold the bump and pin the previous version.
4. **`rnsdb.ts` plugins.** New plugin that opens Mongo on import without checking `enabled` = blocker. Add it to the disabled list in our rendered `config.json` first.
5. **Node version in upstream `package.json`.** If upstream goes past 18.18, bump the Dockerfile base image and re-run e2e.

## 8. Testing

Existing three-tier model from `CLAUDE.md` is preserved. Each tier gets specific additions:

### Tier 1 — unit
- `docker/rnsquadjs/plugins/panelBridge/test/eventMap.test.ts` — for each RNSquadJS event type, assert the produced `EventEnvelope` matches a fixture (covers payload mapping).
- `apps/api/src/lib/rcon.test.ts` — fakes the sidecar HTTP, asserts `rcon.exec` retries on `ECONNREFUSED` for ≤ 5 s after sidecar restart.

### Tier 2 — integration
- `apps/api/test/internal-rnsquadjs-config.test.ts` — `GET /internal/rnsquadjs/config/:id` rejects non-loopback (`req.ip === '10.0.0.5'` → 403), accepts loopback, renders correct shape.
- `apps/api/test/health-workers.test.ts` — extended to require `worker:heartbeat:rnsquadjs:{id}` for every `running` server.

### Tier 3 — e2e (the gate)
- `apps/api/test/e2e/install-lifecycle.e2e.test.ts` — extended:
  - assert `container_inspect rnsquadjs-{uuid}` reports `running` after `/install`,
  - assert `rcon:status:{id}` reaches `connected` within 30 s and the writer process is the sidecar (verify by killing `worker-rcon` if still present — should make no difference),
  - assert at least one `EventEnvelope` of type `PLAYER_CONNECTED` or `NEW_GAME` lands in `events:server:{id}` within 60 s of Squad boot,
  - on `/stop`, assert sidecar transitions to `exited` and `worker:heartbeat:rnsquadjs:{id}` ages out.
- `apps/api/test/e2e/bridge-rpc.e2e.test.ts` — add `container_run` success and forbidden cases for the new image allowlist entry.

`pnpm turbo run test` + `pnpm --filter @squad/api test:e2e` both green = migration is shippable.

## 9. Rollout phases

Each phase ends in a hard gate. No parallel phases.

| Phase | Goal | Gate |
|---|---|---|
| **0. Spec & sample logs** | Capture `~50` lines of real `SquadGame.log` from the canary server into `apps/workers/log-ingest/test/fixtures/`. Render the current parser output as the "golden" set. | Fixture committed. |
| **1. Image + plugin** | Build `squad-panel/rnsquadjs:<sha>` with `panelBridge`. Run it manually against the canary server with the **old** workers still owning RCON/log. Sidecar starts with env `PANEL_BRIDGE_MODE=shadow` — `panelBridge` writes to `events:server:{id}:shadow`, `rcon:status:{id}:shadow`, `worker:heartbeat:rnsquadjs:{id}:shadow`. **No HTTP `/rcon` endpoint is bound in shadow mode** so it cannot accidentally take over RCON. Diff shadow vs production for 24 h. | ≥ 99 % event-set parity, no missing event types. |
| **2. API wiring** | Implement `/internal/rnsquadjs/config/:id`, `rcon.exec`, install/stop/delete extensions. Bridge allowlist updated. **Old workers still running** — sidecar still publishes to `:shadow`. | Tier 2 tests green. |
| **3. Cutover on canary** | Recreate the canary sidecar with `PANEL_BRIDGE_MODE=production` — same image, same SHA, only the env flag flips. `panelBridge` now writes to the real keys and binds `/rcon` HTTP. Simultaneously, the supervisor in `worker-rcon`/`worker-log-ingest` consults a per-server kill switch (`SREM rcon:enabled-servers {id}` and `SREM log-ingest:enabled-servers {id}`) and stops polling that server. | e2e `install-lifecycle` green against canary; 24 h soak with no UI regressions. |
| **4. Fleet cutover** | Roll out to all servers in batches of 5. | All servers green for 24 h. |
| **5. Cleanup** | Delete `apps/workers/rcon/` and `apps/workers/log-ingest/src/parser/`. Remove their compose services. Rewrite the "RNSquadJS stance" section in `CLAUDE.md` to describe the sidecar topology, plugin overlay path, and pinned-by-SHA upgrade flow. | `pnpm turbo run typecheck && test` green; `pnpm --filter @squad/api test:e2e` green. |

Phases 0–2 are reversible with a single revert. Phase 3 onwards requires rolling sidecars back to old image **and** restarting the deleted-but-still-in-git workers, so cleanup (Phase 5) only happens after Phase 4 has soaked at least one full week.

## 10. Risks and explicit non-goals

**Risks:**
- **Parser parity drift.** Mitigation: shadow-stream in Phase 1 + golden fixture in Phase 0. If parity < 99 %, do not proceed.
- **RCON AUTH regression in `squad-rcon`.** Mitigation: §7.3 check + Phase 1 24 h soak.
- **Sidecar resource overhead.** Each sidecar ≈ Node process with ~100 MB RSS. For N servers, that is N × 100 MB. Acceptable on the current single-host topology; flagged for the multi-host roadmap.
- **Per-server kill switch race.** `worker-rcon` checks `rcon:enabled-servers` once per supervisor tick (currently 4 s). During cutover, both old worker and sidecar may briefly hit RCON in the same window. Mitigation: cutover script does `SREM` first, sleeps 6 s, only then recreates the sidecar in `production` mode.
- **`config.json` over loopback exposes RCON password to anyone with shell on `api` container.** Same trust boundary as today (the API already reads it from disk). Documented, not mitigated further.

**Non-goals:**
- We do not adopt RNSquadJS plugins (`chatCommands`, `autoUpdateMods`, vote, warnings, broadcasts). They overlap with planned panel features and would split ownership of features across two codebases.
- We do not introduce Mongo / MariaDB.
- We do not fork the upstream repo. Upgrades are SHA bumps in our Dockerfile, not merges into our tree.
- We do not change the UI (Russian, Monaco editor, Tabs) or the bridge RPC surface (still 14 methods).

## 11. Open questions for the user

1. **Canary server.** Pick one specific server UUID for Phases 1 and 3, or add the `is_canary` column and let the operator flag any server.
2. **`POST /admin/rnsquadjs/rollout` UX.** New page in the dashboard, or CLI-only via `pnpm` script?
3. **Phase 0 log fixture size.** 50 lines is enough for parity smoke; do you want a longer (~10 k lines) capture for stress testing the parser too?

## 12. Execution deviations (2026-06-12)

Recorded during the integration-completion pass (see `docs/superpowers/plans/2026-06-12-rnsquadjs-integration-completion.md` for full rationale):

- **D1 — config.json is a bind-mounted file, not HTTP.** The loopback-guarded `/internal/rnsquadjs/config/:id` endpoint is unreachable from a host-network sidecar, and `curl -o` cannot write to a `--read-only` rootfs. The API renders `/run/squad-panel/rnsquadjs/{id}/config.json` (atomic tmp+rename, chown 1001, 0600); the bridge bind-mounts it read-only at `/app/config.json`.
- **D2 — per-server socket subdirectory.** `{root}/{id}/sock/` is the only sidecar-writable level (mounted at `/run/panelBridge`); the shared-root single-socket layout in §3.2 would collide across sidecars and let the sidecar rewrite its own config through the rw parent.
- **D3 — inverted kill switch.** Redis set `rnsquadjs:cutover-servers` (empty = fully legacy) instead of §9's `SREM rcon:enabled-servers` design; no population bootstrap needed.
- **D4 — cutover transfers the log pipeline only.** `worker-rcon` (A2S, tickrate, lag-spike, rcon:status live-bus) stays authoritative; the sidecar writes `rnsquadjs:status:{id}` and, in production mode, publishes only the legacy-parity event types (player.connected/disconnected, match.started/ended). §3.6's worker-rcon removal is deferred indefinitely.
- **D5 — fail-safe defaults.** `PANEL_BRIDGE_MODE` defaults to shadow; sidecar `REDIS_URL` must be host-loopback (`redis://127.0.0.1:6379`).
- **D6 — panelBridge compiles into the upstream.** Upstream loads plugins from a static compiled-in registry and `lib/` exists only after `yarn build`; the plugin sources are copied into `src/plugins/panelBridge/`, registered via `docker/rnsquadjs/upstream.patch`, and built by rollup inside the image. The config `plugins` field is an array (`[{name:'panelBridge',enabled:true,options:{}}]`); absent plugins are disabled.
