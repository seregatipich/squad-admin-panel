# Local development

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12 (the bridge uses Linux-only APIs).
- Docker Engine 24+ and Compose v2.
- Node 22, pnpm 9.15 (the repo pins via `packageManager`), Go 1.25.
- `sudo` access for [`scripts/install-host-bridge.sh`](../../scripts/install-host-bridge.sh).

## First run

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill APP_DOMAIN, POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SESSION_SECRET.
# Generate: openssl rand -base64 32

pnpm install
pnpm turbo run typecheck
pnpm turbo run test

sudo ./scripts/install-host-bridge.sh
# log out / log back in (or `newgrp panel`) so the panel-group membership applies

docker compose up -d --build
# wait ~2 min, then browse to https://admin.localhost/ (or your APP_DOMAIN)
```

## Useful pnpm commands

| Command | Purpose |
|---|---|
| `pnpm turbo run dev --parallel` | Every workspace's `dev` script with hot reload. |
| `pnpm --filter @squad/api dev` | API only, watches source. |
| `pnpm --filter @squad/web dev` | Next.js dev server on port 3000. |
| `pnpm turbo run test` | Every workspace's `test` (unit + integration; e2e excluded). |
| `pnpm turbo run typecheck` | TS strict check everywhere; runs `go build` on the bridge. |
| `pnpm exec biome check .` | Lint + format. Add `--write` to auto-fix. |
| `pnpm verify:audit-chain` | Out-of-band hash-chain validation. |
| `pnpm db:generate` | After editing a schema file (review the SQL by hand). |
| `pnpm db:migrate` | Apply migrations. Requires `DATABASE_URL`. |
| `pnpm db:studio` | Drizzle Studio. |

## Bridge development

```bash
cd apps/bridge
make build       # static binary at bin/panel-host-bridge
make test        # `go test -race -count=1 ./...`
go vet ./...     # also enforced by lefthook pre-commit
gofmt -l -s .    # nothing should print
govulncheck ./...
```

Install the freshly-built binary over the system one when iterating:

```bash
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

`cp` over the system binary while the service is running fails with "Text file busy" — `install` does atomic replace.

## E2E

The e2e suite hits the live stack and the real bridge. It is **excluded from `pnpm turbo run test`** on purpose.

```bash
# Get a session cookie: log in via the browser → devtools → Application → Cookies
# → copy the value of __Host-sid.
export PANEL_TEST_URL=https://squad-panel.lan
export PANEL_TEST_COOKIE=s_019dbaa5-xxx
pnpm --filter @squad/api test:e2e
```

Two files must stay green:

- [`install-lifecycle.e2e.test.ts`](../../apps/api/test/e2e/install-lifecycle.e2e.test.ts) — the full create→install→start→edit→stop→delete flow.
- [`bridge-rpc.e2e.test.ts`](../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) — every whitelisted method, success + forbidden.

## Regenerating migrations

```bash
cd packages/db
DATABASE_URL=postgres://admin:admin@localhost:5432/admin pnpm generate
```

Phase 0 ships hand-written `0000_init.sql` and follow-ups because Drizzle's auto-generator misses the audit hash-chain trigger, partitioning, and functional indexes. After editing a schema file, re-run `generate` and merge the new SQL by hand — keep the hand-written triggers intact.

## Optional: SOPS-encrypted .env

For shared dev environments:

```bash
sops -e .env > .env.sops
echo '.env.sops filter=sops diff=sops' >> .gitattributes
```

Operators decrypt with their age key on `compose up`.
