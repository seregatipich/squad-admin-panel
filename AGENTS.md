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
5. **Before pushing, the local pre-push checklist must pass** — `scripts/pre-push-checklist.sh` runs automatically via the lefthook pre-push hook as a fast local pre-check (see "CI gate"). The push to `dev` then triggers the `ci` workflow on the self-hosted runner; watch the run and fix forward until every check is green. Work is not done while `dev` CI is red.
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
- **Adding an API route?** Register it in **BOTH** `apps/api/src/server.ts` **and** `apps/api/test/integration/harness.ts` — they keep parallel registration lists, so a route missing from the harness 404s in integration tests.
- **API tests that mutate `players`/`roles`/`panel_meta`** must scope the mutation by `steamId64` (a unique/test-range value), never a bare `uuid` — the parallel `test:cov` shares one DB and `apps/api/test/test-isolation.regression.test.ts` fails any unguarded `delete(players)` / `update(players).roleId` / …. A single-file `vitest run <your.test.ts>` does NOT run that guard, so before pushing also run `pnpm --filter @squad/api exec vitest run test/test-isolation.regression.test.ts`.
- **The pre-push checklist auto-provisions a test DB when it can.** If `DATABASE_URL` is unset but Docker and `.env` are present, `scripts/pre-push-checklist.sh` runs `scripts/new-test-db.sh` for you; if neither a DB nor Docker is available the checklist fails rather than silently skipping tests. Even so, the checklist is a local pre-check, not the gate — **CI is the source of truth.** The Go bridge build cannot run on macOS and Docker image builds are not run locally, so `--no-verify` remains available for genuine emergencies (and for pushing when only Go/Docker-scoped work is untestable locally); CI will still catch anything skipped locally.

## CI gate

Local green is not proof — **CI is the source of truth**. After every push to `dev` (and to `master`), fetch the run result and iterate until every check passes:

```bash
gh run list --branch <branch> --workflow ci --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

The `ci` workflow runs on the org's self-hosted runner (a Multipass VM registered under the default `self-hosted` label) — see the "Self-hosted runner" section in `docs/development/agent-harness.md` for its setup and operating details.

### Local pre-check

The lefthook `pre-push` hook runs [`scripts/pre-push-checklist.sh`](scripts/pre-push-checklist.sh) automatically before every push, as a fast local pre-check ahead of the cloud run. Any failed item blocks the push (bypass in an emergency with `git push --no-verify`).

The checklist runs, in order:

1. `pnpm turbo run typecheck`
2. `pnpm exec biome check .` (whole repo) — the item that most often breaks after a merge; an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it, fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail it.
3. `pnpm turbo run build` (skip with `SKIP_BUILD=1`)
4. gitleaks secret scan (best-effort — only if `gitleaks` is installed)
5. Tests — the packages affected since `origin/dev` (`pnpm turbo run test --filter='...[origin/dev]'`), or the full coverage suite with `FULL=1`. Auto-provisions an isolated migrated DB via `scripts/new-test-db.sh` when `DATABASE_URL` is unset.

Run it by hand any time with `bash scripts/pre-push-checklist.sh`. **Not run locally:** the Go bridge (`apps/bridge` — cannot build on macOS; run `go vet ./... && go test -race ./...` there on Linux) and Docker image builds. The branch model is still enforced independently by the lefthook/`.claude` git-guard hooks (see "Enforcement harness"), not by CI.

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.

## Definition of done

A task — issue, fix, feature, or module — counts as **done** only when ALL of the following hold:

1. The work is merged into `dev` and **pushed to `origin/dev`**.
2. The change is **completely covered by tests** (regression tests for fixes, integration tests for modules — see Testing policy).
3. **ALL tests are verified passing** — the full suite green on the `dev` CI run, not just the tests you added.
4. The **Completion verification** checklist below has been executed at completion time — `scripts/verify-done.sh` exits 0 and every judgment angle is backed by evidence.

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

### Parallel-wave handoff (feature-branch terminal state)

When many tasks run in parallel (one work branch each) and an **orchestrator integrates them serially**, a task agent's terminal state is a *pushed feature branch*, not a dev merge — so the default `scripts/verify-done.sh` (which requires `dev == origin/dev` + a green dev-CI run) does **not** apply. For that flow, **done = implemented + tested + committed + pushed feature branch**, verified with:

```bash
bash scripts/verify-done.sh --feature      # clean tree, on a work branch, pushed, branched off dev
```

The judgment angles above (requirements walked, tests actually run and load-bearing, diff self-review, docs) still apply in full. The orchestrator then merges the branch into `dev` and runs the default `scripts/verify-done.sh` before promotion.

## Promotion `dev` → `master`

- Promote only by **fast-forwarding `master` to the dev tip** — never merge commits, cherry-picks, or direct commits onto `master`:
  ```bash
  git fetch origin
  git push origin origin/dev:master
  ```
  Only commits pushed to `dev` carry green `branch-guard`/`node`/`go`/`docker` checks; a merge commit created locally on `master` has none. The `branch-guard` CI job audits every `master` push and goes red if the SHA is not reachable from `dev` (and once the `protect-master` ruleset is active, GitHub rejects such pushes outright).
- Promote only when the work on `dev` is complete: implemented, tested, documented, committed, pushed, and **`dev` CI is green**.
- A non-docs push to `master` triggers the `deploy-tk104` workflow and **deploys to production**. Promote deliberately and watch both the `ci` and deploy runs to completion.

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
