# Squad Admin Panel

Open-source, self-hosted web admin panel for Squad dedicated servers. Install with one command; manage servers, players, and audit trail from a browser. Phase 0 foundation.

## Quick start (tested on Ubuntu 22.04 / 24.04 LTS and Debian 12)

**Prerequisites**: Docker Engine + Compose v2 installed (see [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)). Everything else is handled by the bootstrap script.

```bash
git clone https://github.com/breaking-squad/squad-admin-panel.git
cd squad-admin-panel
sudo ./scripts/bootstrap.sh
```

That's it. The script is idempotent — safe to re-run if anything fails.

What it does:

1. Installs the privileged Go host-bridge (`systemd` unit + socket + `panel` group + allow-listed host dirs).
2. Generates `.env` with fresh 32-byte `POSTGRES_PASSWORD` / `APP_ENCRYPTION_KEY` / `SESSION_SECRET` and the matching `PANEL_GID`. **Copy the printed `APP_ENCRYPTION_KEY` offline** — losing it means RCON passwords in the DB can no longer be decrypted.
3. Adds `127.0.0.1 <APP_DOMAIN>` to `/etc/hosts` when using a dev-only domain (`*.lan`, `*.localhost`, `*.test`, `*.local`).
4. Runs `docker compose up -d --build` and waits for `api` + `caddy` to become healthy.

Default `APP_DOMAIN` is `squad-panel.lan`. For a real domain, edit `.env` before starting (`APP_DOMAIN=admin.example.com`, `TLS_ISSUER=acme`, `ACME_EMAIL=you@example.com`, `COOKIE_SECURE=true`) and re-run the bootstrap.

Open `https://<APP_DOMAIN>/` in the browser — the setup wizard walks you through org → owner user → done. Install your first Squad dedicated server from `/servers/new`; the bridge runs `steamcmd` into a shared Docker volume (first install ~20 min, ~12.8 GB), writes the 19 default `.cfg` files, opens UFW, and starts the Squad container.

### Uninstall

```bash
sudo ./scripts/uninstall.sh          # removes host bridge + systemd units
docker compose down -v --remove-orphans   # drops DB, Redis, caddy volumes
docker volume rm squad-depot         # drops the 12 GB SteamCMD cache
sudo rm -rf /var/lib/squad-panel     # drops per-server configs + saved/
```

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
docs/               README.md + architecture/, components/<name>/, operations/, development/
```

## Docs

Start at [`docs/README.md`](docs/README.md) — it indexes everything.

- [`docs/architecture/`](docs/architecture/) — system overview, data flow, RBAC, security, decisions
- [`docs/components/`](docs/components/) — per-component docs (api, web, bridge, workers, db, …)
- [`docs/operations/`](docs/operations/) — setup, environment variables, troubleshooting
- [`docs/development/`](docs/development/) — local development, testing

## License

See [LICENSE](LICENSE).