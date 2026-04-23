# Squad Admin Panel

Open-source, self-hosted web admin panel for Squad dedicated servers. Install with one command; manage servers, players, and audit trail from a browser. Phase 0 foundation.

## Quick start (tested on Ubuntu 22.04 / 24.04 LTS and Debian 12)

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Edit .env: set APP_DOMAIN, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET.
# Generate secrets with:   openssl rand -base64 32

sudo ./scripts/install-host-bridge.sh

# Log out and back in once (adds your user to the 'panel' group), then:
docker compose up -d

# Wait ~2 minutes for healthchecks; open https://admin.localhost/ (or your APP_DOMAIN).
```

The browser takes you through the setup wizard: org → first owner user → 2FA → done. Install your first Squad dedicated server from the dashboard; the Go bridge runs steamcmd, generates the systemd unit, opens the firewall, and starts the server for you.

## Repository layout

```
apps/
  api/              Fastify API (REST + WebSocket)
  web/              Next.js 15 App Router
  bridge/           Go privileged daemon (panel-host-bridge)
  workers/          Redis Streams consumers (log-ingest, rcon, audit-archiver, ...)
packages/
  shared-types/     Zod schemas (event envelope, API models)
  shared-config/    Permission keys, constants
  db/               Drizzle schema + migrations
  bridge-client/    TypeScript client for the Go bridge
scripts/            install-host-bridge.sh, verify-bridge.sh, uninstall.sh
docker/             Dockerfiles + Caddyfile
docs/               Architecture, protocol, rbac, security, troubleshooting
```

## Docs

- [architecture.md](docs/architecture.md) — component diagram and data flow
- [bridge-protocol.md](docs/bridge-protocol.md) — wire format for the 14 RPC methods
- [event-envelope.md](docs/event-envelope.md) — shape and versioning
- [rbac.md](docs/rbac.md) — permission keys and clearance model
- [security.md](docs/security.md) — threat model and hardening details
- [development.md](docs/development.md) — local dev setup
- [troubleshooting.md](docs/troubleshooting.md) — common issues

## License

See [LICENSE](LICENSE).