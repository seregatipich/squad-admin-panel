# Setup

## Host requirements

- Ubuntu 22.04 / 24.04 LTS or Debian 12. (Yes, even for dev — the bridge uses Linux-only APIs.)
- Docker Engine 24+ and Compose v2.
- Public IPv4 if you want the Squad server to appear in the community browser; LAN-only is fine for dev.
- ~50 GB free disk for the depot volume.

## First install

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill in: APP_DOMAIN, PANEL_PUBLIC_URL, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET.
# PANEL_PUBLIC_URL must be the full public URL (e.g. https://squad-panel.example.com).
# It is required for Steam OpenID return_to host-binding.
# Generate secrets:
#   openssl rand -base64 32
# Save APP_ENCRYPTION_KEY OFFLINE — losing it makes encrypted secrets unrecoverable.
# STEAM_API_KEY is optional; without it player names fall back to "Player <last 4 of SteamID>".

sudo ./scripts/install-host-bridge.sh
# Idempotent. Creates the `panel` system group, installs the systemd unit + socket,
# creates the data tree, provisions the squad-depot bind volume, and updates
# DATA_DIR + PANEL_GID in .env when the file exists.

sudo usermod -aG panel "$USER"
newgrp panel
# Now the current shell can talk to /run/panel-host-bridge/bridge.sock.

docker compose up -d --build
# wait ~2 min, then browse to https://${APP_DOMAIN}/
```

## First-time setup

After `docker compose up -d`, the API, web, DB, Redis, workers, and bridge should be healthy before the first login. The 5 system roles (`Owner`, `Senior Admin`, `Admin`, `Viewer`, `Moderator`) are seeded by DB migrations.

**First login becomes Owner.** Open `https://${APP_DOMAIN}/login` and click **"Войти через Steam"**. The first Steam OpenID callback that completes on a fresh panel automatically assigns the Owner role to that Steam account (`claimFirstOwner` in `apps/api/src/lib/first-owner.ts`). All subsequent logins skip the claim.

After the Owner session is created, the dashboard layout checks `GET /api/v1/setup/status`. If `setup_completed=false`, the browser is redirected to `/setup`. Enter the organization/community name and submit; `POST /api/v1/setup/complete` stores it and marks setup complete. A completed panel redirects `/setup` back to `/`.

## Resetting first-owner (e.g., after rebuilding a test panel)

The trick is one-shot. To re-arm it:

1. Drop the database: `docker compose exec postgres psql -U admin -c 'DROP DATABASE admin; CREATE DATABASE admin;'` (**DESTRUCTIVE — all data lost**).
2. Apply migrations: `pnpm db:migrate`.
3. Log in via Steam — the first login becomes Owner again.

## Transferring Owner to a different Steam account

If the last Owner lost Steam access, do **not** reset the trick or hand-edit the
session tables. Run the repository command against the target database:

```bash
pnpm --silent mint:owner-session -- \
  --steam-id64 '<new SteamID64>' \
  --confirm-steam-id64 '<new SteamID64>' \
  --name '<current player name>'
```

Load `DATABASE_URL` from the deployment's protected environment before running
the command; do not paste the credential into shell history.

The command atomically creates or updates the player, assigns the system Owner
role without an expiry, queues `Admins.cfg` reconciliation, appends a hash-chain
audit row, and prints a six-hour panel session token. For an existing player it
preserves the identity already collected from Squad. The database stores only
the token hash. Treat stdout as a secret: do not paste it into logs, issues, or
chat. Use the token only as the `__Host-sid` cookie on the target panel, then
revoke the temporary session from the account page after recovery. An API
process that cached this player's old permissions can take up to 30 seconds to
observe the new role.

Clearing the former Owner is a separate, deliberate action. Use the panel after
signing in with the recovered account so the last-Owner invariant remains in
force.

## Verifying the install

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # smoke-tests every bridge method
curl -sk https://${APP_DOMAIN}/health         # {"status":"ok"}
curl -sk https://${APP_DOMAIN}/ready          # {"status":"ok","checks":{...}}
curl -skI https://${APP_DOMAIN}/api/docs       # API docs UI responds
```

`scripts/verify-bridge.sh` exits non-zero on any unexpected response.

## First Squad server

1. Log in via Steam. Create a server in the install wizard.
2. The first install triggers `bridge.depot_update` — this takes ~25 minutes (≈45 GB) on a clean host. Subsequent installs reuse the depot volume.
3. After `depot_update` finishes, the wizard seeds 19 cfg files, opens UFW rules, and starts the container.
4. The dashboard's RCON status indicator turns green within ~30 s of the container reaching `running`.

## Updating the panel itself

```bash
git pull
docker compose build api web worker-rcon worker-log-ingest worker-config-sync worker-audit-archiver worker-event-partition worker-role-expirer worker-seed-reward worker-metrics-sampler worker-media-publisher
docker compose up -d
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

The bridge is deployed separately:

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

## Updating Squad

```bash
# Trigger from the UI (Settings → Depot → Update), OR from a host shell:
curl -sk -X POST https://${APP_DOMAIN}/api/v1/depot/update \
     -H "Cookie: __Host-sid=${SID}" \
     | tee /tmp/depot-update.log
```

After `depot_update` finishes, restart each running server container so it picks up the new files. The depot volume is RO-mounted into the server container, so an existing container keeps the old code until it's restarted.
