# Contributor rules — squad-admin-panel

These rules are mandatory for every contributor and every coding agent (Claude Code, Codex, Gemini CLI, or any other). This file is the only rulebook: agents that do not load `CLAUDE.md` automatically must read it before making any change, and rules are edited here, never duplicated elsewhere.

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

## Local test setup (read before running any DB-backed test)

The local stack runs in Docker (`postgres`, `redis`, `api`, `web`). Getting an isolated, migrated test database right is the #1 time-sink for agents; the facts:

- **The Postgres password is NOT `admin`.** It is the `POSTGRES_PASSWORD` token in `.env`. From the host, Postgres is at **`127.0.0.1:5432`** (the `.env` `DATABASE_URL` uses the docker-internal host `postgres`, which does not resolve on the host).
- **Two env vars, one DB.** Workers and `@squad/db migrate` read `DATABASE_URL`; the API integration harness (`reusePublicSchema`) reads **`TEST_DATABASE_URL`**. Point BOTH at your isolated DB or tests silently hit the shared `admin` database (every mutating route then 500s).
- **Just run the helper** — it does all of the above (real password, `127.0.0.1`, create + migrate, exports both vars):
  ```bash
  eval "$(bash scripts/new-test-db.sh <slug>)"   # sets DATABASE_URL and TEST_DATABASE_URL
  pnpm --filter @squad/api exec vitest run test/<your>.test.ts   # run only your files, not test:cov
  ```
- **Adding an API route?** Add the import and `await app.register(...)` call to `registerRoutes()` in `apps/api/src/routes/index.ts` — both `apps/api/src/server.ts` and `apps/api/test/integration/harness.ts` call that single function, so there is no second list to keep in sync. `apps/api/test/route-registration-parity.test.ts` fails the build if a route file under `apps/api/src/routes/` is ever added without being imported and registered there.
- **API tests that mutate `players`/`roles`/`panel_meta`** must scope the mutation by `steamId64` (a unique/test-range value), never a bare `uuid` — the parallel `test:cov` shares one DB and `apps/api/test/test-isolation.regression.test.ts` fails any unguarded `delete(players)` / `update(players).roleId` / …. A single-file `vitest run <your.test.ts>` does NOT run that guard, so before pushing also run `pnpm --filter @squad/api exec vitest run test/test-isolation.regression.test.ts`.
- **The pre-push checklist auto-provisions a test DB when it can.** If `DATABASE_URL` is unset but Docker and `.env` are present, `scripts/pre-push-checklist.sh` runs `scripts/new-test-db.sh` for you; without any DB it skips the DB-backed suites with a warning instead of blocking the push. The checklist is a fast local pre-check, not the gate — **`ci` on `master` is the source of truth.** The Go bridge build cannot run on macOS and Docker image builds are not run locally, so `--no-verify` remains available for genuine emergencies; `ci` still catches anything skipped locally when the tip is promoted.

## CI gate

Local green is not proof — **`ci` on `master` is the source of truth**. The workflow runs only on pushes to `master` (the fast-forward promotion from `dev`) and on explicit dispatches; `dev` pushes deploy the stand instead. After every promotion, `bash scripts/verify-done.sh --wait` waits for the result. When it reports a red run, fix forward on `dev` until every check passes:

```bash
gh run list --branch master --workflow ci.yml --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

To check a `dev` commit before promoting it, dispatch the same workflow on it: `gh workflow run ci.yml --ref dev`.

**Everything runs on GitHub-hosted VMs (`runs-on: ubuntu-24.04`), including the deploy.** `deploy.yml` builds the images on hosted runners, pushes them to GHCR, and reaches the stand host over SSH with a forced-command key held in the `stand` environment, whose deployment branch policy admits `dev` alone. There is no self-hosted runner. The repository is public on a personal account, so hosted minutes are free and runner groups do not exist — a job that selects `runs-on: group: …` waits in the queue forever. [`scripts/test-ci-runner-strategy.sh`](scripts/test-ci-runner-strategy.sh) fails CI if a job leaves the hosted image, the deploy leaves the `stand` environment, or any workflow selects a runner group or a self-hosted runner.

Workflows stay limited to trusted pushes and explicit dispatches — never `pull_request` — and superseded runs are cancelled (a deploy already in flight is never interrupted). [`scripts/test-workflow-security.sh`](scripts/test-workflow-security.sh) fails CI if any workflow ever reaches a self-hosted job from a pull-request trigger, by label or by group. Because a fork's pull request can bring its own workflow file, the repository setting *Require approval for all outside collaborators* must stay on. See "CI and deployment runners" in `docs/development/agent-harness.md`.

**Adding a package? Add it to `test:cov`.** The api and web suites run as parallel `vitest --shard` slices whose coverage is merged before the thresholds are checked; every other package runs through the `test:cov` script's explicit `--filter` list, driven by `scripts/ci-test-shard.sh`. A package missing from that list never runs in CI — it can be merged with a red suite while the dashboard stays green (#229: 16 of 28 suites were invisible this way, and two workers sat broken behind a green dashboard). [`scripts/test-cov-complete.sh`](scripts/test-cov-complete.sh) fails CI when a workspace package whose `test` script runs vitest is not in the list; run it locally any time with `bash scripts/test-cov-complete.sh`. The Go bridge is deliberately excluded — it has its own `go` job.

**Every `uses:` line under `.github/workflows/` must be SHA-pinned.** A mutable version tag (e.g. `@v4`) can be repointed to execute arbitrary code; the highest-severity case is `deploy.yml`, whose deploy job writes the stand SSH deploy key to disk (#248). [`scripts/test-workflow-pins.sh`](scripts/test-workflow-pins.sh) fails CI when any `uses:` line is not a 40-hex-char commit SHA; run it locally any time with `bash scripts/test-workflow-pins.sh`.

### Local pre-check

The lefthook `pre-push` hook runs [`scripts/pre-push-checklist.sh`](scripts/pre-push-checklist.sh) automatically before every push **that updates `dev`**; work-branch pushes and the `dev`→`master` promotion skip it (nothing deploys from the former, and the latter promotes a tip the checklist already passed). It is deliberately light — about a minute — because it guards pushes that deploy the stand straight away, while the heavy suite runs in `ci` on promotion. Any failed item blocks the push (bypass in an emergency with `git push --no-verify`).

By default the checklist runs, in order:

1. `git fetch origin dev` (offline, the local `origin/dev` ref is used as is). "Changed" below is measured from the merge base with `origin/dev`, like `git diff origin/dev...`, so commits that landed on `dev` after the branch forked never count as this branch's changes.
2. `biome check` over the source tree — the item that most often breaks after a merge; an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it, fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail it.
3. gitleaks secret scan of `origin/dev..HEAD` (only if `gitleaks` is installed).
4. `turbo run typecheck` for the changed packages and their dependents.
5. Tests of the changed packages only, not their dependents; in `apps/api`, only the test files the diff touches. Suites that read `DATABASE_URL` or `REDIS_URL` run against `DATABASE_URL` or a database provisioned for the worktree, and are skipped with a warning when neither is available.
6. `pnpm test:scripts`, only when `scripts/` or `.github/` changed (it needs the database and Redis too).

`FULL=1 bash scripts/pre-push-checklist.sh` runs the old full gate (full typecheck, build, `test:scripts`, `test:cov`, mutation tests) — use it before a promotion you want to be confident about. Turbo already shares one cache between all worktrees of the clone (the main checkout's `.turbo/cache`), so packages another worktree built or typechecked are cache hits. **Not run locally:** the Go bridge (`apps/bridge` — cannot build on macOS; run `go vet ./... && go test -race ./...` there on Linux) and Docker image builds. The branch model is still enforced independently by the lefthook/`.claude` git-guard hooks (see "Enforcement harness").

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.
- **Migrations must stay compatible with the previous release** so a rollback can run against the new schema. Every `dev` push applies new migrations to the stand database automatically (see "Dev stand and promotion"), so this holds from the first push, not from a release.

## Definition of done

A task — issue, fix, feature, or module — counts as **done** only when ALL of the following hold:

1. The work is merged into `dev`, **pushed to `origin/dev`**, and the `deploy` run for that tip is green (the stand runs it).
2. The change is **completely covered by tests** (regression tests for fixes, integration tests for modules — see Testing policy).
3. The tip is promoted to `master` and the full suite is green on its `ci` run — not just the tests you added.
4. `bash scripts/verify-done.sh --wait` exits 0 and the judgment checks below are backed by evidence.
5. When the work originated from a GitHub issue, the completion evidence comment below has been posted.

Until every condition holds, the task is in progress: do not report it as complete and do not close the issue.

## Completion verification (MANDATORY)

"Looks right" is not done, but the checks are proportionate: the mechanical state is one command, and the judgment checks scale with what the change can break.

1. **Mechanical state** — `bash scripts/verify-done.sh --wait` must exit 0. It proves the working tree is clean, `dev` is pushed, the branch model is intact (`git-guard doctor`), the stand deploy is green for the current `dev` tip, and that tip is promoted to `master` with a green `ci` run **for that exact SHA**. This also covers the typecheck, Biome and full test results — do not re-run them by hand.
2. **Requirements** — re-read the original task/issue and walk it point by point: every requested behavior exists and is tested; nothing was silently narrowed, reinterpreted, or dropped. If scope changed, say so explicitly instead of claiming done.
3. **Tests prove the change** — for a fix, confirm the regression test actually fails without the fix (revert the fix, watch it fail, restore it); for a feature, confirm the integration tests exercise the real wiring, not mocks of it.
4. **Diff self-review** — read `git diff origin/dev...HEAD` end to end before merging: no debug leftovers, no unrelated or generated files, no scope creep, no secrets.
5. **Runtime behavior — only when the change is observable at runtime** (an API route, a worker, a page, a migration, a script). Exercise it for real and capture the output: call the route, run the worker, load the page. Refactors, test-only, docs-only and CI/config-only changes skip this; say that in the report instead.
6. **Docs & config** — README/runbooks/`.env.example`/migration notes updated wherever behavior, setup, or operations changed.
7. **Evidence in the report** — every claim is backed by command output (test counts, run IDs, actual responses). A claim without evidence is unverified; "should work" is not done.

If any check cannot be satisfied, the task stays in progress and the blocker must be reported — never report around it.

## GitHub issue completion evidence (issue-originated work only)

GitHub issue comments are the permanent review record for issue work; chat summaries, terminal output and CI status alone do not satisfy it. After `bash scripts/verify-done.sh --wait` passes, post **one** comment on the originating issue with the heading **`Completion evidence — 100% verified`** using `gh issue comment <number> --repo <owner/repo> ...`; the URL `gh` prints is the proof it was published. Keep it short and link instead of restating — five parts:

1. **Requirements** — a checklist mapping each requirement or acceptance criterion to the implementation file and the test that proves it.
2. **Tests** — the exact commands and their results with counts; for a bug fix, the regression test's red-before / green-after evidence.
3. **Runtime check** — the scenario exercised, the tool used, and an excerpt of the observed result (or `Not applicable — <why the change is not observable at runtime>`).
4. **Delivery** — work branch, delivered commit(s), current `dev` SHA, the `deploy` run URL and the `master` `ci` run URL, and `verify-done.sh --wait` passing.
5. **Limitations** — must say `None` for a 100% claim. If any required check or acceptance criterion was skipped, unavailable or failed, the issue is not 100% complete: post a progress/blocker comment instead and keep it open.

Never expose secrets, credentials or private user data in the comment. If code or CI changes after the comment is published, post a superseding comment before closing the issue. If GitHub commenting is unavailable, the task stays in progress and the access failure is reported as a blocker.

### Parallel-wave handoff (feature-branch terminal state)

When many tasks run in parallel (one work branch each) and an **orchestrator integrates them serially**, a task agent's terminal state is a *pushed feature branch*, not a dev merge — so the default `scripts/verify-done.sh` (which requires `dev == origin/dev`, a green stand deploy, and a green `ci` run on the promoted tip) does **not** apply. For that flow, **done = implemented + tested + committed + pushed feature branch**, verified with:

```bash
bash scripts/verify-done.sh --feature      # clean tree, on a work branch, pushed, branched off dev
```

The judgment angles above (requirements walked, tests actually run and load-bearing, diff self-review, docs) still apply in full. The orchestrator then merges the branch into `dev`, promotes the tip, and runs the default `scripts/verify-done.sh --wait`.

Every parallel task agent must also post a **`Feature-branch handoff evidence — not yet 100% complete`** comment on its issue before handoff. That comment must include the branch and commit SHA, requirement coverage, exact test and quality-gate results, runtime verification evidence, verification provenance, and every skip or limitation. It must explicitly state that final completion is pending merge to `dev`, the stand deploy, the `master` `ci` run, and the integrating agent's completion verification. The task agent must return the published comment URL to the orchestrator. After integration, the orchestrator is responsible for posting and verifying the final **`Completion evidence — 100% verified`** comment described above; a handoff comment can never substitute for it.

## Dev stand and promotion

- **Every push to `dev` deploys the development stand** — the stand is for development, not production. `deploy.yml` builds the `api`, `web`, `workers` and `caddy` images in parallel on hosted runners, pushes them to GHCR (`ghcr.io/seregatipich/squad-panel-<image>:<sha>`), and hands the four digests to the stand host over SSH. The host pulls only the images whose digest changed, runs a `pg_dump` and the migrator only when `packages/db/drizzle` changed, and recreates only the services whose image or configuration changed; a push that changes neither is a no-op. Pushes that only touch Markdown or `docs/` do not deploy. Nothing is tested on this path — the local pre-check is the only gate before the stand.
- **Redeploy or roll back** by dispatching the workflow with the commit you want: `gh workflow run deploy.yml --ref dev -f sha=<40-hex sha>` — images of every deployed SHA stay in GHCR. On the host, `bash scripts/rollback-stand.sh` switches back to the previous release. Neither undoes migrations, so **every migration must stay compatible with the release before it** — add columns and tables first, drop what the previous release still reads only in a later release.
- **Promote** only by **fast-forwarding `master` to the dev tip** — never merge commits, cherry-picks, or direct commits onto `master`:
  ```bash
  git fetch origin
  git push origin origin/dev:master
  ```
  The push runs the full `ci` workflow on `master`; `branch-guard` goes red if the SHA is not reachable from `dev`. Nothing deploys from `master` yet — production CD from `master` is a later step.
- Promote **right after pushing `dev`**, not after the deploy finishes: the two run concurrently and `bash scripts/verify-done.sh --wait` waits for both. Nothing deploys from `master` yet, so a tip that turns out red on the stand or in `ci` costs a fix-forward commit, not an incident. A red run is fixed forward on `dev` and promoted again.

## Enforcement harness

The branch model is **machine-enforced**, not just documented (details, setup, and caveats: `docs/development/agent-harness.md`):

- **Claude Code** — `.claude/settings.json` runs `scripts/git-guard-hook.sh` as a `PreToolUse` hook on every Bash call and denies violating git commands with the reason.
- **git hooks (lefthook)** — `branch-guard` runs `scripts/git-guard.sh` on pre-commit and pre-push.
- **GitHub rulesets** (authoritative, binds every client including Codex cloud) — `main` cannot be created; `master`/`dev` cannot be force-pushed or deleted. Managed as code in `.github/rulesets/`, applied with `scripts/apply-rulesets.sh`. The repository is public, so rulesets are available; they are applied and active. The `branch-guard` CI job still separately audits every `master` push and fails the run if the SHA is not reachable from `dev`.

If the guard denies a command, do not work around it — follow the workflow above. Run `bash scripts/git-guard.sh doctor` to check your clone's enforcement wiring.

## Repository hygiene

- Never commit secrets; keep sensitive configuration in environment variables and document required vars in `.env.example`.
- Do not add `.md` files to the repository root. The only permitted root docs are `README.md` and this `CLAUDE.md`. Planning notes, roadmaps, handoffs, and other artifacts go in `docs/`.
- Update README/runbooks/migration notes when behavior, setup, or operations change.

## Commands

pnpm 9 workspace (`apps/*`, `apps/workers/*`, `packages/*`, `docker/rnsquadjs/plugins/*`) orchestrated by Turbo; never use npm or yarn. Package names: `@squad/api`, `@squad/web`, `@squad/db`, `@squad/<package>`, `@squad/worker-<dir>`, `@squad/bridge` (Go), `panel-bridge` (RNSquadJS sidecar plugin).

```bash
pnpm build                                        # turbo; typecheck/test depend on ^build
pnpm turbo run typecheck
pnpm exec biome check .                           # --write <file> to fix
pnpm --filter <pkg> exec vitest run <path>        # one test file (add -t '<name>' for one case)
pnpm test:cov                                     # the full JS suite with coverage (ci shards api/web)
pnpm test:scripts                                 # operations-script contracts; needs DB + Redis URLs
pnpm --filter @squad/api test:e2e                 # live panel only (PANEL_TEST_URL, PANEL_TEST_COOKIE)
pnpm db:generate && pnpm db:migrate               # drizzle-kit reads dist/: build @squad/db first
```

Prefer `vitest run <file>` over `pnpm turbo run test`, which builds every package first. `apps/api` tests use a real Postgres (see "Local test setup"); e2e tests are excluded from every non-e2e run.

## Architecture

A self-hosted control plane for Squad game servers on **one Linux host**, deployed as one Docker Compose stack. The deep reference is `docs/architecture/map.md` (pinned to an older commit — re-check against `dev`); install/stop/delete/restore sequences are in `docs/architecture/data-flow.md`.

- **Privilege boundary.** `apps/bridge` (Go, root, systemd) is the only privileged component and the sole holder of the Docker socket. Everything else calls it over the Unix socket `/run/panel-host-bridge/bridge.sock` through `packages/bridge-client`. Its RPC set is a closed allowlist kept in lockstep across `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts` and `apps/bridge/internal/handlers/handlers.go`; arguments (paths, images, mounts) are allowlisted in `apps/bridge/internal/validate/`. Bridge-consuming containers run as `user: "<uid>:${PANEL_GID}"` (workers `1000`, only the api `0`) — `group_add` breaks the `SO_PEERCRED` peer check.
- **API (`apps/api`).** Fastify 5 + Zod type provider. `src/server.ts` registers plugins in a load-bearing order (registration order is hook order), then `registerRoutes()`. Authorization and auditing are *data on the route*, enforced by global hooks: `config.permissions` (keys from `packages/shared-config/src/permissions.ts`) and `config.audit` (required on every mutating route — `audit-coverage.test.ts` enforces it). Routes hardcode full `/api/v1/...` paths; business logic lives in `src/lib/`.
- **Workers (`apps/workers/*`).** Independent deployables that share types, not code: no worker framework, each `src/index.ts` hand-rolls env → postgres/drizzle → ioredis → `createDiag` → optional bridge → `startHeartbeat` → signal handlers → tick loop. Copy-paste between workers is deliberate — do not add cross-worker dependencies. All build from `docker/worker.Dockerfile` with `ARG WORKER`. Health is Redis-only (`worker:heartbeat:<name>`, TTL 30 s); no worker opens a port. `apps/workers/_test-shared/contract.ts` is the shared heartbeat/SIGTERM contract test.
- **Messaging.** Redis Streams carry domain events in the `EventEnvelope` from `packages/shared-types` (`events:server:{id}`, `events:global`). Consumers are idempotent twice over — Redis `SET NX` dedup key plus `processed_events` insert — and `XACK` only after the side effect commits; groups are named `<service>:v<n>`. Live browser updates go over one WebSocket (`/api/v1/ws/live`) fanned out via Redis pub/sub; the event unions in `apps/api/src/plugins/live-bus.ts` and `apps/web/src/lib/live-bus.ts` are separate and must be updated together.
- **Database (`packages/db`).** Drizzle schema in `src/schema/`, forward-only SQL migrations in `drizzle/`. Drizzle cannot generate triggers, partitions or guards — append hand-written DDL (idempotent snippets in `packages/db/sql/`) to the generated migration. `audit_log` is an append-only SHA-256 hash chain and `config_versions` is append-only, both enforced by DB triggers; `events`/`diagnostic_events` are partitioned and rotated by `worker-event-partition`.
- **Web (`apps/web`).** Next.js 15 App Router + React 19. No server-state library: pages use `useState`/`useEffect`, inline `fetch('/api/v1/…', { credentials: 'include', cache: 'no-store' })`, and per-page polling. **The UI is Russian-only** — all user-visible strings are Russian; `src/i18n` holds a single `ru` dictionary covering only the shell.
- **Config files.** Squad's own `.cfg` files on the host stay the source of truth for live server config; the panel writes them through the bridge and records every write in `config_versions`.

Further conventions (bridge-RPC checklist, test tiers, commit style `<type>(<scope>): <subject>`) are in `docs/development/conventions.md` and `docs/development/testing.md`.
