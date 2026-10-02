# Contributor rules — squad-admin-panel

These rules are mandatory for every contributor and every coding agent (Claude Code, Codex, Gemini CLI, or any other). This file is the only rulebook: agents that do not load `CLAUDE.md` automatically (the root `AGENTS.md` points them here) must read it before making any change, and rules are edited here, never duplicated elsewhere. Procedures that would bloat this file live in `docs/development/` and are linked from "Where to find more" below.

## Branch model (HARD RULES)

- **`master` is the verified branch** (`origin/HEAD` → `master`): the only branch `ci` runs on, and the future source of production releases (production CD is not set up yet). It receives commits **only by fast-forward from `dev`** — never direct commits, never merges from work branches, never a branch base for new work.
- **There is no `main` branch. Never create, push, checkout, or target a branch named `main`.** If a tool, template, or CLI defaults to `main`, override it to `master`. If you encounter a `main` ref, do not build on it or merge into it — report it so it can be deleted.
- **`dev` is the integration branch, and every push to it deploys the development stand** (host and origin come from the `stand` environment, never from the code) within minutes, without running tests. All work lands in `dev` via merges from work branches. Never commit directly to `dev`.
- **Work branches are always created from an up-to-date `dev`**, never from `master`. Name them by intent: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `refactor/<slug>`.

## Workflow (every task: issue, fix, feature, module)

The whole loop is: branch, implement with tests, merge into `dev`, push, promote straight away, wait once. Gates are not repeated by hand — the pre-push hook is the local gate and `ci` on `master` is the authoritative one.

1. Sync and branch off `dev`:
   ```bash
   git fetch origin
   git switch -c feature/<slug> origin/dev
   ```
2. Implement with tests (see Testing policy). Commit locally as you go; the pre-commit hook runs Biome on what you stage. While iterating, run only the affected test files (`pnpm --filter <pkg> exec vitest run <file>`). Pushing the work branch is optional and gated by nothing.
3. Merge into `dev` — this repo uses **direct merges, not pull requests**. **Never merge red:** at this point the affected package's tests, `typecheck` and `biome check` must pass, and the push below runs exactly those checks for you:
   ```bash
   git merge origin/dev                  # on the work branch: sync, resolve conflicts
   git switch dev && git pull origin dev
   git merge --no-ff feature/<slug>
   git push origin dev                   # pre-push checklist runs here, then the stand deploy starts
   ```
   Do not run `pnpm test:cov`, a full `typecheck` or `biome check .` by hand first: the checklist already covers what changed and `ci` covers the rest. For changes under `apps/bridge`: `go vet ./... && go test -race -count=1 ./...` (Linux only).
4. **Promote immediately, without waiting for the deploy** — the stand deploy and the `ci` run do not depend on each other, so they run side by side:
   ```bash
   git push origin origin/dev:master     # fast-forward only; starts ci
   bash scripts/verify-done.sh --wait    # one command: waits for the deploy AND ci on this exact tip
   ```
   A red deploy or red `ci` is fixed forward on `dev` and promoted again.
5. Delete the merged work branch.

**Several tasks in one session: batch the promotion.** Merge and push each task to `dev` as it is ready, but promote and run `verify-done.sh --wait` once for the batch — `ci` cancels superseded `master` runs anyway, so a promotion per task only buys cancelled runs. Every task in the batch is done when the verification of the final tip passes.

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.
- **Migrations must stay compatible with the previous release** so a rollback can run against the new schema. Every `dev` push applies new migrations to the stand database automatically (see "Dev stand and promotion"), so this holds from the first push, not from a release.
- **Local test setup.** The Postgres password is not `admin` (it is `POSTGRES_PASSWORD` in `.env`, host `127.0.0.1`), and DB-backed tests read two env vars. Run `eval "$(bash scripts/new-test-db.sh <slug>)"` before any DB-backed test; API tests that mutate `players`/`roles`/`panel_meta` must scope by `steamId64`. Full facts, including the route-registration rule: [local-test-setup.md](docs/development/local-test-setup.md).

## Definition of done

A task — issue, fix, feature, or module — counts as **done** only when ALL of the following hold: the work is merged into `dev`, **pushed to `origin/dev`**, and the `deploy` run for that tip is green; it is **completely covered by tests** (see Testing policy); the tip is promoted to `master` with a green `ci` run (the full suite, not just your tests); `bash scripts/verify-done.sh --wait` exits 0 and the checks below are backed by evidence; and, for issue-originated work, the `Completion evidence — 100% verified` comment is posted ([completion-evidence.md](docs/development/completion-evidence.md)). Until then the task is in progress: do not report it as complete and do not close the issue.

## Completion verification (MANDATORY)

"Looks right" is not done, but the checks are proportionate to what the change can break:

1. **Mechanical state** — `bash scripts/verify-done.sh --wait` exits 0: clean tree, `dev` pushed, branch model intact (`git-guard doctor`), stand deploy green for the current `dev` tip, and that tip promoted to `master` with a green `ci` run **for that exact SHA**. It covers typecheck, Biome and the full tests — do not re-run them by hand.
2. **Requirements** — re-read the original task/issue and walk it point by point; nothing silently narrowed, reinterpreted, or dropped. If scope changed, say so instead of claiming done.
3. **Tests prove the change** — a fix's regression test fails without the fix (revert, watch it fail, restore); a feature's integration tests exercise the real wiring, not mocks of it.
4. **Diff self-review** — read `git diff origin/dev...HEAD` end to end before merging: no debug leftovers, unrelated or generated files, scope creep, or secrets.
5. **Runtime behavior — only when the change is observable at runtime** (route, worker, page, migration, script): exercise it for real and capture the output. Refactors, test-only, docs-only and CI/config-only changes skip this; say so in the report.
6. **Docs & config** — README/runbooks/`.env.example`/migration notes updated wherever behavior, setup, or operations changed.
7. **Evidence** — every claim is backed by command output (test counts, run IDs, responses); "should work" is not done.

If any check cannot be satisfied, the task stays in progress and the blocker must be reported — never report around it.

### Parallel-wave handoff (feature-branch terminal state)

When an orchestrator integrates many parallel work branches serially, a task agent's terminal state is a *pushed feature branch*, not a dev merge: done = implemented + tested + committed + pushed, verified with `bash scripts/verify-done.sh --feature` (the default mode does not apply). The judgment checks above still apply in full, the agent posts a `Feature-branch handoff evidence — not yet 100% complete` issue comment, and the orchestrator later merges, promotes, and posts the final completion evidence; a handoff comment never substitutes for it. Required comment contents: [completion-evidence.md](docs/development/completion-evidence.md).

## CI gate

**`ci` on `master` is the source of truth**; local green is not proof. After every promotion, `bash scripts/verify-done.sh --wait` waits for the result, and a red run is fixed forward on `dev`. Hard rules (reasons, commands and the guard scripts behind them: [ci.md](docs/development/ci.md)):

- Everything runs on GitHub-hosted VMs (`runs-on: ubuntu-24.04`), including the deploy; never a self-hosted runner and never `runs-on: group:`.
- Workflows run only on trusted pushes and explicit dispatches — never `pull_request`.
- Every `uses:` line under `.github/workflows/` must be pinned to a 40-hex commit SHA.
- Adding a workspace package with a vitest `test` script? Add it to the `test:cov` filter list or it never runs in CI (`bash scripts/test-cov-complete.sh`). The Go bridge has its own `go` job.

## Dev stand and promotion

- Every push to `dev` deploys the development stand (nothing is tested on that path); promote by **fast-forwarding `master`** only (`git push origin origin/dev:master`) — never merge commits, cherry-picks, or direct commits onto `master`.
- Roll back or redeploy with `gh workflow run deploy.yml --ref dev -f sha=<sha>`. That never undoes migrations, so every migration must stay compatible with the release before it.

Full procedure: [deploy.md](docs/development/deploy.md).

## Enforcement harness

The branch model is machine-enforced (Claude Code `PreToolUse` hook, lefthook `branch-guard`, GitHub rulesets, the `branch-guard` CI job); setup and caveats are in [agent-harness.md](docs/development/agent-harness.md). If the guard denies a command, do not work around it — follow the workflow above; `bash scripts/git-guard.sh doctor` checks your clone's wiring.

## Documentation

`docs/` is part of the source of truth: update the affected docs in the same task as the code, schema, configuration or workflow change (code wins when they disagree, and the doc is fixed in the same change). Docs are written in English. Put each doc where the existing structure in [docs/README.md](docs/README.md) puts it, link new docs from that table of contents, and prefer linking to a doc over restating it.

## Repository hygiene

- Never commit secrets; keep sensitive configuration in environment variables and document required vars in `.env.example`.
- Do not add `.md` files to the repository root. The only permitted root files of that kind are `README.md`, this `CLAUDE.md`, and the `AGENTS.md` pointer to it. Planning notes, roadmaps, handoffs, and other artifacts go in `docs/`.
- Update README/runbooks/migration notes when behavior, setup, or operations change.
- Write documentation in English; only quoted product UI strings (the web UI is Russian-only) and literals emitted by the code stay Russian.

## Commands

pnpm 9 workspace (`apps/*`, `apps/workers/*`, `packages/*`, `docker/rnsquadjs/plugins/*`) orchestrated by Turbo; never use npm or yarn. Package names: `@squad/api`, `@squad/web`, `@squad/db`, `@squad/<package>`, `@squad/worker-<dir>`, `@squad/bridge` (Go), `panel-bridge` (RNSquadJS sidecar plugin).

```bash
pnpm dev:app                                      # api (3001) + web (3000) on the host, hot reload, no build needed; needs .env
pnpm build                                        # turbo; typecheck depends on ^build
pnpm turbo run typecheck
pnpm exec biome check .                           # --write <file> to fix
pnpm --filter <pkg> exec vitest run <path>        # one test file (add -t '<name>' for one case)
pnpm turbo run test:unit                          # only the suites that need no Postgres/Redis
pnpm test:cov                                     # the full JS suite with coverage (ci shards api/web/packages)
pnpm test:scripts                                 # operations-script contracts; needs DB + Redis URLs
pnpm --filter @squad/api test:e2e                 # live panel only (PANEL_TEST_URL, PANEL_TEST_COOKIE)
pnpm db:migrate                                   # apply the SQL migrations; they are hand-written (db:generate is disabled, see docs/operations/migrations.md)
```

Prefer `vitest run <file>` over `pnpm turbo run test`, which builds every package first. `apps/api` tests use a real Postgres (see "Local test setup" in the Testing policy); e2e tests are excluded from every non-e2e run.

## Architecture

A self-hosted control plane for Squad game servers on **one Linux host**, deployed as one Docker Compose stack. The overview is `docs/architecture/map.md`; install/stop/delete/restore sequences are in `docs/architecture/data-flow.md`.

- **Privilege boundary.** `apps/bridge` (Go, root, systemd) is the only privileged component and the sole holder of the Docker socket. Everything else calls it over the Unix socket `/run/panel-host-bridge/bridge.sock` through `packages/bridge-client`. Its RPC set is a closed allowlist kept in lockstep across `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts` and `apps/bridge/internal/handlers/handlers.go`; arguments (paths, images, mounts) are allowlisted in `apps/bridge/internal/validate/`. Bridge-consuming containers run as `user: "<uid>:${PANEL_GID}"` (workers `1000`, only the api `0`) — `group_add` breaks the `SO_PEERCRED` peer check.
- **API (`apps/api`).** Fastify 5 + Zod type provider. `src/server.ts` registers plugins in a load-bearing order (registration order is hook order), then `registerRoutes()` (a new route file is imported and registered in `src/routes/index.ts`, the single list the server and the test harness share). Authorization and auditing are *data on the route*, enforced by global hooks: `config.permissions` (keys from `packages/shared-config/src/permissions.ts`) and `config.audit` (required on every mutating route — `audit-coverage.test.ts` enforces it). Routes hardcode full `/api/v1/...` paths; business logic lives in `src/lib/`.
- **Workers (`apps/workers/*`).** Independent deployables that share lifecycle code through `@squad/worker-kit` (`createWorkerLog`, `runWorker`: env → postgres/drizzle → ioredis → `createDiag` → heartbeat → shutdown → tick loop). Workers with an unusual lifecycle (rcon, log-ingest, discord, scheduler, config-sync, diag-flush, ban-sync, automation, metrics-sampler) keep their own `main()`. Workers do not depend on each other. All build from `docker/worker.Dockerfile` with `ARG WORKER`. Health is Redis-only (`worker:heartbeat:<name>`, TTL 30 s); no worker opens a port. `apps/workers/_test-shared/contract.ts` is the shared heartbeat/SIGTERM contract test.
- **Messaging.** Redis Streams carry domain events in the `EventEnvelope` from `packages/shared-types` (`events:server:{id}`, `events:global`). Consumers are idempotent through a per-group Redis `dedup:<group>:<event_id>` key (checked before, set after the side effect) and `XACK` only after the side effect commits; `processed_events` is no longer written, and nothing writes `events:dlq`; groups are named `<service>:v<n>`. Live browser updates go over one WebSocket (`/api/v1/ws/live`) fanned out via Redis pub/sub; the event unions in `apps/api/src/plugins/live-bus.ts` and `apps/web/src/lib/live-bus.ts` are separate and must be updated together.
- **Database (`packages/db`).** Drizzle schema in `src/schema/`, forward-only SQL migrations in `drizzle/`. Drizzle cannot generate triggers, partitions or guards — append hand-written DDL (idempotent snippets in `packages/db/sql/`) to the generated migration. `audit_log` is an append-only SHA-256 hash chain and `config_versions` is append-only, both enforced by DB triggers; `events`/`diagnostic_events` are partitioned and rotated by `worker-event-partition`.
- **Web (`apps/web`).** Next.js 15 App Router + React 19. No server-state library: pages fetch through `apiFetch`/`apiSend`/`apiResult` and the `usePolledResource`/`useApiResource` hooks (`src/lib/api.ts`, `src/lib/use-polled-resource.ts`); a raw `fetch(` in non-test code is blocked by the ratchet in `src/raw-fetch-ratchet.test.ts` (see docs/development/conventions.md). **The UI is Russian-only** — all user-visible strings are Russian; `src/i18n` holds a single `ru` dictionary covering only the shell.
- **Config files.** Squad's own `.cfg` files on the host stay the source of truth for live server config; the panel writes them through the bridge and records every write in `config_versions`.

## Where to find more

- [docs/README.md](docs/README.md) — table of contents for all docs (architecture, components, operations, development).
- [local-test-setup.md](docs/development/local-test-setup.md), [testing.md](docs/development/testing.md), [local-development.md](docs/development/local-development.md) — databases, test tiers, running the stack.
- [ci.md](docs/development/ci.md), [deploy.md](docs/development/deploy.md), [agent-harness.md](docs/development/agent-harness.md) — CI gate and pre-check, stand and promotion, enforcement and runners.
- [completion-evidence.md](docs/development/completion-evidence.md) — issue evidence comments and the parallel-wave handoff.
- [conventions.md](docs/development/conventions.md) (bridge-RPC checklist, commit style `<type>(<scope>): <subject>`) and [code-style.md](docs/development/code-style.md).
- [solve-issues-parallel.md](docs/development/solve-issues-parallel.md) — fanning the issue backlog out to Managed Agents.
