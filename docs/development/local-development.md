# Local development

There are two ways to run the project and they need different machines:

| Path | Where | What you get |
|---|---|---|
| [Develop and run tests](#develop-and-run-tests-macos-or-linux) | macOS or Linux | Postgres and Redis in Docker; the api, the web dev server and the test suites on the host. No host bridge, no game servers. |
| [Full production-like stack](#full-stack-linux-only) | Linux (Ubuntu 22.04 / 24.04, Debian 12) | Every service in Docker behind Caddy, plus the host bridge that starts Squad servers. |

## Prerequisites

- Node 22 and pnpm 9.15 (the repo pins it via `packageManager`; `corepack enable` provides it).
- Docker with Compose v2 (Docker Desktop on macOS).
- Only for the full stack: Linux and `sudo`. Go 1.25.13+ only to work on `apps/bridge` (it uses Linux-only syscalls).

## Develop and run tests (macOS or Linux)

```bash
git clone git@github.com:seregatipich/squad-admin-panel.git
cd squad-admin-panel
pnpm install

cp .env.example .env
# fill the six values in the table below, then:

docker compose up -d postgres redis
eval "$(bash scripts/new-test-db.sh mydev)"
pnpm --filter @squad/api exec vitest run test/<file>.test.ts
pnpm dev:app
```

**1. Fill `.env`.** Everything else keeps its default for this path (`APP_DOMAIN`, TLS and the Steam, Discord and media settings only matter for the full stack):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `REDIS_SIDECAR_PASSWORD`, `RESTIC_PASSWORD` | `openssl rand -hex 32` each. They are embedded in connection URLs, so keep them URL-safe. |
| `SESSION_SECRET`, `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` each. |

Compose refuses to start any service, `postgres` alone included, while one of these is blank: it interpolates the whole file, and the `postgres`, `redis`, `api` and `backup` services mark them required.

**2. Start Postgres and Redis.** `COMPOSE_FILE=docker/compose.yml` in `.env` lets a plain `docker compose` in the repository root find the stack. `docker compose ps` shows both `healthy` after a few seconds. They publish `127.0.0.1:5432` and `127.0.0.1:6379`.

**3. Create a migrated test database.** [`scripts/new-test-db.sh`](../../scripts/new-test-db.sh) creates `test_<slug>` in the compose Postgres, applies the migrations, and prints three `export` lines that `eval` puts into your shell:

- `DATABASE_URL` and `TEST_DATABASE_URL` — the same database. The worker packages and `pnpm db:migrate` read the first, the api integration harness the second; if they differ, tests silently hit another database.
- `TEST_REDIS_URL` — Redis with the `REDIS_PASSWORD` from `.env` and a logical database in 8–15 derived from the slug. The api harness throws when it is unset, because it flushes logical databases.

The variables live in that shell only, so run step 4 and `pnpm dev:app` in the same terminal. Re-running with the same slug reuses the database. Remove it with `bash scripts/new-test-db.sh --drop <slug>`.

**4. Run tests.** Prefer one file or package over `pnpm test:cov` while you work:

```bash
pnpm --filter @squad/api exec vitest run test/<file>.test.ts
pnpm --filter @squad/api exec vitest run test/test-isolation.regression.test.ts   # guard; single-file runs do not include it
```

[testing.md](testing.md) describes the tiers, and the Redis logical databases each suite uses.

**5. Run the app.** `pnpm dev:app` starts the api and the web dev server, with no prior `pnpm build`:

| | |
|---|---|
| web | <http://localhost:3000> — proxies `/api` and `/health` to the api |
| api | `127.0.0.1:3001` |

It reads `.env`, then your own `.env.local`; the layers are, from lowest to highest precedence:

1. `.env`.
2. Host-reachable defaults built by [`scripts/dev-app.mjs`](../../scripts/dev-app.mjs): `DATABASE_URL` and `REDIS_URL` at `127.0.0.1` with the `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` from `.env` (default 5432 / 6379), `API_PORT=3001`, `WEB_PORT=3000`, `API_URL=http://localhost:<API_PORT>`, `PANEL_PUBLIC_URL=http://localhost:<WEB_PORT>`. The `DATABASE_URL` and `PANEL_PUBLIC_URL` in `.env` are the compose-internal and production ones and are not used here.
3. `.env.local` (gitignored, optional): the commented block at the end of [`.env.example`](../../.env.example) lists what you may override. `${NAME}` references are expanded (Node's `--env-file` cannot do that, and `--env-file-if-exists` needs Node 22.9 while `engines` allows 22.0), so it can reuse `${POSTGRES_PASSWORD}`.
4. Variables already exported in the shell — which is why the database from step 3 is the one the api uses. Without it the api would use the `admin` database, which has no tables until `DATABASE_URL=… pnpm db:migrate` has run against it.

`node scripts/dev-app.mjs --print` shows the result with passwords masked and starts nothing. The command stops with the missing names when a secret from step 1 is blank.

Hot reload covers the api (`tsx watch --conditions=development`), the web (Next dev) and the workspace packages they import: `--conditions=development` and the `.js` → `.ts` alias in `apps/web/next.config.mjs` make `@squad/*` resolve to `src/`. Changes under `packages/*` restart the api and recompile the web. Not covered:

- The bridge, RCON, log ingestion and the game servers — there is no host bridge on macOS and `dev:app` starts no workers, so the features that depend on them do not work.
- Workers: `pnpm --filter @squad/worker-<name> dev` still resolves the `@squad/*` packages from `dist/` (run `pnpm build` once) and loads no `.env`, so export its variables yourself.
- Steam login: Steam OpenID needs a public HTTPS return URL. Mint a session with `pnpm --silent mint:owner-session` (see the table below) instead.

`pnpm dev` is the same command as `pnpm dev:app`. The old `turbo run dev --parallel`, which started about 23 watchers, with api and web both on port 3000 and no `.env`, remains as `pnpm dev:all`.

### Several worktrees on one machine

Parallel checkouts share one Docker and one Redis unless you separate them:

- **Postgres:** each caller gets its own database (`test_<slug>`; the pre-push checklist keeps `test_prepush_<worktree directory>`), so worktrees can share one Postgres container. When more than one postgres container runs (two stacks, or the dev stand next to a local stack), `new-test-db.sh` stops and lists them instead of taking the first. Pick one with `PG_CONTAINER=<name>`, or set `COMPOSE_PROJECT_NAME` in the environment or `.env` to choose the stack by project; `PG_HOST`, `PG_PORT`, `REDIS_HOST` and `REDIS_PORT` override the host side. The pre-push checklist hides the script's stderr, so it only warns that provisioning failed: export `PG_CONTAINER` in your shell profile.
- **Redis:** the logical database in `TEST_REDIS_URL` separates slugs only where it is used as given. The api harness remaps it to `8 + (VITEST_POOL_ID % 8)` for every worker slot, so two worktrees that run the api suite at the same time against the same Redis flush each other's databases.
- **Own stack per worktree**, for real isolation: set these in that worktree's `.env` (Compose reads `.env`, not `.env.local`); the values shown are the defaults, so a checkout that sets none of them behaves as before.

  | Variable | Default | Moves |
  |---|---|---|
  | `COMPOSE_PROJECT_NAME` | `squad-admin-panel` | containers, network and named volumes |
  | `POSTGRES_HOST_PORT` | `5432` | published Postgres port (`127.0.0.1`) |
  | `REDIS_HOST_PORT` | `6379` | published Redis port (`127.0.0.1`) |
  | `CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT` | `80`, `443` | Caddy, for the full stack |

  `new-test-db.sh` and `pnpm dev:app` read the two database ports from the same file, and the host-network `worker-rcon` and the per-server sidecars follow them. `COMPOSE_PROJECT_NAME` outranks the `name:` in `docker/compose.yml`; the file keeps a literal name on purpose, because Compose 2.15 mangles an interpolated one and would rename every volume of an existing install. `docker/compose.stand.yml` does not read these variables, and `scripts/bootstrap.sh` still probes the container names `squad-admin-panel-*`.
- **Cleanup:** deleting a worktree does not delete its databases. `bash scripts/prune-test-dbs.sh` lists the `test_prepush_*` databases whose worktree is gone, `--older-than <days>` adds any `test_*` database created that long ago (a live worktree's is recreated by its next push), and `--yes` drops what was listed. It skips databases with open connections and never touches names outside `test_*`. It reads the worktrees of this clone only, so another clone's databases in the same Postgres look orphaned from here: keep the dry run.

## Full stack (Linux only)

[`scripts/bootstrap.sh`](../../scripts/bootstrap.sh) does all of it and is idempotent:

```bash
git clone git@github.com:seregatipich/squad-admin-panel.git
cd squad-admin-panel
sudo ./scripts/bootstrap.sh
```

It installs the host bridge (`install-host-bridge.sh`), creates the `data/` tree, writes `.env` with fresh secrets, maps a dev domain in `/etc/hosts`, builds the images and starts the stack. To do the same by hand — `cp .env.example .env`, fill the secrets, `sudo ./scripts/install-host-bridge.sh`, log out and in (or `newgrp panel`) so the `panel` group applies, `docker compose up -d --build` — follow [setup.md](../operations/setup.md). Then browse to `https://<APP_DOMAIN>/`.

## Useful pnpm commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm dev:app` | API (3001) and web (3000) with hot reload, configured from `.env` / `.env.local`; needs no build. |
| `pnpm dev:all` | `turbo run dev --parallel`: every workspace's `dev` script, no env loading; api and web both default to port 3000. |
| `pnpm --filter @squad/api dev` | API only, watches source (reads the environment, not `.env`). |
| `pnpm --filter @squad/web dev` | Next.js dev server on `$PORT`, default 3000. |
| `pnpm turbo run test` | Every workspace's `test` (unit + integration; e2e excluded). |
| `pnpm turbo run typecheck` | TS strict check everywhere; runs `go build` on the bridge. |
| `pnpm exec biome check .` | Lint + format. Add `--write` to auto-fix. |
| `pnpm verify:audit-chain` | Out-of-band hash-chain validation. |
| `pnpm db:generate` | Refuses to run: migrations are hand-written, see [migrations.md](../operations/migrations.md). |
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

`branch-guard` checks the pushed refspecs, then `checklist` runs [`scripts/pre-push-checklist.sh`](../../scripts/pre-push-checklist.sh). A push to `dev` deploys the dev stand without tests, so the checklist is the last check before the stand; the full suite runs in `ci` once the tip is promoted to `master`. It therefore checks only what the branch changed, and runs only for a push that updates `dev`: the lefthook command receives the pushed refspecs on stdin and exits at once when none of them is `refs/heads/dev` (a work-branch push deploys nothing, and the dev→master promotion carries a tip the `dev` push already passed). A manual run, or `FULL=1`, always runs:

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
- otherwise, when `.env` exists and Docker runs the local stack, a database of this worktree, `test_prepush_<worktree directory>`, created and migrated by [`scripts/new-test-db.sh`](../../scripts/new-test-db.sh) and kept between pushes so a push applies only new migrations. After you remove the worktree, `bash scripts/prune-test-dbs.sh --yes` drops it (see [Several worktrees](#several-worktrees-on-one-machine));
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

`"dompurify": "^3.4.13"` raises the transitive `dompurify` copy that
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

`"fast-uri": "^3.1.6"` forces the patched parser through every Fastify/AJV
subtree, including the production API, because no workspace manifest owns this
transitive package directly; 3.1.6 closes GHSA-5jgf-p345-68v8,
GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf and GHSA-jqff-g426-hqxp.

Every override is a range (a `^` floor), never an exact version: an exact pin
holds the whole workspace on that version and keeps `pnpm update` and
Dependabot from taking the next security fix. [`scripts/test-dependency-pins.sh`](../../scripts/test-dependency-pins.sh)
fails CI on an exact override. `"postcss": "^8.5.26"` also raises its internal
`nanoid` edge to a patched 3.3.x release. Both pins can be removed once all of
their direct parents independently require the same fixed floors.

## Install scripts (`pnpm.onlyBuiltDependencies`)

Only the packages listed in root `package.json`'s `pnpm.onlyBuiltDependencies`
(`@biomejs/biome`, `@node-rs/argon2`, `esbuild`) may run install scripts; pnpm
skips every other dependency's `preinstall`/`install`/`postinstall`. The list
must stay in `package.json`: the pinned pnpm 9 ignores the same setting in
`pnpm-workspace.yaml` (that location arrived in pnpm 10), and while it sat
there every transitive install script ran in CI and in the image builds.
Deliberately not allowed:

- `ssh2` (used by `worker-log-ingest` for SSH log sources) — its install script
  only compiles an optional native crypto binding; without it ssh2 uses its
  JavaScript/Node `crypto` implementation. Its optional `cpu-features` addon is
  not built either.
- `lefthook` — its postinstall only runs `lefthook install`, which the root
  `prepare` script already does.

Add a package only when it cannot work without its script, and say why here.

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

## Migrations

Migrations are hand-written: `pnpm db:generate` refuses to run, because Drizzle's generator would diff against a stale snapshot and misnumber the file, and it misses the audit hash-chain trigger, partitioning and functional indexes. After editing a schema file, write the SQL by hand as described in [migrations.md](../operations/migrations.md), then apply it to your database with `pnpm db:migrate` (it needs `DATABASE_URL`; the one `new-test-db.sh` exports is already migrated).

## Optional: SOPS-encrypted .env

For shared dev environments:

```bash
sops -e .env > .env.sops
echo '.env.sops filter=sops diff=sops' >> .gitattributes
```

Operators decrypt with their age key on `compose up`.
