# Local development

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12 (the bridge uses Linux-only APIs).
- Docker Engine 24+ and Compose v2.
- Node 22, pnpm 9.15 (the repo pins via `packageManager`), Go 1.25.13+.
- `sudo` access for [`scripts/install-host-bridge.sh`](../../scripts/install-host-bridge.sh).

## First run

```bash
git clone git@github.com:seregatipich/squad-admin-panel.git
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
| `pnpm --silent mint:owner-session -- --steam-id64 <id> --confirm-steam-id64 <id> --name <name>` | Promote a player to Owner and print a six-hour panel session token. Requires `DATABASE_URL`; treat stdout as a secret. |

## Git hooks

`pnpm install` installs the [lefthook](../../lefthook.yml) hooks. Bypass them only in a genuine emergency, with `--no-verify`.

### pre-commit

Runs in parallel on the staged files:

| Command | Runs for | What it does |
|---|---|---|
| `branch-guard` | every commit | `scripts/git-guard.sh check-commit` — refuses direct commits on `master`, `dev` (except mid-merge) and `main`. See [agent-harness.md](agent-harness.md). |
| `biome-check` | staged `*.{ts,tsx,js,jsx,json,css}` | `biome check` on the staged files. |
| `go-fmt` | staged `apps/bridge/**/*.go` | Fails when `gofmt -l -s` lists a file (fix with `gofmt -w -s apps/bridge`), then runs `go vet ./...` for `GOOS=linux GOARCH=amd64`: the bridge uses Linux-only syscalls, so a native `go vet` fails on macOS. Skipped when `go` is not installed. |
| `gitleaks` | every commit | `gitleaks protect --staged`; a finding blocks the commit. Skipped when `gitleaks` is not installed. |

### pre-push

`branch-guard` checks the pushed refspecs, then `checklist` runs [`scripts/pre-push-checklist.sh`](../../scripts/pre-push-checklist.sh). A push to `dev` deploys the tk104 stand without tests, so the checklist is the last check before the stand; the full suite runs in `ci` once the tip is promoted to `master`. It therefore checks only what the branch changed, and runs on every push, the dev→master promotion included:

1. `git fetch origin dev` — offline, the local `origin/dev` ref is used as is.
2. `biome check apps packages scripts docker/rnsquadjs`.
3. gitleaks over the commits `origin/dev..HEAD` (only if `gitleaks` is installed).
4. `turbo run typecheck` for the packages changed since `origin/dev` and their dependents.
5. `turbo run test` for the changed packages only, not their dependents. In `apps/api` only the test files the diff touches run (`vitest run <files>`); a change to API source alone is typechecked and left to `ci`.
6. `pnpm test:scripts`, only when `scripts/` or `.github/` changed.

"Changed" means changed since the merge base with `origin/dev`, including uncommitted and untracked files, so commits that landed on `dev` after the branch forked never count as the branch's own changes.

Measured on 2026-09-26 for a one-line change in a worker: 25 s with an empty turbo cache and 26 s for the next change on a warm cache; the full sequence the checklist used to run by default took 136 s and 49 s for the same changes, and on a branch two commits behind `dev` it selected the tests of all 32 packages instead of one.

Suites that need Postgres or Redis — `@squad/api`, `@squad/db`, most workers and `test:scripts`; a package counts when its tests, test helpers or `vitest.config` read `DATABASE_URL` or `REDIS_URL` — run against:

- an exported `DATABASE_URL` (`TEST_DATABASE_URL` defaults to it);
- otherwise, when `.env` exists and Docker runs the local stack, a database of this worktree, `test_prepush_<worktree directory>`, created and migrated by [`scripts/new-test-db.sh`](../../scripts/new-test-db.sh) and kept between pushes so a push applies only new migrations. Drop it after removing the worktree: `docker exec <postgres container> dropdb -U admin test_prepush_<name>`;
- otherwise a throwaway database on a native Postgres at `127.0.0.1:5432` that accepts the `.env` password.

Without any of them the checklist skips those suites with a warning instead of blocking the push.

`FULL=1 bash scripts/pre-push-checklist.sh` runs the full gate instead: full typecheck, `biome check .`, the production build (skip with `SKIP_BUILD=1`), gitleaks, `test:scripts`, `test:cov` and the mutation suite, and fails when no database is available. Run it before a promotion you want to be confident about. `PREPUSH_TURBO_CONCURRENCY` (default `2`) limits the parallel package tests; `VITEST_MAX_FORKS` limits Vitest workers.

Turbo 2.9 shares one cache between all worktrees of a clone (the main checkout's `.turbo/cache`), so packages another worktree already built or typechecked are cache hits; an exported `TURBO_CACHE_DIR` overrides the location. `@squad/web` tests depend only on its dependencies' builds ([`apps/web/turbo.json`](../../apps/web/turbo.json)), so they never wait for `next build`.

## pnpm overrides

Root `package.json`'s `pnpm.overrides` block pins specific transitive dependency
versions across the whole workspace. Most entries (`vite`, `esbuild`, `postcss`,
`sharp`) exist for build-tool compatibility and predate this note.

`"@fastify/swagger-ui>@fastify/static": "^10.1.2"` is scoped to the
`@fastify/static` copy that `@fastify/swagger-ui` pulls in (`apps/api`'s own
`@fastify/swagger-ui` range stays `^5.1.0`). It closes Dependabot alerts 91
(`GHSA-83w8-p2f5-377r`) and 92 (`GHSA-8pvw-jcv7-9cmj`), both path-traversal
issues in `@fastify/static` below 10.1.0. Drop this override once `apps/api`
deliberately upgrades `@fastify/swagger-ui` to `^6.1.1` or later — those
releases already declare `@fastify/static: ^10.1.0` on their own.

`"dompurify": "3.4.13"` pins the transitive `dompurify` copy that
`monaco-editor` resolves internally, including the fix for
`GHSA-55q2-fjhq-7xh7`. Nothing in this repo or in `monaco-editor`'s shipped output
imports the npm `dompurify` package — `monaco-editor` vendors its own
DOMPurify inside its bundled `esm/vs/base/browser/dompurify/dompurify.js`
rather than depending on the npm package at runtime — so this override
changes zero executed bytes; it only satisfies lockfile-scanning tools.
The browser-executed DOMPurify copy only moves forward when
`monaco-editor` itself is bumped (see `apps/web/package.json`). Monaco 0.56.0
still vendors DOMPurify 3.4.8, but its sanitization path passes a string/fragment
and never enables DOMPurify's vulnerable `IN_PLACE` option; the npm override must
not be described as replacing that embedded browser copy.

`"fast-uri": "3.1.5"` forces the patched parser through every Fastify/AJV
subtree, including the production API, because no workspace manifest owns this
transitive package directly. `"postcss": "^8.5.26"` also raises its internal
`nanoid` edge to a patched 3.3.x release. Both pins can be removed once all of
their direct parents independently require the same fixed floors.

## Bridge development

```bash
cd apps/bridge
make build       # static binary at bin/panel-host-bridge
make test        # `go test -race -count=1 ./...`
GOOS=linux GOARCH=amd64 go vet ./...   # what the pre-commit hook runs; a native vet fails on macOS
gofmt -l -s .    # nothing should print; the pre-commit hook fails otherwise
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
