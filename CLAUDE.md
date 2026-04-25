# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Open-source, self-hosted admin panel for Squad dedicated servers that **owns the full server lifecycle** — install, update, start/stop, live config editing, log/event ingestion, audit. Each Squad server runs as its own Docker container (`--network host`, bind-mounted configs, shared depot volume). Panel is `docker compose up -d` on a single Linux host.

### RNSquadJS stance
RNSquadJS is an **external black box** we neither fork, patch, nor vendor. The Go bridge and TS workers talk to a running Squad server directly: `apps/workers/rcon/src/protocol.ts` is our own Valve-RCON wire implementation (two-packet AUTH trick for Squad's quirk); `apps/workers/log-ingest/src/parser/` is our own `SquadGame.log` line parser. Any inspiration taken from RNSquadJS lives inside those two files — nothing imports from it.

## Monorepo layout

pnpm workspace + Turbo orchestration. TypeScript for everything except the privileged host daemon (Go).

```
apps/
  api/              Fastify 5 + Zod type-provider, REST + @fastify/websocket
  web/              Next.js 15 + React 19 App Router, Tailwind 4, client components polling REST
  bridge/           Go 1.25 privileged daemon (panel-host-bridge)
  workers/
    rcon/           Valve-RCON client + supervisor publishing rcon:status:{id}
    log-ingest/     docker logs -f tail → regex parser → Redis Streams
    audit-archiver/ cold-archives audit_log rows older than 90d
    event-partition/monthly partition rotation for the events table
    {automation,backup,config-sync,discord,scheduler,stats}/ stubs, not P0
packages/
  shared-types/     Zod schemas + EventEnvelope
  shared-config/    Permission keys, bridge-method allowlist, heartbeat util
  db/               Drizzle schema + SQL migrations (packages/db/drizzle/)
  bridge-client/    TS client for the Go bridge over /run/panel-host-bridge.sock
docker/             Dockerfiles (api/web/worker/squad-server/depot-init) + Caddyfile + entrypoints
scripts/            install-host-bridge.sh, verify-bridge.sh, verify-audit-chain.ts
docs/               README.md + architecture/ + components/<name>/ + operations/ + development/
```

## Commands

Root `package.json` proxies to Turbo; most day-to-day work goes through these.

```bash
pnpm install                                # workspace bootstrap
pnpm turbo run typecheck                    # tsc --noEmit across everything
pnpm turbo run test                         # 21 packages; vitest + go test
pnpm turbo run test --force                 # bypass Turbo cache
pnpm turbo run build                        # per-app dist/
pnpm biome check --write .                  # lint + format (aliased: pnpm lint:fix)
pnpm verify:audit-chain                     # sha-chain integrity on audit_log (needs DATABASE_URL)

# single package
pnpm --filter @squad/api dev                # tsx watch src/index.ts
pnpm --filter @squad/web dev                # next dev
pnpm --filter @squad/api test               # vitest in apps/api only
pnpm --filter @squad/api exec vitest run test/rcon-send.test.ts  # single test file

# DB (Drizzle)
pnpm db:generate                            # after schema edits
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate

# Go bridge
cd apps/bridge && make build                # CGO_ENABLED=0, stripped
cd apps/bridge && go test -race -count=1 ./...
cd apps/bridge && go vet ./...              # also enforced by lefthook pre-commit

# Full stack
docker compose up -d                        # needs .env populated + bridge installed on host
docker compose build api web worker-*       # after TS code changes
docker compose logs api --since 2m          # journal-style tail

# Bridge on the host (requires root)
sudo ./scripts/install-host-bridge.sh       # idempotent — creates panel group, unit, socket
sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/  # redeploy; `cp` fails with "Text file busy" while running
sudo systemctl {restart,status} panel-host-bridge
sg panel -c 'bash scripts/verify-bridge.sh'  # RPC smoke test with all 17 methods
```

CI (`.github/workflows/ci.yml`) runs the same `pnpm turbo run typecheck|test` + `biome check` + `go test -race` + `govulncheck` + gitleaks. Lefthook pre-commit runs `go-fmt`, `biome-check`, and gitleaks locally; if gitleaks binary is missing it warns but does not block.

## Architecture spine

Three privilege zones with narrow contracts between them.

### 1. Host daemon `apps/bridge/` (Go, root)

Listens on `/run/panel-host-bridge.sock` (systemd socket activation, 0660 root:panel). Auth by `SO_PEERCRED` + primary-GID check — only the `panel` group can connect. 17 whitelisted RPC methods (full set in `packages/shared-config/src/bridge-methods.ts`: ping, host_info, host_metrics, file_read|write|atomic_write, ufw_rule, process_info, container_run|start|stop|rm|inspect|stats|logs_follow, depot_update, host_agent_restart). Length-prefixed JSON framing (16 MiB max), each request dispatched in its own goroutine so long-running streams (`container_logs_follow`, `depot_update`) don't block other calls.

Current method set (`packages/shared-config/src/bridge-methods.ts` is the source of truth):
- `ping`, `host_info`, `host_metrics`, `process_info`
- `file_read`, `file_write`, `file_atomic_write` — paths are hard-allowlisted to `/var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg` + `/var/lib/squad-panel/saved/{uuid}/**` + `/var/lib/docker/volumes/squad-depot/**` (RO). `AtomicWrite` `MkdirAll`s up through the allowed root.
- `ufw_rule` — game/query/beacon/rcon ports
- `container_run|start|stop|rm|inspect|logs_follow` — Docker CLI wrapper. Client passes **structured params**, never raw flags; the bridge composes `docker run -d --network host --user 1001:1001 --read-only -v squad-depot:/squad:ro -v .../configs:/squad/SquadGame/ServerConfig:rw -v .../saved:/squad/SquadGame/Saved:rw <image>`. Only two images are allowlisted: `squad-server:latest` and `squad-panel/depot-init:latest`.
- `depot_update` — spawns a transient `squad-panel/depot-init` container that runs `steamcmd +app_update 403240 validate` into the shared `squad-depot` named volume. Stream output goes back to the caller.

`systemd-analyze security panel-host-bridge.service` target is **< 3.0**; current score is **2.0 OK** (only `CAP_NET_ADMIN` remains, needed for ufw). The unit (`apps/bridge/deploy/panel-host-bridge.service`) has `ProtectHome=yes` which means the bridge cannot see `/root/` — harmless warnings from docker CLI about `/root/.docker/config.json` are expected.

There is **no systemd-unit / apt-install / steamcmd surface in the bridge** anymore — the pre-container migration code was fully removed. The `install-host-bridge.sh` script is responsible for one-time apt-install of `docker-ce` + creation of `/var/lib/squad-panel/{configs,saved}`.

### 2. API / workers (Node 22, inside Docker)

`apps/api/src/server.ts` registers all routes; `plugins/bridge.ts` decorates Fastify with `app.bridge` (singleton) and `app.makeBridgeClient()` (per-WebSocket dedicated connection — closing it tears down the bridge-side subprocess cleanly). `plugins/status-reconciler.ts` polls `container_inspect` every 4 s and reconciles `servers.status` against Docker state. Workers use `packages/shared-config/src/heartbeat.ts` to publish `worker:heartbeat:{name}` keys with TTL 30 s so `/api/v1/health/workers` surfaces liveness.

Event flow: `worker-rcon` (ListPlayers every 30 s, ShowServerInfo keepalive every 90 s) and `worker-log-ingest` (tail `docker logs -f squad-{uuid}` via bridge) produce `EventEnvelope` (see `packages/shared-types/src/events.ts` — UUIDv7 id, discriminated-union `type`, versioned payload) into Redis Streams `events:server:{id}`. API reads via `XREVRANGE` for the per-server feed; `worker-event-partition` rotates monthly Postgres partitions.

Config editor at `/servers/:id/configs` (Monaco, lazy-loaded) — three tabs: **Редактор** (Monaco on current content, optional commit message, dirty-tracking), **История** (list of `config_versions` rows with author email + commit message + sha256 + per-row `diff` / `restore` actions; clicking `diff` opens Monaco diff-editor between the version and tip), **Blame** (tip content with per-line attribution — version_id short hash + author email + date, computed by `apps/api/src/lib/blame.ts` via Myers diff walk and cached in Redis under `config-blame:{tip_version_id}` TTL 24h, auto-invalidated on next save because the cache key IS the tip id). PUT atomic-writes via bridge AND appends a row to `config_versions` (append-only table, DB trigger rejects UPDATE/DELETE). No-op writes (sha256 unchanged) short-circuit and don't pollute history. Restore creates a NEW version with the old content — never destructive. `Rcon.cfg` contains the RCON password so audit persists only before/after sha256, never the content.

### 3. Per-server Squad container

Image `squad-server:latest` is debian-bookworm-slim + `libc6/libstdc++6/libssl3/tini/util-linux`. Entrypoint (`docker/squad-server-entrypoint.sh`) `chown -R 1001:1001 /squad/SquadGame/{Saved,ServerConfig}` then `runuser -u squad -- /squad/SquadGameServer.sh …`. The RW bind-mount source dirs are auto-created by Docker on first `container_run` as root-owned; the entrypoint re-owns them so Squad (uid 1001) can write logs and workshop cache.

Shared `squad-depot` named volume is populated **once** by the depot-init container. `server-install.ts`'s `seedConfigs` copies the 19 default `.cfg` out of the volume's host-side path (`/var/lib/docker/volumes/squad-depot/_data/SquadGame/ServerConfig/`) into `/var/lib/squad-panel/configs/{uuid}/ServerConfig/`, rewriting `Rcon.cfg` (password) and `Server.cfg` (display name), then inserting one `config_versions` row per file as the **baseline** (author=NULL / "system", message="initial install — SteamCMD depot default"). From then on those host files are the **source of truth** — the container mounts them RW, Squad reads them on boot (hot-reload files re-read live).

**Important invariant**: Squad itself does NOT generate or modify any file under `SquadGame/ServerConfig/` on first boot or later. SteamCMD's `app_update 403240` ships all 19 `.cfg` templates directly — confirmed by Squad Wiki (Server Installation + Server Configuration pages), cm2network/squad Docker image layout, and a host-side SHA comparison after 15 min of Squad runtime. All Squad-side writes go to `SquadGame/Saved/` (logs, `.bazaar` EOS marker, `CrashReportClient.ini`, `PersistentDownloadDir/`). There is no "first-boot config generation" step; don't add one.

EOS + EAC (Easy AntiCheat) work inside the container with `--network host` and no extra capabilities — verified during the container migration risk-spike; don't add `--cap-add SYS_PTRACE` unless AntiCheat specifically logs an init failure.

## Key gotchas worth knowing upfront

- **RCON "not_polled" ≠ error**: `worker-rcon` only polls servers whose DB status is `running|starting`. When stopped, it drops the target; `rcon:status:{id}` in Redis expires in 300 s. The API returns `{state: 'not_polled'}` (NOT `null`, NOT `'unknown'`). UI renders `"— (сервер не запущен)"`.
- **Audit log hash chain**: `audit_log.row_hash = sha256(prev_hash || canonical_json(row))`. Table has a `BEFORE UPDATE/DELETE` trigger that raises "audit_log is append-only". Run `pnpm verify:audit-chain` to check integrity. `audit_log.id` is `bigserial` → must be `String(...)` when serializing to JSON (BigInt breaks `JSON.stringify`).
- **BridgeClient decode-error path must NOT set `closed=true`**: dropping the socket + letting the next call reconnect is correct; permanently closing wedges every subsequent request. See `packages/bridge-client/src/client.ts` attachHandlers — the existing pattern is load-bearing.
- **Per-WebSocket bridge clients**: `server-logs.ts` and `server-install.ts` use `app.makeBridgeClient()` (new connection per socket) not `app.bridge` (shared). The shared instance was starving sibling calls when a long `container_logs_follow` held the multiplex.
- **Locale**: UI is Russian. Don't machine-translate to English when editing copy unless asked.
- **Commit hygiene**: `lefthook install` runs on `pnpm install`. Pre-commit blocks on biome errors but only warns on gitleaks-missing. Never commit with `--no-verify` unless explicitly told.
- **Don't re-read a file right after Edit/Write**: the harness tracks file state; `old_string not unique` is the signal to include more surrounding context, not to re-Read.

## Testing philosophy — NON-NEGOTIABLE

**Every piece of functionality must be exercisable by a single test suite, end-to-end, against real infrastructure.** Fakes belong inside unit tests; the critical path (install a server, boot Squad, auth RCON, edit a config, stop, delete) is validated against a live panel stack with real Docker, real Postgres, real Redis, and the real Go bridge. If a change cannot be covered by a test that drives the system the way a human would, the change is not done.

Three explicit tiers:

### Tier 1 — unit
Pure functions, parsers, validators, pure reducers. Vitest / `go test -race`. Fakes + in-memory runners. Lives next to the code it tests. Fast (< 1 s per file). Current home: `apps/api/test/*.test.ts`, `apps/bridge/internal/**/*_test.go`, `packages/**/test/*.test.ts`, `apps/workers/**/test/*.test.ts`.

### Tier 2 — integration
Routes through the real Fastify instance via `inject()` or over HTTP, but with fake bridge and optionally an ephemeral Postgres/Redis. Proves plumbing (auth, RBAC, audit, validation, WS frame splitting) without requiring a Squad container. Current home: `apps/api/test/*.test.ts` (e.g. `server-logs.test.ts`, `install-ws.test.ts`). Run with `pnpm --filter @squad/api test`.

### Tier 3 — end-to-end (e2e)
Drives the **live panel** over HTTPS, uses the **real host bridge** RPC surface, creates an actual Docker container, boots Squad, verifies RCON AUTH succeeds with a real `ShowServerInfo` JSON response, edits configs, graceful-stops. This is the suite the project bets correctness on. Home: `apps/api/test/e2e/*.e2e.test.ts`.

```bash
# prerequisites (once per host): docker compose is up, bridge is active,
# depot volume populated (first depot_update takes ~25 min), and you have
# a valid Owner session cookie from the running UI.
#
# Get cookie: log into panel in browser → devtools → Application → Cookies
# → copy the value of __Host-sid (long random string after the prefix).

export PANEL_TEST_URL=https://squad-panel.lan         # or override
export PANEL_TEST_COOKIE=s_019dbaa5-xxx-yyy-zzz...    # the real cookie value
pnpm --filter @squad/api test:e2e
```

The e2e suite has two files that must both stay green:

| File | What it proves |
|---|---|
| `install-lifecycle.e2e.test.ts` | POST /servers → /install seeds 19 cfg files from depot → ufw rules added → `container_run` starts `squad-{uuid}` → status-reconciler flips DB `running` → worker-rcon reports `rcon_status.state=connected` → Monaco-backed PUT /configs/Admins.cfg updates sha256 → POST /stop triggers RCON AdminBroadcast→AdminEndMatch→container_stop → DELETE removes row + container. 2-3 min per run. |
| `bridge-rpc.e2e.test.ts` | Hits `/run/panel-host-bridge.sock` directly through `@squad/bridge-client`. Exercises every whitelisted RPC method's success path AND its forbidden path (path allowlists, image allowlist, bad container names). 10-30 s. |

The e2e runner (`vitest.e2e.config.ts`) runs serially, 15 min global timeout, and is **excluded from `pnpm turbo run test`** on purpose — the CI `node` job stays fast. E2E runs on the target host (or a staging replica) and is the blocker before cutting a release tag.

**What "fixed" means here**: if you claim a bug is fixed or a feature is shipped, the corresponding test is in the right tier and passes on your machine. "Works on my manual retry" is not fixed. `test:e2e` + `pnpm turbo run test` both green is fixed.

## Before shipping a change

1. Read `docs/architecture/data-flow.md` if touching cross-component data flow, `docs/components/bridge/api.md` if changing the bridge surface, `docs/architecture/rbac.md` if adding a permission key.
2. If a route is new and mutates state, it **must** have `config.audit: {action, resource}` — `apps/api/test/audit-coverage.test.ts` scans registered routes at startup and fails the suite if a POST/PUT/PATCH/DELETE lacks it.
3. If adding a bridge RPC method, keep three sources in sync: `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts`, and the Go handlers in `apps/bridge/internal/handlers/handlers.go`. The `validate.*` allowlist must be tightened in the same commit. Add a case to `test/e2e/bridge-rpc.e2e.test.ts` covering both the success and the forbidden path.
4. Critical-path changes (install flow, container_run spec, config editor, RCON AUTH, depot seeding) require a test in `test/e2e/install-lifecycle.e2e.test.ts` or a new file under `test/e2e/` — the suite must stay green after the change.
5. `pnpm turbo run typecheck && pnpm turbo run test` green AND `pnpm --filter @squad/api test:e2e` green are both prerequisites for a commit touching the critical path.

## Documentation System

Documentation is a mandatory part of this repository. Treat `docs/` as part of the source of truth for the project, and keep it synchronized with the actual code at all times.

You must not consider any coding task complete until you have checked whether documentation needs to be created or updated.

### Core Rule

After every change to code, tests, configuration, data models, APIs, dependencies, architecture, deployment behavior, or developer workflows, check the `docs/` directory and update all affected documentation in the same task.

Do not wait for the user to explicitly ask for documentation updates.

If the code and documentation disagree, the code is the source of truth, but you must immediately update the documentation to match the code.

Never document behavior that does not exist in the current codebase.

---

## Documentation Location

All project documentation must live under:

```text
docs/
```

The documentation structure should be:

```text
docs/
  README.md
  architecture/
    README.md
    system-overview.md
    data-flow.md
    decisions.md
  components/
    <component-name>/
      README.md
      api.md
      data-model.md
      flows.md
      configuration.md
      testing.md
      troubleshooting.md
      changelog.md
  operations/
    setup.md
    deployment.md
    environment-variables.md
    migrations.md
    monitoring.md
  development/
    conventions.md
    testing.md
    local-development.md
    code-style.md
```

Create only useful files. Do not create empty placeholder documents.

If a document is not applicable, either do not create it or explicitly state why it is not applicable.

Example:

```md
This component currently has no public API.
```

---

## Component Detection

A component is any meaningful standalone part of the system, including but not limited to:

* service
* module
* package
* library
* domain area
* API layer
* CLI
* UI feature
* worker
* background job
* queue consumer
* integration
* infrastructure layer
* configuration layer
* database or persistence layer

Each significant component must have its own directory:

```text
docs/components/<component-name>/
```

---

## Required Component Documents

Each component should normally contain:

```text
README.md
api.md
data-model.md
flows.md
configuration.md
testing.md
troubleshooting.md
changelog.md
```

### `README.md`

Must explain:

* component purpose
* responsibilities
* what the component does not do
* code location
* main files and directories
* dependencies
* components that depend on it
* components it depends on
* basic usage example
* links to related component docs

### `api.md`

Must document public interfaces, including:

* HTTP endpoints
* RPC methods
* exported functions/classes
* CLI commands
* events
* queues
* hooks
* SDK interfaces
* public configuration surface

For each API, include:

* name
* purpose
* input parameters
* output value
* errors
* side effects
* example usage

### `data-model.md`

Must document:

* entities
* fields
* types
* constraints
* relationships
* storage location
* migrations
* validation rules
* example payloads or records

### `flows.md`

Must document:

* main flows
* alternative flows
* error flows
* retry logic
* fallback logic
* background processing
* interactions with other components

### `configuration.md`

Must document:

* environment variables
* config files
* feature flags
* defaults
* required values
* sensitive values
* local/staging/production differences
* configuration examples

Use this table for environment variables:

```md
| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
```

### `testing.md`

Must document:

* test locations
* how to run tests
* what is covered
* what is not covered
* mocks and stubs
* test data
* important edge cases

### `troubleshooting.md`

Must document:

* common problems
* symptoms
* likely causes
* diagnostics
* fixes
* useful logs
* useful commands
* relevant metrics

### `changelog.md`

Must be updated for meaningful component changes.

Use this format:

```md
# Changelog

## YYYY-MM-DD

### Added

### Changed

### Fixed

### Removed

### Migration notes
```

---

## Top-Level Documentation

### `docs/README.md`

Must be the main documentation entry point.

It should include:

* short project description
* links to architecture docs
* list of components
* links to component documentation
* links to setup, testing, deployment, and configuration docs
* documentation maintenance rules

### `docs/architecture/README.md`

Must describe:

* system purpose
* main subsystems
* component relationships
* external services
* architectural constraints

### `docs/architecture/system-overview.md`

Must describe:

* how the system works overall
* responsibilities of major components
* main user/system scenarios
* critical dependencies

### `docs/architecture/data-flow.md`

Must describe:

* input data
* processing stages
* output data
* storage locations
* external calls
* error cases

### `docs/architecture/decisions.md`

Must record meaningful architectural decisions.

Use this format:

```md
## YYYY-MM-DD — Decision title

### Context

### Decision

### Rationale

### Consequences

### Alternatives considered
```

---

## Mandatory Workflow For Every Task

For every repository task, follow this workflow:

```text
1. Understand the requested change.
2. Identify affected components.
3. Inspect existing documentation for those components.
4. Modify the code.
5. Modify or create tests when needed.
6. Update all affected documentation.
7. Check that documentation matches the final code.
8. Check relative links in changed documentation.
9. Report documentation updates in the final response.
```

A task is not complete until documentation has been checked.

---

## When Documentation Must Be Updated

Update documentation whenever any of the following changes occur:

* new component added
* component removed
* component renamed
* directory structure changed
* new API added
* existing API changed
* API removed
* function/method/endpoint/command parameters changed
* response format changed
* data model changed
* database schema changed
* migration added
* business logic changed
* validation rules changed
* authorization logic changed
* authentication logic changed
* error handling changed
* dependency added
* dependency removed
* configuration changed
* environment variable added
* environment variable removed
* default value changed
* test behavior changed
* important edge case added
* local development workflow changed
* build command changed
* test command changed
* deployment process changed
* background job changed
* worker changed
* queue changed
* external integration changed
* monitoring, logging, or metrics changed

---

## Documentation Update Mapping

When changing an API, update:

```text
docs/components/<component-name>/api.md
docs/components/<component-name>/README.md
docs/components/<component-name>/flows.md
docs/components/<component-name>/testing.md
docs/components/<component-name>/changelog.md
```

When changing data models, schemas, DTOs, events, or migrations, update:

```text
docs/components/<component-name>/data-model.md
docs/components/<component-name>/flows.md
docs/architecture/data-flow.md
docs/components/<component-name>/changelog.md
```

When changing configuration, update:

```text
docs/components/<component-name>/configuration.md
docs/operations/environment-variables.md
docs/operations/setup.md
docs/components/<component-name>/changelog.md
```

When changing tests, update:

```text
docs/components/<component-name>/testing.md
docs/development/testing.md
```

When changing architecture, component responsibilities, dependencies, or data flow, update:

```text
docs/architecture/README.md
docs/architecture/system-overview.md
docs/architecture/data-flow.md
docs/architecture/decisions.md
```

When adding a new component, create:

```text
docs/components/<component-name>/README.md
docs/components/<component-name>/api.md
docs/components/<component-name>/data-model.md
docs/components/<component-name>/flows.md
docs/components/<component-name>/configuration.md
docs/components/<component-name>/testing.md
docs/components/<component-name>/troubleshooting.md
docs/components/<component-name>/changelog.md
```

Also update:

```text
docs/README.md
docs/architecture/README.md
docs/architecture/system-overview.md
docs/architecture/data-flow.md
```

When removing a component:

* remove or archive its documentation
* update `docs/README.md`
* update architecture docs
* update data-flow docs
* remove broken links
* add changelog notes to related components if relevant

If historical documentation should be preserved, move it to:

```text
docs/archive/<component-name>/
```

Add this notice at the top of archived files:

```md
> Archived: this component was removed from active code on YYYY-MM-DD.
```

---

## Documentation Quality Rules

Documentation must be:

* accurate
* specific to the current code
* useful to a new developer
* linked with relative links
* free of broken links
* free of stale behavior descriptions
* free of invented future behavior
* free of empty TODO-only sections

Prefer:

* concrete examples
* tables for APIs and configuration
* code snippets where useful
* short explanations tied to actual files
* explicit notes about limitations

Do not write vague phrases such as:

```text
This handles business logic.
```

Instead, explain what logic it handles, where it lives, and how it is triggered.

---

## Initial Documentation Creation

If `docs/` does not exist, create it.

Initial setup process:

```text
1. Scan the repository structure.
2. Identify major components.
3. Create `docs/README.md`.
4. Create `docs/architecture/`.
5. Create `docs/components/`.
6. Create documentation for each major component.
7. Add operations and development docs if relevant.
8. Add relative links between documents.
9. Verify that no created document is empty.
```

Base the initial documentation only on actual code, configuration, tests, and repository files.

---

## Prohibited Behavior

Do not:

* finish a task without checking documentation
* change code while ignoring `docs/`
* leave stale documentation behind
* create empty documentation files
* document behavior that does not exist
* describe planned behavior as current behavior
* leave TODOs instead of documenting information that can be inferred from code
* delete documentation without confirming the component was removed
* ignore configuration changes
* ignore test changes
* ignore migration notes
* leave broken relative links

---

## Documentation Self-Check

Before finalizing any task, perform this checklist:

```md
## Documentation Self-Check

- [ ] I identified all affected components.
- [ ] I checked existing documentation under `docs/`.
- [ ] I updated component docs if behavior changed.
- [ ] I updated API docs if public interfaces changed.
- [ ] I updated data-model docs if data structures changed.
- [ ] I updated flows docs if logic or interactions changed.
- [ ] I updated configuration docs if settings changed.
- [ ] I updated testing docs if tests or edge cases changed.
- [ ] I updated architecture docs if responsibilities or data flow changed.
- [ ] I updated changelogs for meaningful component changes.
- [ ] I checked relative links in changed docs.
- [ ] I verified that documentation matches the final code.
```

If any required item is not complete, continue working until the documentation is correct.

---

## Final Response Requirement

At the end of every task, include a documentation report:

```md
## Documentation Update Report

### Updated docs

- `path/to/doc.md` — what changed

### Not updated

- `path/to/doc.md` — why no update was needed

### Documentation risks

- `None`, or list known risks/uncertainties
```

If no documentation changed, explicitly state which documentation was checked and why no update was required.

Do not write only "documentation was not needed" without explaining the check.
