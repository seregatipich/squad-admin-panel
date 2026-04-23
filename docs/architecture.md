# Architecture

## Components (Phase 0)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Linux host (Ubuntu/Debian)                        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                     Docker Compose stack                     │       │
│  │  ┌─────────┐    ┌─────────┐    ┌──────────┐                 │       │
│  │  │  Caddy  │───▶│   Web   │    │   API    │                 │       │
│  │  │  (TLS)  │    │ Next.js │    │ Fastify  │                 │       │
│  │  └─────────┘    └─────────┘    └────┬─────┘                 │       │
│  │                                      │                       │       │
│  │                                 ┌────▼────┐                  │       │
│  │                                 │  Redis  │                  │       │
│  │                                 │ Streams │                  │       │
│  │                                 └──┬───┬──┘                  │       │
│  │            ┌───────────────────────┤   ├─────────────┐       │       │
│  │      ┌─────▼───────┐      ┌───────▼───▼───┐   ┌─────▼─────┐ │       │
│  │      │worker-log-  │      │    Workers    │   │ Postgres  │ │       │
│  │      │ingest       │      │ audit-arch,   │   │  (all     │ │       │
│  │      │worker-rcon  │      │ event-part,   │   │  panel    │ │       │
│  │      │             │      │ stubs others  │   │  data)    │ │       │
│  │      └─────┬───────┘      └─────┬─────────┘   └───────────┘ │       │
│  │            │                     │                           │       │
│  └────────────┼─────────────────────┼───────────────────────────┘       │
│               │ RCON+logs           │ bind-mount                         │
│               │ (127.0.0.1)         │ + peer credentials                 │
│               │             ┌───────▼────────────────┐                   │
│               │             │  panel-host-bridge     │ (native systemd)  │
│               │             │  - Go 1.22, 4 MB       │                   │
│               │             │  - JSON-RPC framed     │                   │
│               │             │  - Systemd ops         │                   │
│               │             │  - steamcmd, apt, ufw  │                   │
│               │             │  - SO_PEERCRED auth    │                   │
│               │             └───────┬────────────────┘                   │
│               │                     │ systemctl                          │
│               │             ┌───────▼────────────────────────┐           │
│               └────────────▶│  Squad servers (native systemd) │          │
│                             │  squad-server-{uuid}.service   │           │
│                             │  /opt/squad-servers/{uuid}/    │           │
│                             └────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data flow

**Install a server:** user → web UI → `POST /api/v1/servers` → API writes row (status=`pending`) → API calls `bridge.steamcmd_run(args)` via unix socket → Go bridge validates args against whitelist → streams stdout back as `stream:stdout` frames → `bridge.file_atomic_write` for Rcon.cfg/Server.cfg edits → `bridge.systemctl_write_unit` + `daemon_reload` + `enable` → `bridge.ufw_rule add` for each port.

**Start a server:** user → `POST /api/v1/servers/{id}/start` → API updates `servers.status = 'starting'` → `bridge.systemctl_action { action: 'start' }` → systemd launches Squad → worker-log-ingest picks up the new running server on its 15 s reconcile → opens journalctl_follow via bridge → emits `server.ready` on beacon-port bind.

**Live player list:** worker-rcon's 15 s reconcile notices the server is running → opens TCP RCON to 127.0.0.1:21114 → authenticates → polls `ListPlayers` every 30 s → UPSERTs `players` and `player_name_history` → publishes `rcon.players_polled` envelope to Redis Stream `events:server:{uuid}`.

## Trust boundaries

The Go bridge runs as **root** and is the only privileged component. Everything else runs as the unprivileged `node` user inside containers and talks to the bridge only over the unix domain socket `/run/panel-host-bridge.sock`, which is mode `0660 root:panel`. The bridge:

1. Accepts a new connection → `getsockopt(SO_PEERCRED)` → checks caller UID is in the `panel` group; drops the connection otherwise.
2. Runs **every** privileged call through a whitelist validator (paths, unit names, apt packages, steamcmd args, ufw action/port/proto).
3. Emits structured logs for every rejected call with the peer's PID, UID, and the reason so an operator can tell legitimate failures from attack attempts.

The `panel` group membership is the one "sensitive" permission panel requires on the host — we recommend limiting it to the Docker-group member(s) that actually run compose.

## Identity model

- `users.id` is a UUIDv7 (app-generated).
- `players.steam_id64` is a `bigint` — SteamID64 is the canonical identity; EOS ID, BE GUID, IP live in sibling columns or history tables.
- Sessions are opaque IDs (server-side-only lookup), not JWTs. Cookie is `__Host-sid` (Secure; HttpOnly; SameSite=lax; Path=/; no domain attribute).

## Event envelope

Every event flowing through Redis Streams uses the same envelope. `packages/shared-types/src/events.ts` is the source of truth; never bypass it.

```ts
interface EventEnvelope {
  event_id: string;           // UUIDv7, sortable
  version: number;            // schema version, starts at 1
  type: EventType;            // enum member
  server_id: string | null;   // null for global events
  ts: string;                 // ISO-8601 UTC
  actor: { kind: 'user'|'system'|'external'; id: string|null } | null;
  correlation_id: string | null;
  payload: unknown;           // typed per `type`
}
```

Consumers live under `apps/workers/*`. Dual-layer idempotency is enforced on both sides:

- **Producer** best-effort `SET dedup:${group}:${event_id} 1 EX 86400 NX`.
- **Consumer** both Redis SETNX **and** a PG `processed_events` UPSERT before acting.

## Testing

- `pnpm turbo run test` runs every workspace's unit tests.
- `pnpm turbo run typecheck` runs every TS project plus `go build` on the bridge.
- Integration tests that need a live DB + Redis run behind `pnpm --filter @squad/api test:integration`.
- E2E (Playwright) under `apps/web/test/e2e/` drives the setup wizard, login, and install flow against a hermetic mock-SteamCMD container.
- §17.8 live-player E2E requires a real Squad client; documented as a manual gate in `docs/troubleshooting.md`.
