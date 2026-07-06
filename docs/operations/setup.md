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
# creates /var/lib/squad-panel/{configs,saved}, and ensures docker is present.

sudo usermod -aG panel "$USER"
newgrp panel
# Now the current shell can talk to /run/panel-host-bridge/bridge.sock.

docker compose up -d --build
# wait ~2 min, then browse to https://${APP_DOMAIN}/
```

## First-time setup

After `docker compose up -d`, the panel is ready immediately — there is no setup wizard. The 5 system roles (`Owner`, `Senior Admin`, `Admin`, `Viewer`, `Moderator`) are seeded by the DB migration.

**First login becomes Owner.** Open `https://${APP_DOMAIN}/login` and click **"Войти через Steam"**. The first Steam OpenID callback that completes on a fresh panel automatically assigns the Owner role to that Steam account (`claimFirstOwner` in `apps/api/src/lib/first-owner.ts`). All subsequent logins skip the claim. There is no `/setup` wizard and no `/api/v1/setup/*` API.

## Resetting first-owner (e.g., after rebuilding a test panel)

The trick is one-shot. To re-arm it:

1. Drop the database: `docker compose exec postgres psql -U admin -c 'DROP DATABASE admin; CREATE DATABASE admin;'` (**DESTRUCTIVE — all data lost**).
2. Apply migrations: `pnpm db:migrate`.
3. Log in via Steam — the first login becomes Owner again.

## Transferring Owner to a different Steam account

If the last Owner lost Steam access, do **not** reset the trick. Instead, assign the Owner role directly via SQL:

```sql
-- Find the Owner role:
SELECT id FROM roles WHERE name = 'Owner';
-- Assign it to the new SteamID (upsert players row first if not present):
INSERT INTO players (steam_id64, canonical_name) VALUES (<new_steam_id64>, 'NewOwner') ON CONFLICT DO NOTHING;
UPDATE players SET role_id = '<owner_role_id>' WHERE steam_id64 = <new_steam_id64>;
-- Optionally clear the former Owner:
UPDATE players SET role_id = NULL WHERE steam_id64 = <old_steam_id64>;
```

## Verifying the install

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # smoke-tests every bridge method
curl -sk https://${APP_DOMAIN}/health         # {"status":"ok"}
curl -sk https://${APP_DOMAIN}/ready          # {"status":"ready"}
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
docker compose build api web worker-rcon worker-log-ingest worker-config-sync worker-audit-archiver worker-event-partition worker-role-expirer worker-metrics-sampler
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
