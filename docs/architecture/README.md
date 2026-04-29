# Architecture

The panel is a single-host system with three privilege zones and narrow contracts between them.

## Subsystems

| Zone | What runs there | Privilege |
|---|---|---|
| **Host daemon** ([`apps/bridge`](../components/bridge/README.md)) | Go binary listening on `/run/panel-host-bridge/bridge.sock` | root, `CAP_NET_ADMIN` for `ufw` |
| **Containers** | API, web, workers, Postgres, Redis (via `docker compose`) | unprivileged users inside containers; talk to bridge over the unix socket only |
| **Per-server containers** | One `squad-server:latest` container per game server, `--network host`, bind-mounted configs, shared depot volume | uid 1001 inside the container |

External services: only Steam CDN (read-only via `depot_update`) and Epic Online Services (used by Squad itself for matchmaking).

## Component relationships

```
            ┌─────────────────────────────────────────────────────────┐
            │                  Linux host                             │
            │                                                         │
   browser ─┼─▶ Caddy ─▶ web (Next.js) ────────┐                      │
            │           api (Fastify) ─┐       │                      │
            │             ▲            ▼       ▼                      │
            │             │         Postgres  Redis Streams           │
            │             │            ▲       ▲                      │
            │             │            │       │                      │
            │             │      workers (rcon, log-ingest, archiver, │
            │             │              event-partition, stubs)      │
            │             │                                           │
            │             ▼                                           │
            │   /run/panel-host-bridge/bridge.sock (unix, 0660 root:panel)   │
            │             │                                           │
            │             ▼                                           │
            │     panel-host-bridge (Go, root, systemd-managed)       │
            │             │                                           │
            │             ▼                                           │
            │   docker run … squad-server:latest --network host       │
            │             │                                           │
            │             ▼                                           │
            │   one container per Squad server                        │
            │                                                         │
            └─────────────────────────────────────────────────────────┘
```

## Architectural constraints

- **Single host, single compose stack.** Multi-host orchestration is explicitly out of scope.
- **The bridge is the only path to root.** Anything that requires privilege (`docker run`, `ufw` rules, writes under `/var/lib/squad-panel/`) goes through it. RPC method names are pinned by [`packages/shared-config/src/bridge-methods.ts`](../../packages/shared-config/src/bridge-methods.ts).
- **`SquadGame/ServerConfig/*.cfg` is the source of truth for live config.** SteamCMD ships the templates inside the depot volume; the install flow seeds host-side copies, and from then on the host files are RW-mounted into the container. Squad re-reads a subset live (`Admins.cfg`, `Bans.cfg`, `Remote*ListHosts.cfg`).
- **Audit log is append-only and hash-chained.** A DB trigger rejects `UPDATE`/`DELETE`. `pnpm verify:audit-chain` validates integrity out-of-band.
- **RNSquadJS is not a dependency.** The RCON wire client and log parser are our own code (`apps/workers/rcon/src/protocol.ts`, `apps/workers/log-ingest/src/parser/`). We do not vendor or fork RNSquadJS.

## Where to look next

- For *what runs and why*, read [system-overview.md](system-overview.md).
- For *how data moves*, read [data-flow.md](data-flow.md).
- For *who can do what*, read [rbac.md](rbac.md).
- For *threat model*, read [security.md](security.md).
- For *why it's designed this way*, read [decisions.md](decisions.md).
