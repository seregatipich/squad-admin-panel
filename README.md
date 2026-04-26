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

Open `https://<APP_DOMAIN>/` in the browser and sign in via Steam — the first user to log in claims the Owner role automatically (DB-authoritative, single transaction; an advisory lock keeps concurrent first-logins safe). Install your first Squad dedicated server from `/servers/new`; the bridge runs `steamcmd` into a shared Docker volume (first install ~20 min, ~12.8 GB), writes the 19 default `.cfg` files, opens UFW, and starts the Squad container.

## Server lifecycle

The panel owns the full destructive lifecycle — install, edit, soft-delete with backup, restore, all from the UI.

- **Soft-delete**: `DELETE /api/v1/servers/:id` first reads every `.cfg` via the bridge and persists each one as a row in `config_versions` tagged `deletion-backup-marker`. Only after the backup is durable does the orchestrator stop+remove the container, call the new `directory_delete` bridge RPC for `/var/lib/squad-panel/{configs,saved}/{uuid}`, drop UFW rules, and finally `UPDATE servers SET deleted_at = now()`. If the bridge can't read any `.cfg` the deletion aborts and the server stays alive — backups are never optional. Best-effort failures from phases 2–4 are recorded in the response body and audit log; the soft-delete still commits.
- **Archive**: `/servers/archive` lists every soft-deleted server. `/servers/archive/[id]` shows the full backup file set with sha256 + author + timestamp, with read-only viewers for each file. The partial unique index `servers_slug_active_key` lets a deleted slug be reused by an active server.
- **Restore wizard**: `/servers/archive/[id]/restore` mints a brand-new server (UUIDv7 + fresh RCON password + copied `serverSettings`), runs the standard install flow against the depot, then overlays the backed-up `.cfg` via `bridge.fileAtomicWrite` (skipping `Rcon.cfg` so the new server keeps its own credentials). Each restored file lands as a new `config_versions` row tagged `restored from server <id>`.

## Live updates

`GET /api/v1/ws/live` is a single authenticated WebSocket fed by Redis pub/sub fan-out. The status reconciler emits on container-state edges, the bridge heartbeat emits on connectivity flips, the RCON worker re-publishes its `rcon:status:{id}` writes on the `rcon:status:changed` channel — clients see changes within ~5 s instead of 10–30 s polling. The web client mounts a sticky `ConnectionBanner` that turns red when the WebSocket drops and amber when the bridge is unreachable, so operators never have to refresh to know whether an action will go through.

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