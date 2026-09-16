# Contributor rules — squad-admin-panel

These rules are mandatory for every contributor and every coding agent (Claude Code, Codex, Gemini CLI, or any other). `CLAUDE.md` and `GEMINI.md` import this file; do not duplicate rules there — edit them here.

## Branch model (HARD RULES)

- **`master` is the production branch** (`origin/HEAD` → `master`). It receives merges **only from `dev`** — never direct commits, never merges from work branches, never a branch base for new work.
- **There is no `main` branch. Never create, push, checkout, or target a branch named `main`.** If a tool, template, or CLI defaults to `main`, override it to `master`. If you encounter a `main` ref, do not build on it or merge into it — report it so it can be deleted.
- **`dev` is the integration branch.** All work lands in `dev` via merges from work branches. Never commit directly to `dev`.
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
5. **Before pushing, the local pre-push checklist must pass** — `scripts/pre-push-checklist.sh` runs automatically via the lefthook pre-push hook as a fast local pre-check (see "CI gate"). The push to `dev` then triggers the `ci` workflow on GitHub-hosted runners; watch the run and fix forward until every check is green. Work is not done while `dev` CI is red.
6. Delete the merged work branch.

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
- **The pre-push checklist auto-provisions a test DB when it can.** If `DATABASE_URL` is unset but Docker and `.env` are present, `scripts/pre-push-checklist.sh` runs `scripts/new-test-db.sh` for you; if neither a DB nor Docker is available the checklist fails rather than silently skipping tests. Even so, the checklist is a local pre-check, not the gate — **CI is the source of truth.** The Go bridge build cannot run on macOS and Docker image builds are not run locally, so `--no-verify` remains available for genuine emergencies (and for pushing when only Go/Docker-scoped work is untestable locally); CI will still catch anything skipped locally.

## CI gate

Local green is not proof — **CI is the source of truth**. After every push to `dev` (and to `master`), fetch the run result and iterate until every check passes:

```bash
gh run list --branch <branch> --workflow ci --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

**Verification runs on GitHub-hosted VMs (`runs-on: ubuntu-24.04`); only `deploy-tk104.yml` runs on the repository's own runner on tk104 (`runs-on: [self-hosted, tk104-deploy]`, `environment: production`).** The repository is public on a personal account, so hosted minutes are free and runner groups do not exist — a job that selects `runs-on: group: …` waits in the queue forever. [`scripts/test-ci-runner-strategy.sh`](scripts/test-ci-runner-strategy.sh) fails CI if a `ci` job leaves the hosted image, a deploy job leaves the labelled runner or the `production` environment, or any workflow selects a runner group.

CI stays limited to trusted `dev`/`master` pushes and explicit dispatches — never `pull_request` — and superseded runs are cancelled. [`scripts/test-workflow-security.sh`](scripts/test-workflow-security.sh) fails CI if any workflow ever reaches a self-hosted job from a pull-request trigger, by label or by group. Because a fork's pull request can bring its own workflow file, the repository setting *Require approval for all outside collaborators* must stay on. See "CI and deployment runners" in `docs/development/agent-harness.md`.

**Adding a package? Add it to `test:cov`.** CI's JS tests are the `test:cov` script's explicit `--filter` list, run in parallel slices by `scripts/ci-test-shard.sh`. A package missing from that list never runs in CI — it can be merged with a red suite while `dev` stays green (#229: 16 of 28 suites were invisible this way, and two workers sat broken behind a green dashboard). [`scripts/test-cov-complete.sh`](scripts/test-cov-complete.sh) now fails CI when a workspace package whose `test` script runs vitest is not in the list; run it locally any time with `bash scripts/test-cov-complete.sh`. The Go bridge is deliberately excluded — it has its own `go` job.

**Every `uses:` line under `.github/workflows/` must be SHA-pinned.** A mutable version tag (e.g. `@v4`) can be repointed to execute arbitrary code in verification; the highest-severity case remains `deploy-tk104.yml`, whose self-hosted job checks out code and then writes the production SSH deploy key to disk (#248). [`scripts/test-workflow-pins.sh`](scripts/test-workflow-pins.sh) fails CI when any `uses:` line is not a 40-hex-char commit SHA; run it locally any time with `bash scripts/test-workflow-pins.sh`.

### Local pre-check

The lefthook `pre-push` hook runs [`scripts/pre-push-checklist.sh`](scripts/pre-push-checklist.sh) automatically before every push, as a fast local pre-check ahead of the cloud run. Any failed item blocks the push (bypass in an emergency with `git push --no-verify`).

The checklist runs, in order:

1. `pnpm turbo run typecheck`
2. `pnpm exec biome check .` (whole repo) — the item that most often breaks after a merge; an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it, fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail it.
3. `pnpm turbo run build` (skip with `SKIP_BUILD=1`)
4. gitleaks secret scan, scoped to origin/dev..HEAD (best-effort — only if `gitleaks` is installed; assumes origin/dev is already fetched locally, same as item 5 below)
5. Operation and verification script contracts (`pnpm test:scripts`) after an isolated migrated database is available.
6. Tests — the packages affected since `origin/dev` (`pnpm turbo run test --filter='...[origin/dev]'`), or the full coverage suite with `FULL=1`. Auto-provisions an isolated migrated DB via `scripts/new-test-db.sh` when `DATABASE_URL` is unset.
7. Shared-config mutation tests, affected since `origin/dev`, or the full mutation suite with `FULL=1`.

Run it by hand any time with `bash scripts/pre-push-checklist.sh`. **Not run locally:** the Go bridge (`apps/bridge` — cannot build on macOS; run `go vet ./... && go test -race ./...` there on Linux) and Docker image builds. The branch model is still enforced independently by the lefthook/`.claude` git-guard hooks (see "Enforcement harness"), not by CI.

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.
- **Migrations must stay compatible with the previous release** so a rollback can run against the new schema (see "Promotion").

## Definition of done

A task — issue, fix, feature, or module — counts as **done** only when ALL of the following hold:

1. The work is merged into `dev` and **pushed to `origin/dev`**.
2. The change is **completely covered by tests** (regression tests for fixes, integration tests for modules — see Testing policy).
3. **ALL tests are verified passing** — the full suite green on the `dev` CI run, not just the tests you added.
4. The **Completion verification** checklist below has been executed at completion time — `scripts/verify-done.sh` exits 0 and every judgment angle is backed by evidence.
5. When the work originated from a GitHub issue, a **100% completion evidence comment** has been posted to that issue and verified visible, as defined below.

Until every condition holds, the task is in progress: do not report it as complete, do not close the issue, and do not promote to `master`.

## Completion verification (MANDATORY)

"Looks right" is not done. Before reporting any task complete, verify it from every angle, at completion time (not from stale mid-task results):

1. **Requirements** — re-read the original task/issue and walk it point by point: every requested behavior exists and is tested; nothing was silently narrowed, reinterpreted, or dropped. If scope changed, say so explicitly instead of claiming done.
2. **Tests prove the change** — for a fix, confirm the regression test actually fails without the fix (revert/stash, watch it fail, restore); for a feature, confirm the integration tests exercise the real wiring, not mocks of it.
3. **Runtime behavior** — exercise the change for real, not only through tests: call the API route, run the worker, load the page. Capture actual output as evidence.
4. **Full local gate** — `pnpm turbo run typecheck`, `pnpm exec biome check .`, and the affected packages' tests pass (see Workflow step 3).
5. **Diff self-review** — read `git diff origin/dev...HEAD` end to end before merging: no debug leftovers, no unrelated or generated files, no scope creep, no secrets.
6. **Docs & config** — README/runbooks/`.env.example`/migration notes updated wherever behavior, setup, or operations changed.
7. **Mechanical state** — run `bash scripts/verify-done.sh`: it must exit 0. It proves the working tree is clean, `dev` is pushed, the branch model is intact (`git-guard doctor`), and the `ci` workflow is green **for the current dev tip** — a green run on an older SHA does not count.
8. **Evidence in the report** — every claim is backed by fresh command output (test counts, CI run IDs, actual responses). A claim without evidence is unverified; "should work" is not done.

If any angle cannot be satisfied, the task stays in progress and the blocker must be reported — never report around it.

## GitHub issue completion evidence (MANDATORY)

GitHub issue comments are the permanent review record for issue work. Chat summaries, local terminal output, commit messages, and CI status alone do not satisfy this requirement.

After the work is merged and pushed to `dev`, the current `dev` CI run is green, and `bash scripts/verify-done.sh` passes, the integrating agent must post a final comment on the originating issue with the heading **`Completion evidence — 100% verified`**. Post it with `gh issue comment <number> --repo <owner/repo> ...` (or the equivalent GitHub tool), capture the returned comment URL, and re-read the published comment to verify that it is visible and correctly rendered before reporting or closing the issue.

The final comment must contain fresh, reviewable evidence for every item below:

1. **Requirements** — a point-by-point checklist mapping every issue requirement or acceptance criterion to the implementation and its proving test. Include relevant file paths and commit SHAs or links.
2. **Automated tests** — every exact command run, its result, and useful test counts. For a bug fix, include the regression test's observed red-before / green-after evidence.
3. **Functionality verification** — the real API, UI, CLI, worker, deployment, or other user-visible scenario exercised; the applicable tool used (for example browser automation, `curl`, a database client, or service logs); and the actual observed result. Include reviewable response excerpts, screenshots, recordings, or artifact/log links when the applicable tool can produce them. “Should work” is not evidence.
4. **Quality gates** — fresh results for typecheck, Biome, affected/full tests, and any applicable Go, build, migration, security, or platform-specific checks.
5. **Delivery and CI** — work branch, delivered commit(s), current `dev` SHA, and the CI run URL/ID with every job's conclusion.
6. **Completion verification** — the command and passing result from `bash scripts/verify-done.sh` for the current `dev` tip.
7. **Verification provenance** — the agent/model or session identity when available, the tools used for verification, and the verification timestamp.
8. **Risks, skips, and limitations** — this must say `None` for a 100% completion claim. If any required check, runtime scenario, tool, or acceptance criterion was skipped, unavailable, inconclusive, or failed, the issue is not 100% complete; post a progress/blocker comment instead and keep the issue open.

Do not expose secrets, credentials, private user data, or unredacted sensitive logs in evidence comments. Link safe CI artifacts or include minimal redacted excerpts instead.

The evidence comment must describe the exact code and CI state being delivered. If code changes, tests are rerun, or CI is rerun after the comment is published, update the comment or publish a superseding fresh comment and verify it again. The issue may be closed only after the final evidence comment is visible. If GitHub commenting or comment verification is unavailable, the task remains in progress and the access failure must be reported as a blocker.

### Parallel-wave handoff (feature-branch terminal state)

When many tasks run in parallel (one work branch each) and an **orchestrator integrates them serially**, a task agent's terminal state is a *pushed feature branch*, not a dev merge — so the default `scripts/verify-done.sh` (which requires `dev == origin/dev` + a green dev-CI run) does **not** apply. For that flow, **done = implemented + tested + committed + pushed feature branch**, verified with:

```bash
bash scripts/verify-done.sh --feature      # clean tree, on a work branch, pushed, branched off dev
```

The judgment angles above (requirements walked, tests actually run and load-bearing, diff self-review, docs) still apply in full. The orchestrator then merges the branch into `dev` and runs the default `scripts/verify-done.sh` before promotion.

Every parallel task agent must also post a **`Feature-branch handoff evidence — not yet 100% complete`** comment on its issue before handoff. That comment must include the branch and commit SHA, requirement coverage, exact test and quality-gate results, runtime verification evidence, verification provenance, and every skip or limitation. It must explicitly state that final completion is pending merge to `dev`, full `dev` CI, and the integrating agent's completion verification. The task agent must return the published comment URL to the orchestrator. After integration, the orchestrator is responsible for posting and verifying the final **`Completion evidence — 100% verified`** comment described above; a handoff comment can never substitute for it.

## Promotion `dev` → `master`

- Promote only by **fast-forwarding `master` to the dev tip** — never merge commits, cherry-picks, or direct commits onto `master`:
  ```bash
  git fetch origin
  git push origin origin/dev:master
  ```
  Only commits pushed to `dev` carry green `branch-guard`/`node`/`go`/`docker` checks; a merge commit created locally on `master` has none. On a `master` push the other CI jobs skip — the commit already passed them on `dev` — and `branch-guard` goes red unless the SHA is reachable from `dev` **and** has a successful `ci` run on `dev` (once the `protect-master` ruleset is active, GitHub rejects such pushes outright).
- Promote only when the work on `dev` is complete: implemented, tested, documented, committed, pushed, and **`dev` CI is green**.
- A non-docs push to `master` triggers the `deploy-tk104` workflow and **deploys to production**. The deploy builds nothing on tk104: it loads the images the commit's `dev` CI run built (artifact `release-images-<sha>`, kept 14 days — re-run that `ci` run's `docker` job if it has expired) and starts them. Promote deliberately and watch both the `ci` and deploy runs to completion.
- **Rollback** is `bash scripts/rollback-tk104.sh` on tk104: it restarts the previous release's images, which the host keeps loaded, and does not undo migrations. Therefore **every migration must stay compatible with the release before it** — add columns and tables first, drop what the previous release still reads only in a later release.

## Enforcement harness

The branch model is **machine-enforced**, not just documented (details, setup, and caveats: `docs/development/agent-harness.md`):

- **Claude Code** — `.claude/settings.json` runs `scripts/git-guard-hook.sh` as a `PreToolUse` hook on every Bash call and denies violating git commands with the reason.
- **Codex** — `.codex/rules/git-policy.rules` (execpolicy) forbids the violating commands and `.codex/hooks.json` runs the same guard hook. The project must be trusted once and the hook approved via `/hooks`.
- **git hooks (lefthook)** — `branch-guard` runs `scripts/git-guard.sh` on pre-commit and pre-push.
- **GitHub rulesets** (authoritative, binds every client including Codex cloud) — `main` cannot be created; `master`/`dev` cannot be force-pushed or deleted; `master` only accepts CI-green SHAs. Managed as code in `.github/rulesets/`, applied with `scripts/apply-rulesets.sh`. *Currently dormant: GitHub requires Pro/Team or a public repo for rulesets on this private repository.* Until then the `branch-guard` CI job audits every `master` push and fails the run if the SHA is not reachable from `dev`.

If the guard denies a command, do not work around it — follow the workflow above. Run `bash scripts/git-guard.sh doctor` to check your clone's enforcement wiring.

## Repository hygiene

- Never commit secrets; keep sensitive configuration in environment variables and document required vars in `.env.example`.
- Do not add `.md` files to the repository root. The only permitted root docs are `README.md` and the agent rule files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). Planning notes, roadmaps, handoffs, and other artifacts go in `ai_docs/` or `docs/`.
- Update README/runbooks/migration notes when behavior, setup, or operations change.
