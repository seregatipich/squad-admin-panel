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
# Fill in: APP_DOMAIN, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET.
# Generate secrets:
#   openssl rand -base64 32
# Save APP_ENCRYPTION_KEY OFFLINE — losing it makes encrypted secrets unrecoverable.

sudo ./scripts/install-host-bridge.sh
# Idempotent. Creates the `panel` system group, installs the systemd unit + socket,
# creates /var/lib/squad-panel/{configs,saved}, and ensures docker is present.

sudo usermod -aG panel "$USER"
newgrp panel
# Now the current shell can talk to /run/panel-host-bridge.sock.

docker compose up -d --build
# wait ~2 min, then browse to https://${APP_DOMAIN}/
```

The first `/setup` page asks for owner email + password. Once submitted, the endpoint guards against re-runs (`410 setup_already_complete`).

## Verifying the install

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # smoke-tests every bridge method
curl -sk https://${APP_DOMAIN}/health         # {"status":"ok"}
curl -sk https://${APP_DOMAIN}/ready          # {"status":"ready"}
```

`scripts/verify-bridge.sh` exits non-zero on any unexpected response.

## First Squad server

1. Log in. Create a server in the install wizard.
2. The first install triggers `bridge.depot_update` — this takes ~25 minutes (≈45 GB) on a clean host. Subsequent installs reuse the depot volume.
3. After `depot_update` finishes, the wizard seeds 19 cfg files, opens UFW rules, and starts the container.
4. The dashboard's RCON status indicator turns green within ~30 s of the container reaching `running`.

## Updating the panel itself

```bash
git pull
docker compose build api web worker-rcon worker-log-ingest worker-audit-archiver worker-event-partition worker-metrics-sampler
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
