# Contributor rules — squad-admin-panel

These rules are mandatory for every contributor and every coding agent (Claude Code, Codex, Gemini CLI, or any other). This file is the only rulebook: agents that do not load `CLAUDE.md` automatically must read it before making any change, and rules are edited here, never duplicated elsewhere.

## Branch model (HARD RULES)

- **`master` is the verified branch** (`origin/HEAD` → `master`): the only branch `ci` runs on, and the future source of production releases (production CD is not set up yet). It receives commits **only by fast-forward from `dev`** — never direct commits, never merges from work branches, never a branch base for new work.
- **There is no `main` branch. Never create, push, checkout, or target a branch named `main`.** If a tool, template, or CLI defaults to `main`, override it to `master`. If you encounter a `main` ref, do not build on it or merge into it — report it so it can be deleted.
- **`dev` is the integration branch, and every push to it deploys the tk104 development stand** (https://tk104.duckdns.org) within minutes, without running tests. All work lands in `dev` via merges from work branches. Never commit directly to `dev`.
- **Work branches are always created from an up-to-date `dev`**, never from `master`. Name them by intent: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `refactor/<slug>`.

## Workflow (every task: issue, fix, feature, module)

1. Sync and branch off `dev`:
   ```bash
   git fetch origin
   git switch -c feature/<slug> origin/dev
   ```
2. Implement with tests (see Testing policy). Commit and push each logical chunk — do not accumulate large uncommitted diffs. **Never commit red:** before every commit, the affected package's tests plus `typecheck` and `biome check` must pass.
3. Before merging back, sync with `dev` (`git merge origin/dev` into your branch, resolve conflicts) and run the local gate:
   ```bash
   pnpm turbo run typecheck
   pnpm exec biome check .
   pnpm test:cov            # or at minimum the affected package's tests
   ```
   For changes under `apps/bridge`: `go vet ./... && go test -race -count=1 ./...`.
4. Merge into `dev` — this repo uses **direct merges, not pull requests**:
   ```bash
   git switch dev && git pull origin dev
   git merge --no-ff feature/<slug>
   git push origin dev
   ```
5. **Before pushing, the local pre-push checklist must pass** — `scripts/pre-push-checklist.sh` runs automatically via the lefthook pre-push hook (see "Local pre-check"). It is the only check a `dev` push gets before it reaches the stand: the push starts the `deploy-tk104` workflow, which builds the images and deploys them to tk104 without tests. Watch the deploy and fix forward if it fails.
6. Promote the finished tip to `master` so the full `ci` suite verifies it (see "Dev stand and promotion"); work is not done while that run is red.
7. Delete the merged work branch.

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

Local green is not proof — **`ci` on `master` is the source of truth**. The workflow runs only on pushes to `master` (the fast-forward promotion from `dev`) and on explicit dispatches; `dev` pushes deploy the stand instead. After every promotion, fetch the run result and fix forward on `dev` until every check passes:

```bash
gh run list --branch master --workflow ci.yml --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

To check a `dev` commit before promoting it, dispatch the same workflow on it: `gh workflow run ci.yml --ref dev`.

**Everything runs on GitHub-hosted VMs (`runs-on: ubuntu-24.04`), including the deploy.** `deploy-tk104.yml` builds the images on hosted runners, pushes them to GHCR, and reaches tk104 over SSH with a forced-command key held in the `tk104-dev` environment, whose deployment branch policy admits `dev` alone. There is no self-hosted runner. The repository is public on a personal account, so hosted minutes are free and runner groups do not exist — a job that selects `runs-on: group: …` waits in the queue forever. [`scripts/test-ci-runner-strategy.sh`](scripts/test-ci-runner-strategy.sh) fails CI if a job leaves the hosted image, the deploy leaves the `tk104-dev` environment, or any workflow selects a runner group or a self-hosted runner.

Workflows stay limited to trusted pushes and explicit dispatches — never `pull_request` — and superseded runs are cancelled (a deploy already in flight is never interrupted). [`scripts/test-workflow-security.sh`](scripts/test-workflow-security.sh) fails CI if any workflow ever reaches a self-hosted job from a pull-request trigger, by label or by group. Because a fork's pull request can bring its own workflow file, the repository setting *Require approval for all outside collaborators* must stay on. See "CI and deployment runners" in `docs/development/agent-harness.md`.

**Adding a package? Add it to `test:cov`.** The api and web suites run as parallel `vitest --shard` slices whose coverage is merged before the thresholds are checked; every other package runs through the `test:cov` script's explicit `--filter` list, driven by `scripts/ci-test-shard.sh`. A package missing from that list never runs in CI — it can be merged with a red suite while the dashboard stays green (#229: 16 of 28 suites were invisible this way, and two workers sat broken behind a green dashboard). [`scripts/test-cov-complete.sh`](scripts/test-cov-complete.sh) fails CI when a workspace package whose `test` script runs vitest is not in the list; run it locally any time with `bash scripts/test-cov-complete.sh`. The Go bridge is deliberately excluded — it has its own `go` job.

**Every `uses:` line under `.github/workflows/` must be SHA-pinned.** A mutable version tag (e.g. `@v4`) can be repointed to execute arbitrary code; the highest-severity case is `deploy-tk104.yml`, whose deploy job writes the tk104 SSH deploy key to disk (#248). [`scripts/test-workflow-pins.sh`](scripts/test-workflow-pins.sh) fails CI when any `uses:` line is not a 40-hex-char commit SHA; run it locally any time with `bash scripts/test-workflow-pins.sh`.

### Local pre-check

The lefthook `pre-push` hook runs [`scripts/pre-push-checklist.sh`](scripts/pre-push-checklist.sh) automatically before every push. It is deliberately light — about a minute — because it guards pushes that deploy the stand straight away, while the heavy suite runs in `ci` on promotion. Any failed item blocks the push (bypass in an emergency with `git push --no-verify`).

By default the checklist runs, in order:

1. `git fetch origin dev`, so "changed since `origin/dev`" means the real remote state.
2. `biome check` over the source tree — the item that most often breaks after a merge; an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it, fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail it.
3. gitleaks secret scan of `origin/dev..HEAD` (only if `gitleaks` is installed).
4. `turbo run typecheck` for the packages affected since `origin/dev` and their dependents.
5. Tests of the packages changed since `origin/dev` — only those packages, not their dependents; in `apps/api`, only the test files the diff touches. DB-backed suites use an isolated DB (auto-provisioned when possible) and are skipped with a warning when none is available.
6. `pnpm test:scripts`, only when `scripts/` or `.github/` changed.

`FULL=1 bash scripts/pre-push-checklist.sh` runs the old full gate (full typecheck, build, `test:scripts`, `test:cov`, mutation tests) — use it before a promotion you want to be confident about. All worktrees share one turbo cache (`TURBO_CACHE_DIR`, default `~/.cache/turbo/squad-admin-panel`), so unchanged packages are cache hits. **Not run locally:** the Go bridge (`apps/bridge` — cannot build on macOS; run `go vet ./... && go test -race ./...` there on Linux) and Docker image builds. The branch model is still enforced independently by the lefthook/`.claude` git-guard hooks (see "Enforcement harness").

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.
- **Migrations must stay compatible with the previous release** so a rollback can run against the new schema. Every `dev` push applies new migrations to the stand database automatically (see "Dev stand and promotion"), so this holds from the first push, not from a release.

## Definition of done

A task — issue, fix, feature, or module — counts as **done** only when ALL of the following hold:

1. The work is merged into `dev`, **pushed to `origin/dev`**, and the `deploy-tk104` run for that tip is green (the stand runs it).
2. The change is **completely covered by tests** (regression tests for fixes, integration tests for modules — see Testing policy).
3. **ALL tests are verified passing** — the tip is promoted to `master` and the full suite is green on its `ci` run, not just the tests you added.
4. The **Completion verification** checklist below has been executed at completion time — `scripts/verify-done.sh` exits 0 and every judgment angle is backed by evidence.
5. When the work originated from a GitHub issue, a **100% completion evidence comment** has been posted to that issue and verified visible, as defined below.

Until every condition holds, the task is in progress: do not report it as complete and do not close the issue.

## Completion verification (MANDATORY)

"Looks right" is not done. Before reporting any task complete, verify it from every angle, at completion time (not from stale mid-task results):

1. **Requirements** — re-read the original task/issue and walk it point by point: every requested behavior exists and is tested; nothing was silently narrowed, reinterpreted, or dropped. If scope changed, say so explicitly instead of claiming done.
2. **Tests prove the change** — for a fix, confirm the regression test actually fails without the fix (revert/stash, watch it fail, restore); for a feature, confirm the integration tests exercise the real wiring, not mocks of it.
3. **Runtime behavior** — exercise the change for real, not only through tests: call the API route, run the worker, load the page. Capture actual output as evidence.
4. **Full local gate** — `pnpm turbo run typecheck`, `pnpm exec biome check .`, and the affected packages' tests pass (see Workflow step 3).
5. **Diff self-review** — read `git diff origin/dev...HEAD` end to end before merging: no debug leftovers, no unrelated or generated files, no scope creep, no secrets.
6. **Docs & config** — README/runbooks/`.env.example`/migration notes updated wherever behavior, setup, or operations changed.
7. **Mechanical state** — run `bash scripts/verify-done.sh`: it must exit 0. It proves the working tree is clean, `dev` is pushed, the branch model is intact (`git-guard doctor`), the stand deploy is green for the current `dev` tip, and that tip is promoted to `master` with a green `ci` run **for that exact SHA** — a green run on an older SHA does not count.
8. **Evidence in the report** — every claim is backed by fresh command output (test counts, CI run IDs, actual responses). A claim without evidence is unverified; "should work" is not done.

If any angle cannot be satisfied, the task stays in progress and the blocker must be reported — never report around it.

## GitHub issue completion evidence (MANDATORY)

GitHub issue comments are the permanent review record for issue work. Chat summaries, local terminal output, commit messages, and CI status alone do not satisfy this requirement.

After the work is merged and pushed to `dev`, deployed to the stand, promoted to `master` with a green `ci` run, and `bash scripts/verify-done.sh` passes, the integrating agent must post a final comment on the originating issue with the heading **`Completion evidence — 100% verified`**. Post it with `gh issue comment <number> --repo <owner/repo> ...` (or the equivalent GitHub tool), capture the returned comment URL, and re-read the published comment to verify that it is visible and correctly rendered before reporting or closing the issue.

The final comment must contain fresh, reviewable evidence for every item below:

1. **Requirements** — a point-by-point checklist mapping every issue requirement or acceptance criterion to the implementation and its proving test. Include relevant file paths and commit SHAs or links.
2. **Automated tests** — every exact command run, its result, and useful test counts. For a bug fix, include the regression test's observed red-before / green-after evidence.
3. **Functionality verification** — the real API, UI, CLI, worker, deployment, or other user-visible scenario exercised; the applicable tool used (for example browser automation, `curl`, a database client, or service logs); and the actual observed result. Include reviewable response excerpts, screenshots, recordings, or artifact/log links when the applicable tool can produce them. “Should work” is not evidence.
4. **Quality gates** — fresh results for typecheck, Biome, affected/full tests, and any applicable Go, build, migration, security, or platform-specific checks.
5. **Delivery and CI** — work branch, delivered commit(s), current `dev` SHA, the `deploy-tk104` run URL/ID, and the `master` `ci` run URL/ID with every job's conclusion.
6. **Completion verification** — the command and passing result from `bash scripts/verify-done.sh` for the current `dev` tip.
7. **Verification provenance** — the agent/model or session identity when available, the tools used for verification, and the verification timestamp.
8. **Risks, skips, and limitations** — this must say `None` for a 100% completion claim. If any required check, runtime scenario, tool, or acceptance criterion was skipped, unavailable, inconclusive, or failed, the issue is not 100% complete; post a progress/blocker comment instead and keep the issue open.

Do not expose secrets, credentials, private user data, or unredacted sensitive logs in evidence comments. Link safe CI artifacts or include minimal redacted excerpts instead.

The evidence comment must describe the exact code and CI state being delivered. If code changes, tests are rerun, or CI is rerun after the comment is published, update the comment or publish a superseding fresh comment and verify it again. The issue may be closed only after the final evidence comment is visible. If GitHub commenting or comment verification is unavailable, the task remains in progress and the access failure must be reported as a blocker.

### Parallel-wave handoff (feature-branch terminal state)

When many tasks run in parallel (one work branch each) and an **orchestrator integrates them serially**, a task agent's terminal state is a *pushed feature branch*, not a dev merge — so the default `scripts/verify-done.sh` (which requires `dev == origin/dev`, a green stand deploy, and a green `ci` run on the promoted tip) does **not** apply. For that flow, **done = implemented + tested + committed + pushed feature branch**, verified with:

```bash
bash scripts/verify-done.sh --feature      # clean tree, on a work branch, pushed, branched off dev
```

The judgment angles above (requirements walked, tests actually run and load-bearing, diff self-review, docs) still apply in full. The orchestrator then merges the branch into `dev`, promotes the tip, and runs the default `scripts/verify-done.sh`.

Every parallel task agent must also post a **`Feature-branch handoff evidence — not yet 100% complete`** comment on its issue before handoff. That comment must include the branch and commit SHA, requirement coverage, exact test and quality-gate results, runtime verification evidence, verification provenance, and every skip or limitation. It must explicitly state that final completion is pending merge to `dev`, the stand deploy, the `master` `ci` run, and the integrating agent's completion verification. The task agent must return the published comment URL to the orchestrator. After integration, the orchestrator is responsible for posting and verifying the final **`Completion evidence — 100% verified`** comment described above; a handoff comment can never substitute for it.

## Dev stand and promotion

- **Every push to `dev` deploys the tk104 development stand** (https://tk104.duckdns.org) — tk104 is a stand for development, not production. `deploy-tk104.yml` builds the `api`, `web`, `workers` and `caddy-tk104` images in parallel on hosted runners, pushes them to GHCR (`ghcr.io/seregatipich/squad-panel-<image>:<sha>`), and hands the four digests to tk104 over SSH. The host pulls only the images whose digest changed, runs a `pg_dump` and the migrator only when `packages/db/drizzle` changed, and recreates only the services whose image or configuration changed; a push that changes neither is a no-op. Pushes that only touch Markdown or `docs/` do not deploy. Nothing is tested on this path — the local pre-check is the only gate before the stand.
- **Redeploy or roll back** by dispatching the workflow with the commit you want: `gh workflow run deploy-tk104.yml --ref dev -f sha=<40-hex sha>` — images of every deployed SHA stay in GHCR. On the host, `bash scripts/rollback-tk104.sh` switches back to the previous release. Neither undoes migrations, so **every migration must stay compatible with the release before it** — add columns and tables first, drop what the previous release still reads only in a later release.
- **Promote** only by **fast-forwarding `master` to the dev tip** — never merge commits, cherry-picks, or direct commits onto `master`:
  ```bash
  git fetch origin
  git push origin origin/dev:master
  ```
  The push runs the full `ci` workflow on `master`; `branch-guard` goes red if the SHA is not reachable from `dev`. Nothing deploys from `master` yet — production CD from `master` is a later step.
- Promote when the work on `dev` is complete — implemented, tested, documented, committed, pushed, and deployed to the stand — and watch the `ci` run to completion. A red run is fixed forward on `dev` and promoted again.

## Enforcement harness

The branch model is **machine-enforced**, not just documented (details, setup, and caveats: `docs/development/agent-harness.md`):

- **Claude Code** — `.claude/settings.json` runs `scripts/git-guard-hook.sh` as a `PreToolUse` hook on every Bash call and denies violating git commands with the reason.
- **git hooks (lefthook)** — `branch-guard` runs `scripts/git-guard.sh` on pre-commit and pre-push.
- **GitHub rulesets** (authoritative, binds every client including Codex cloud) — `main` cannot be created; `master`/`dev` cannot be force-pushed or deleted. Managed as code in `.github/rulesets/`, applied with `scripts/apply-rulesets.sh`. The repository is public, so rulesets are available, but they are not applied yet; until they are, only the hooks above and the `branch-guard` CI job (which audits every `master` push and fails the run if the SHA is not reachable from `dev`) enforce the model.

If the guard denies a command, do not work around it — follow the workflow above. Run `bash scripts/git-guard.sh doctor` to check your clone's enforcement wiring.

## Repository hygiene

- Never commit secrets; keep sensitive configuration in environment variables and document required vars in `.env.example`.
- Do not add `.md` files to the repository root. The only permitted root docs are `README.md` and this `CLAUDE.md`. Planning notes, roadmaps, handoffs, and other artifacts go in `docs/`.
- Update README/runbooks/migration notes when behavior, setup, or operations change.
