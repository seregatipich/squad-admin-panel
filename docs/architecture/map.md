# Architecture map

A short, verified overview of how `squad-admin-panel` is laid out and which contracts hold it together. It names where things live and links to the documents that go deep; it deliberately carries few numbers, because counts rot faster than structure.

> **Verified against** `origin/dev` at `c41c7547` (2026-10-01). When the code and this page disagree, the code wins and this page is fixed in the same change (see the Documentation rule in [`CLAUDE.md`](../../CLAUDE.md)).

| If you want | Read |
|---|---|
| Install / stop / delete / restore sequences | [data-flow.md](data-flow.md) |
| Privilege zones and what runs where | [README.md](README.md), [system-overview.md](system-overview.md) |
| Permissions and roles | [rbac.md](rbac.md), [components/rbac](../components/rbac/README.md) |
| Threat model and secrets | [security.md](security.md) |
| Why a choice was made | [decisions.md](decisions.md) |
| One component in depth | `docs/components/<name>/` (see [Components](#components-and-where-their-docs-live)) |
| Operating the stack | [`docs/operations/`](../operations/) |

## The system in one paragraph

A self-hosted control plane for Squad game servers on **one Linux host**, shipped as one Docker Compose stack. Caddy terminates TLS and fronts `web` (Next.js) and `api` (Fastify). Background work runs in independent worker processes that talk to Postgres and Redis. The only privileged component is the Go **bridge**, a root systemd daemon that owns the Docker socket and is reached over a Unix socket; every game server is a container the bridge starts. Live updates reach browsers over one WebSocket fed by Redis pub/sub.

```
browser ─▶ Caddy ─┬─▶ web (Next.js 15)
                  └─▶ api (Fastify 5) ──▶ Postgres (Drizzle)
                          │  ▲               ▲
                          │  └── Redis ◀─────┤  Streams, pub/sub, heartbeats
                          ▼                  │
              workers (apps/workers/*) ──────┘
                          │
   unix socket /run/panel-host-bridge/bridge.sock
                          ▼
        bridge (Go, root, systemd) ──▶ docker ──▶ one squad-server container per game server
                                                  (+ one RNSquadJS sidecar per cut-over server)
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | Fastify 5 HTTP + WebSocket API: `src/server.ts`, `src/plugins/`, `src/routes/`, `src/lib/` |
| `apps/web` | Next.js 15 App Router dashboard, Russian-only UI; route groups `(dashboard)`, `(me)`, `(public)`, plus `login` and `setup` |
| `apps/workers/*` | One deployable per directory; `_test-shared` holds the shared contract test |
| `apps/bridge` | Go host daemon (`cmd/panel-host-bridge`, `internal/{auth,fsx,handlers,metrics,rpc,runner,sysd,validate}`) |
| `packages/` | `db`, `shared-types`, `shared-config`, `diag`, `bridge-client`, `chat-ingest`, `steam-api` |
| `docker/` | Dockerfiles (`api`, `web`, `worker`, `restic`, ...), `compose.yml` and `compose.stand.yml`, Caddy configs, `rnsquadjs/` sidecar overlay |
| `scripts/` | Operations scripts (install, deploy, restore, verify) and their contract tests |
| `docs/` | This documentation tree; table of contents in [docs/README.md](../README.md) |

## Privilege boundary

`apps/bridge` is the only privileged component. Everything else calls it through `packages/bridge-client`. The RPC set is a closed allowlist (27 methods) kept in lockstep across three files: `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts` and `apps/bridge/internal/handlers/handlers.go`. Arguments (paths, images, mounts, config file names) are allowlisted in `apps/bridge/internal/validate/`; the bridge builds `docker run` from structured parameters and never accepts raw flags. Access control is the socket itself: socket activation plus a `SO_PEERCRED` primary-GID check, which is why bridge-consuming containers run as `user: "<uid>:${PANEL_GID}"` and cannot use `group_add`. Details: [components/bridge](../components/bridge/README.md), [components/bridge-client](../components/bridge-client/README.md).

## API (`apps/api`)

- `src/server.ts` registers plugins in a load-bearing order (registration order is hook order), then calls `registerRoutes()` from `src/routes/index.ts`. The test harness calls the same function, and `test/route-registration-parity.test.ts` fails when a route file is not registered.
- Authorization and auditing are data on the route, enforced by global hooks: `config.permissions` (keys from `packages/shared-config/src/permissions.ts`) and `config.audit` (required on every mutating route, enforced by `audit-coverage.test.ts`). Routes hardcode full `/api/v1/...` paths; business logic lives in `src/lib/`.
- Identity: Steam OpenID login (`lib/steam-openid.ts`) with a first-owner claim, Discord OAuth as a second provider (`lib/discord-oauth.ts`), cookie sessions (`lib/sessions.ts`) and per-user API tokens (`lib/api-tokens.ts`). A few routes are public and token-authenticated (`public-*.ts`, media upload tokens).
- Plugins with their own lifecycle include the status reconciler (flips `servers.status` from `container_inspect`), the audit writer, the live-bus fan-out, heartbeat watch and orphan sweep. Docs: [components/api](../components/api/README.md), [components/live-bus](../components/live-bus/README.md), [components/api-tokens](../components/api-tokens/README.md).

## Web (`apps/web`)

No server-state library: pages use `useState`/`useEffect`, inline `fetch('/api/v1/...', { credentials: 'include', cache: 'no-store' })` and per-page polling; live events arrive on `/api/v1/ws/live`. The browser-side event union in `src/lib/live-bus.ts` is separate from the API's (`apps/api/src/plugins/live-bus.ts`) and both must change together. Design system: [components/web](../components/web/README.md).

## Workers (`apps/workers`)

Independent deployables that share types, not code. Each `src/index.ts` hand-rolls env, Postgres, Redis, `createDiag`, optionally the bridge, `startHeartbeat`, signal handling and a tick loop; copy-paste between workers is deliberate. All build from `docker/worker.Dockerfile` with `ARG WORKER`. Health is Redis-only (`worker:heartbeat:<name>`, TTL 30 s) and no worker opens a port. The heartbeat and SIGTERM contract is tested by `apps/workers/_test-shared/contract.ts`. Directory list: `ls apps/workers`.

| Group | Workers |
|---|---|
| Game server I/O | `rcon` (RCON supervisor, rosters, A2S, squad history), `log-ingest` (log parser, retention), `config-sync` (writes managed `Admins.cfg` segments through the bridge) |
| Data lifecycle | `event-partition`, `audit-archiver`, `diag-flush` (`diag:queue` to `diagnostic_events`), `metrics-sampler`, `backup` (idle placeholder; real backups run in the `restic` compose service) |
| Aggregation | `stats` (dossier reconcile guard, no compose service), `leaderboard-aggregator`, `presence-daily`, `seed-reward` |
| Access and moderation | `role-expirer`, `clan-guard`, `clan-priority-expirer`, `ban-sync` |
| Integration | `discord`, `steam-refresh`, `media-publisher`, `automation` (plugin and event-hook host) |
| Scheduling | `scheduler` (seed, rotation, scheduled tasks, map vote, season finalize ticks) |

Docs: [components/workers](../components/workers/README.md).

## Messaging

Redis Streams carry domain events in the `EventEnvelope` from `packages/shared-types` (`events:server:{id}`, `events:global`). Consumers are idempotent twice over (a Redis `SET NX` dedup key plus a `processed_events` insert) and `XACK` only after the side effect commits; consumer groups are named `<service>:v<n>`. Browser updates go through one WebSocket fed by Redis pub/sub. The RNSquadJS sidecar (`docker/rnsquadjs/plugins/panelBridge`) is a second, per-server log pipeline running beside `log-ingest`; its cutover state and open phases are in [the migration spec](../superpowers/specs/2026-04-24-rnsquadjs-migration-design.md) and [decisions.md](decisions.md). Flow detail: [data-flow.md](data-flow.md).

## Database (`packages/db`)

Drizzle schema in `src/schema/`, forward-only SQL migrations in `drizzle/` (the `migrator` compose service applies them). Drizzle cannot express triggers, partitions or guards, so hand-written DDL (idempotent snippets in `sql/`) is appended to the generated migration. `audit_log` is an append-only SHA-256 hash chain and `config_versions` is append-only, both enforced by triggers; `events` and `diagnostic_events` are range-partitioned and rotated by `event-partition`. Migrations must stay compatible with the previous release because rollbacks never undo them. Docs: [components/db](../components/db/README.md), [operations/migrations.md](../operations/migrations.md).

## Configuration source of truth

Squad's own `.cfg` files on the host remain the source of truth for live server configuration. The panel seeds them from the depot at install time, writes them through the bridge and records every write in `config_versions`.

## Components and where their docs live

| Area | Docs |
|---|---|
| API, tokens, live bus, RBAC | [api](../components/api/README.md), [api-tokens](../components/api-tokens/README.md), [live-bus](../components/live-bus/README.md), [rbac](../components/rbac/README.md) |
| Web | [web](../components/web/README.md) |
| Bridge and its client | [bridge](../components/bridge/README.md), [bridge-client](../components/bridge-client/README.md) |
| Workers | [workers](../components/workers/README.md) (one directory per documented worker) |
| Shared packages | [db](../components/db/README.md), [diag](../components/diag/README.md), [shared-types](../components/shared-types/README.md), [shared-config](../components/shared-config/README.md) |

## Delivery

Pushes to `dev` deploy the development stand; `master` is fast-forwarded from `dev` and runs the full `ci` workflow. Procedures: [deploy.md](../development/deploy.md), [ci.md](../development/ci.md), [agent-harness.md](../development/agent-harness.md). Local setup and tests: [local-development.md](../development/local-development.md), [testing.md](../development/testing.md).
