# CI gate and local pre-check

Details behind the "CI gate" rules in [`CLAUDE.md`](../../CLAUDE.md). Runner and deploy-pipeline internals live in [agent-harness.md](agent-harness.md); the stand deploy and promotion procedure is in [deploy.md](deploy.md).

## CI gate

Local green is not proof — **`ci` on `master` is the source of truth**. The workflow runs only on pushes to `master` (the fast-forward promotion from `dev`) and on explicit dispatches; `dev` pushes deploy the stand instead. After every promotion, `bash scripts/verify-done.sh --wait` waits for the result. When it reports a red run, fix forward on `dev` until every check passes:

```bash
gh run list --branch master --workflow ci.yml --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

To check a `dev` commit before promoting it, dispatch the same workflow on it: `gh workflow run ci.yml --ref dev`.

**Everything runs on GitHub-hosted VMs (`runs-on: ubuntu-24.04`), including the deploy.** `deploy.yml` builds the images on hosted runners, pushes them to GHCR, and reaches the stand host over SSH with a forced-command key held in the `stand` environment, whose deployment branch policy admits `dev` alone. There is no self-hosted runner. The repository is public on a personal account, so hosted minutes are free and runner groups do not exist — a job that selects `runs-on: group: …` waits in the queue forever. [`scripts/test-ci-runner-strategy.sh`](../../scripts/test-ci-runner-strategy.sh) fails CI if a job leaves the hosted image, the deploy leaves the `stand` environment, or any workflow selects a runner group or a self-hosted runner.

Workflows stay limited to trusted pushes and explicit dispatches — never `pull_request` — and superseded runs are cancelled (a deploy already in flight is never interrupted). [`scripts/test-workflow-security.sh`](../../scripts/test-workflow-security.sh) fails CI if any workflow ever reaches a self-hosted job from a pull-request trigger, by label or by group. Because a fork's pull request can bring its own workflow file, the repository setting *Require approval for all outside collaborators* must stay on. See "CI and deployment runners" in [agent-harness.md](agent-harness.md).

**Adding a package? Add it to `test:cov`.** The api and web suites run as parallel `vitest --shard` slices whose coverage is merged before the thresholds are checked; every other package runs through the `test:cov` script's explicit `--filter` list, driven by `scripts/ci-test-shard.sh`. A package missing from that list never runs in CI — it can be merged with a red suite while the dashboard stays green (#229: 16 of 28 suites were invisible this way, and two workers sat broken behind a green dashboard). [`scripts/test-cov-complete.sh`](../../scripts/test-cov-complete.sh) fails CI when a workspace package whose `test` script runs vitest is not in the list; run it locally any time with `bash scripts/test-cov-complete.sh`. The Go bridge is deliberately excluded — it has its own `go` job.

**Every `uses:` line under `.github/workflows/` must be SHA-pinned.** A mutable version tag (e.g. `@v4`) can be repointed to execute arbitrary code; the highest-severity case is `deploy.yml`, whose deploy job writes the stand SSH deploy key to disk (#248). [`scripts/test-workflow-pins.sh`](../../scripts/test-workflow-pins.sh) fails CI when any `uses:` line is not a 40-hex-char commit SHA; run it locally any time with `bash scripts/test-workflow-pins.sh`.

## Local pre-check

The lefthook `pre-push` hook runs [`scripts/pre-push-checklist.sh`](../../scripts/pre-push-checklist.sh) automatically before every push **that updates `dev`**; work-branch pushes and the `dev`→`master` promotion skip it (nothing deploys from the former, and the latter promotes a tip the checklist already passed). It is deliberately light — about a minute — because it guards pushes that deploy the stand straight away, while the heavy suite runs in `ci` on promotion. Any failed item blocks the push (bypass in an emergency with `git push --no-verify`).

By default the checklist runs, in order:

1. `git fetch origin dev` (offline, the local `origin/dev` ref is used as is). "Changed" below is measured from the merge base with `origin/dev`, like `git diff origin/dev...`, so commits that landed on `dev` after the branch forked never count as this branch's changes.
2. `biome check` over the source tree — the item that most often breaks after a merge; an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it, fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail it.
3. gitleaks secret scan of `origin/dev..HEAD` (only if `gitleaks` is installed).
4. `turbo run typecheck` for the changed packages and their dependents.
5. Tests of the changed packages only, not their dependents; in `apps/api`, only the test files the diff touches. Suites that read `DATABASE_URL` or `REDIS_URL` run against `DATABASE_URL` or a database provisioned for the worktree, and are skipped with a warning when neither is available.
6. `pnpm test:scripts`, only when `scripts/` or `.github/` changed (it needs the database and Redis too).

`FULL=1 bash scripts/pre-push-checklist.sh` runs the old full gate (full typecheck, build, `test:scripts`, `test:cov`, mutation tests) — use it before a promotion you want to be confident about. Turbo already shares one cache between all worktrees of the clone (the main checkout's `.turbo/cache`), so packages another worktree built or typechecked are cache hits. **Not run locally:** the Go bridge (`apps/bridge` — cannot build on macOS; run `go vet ./... && go test -race ./...` there on Linux) and Docker image builds. The branch model is still enforced independently by the lefthook/`.claude` git-guard hooks (see [agent-harness.md](agent-harness.md)).
