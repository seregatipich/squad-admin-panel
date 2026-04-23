# Local development

## Prereqs

- Ubuntu 22.04 / 24.04 LTS or Debian 12. (Yes, even for dev — the bridge uses Linux-only APIs.)
- Docker 24+ and compose v2.
- Node 22, pnpm 9.15.0 (the repo pins via Corepack), Go 1.22+.
- `sudo` access for the `install-host-bridge.sh` script.

## First run

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Edit .env: APP_DOMAIN, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET.
# Generate secrets:
#   openssl rand -base64 32

pnpm install
pnpm turbo run typecheck
pnpm turbo run test

sudo ./scripts/install-host-bridge.sh
# log out / log back in so your user's 'panel' group membership takes effect

docker compose up -d --build
# wait ~2 min, then browse to https://admin.localhost/ (or your APP_DOMAIN)
```

## Useful pnpm commands

| Command                              | What it does                                                      |
|--------------------------------------|-------------------------------------------------------------------|
| `pnpm turbo run dev --parallel`      | Launches every workspace's `dev` script (hot reload).             |
| `pnpm --filter @squad/api dev`       | API only, watches source.                                         |
| `pnpm turbo run test`                | Every workspace's `test` target (unit + integration).             |
| `pnpm turbo run typecheck`           | TS strict check everywhere; runs `go build` on the bridge.        |
| `pnpm exec biome check .`            | Lint + format. Add `--write` to auto-fix.                         |
| `pnpm verify:audit-chain`            | Out-of-band hash-chain validation for `audit_log`.                |

## Bridge development

```bash
cd apps/bridge
make build     # static binary at bin/panel-host-bridge
make test      # `go test -race -count=1 ./...`
make lint      # `go vet` + `gofmt -l -s`
make vulncheck # `govulncheck ./...`
```

Install the freshly built binary over the system one when iterating on bridge code:

```bash
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

## Running a mock SteamCMD for CI / hermetic tests

We ship a tiny mock SteamCMD container in `docker/squad-mock-depot/` that serves a pre-seeded tarball so integration tests don't have to reach Steam's CDN. Point the bridge at it with:

```bash
PANEL_BRIDGE_STEAMCMD=/opt/squad-mock-depot/steamcmd-mock.sh docker compose up
```

## Regenerating migrations

```bash
cd packages/db
DATABASE_URL=postgres://admin:admin@localhost:5432/admin pnpm generate
```

Phase 0 ships hand-written `0000_init.sql` because Drizzle's auto-generator misses the audit hash-chain triggers, partitioning, and functional indexes. After editing a schema file, re-run `generate` and merge the new SQL by hand (keep the hand-written triggers intact).
