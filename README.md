# Squad Admin Panel

Open-source, self-hosted web admin panel for Squad dedicated servers. Install with one command; manage servers, players, and audit trail from a browser.

## Quick start (Ubuntu 22.04 / 24.04 LTS, Debian 12+)

**Prerequisites**: Docker Engine + Compose v2 ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)).

```bash
git clone https://github.com/seregatipich/squad-admin-panel.git
cd squad-admin-panel
sudo ./scripts/bootstrap.sh
```

The script is idempotent — safe to re-run. What it does:

1. Installs the privileged Go host-bridge (systemd unit + socket + `panel` group).
2. Creates the `data/` tree for PostgreSQL, Redis, Caddy, depot, and per-server files.
3. Generates `.env` with fresh secrets (`POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`). **Copy the printed `APP_ENCRYPTION_KEY` offline** — losing it means RCON passwords in the DB can no longer be decrypted.
4. Adds `127.0.0.1 <APP_DOMAIN>` to `/etc/hosts` for dev domains (`*.lan`, `*.localhost`, `*.test`, `*.local`).
5. Runs `docker compose build` and `docker compose up -d`, then waits for health checks.

Default domain is `squad-panel.lan`. For production, edit `.env` before starting:

```env
APP_DOMAIN=admin.example.com
TLS_ISSUER=acme
ACME_EMAIL=you@example.com
COOKIE_SECURE=true
```

Open `https://<APP_DOMAIN>/` — the first Steam login claims the Owner role automatically.

## Rebuild from scratch

Wipes everything — database, Redis, Caddy certs, per-server data, and the ~12 GB SteamCMD depot cache. Only `.env` secrets and the host bridge are preserved.

```bash
sudo ./scripts/rebuild.sh
```

## Architecture

```
                         ┌──────────┐
                         │  Caddy   │ :80/:443 reverse proxy + TLS
                         └────┬─────┘
                    ┌─────────┼─────────┐
                    │         │         │
               ┌────▼───┐ ┌──▼──┐ ┌────▼────┐
               │  API   │ │ Web │ │ Workers  │  (7 active + 5 stubs)
               │Fastify │ │Next │ │  Node.js │
               └──┬──┬──┘ └─────┘ └────┬────┘
                  │  │                  │
           ┌──────┘  └──────┐           │
      ┌────▼────┐     ┌────▼────┐  ┌───▼────┐
      │Postgres │     │  Redis  │  │ Bridge │  Go daemon (root)
      │  16     │     │   7     │  │  Unix  │  25 RPC methods
      └─────────┘     └─────────┘  │ socket │
                                   └───┬────┘
                                       │
                              ┌────────▼────────┐
                              │  Host system    │
                              │ Docker, UFW,    │
                              │ SteamCMD, files │
                              └─────────────────┘
```

### Services (docker-compose.yml)

| Service | Role |
|---------|------|
| **caddy** | Reverse proxy, TLS termination (self-signed or ACME) |
| **api** | Fastify REST + WebSocket server, auth, RBAC, audit logging |
| **web** | Next.js 15 / React 19 dashboard |
| **migrator** | One-shot Drizzle migration runner |
| **worker-rcon** | RCON polling + A2S UDP queries |
| **worker-log-ingest** | Docker log tailing, Squad log parsing |
| **worker-metrics-sampler** | Host metrics collection (CPU, memory, disk) |
| **worker-diag-flush** | Diagnostic event batching to database |
| **worker-audit-archiver** | Cold-archives audit log rows >90 days |
| **worker-event-partition** | Monthly partition rotation |
| **worker-config-sync** | Config sync (stub) |
| **postgres** | PostgreSQL 16 |
| **redis** | Redis 7 (pub/sub, streams, cache) |

### Key features

- **Server lifecycle**: install, edit, soft-delete with backup, restore from archive
- **Live updates**: single WebSocket per client via Redis pub/sub; status changes within ~5s
- **Config editor**: Monaco-based `.cfg` editor with versioned history
- **RCON + A2S**: live player list, server info, tickrate, kick/ban
- **Monitoring**: CPU/memory time-series charts, lag spike detection, crash loop detection
- **Tag management**: tag servers with chips, filter by tags
- **License management**: license key storage with encryption
- **Game updates**: coordinated depot update with server stop/restart
- **Audit trail**: append-only audit log with SHA-256 chain integrity
- **RBAC**: Owner, SeniorAdmin, Admin, Moderator, Viewer roles

## Repository layout

```
apps/
  api/              Fastify API (REST + WebSocket)
  web/              Next.js 15 App Router
  bridge/           Go privileged daemon (panel-host-bridge)
  workers/          Redis Streams consumers (rcon, log-ingest, metrics, ...)
packages/
  shared-types/     Zod schemas (event envelope, API models)
  shared-config/    Permission keys, constants, heartbeat
  db/               Drizzle schema + migrations
  bridge-client/    TypeScript client for the Go bridge
  diag/             Diagnostic event utilities
scripts/            bootstrap.sh, rebuild.sh, uninstall.sh, verify-bridge.sh
docker/             Dockerfiles + Caddyfile
docs/               Architecture, component docs, operations, development
```

## Development

**Requirements**: Node.js 22+, pnpm 9+, Go 1.25.13+ (for bridge), Docker.

```bash
pnpm install
pnpm build
pnpm dev                         # all apps in dev mode (turbo)
pnpm test                        # run all tests
pnpm typecheck                   # TypeScript checks
pnpm lint                        # biome check
```

Dev compose override (hot-reload for API and Web):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

### Database

```bash
pnpm db:generate                 # regenerate Drizzle schema
pnpm db:migrate                  # run pending migrations
pnpm db:studio                   # open Drizzle Studio GUI
```

### Bridge

```bash
pnpm bridge:build                # build Go binary
pnpm bridge:test                 # run Go tests
sg panel -c "bash scripts/verify-bridge.sh"   # smoke test
```

## Operations

### Useful commands

```bash
docker compose ps                            # stack state
docker compose logs -f api                   # tail API logs
docker compose logs -f worker-rcon           # tail RCON worker
pnpm verify:audit-chain                      # validate audit log integrity
```

### Uninstall

```bash
sudo ./scripts/uninstall.sh                  # removes host bridge + systemd units
docker compose down -v --remove-orphans      # drops DB, Redis, Caddy volumes
docker volume rm squad-depot                 # drops the SteamCMD cache (~12 GB)
sudo rm -rf /var/lib/squad-panel             # drops per-server configs + saves
```

### Environment variables

See [`.env.example`](.env.example) for all variables. Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_DOMAIN` | yes | FQDN for the panel |
| `POSTGRES_PASSWORD` | yes | PostgreSQL password (auto-generated) |
| `APP_ENCRYPTION_KEY` | yes | 32-byte key for RCON password encryption |
| `SESSION_SECRET` | yes | 32-byte key for session signing |
| `TLS_ISSUER` | no | `internal` (default) or `acme` for Let's Encrypt |
| `STEAM_API_KEY` | no | Steam Web API key for player lookups |

## Docs

Start at [`docs/README.md`](docs/README.md) for the full index:

- [`docs/architecture/`](docs/architecture/) — system overview, data flow, RBAC, security, ADRs
- [`docs/components/`](docs/components/) — per-component docs (API, web, bridge, workers, DB)
- [`docs/operations/`](docs/operations/) — setup, env vars, deployment, troubleshooting
- [`docs/development/`](docs/development/) — local dev, testing, conventions

## License

See [LICENSE](LICENSE).
