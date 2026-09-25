# Agent enforcement harness

The branch model in [`CLAUDE.md`](../../CLAUDE.md) — `master` = the verified branch fed only by fast-forward from `dev`, `dev` = integration fed only by work-branch merges, no `main` branch, tests + CI mandatory — is enforced mechanically, in depth, for every coding agent and human contributor. This document describes each layer, how to set it up, and its limits.

## The shared guard

[`scripts/git-guard.sh`](../../scripts/git-guard.sh) is the single source of truth. Every layer is a thin adapter around it. Exit code `0` allows, `2` denies with the reason on stderr.

| Subcommand | Used by | What it does |
| --- | --- | --- |
| `check-command "<shell string>"` | Claude Code PreToolUse hook | Parses a proposed shell command and denies branch-model violations before they run |
| `check-commit` | lefthook `pre-commit` | Denies direct commits on `master`, `dev` (except mid-merge conflict resolution), or `main` |
| `check-push` | lefthook `pre-push` | Reads the native pre-push refspec lines and denies pushes that violate the model |
| `doctor` | humans | Reports enforcement wiring problems in the current clone (never blocks) |

Blocked by `check-command`:

- creating, checking out, renaming to, tracking, or pushing any `main` ref;
- `git commit` while on `master`, or on `dev` outside merge-conflict resolution (`MERGE_HEAD` present);
- `git merge <work-branch>` while on `master` (only `dev` may be merged there);
- pushing a SHA to `master` that is **not reachable from `dev`** (`git merge-base --is-ancestor`) — the exact definition of "master only receives what went through dev";
- creating work branches from `master`/`origin/master` (they must come from `dev`);
- force-pushing or deleting `master`/`dev`, and `git push --all/--mirror`.

Deliberately **not** blocked: `--no-verify`. The pre-push test gate is environment-dependent (DB/Redis/Linux-only bridge tests), and CI is the source of truth per `CLAUDE.md`; the agent-layer hooks and GitHub rulesets still check every command and every push regardless.

Read-only `git branch` query forms (`git branch --list main`, `git branch -a`, `git branch --contains …`) are **not** blocked — only create/rename/checkout/push of a `main` ref is. Test suite: [`scripts/test-git-guard.sh`](../../scripts/test-git-guard.sh) (runs in CI as part of the `branch-guard` job) builds throwaway repositories and asserts the allow/deny decision for 69 scenarios. Run it locally with `bash scripts/test-git-guard.sh`.

## Layer 1 — Claude Code

[`.claude/settings.json`](../../.claude/settings.json) registers [`scripts/git-guard-hook.sh`](../../scripts/git-guard-hook.sh) as a `PreToolUse` hook for the `Bash` tool. The hook receives the tool-call JSON on stdin, extracts `tool_input.command`, and delegates to `check-command`. A denial (exit 2) is fed back to the model with the reason, so the agent self-corrects onto the documented workflow.

Committed project settings load automatically — no per-user setup.

## Layer 2 — git hooks (lefthook)

[`lefthook.yml`](../../lefthook.yml) runs `branch-guard` as a command on `pre-commit` (`check-commit`) and on `pre-push` (`check-push`, with `use_stdin: true` so it receives the native refspec lines). The pre-push guard runs on every push — including cross-ref pushes such as the dev→master promotion and file-less branch deletions. This layer binds humans and any tool that shells out to git with hooks enabled. Hooks install via the `prepare` script on `pnpm install`; if `core.hooksPath` is set globally it must delegate to lefthook (run `doctor` to check).

## Layer 3 — GitHub rulesets (authoritative)

Client-side layers can be bypassed by a client that doesn't load them (e.g. Codex, Gemini CLI, or cloud/web agents). The rulesets bind **every** client, with no bypass actors — including repository admins:

| Ruleset | Target | Rules |
| --- | --- | --- |
| `block-main` | `refs/heads/main` | creation and update restricted — the branch cannot exist |
| `protect-master` | `refs/heads/master` | no deletion, no force-push |
| `protect-dev` | `refs/heads/dev` | no deletion, no force-push |

`protect-master` requires no status checks. `ci` runs on `master` only after the promotion push has landed, so a check required *before* that push could never be satisfied. What makes a `master` push legitimate is that it fast-forwards to a commit already on `dev`:

```bash
git fetch origin
git push origin origin/dev:master
```

The client hooks deny any other `master` push, and the `branch-guard` job's "Audit master ancestry" step turns the `ci` run of that push red when the SHA is not reachable from `dev` — a bypass is detected at once instead of passing silently.

The rulesets live as code in [`.github/rulesets/`](../../.github/rulesets/) and are applied (create-or-update by name, idempotent) with:

```bash
scripts/apply-rulesets.sh   # requires gh with admin access
```

> **Not applied yet (checked 2026-09-26):** the repository is public, so GitHub accepts rulesets on it, but `gh api repos/seregatipich/squad-admin-panel/rulesets` returns `[]` — `scripts/apply-rulesets.sh` has not been run since the move to this repository (the former private organization repository could not have rulesets without GitHub Pro/Team). Until it is run, the client hooks and the `branch-guard` audit are the only enforcement.

Emergency escape hatch: edit or disable the ruleset in GitHub → Settings → Rules → Rulesets (deliberately manual and audited).

> **Code scanning plan gating (2026-07-29, issue #211):** GitHub's default CodeQL code-scanning setup (the dynamic `github-code-scanning/codeql` workflow, never a repo-committed file) requires **GitHub Advanced Security**, which was not licensed on the former private Free-plan organization repository — `gh api repos/breaking-squad/squad-admin-panel/code-scanning/default-setup` returned HTTP 403, and attempting to disable the workflow via the Actions API (`PUT .../actions/workflows/294697655/disable`) returns HTTP 422 `Unable to disable this workflow`. The dynamic workflow produced zero runs, successful or failed, after 2026-07-16 despite 8+ subsequent `master` pushes through 2026-07-28, so it is already out-of-band disabled and cannot be re-enabled from this repo without GHAS. There is no repo-committed `codeql*.yml`/`codeql*.yaml` workflow — creating one would fail identically. The regression guard [`scripts/test-codeql-default-setup.sh`](../../scripts/test-codeql-default-setup.sh) asserts both facts stay true: no such workflow file exists, and this note is present.

## CI and deployment runners

The repository is `seregatipich/squad-admin-panel`, a **public repository on a personal
account**: GitHub-hosted minutes are free, and there are no runner groups (they are an
organization feature). Every job of both workflows runs on a disposable `ubuntu-24.04`
VM; there is no self-hosted runner.

| Workflow | Trigger | What it does |
|---|---|---|
| [`deploy-tk104.yml`](../../.github/workflows/deploy-tk104.yml) | push to `dev` (except `**.md` and `docs/**`), or a dispatch with an optional `sha` | builds the four release images, pushes them to GHCR, and deploys them to the tk104 development stand — with no tests |
| [`ci.yml`](../../.github/workflows/ci.yml) | push to `master` (the fast-forward promotion), or a dispatch | the full verification suite; nothing deploys from it |

[`scripts/test-ci-runner-strategy.sh`](../../scripts/test-ci-runner-strategy.sh) fails
CI when a job of either workflow leaves the hosted image or selects a self-hosted runner
or a runner group — a group a personal account does not have would leave the job
`queued` forever without an error — when `ci` runs on anything but `master` pushes and
dispatches, when a deploy job loses its `github.repository` guard or the deploy leaves
the `tk104-dev` environment, or when the job graph described below drifts.

**Outside code must never reach a deploy secret.** Both workflows accept only trusted
`push` events and explicit dispatches — never `pull_request`.
[`scripts/test-workflow-security.sh`](../../scripts/test-workflow-security.sh) enforces
that no workflow combines a `pull_request`/`pull_request_target` trigger with a
self-hosted job, recognising the bare label, inline and block label lists, and runner
groups, and it checks its own detector against fixtures first (#217, #286). That guard
only sees workflow files already in the repository: a fork's pull request can bring its
own workflow file. Two repository settings close that gap and must stay on — Settings →
Actions → General → *Require approval for all outside collaborators*, and *Workflow
permissions: read repository contents*. The deploy secrets (`TK104_SSH_KEY`,
`TK104_SSH_KNOWN_HOSTS`) live only in the `tk104-dev` environment, whose deployment
branch policy admits `dev` alone.

### The stand deploy

`deploy-tk104.yml` has two jobs and no workflow-level concurrency:

- **`build`** — one matrix leg per image (`api`, `web`, `workers`, `caddy-tk104`), with
  `packages: write`. A leg skips the build when
  `ghcr.io/seregatipich/squad-panel-<image>:<sha>` already exists (a redeploy or a
  rollback); otherwise it builds that target of [`docker-bake.hcl`](../../docker-bake.hcl)
  and pushes `:<sha>` and `:dev`, with a registry layer cache at `:buildcache`
  (`mode=max`). A newer push cancels the same image's older build (concurrency group
  `deploy-build-<image>`), so a merge wave spends minutes only on the commit that will be
  deployed; the superseded run's deploy is then skipped.
- **`deploy`** — after every build, in the `tk104-dev` environment, one at a time
  (group `deploy-tk104`, never cancelled mid-flight). It resolves the four `:<sha>` tags
  to digests, writes the deploy key and the pinned host key (checked with
  `ssh-keygen -l` and `ssh-keygen -F tk104.duckdns.org`; `StrictHostKeyChecking=yes`),
  and runs

  ```bash
  ssh seregatipich@tk104.duckdns.org \
    "deploy <sha> api=sha256:<digest> web=sha256:<digest> workers=sha256:<digest> caddy-tk104=sha256:<digest>"
  ```

  The key is bound to a forced command on the host (`~/bin/panel-deploy`, an installed
  copy of `scripts/tk104-deploy-entry.sh`) that accepts only that shape, fetches the
  commit itself, and runs `scripts/deploy-tk104.sh` with the images pinned by digest: the
  job never gets a shell on tk104 and copies no files there. It then polls
  `https://tk104.duckdns.org/health` every 2 s for about 90 s until it answers 200 with
  `"status":"ok"`, and removes the key whatever happened.

Redeploy or roll back with `gh workflow run deploy-tk104.yml --ref dev -f sha=<40-hex sha>`;
the build job refuses a commit that `dev` does not contain.
[`scripts/deploy-tk104-workflow.test.ts`](../../scripts/deploy-tk104-workflow.test.ts)
(part of `pnpm test:scripts`) locks the job graph and runs the steps' own shell against
stubbed `gh`, `docker`, `ssh`, and `curl`.

### Verification

`ci.yml` cancels a superseded run of the same ref (`cancel-in-progress: true`); only
the newest SHA matters and nothing deploys from it.

| Job | What it runs |
|---|---|
| `branch-guard` | the master ancestry audit (on `master` pushes) and the harness's own contract suites |
| `lint` | Biome, the `test:cov` completeness check, the solve-issues runner tests, `turbo typecheck` (Turbo cache restored with `actions/cache`), gitleaks |
| `test-api` (4 shards) | a quarter of the API suite by test file, against Postgres and Redis services — no build, no migration |
| `test-web` (2 shards) | half of the web suite each — no services, no build |
| `test-packages` | every other `test:cov` package whole under its own thresholds, four at a time, longest first; builds only the workers the contract tests start |
| `scripts` | migrations, then `pnpm test:scripts` |
| `changes` → `mutation` | Stryker on `packages/shared-config`, only when it changed between `github.event.before` and the pushed SHA (always on a dispatch, a new branch, or a range the checkout cannot resolve) |
| `go` | `go vet`, `go test -race`, `govulncheck` (pinned `v1.7.0`), and a static-link check of the bridge binary |
| `images` | the `release` group and `rnsquadjs` of `docker-bake.hcl`, reading (never writing) the GHCR layer cache the stand deploy writes, then smoke tests: the api image imports `postgres`, every `WORKER` in `compose.tk104.yml` is in the workers image, and the workers image exits 64 without one |
| `backup` | the INFRA-8 backup/restore round trip (`scripts/test-backup-restore.sh`) |
| `gate` | `needs` every other job with `if: always()` and fails unless all of them succeeded (only `mutation` may be skipped); then merges the API and web shards' blob reports with `vitest --merge-reports --coverage`, which enforces those packages' coverage thresholds on the whole suite |

The API and web suites need no build: vitest resolves every `@squad/*` import to its
source through the packages' `development` export condition, and the API harness builds
its template database from the SQL migrations itself. One shard cannot meet its
package's thresholds, so [`scripts/ci-test-shard.sh`](../../scripts/ci-test-shard.sh)
switches them off per shard and writes a blob report, and `gate` applies them to the
merged coverage. [`scripts/test-ci-test-shard.sh`](../../scripts/test-ci-test-shard.sh)
fails CI if the slices stop adding up to the `test:cov` list exactly or the shard
arguments drift.

The PostgreSQL and Redis service containers keep their data on bounded `tmpfs` mounts
(1 GiB and 128 MiB), so an interrupted job never leaves anonymous volumes behind, and
poll their health every 2 s. `test-api` and `test-packages` also switch off `fsync`,
`synchronous_commit`, and `full_page_writes` — through `ALTER SYSTEM` and
`pg_reload_conf()` over `docker exec`, since service containers take no server
arguments — because the data dies with the VM. Turbo hashes no connection setting
(`DATABASE_URL`, `REDIS_URL` and the rest are `globalPassThroughEnv`): the services get a
new host port every run, and a hashed port would make every cached task a miss.

The `go` job runs natively: the hosted image ships a C compiler, so `go test -race`
needs no container, and `actions/setup-go` caches modules keyed by
`apps/bridge/go.sum`.

Для снижения локальной нагрузки перед `git push` можно задать
`VITEST_MAX_FORKS=2`. Переменная включена в `globalPassThroughEnv` Turbo: она
доходит до Vitest, но не меняет ключи кэша, поскольку влияет только на число
одновременных процессов. Stryker также ограничен двумя процессами в своём
конфигурационном файле, поэтому мутационная проверка не занимает все ядра
рабочей машины. Предварительный шлюз одновременно запускает не больше двух
затронутых пакетных тестов; для осознанной локальной настройки служит
`PREPUSH_TURBO_CONCURRENCY`, значение по умолчанию — `2`.

## Deploy troubleshooting

A failed `deploy-tk104` run names the step that broke:

- **`build`** — a Dockerfile or bake problem. `ci`'s `images` job builds the same
  targets when the commit is promoted.
- **Resolve the image digests** — an image of that SHA is missing from GHCR, usually
  because a build leg was cancelled by a newer push; re-run the workflow.
- **Configure pinned SSH trust and deploy key** — the `tk104-dev` environment lacks
  `TK104_SSH_KEY`, or `TK104_SSH_KNOWN_HOSTS` holds no valid key line for
  `tk104.duckdns.org`.
- **Deploy the release on tk104** — the forced command refused the request, or
  `scripts/deploy-tk104.sh` failed on the host; its output is in the step log.
- **External health check** — the release started, but `/health` did not report
  `"status":"ok"` within about 90 s. Roll back with a dispatch of the last good SHA, or
  with `bash scripts/rollback-tk104.sh` on the host. Neither undoes migrations (see
  CLAUDE.md → "Dev stand and promotion").

**History.** Verification first ran hosted with a separate self-hosted deploy runner
(#286), then moved onto the `breaking-squad` organization's `selfhost-group-1` group
(2026-08-24). Organization runners could only be re-registered with an `admin:org`
credential, and they failed twice with their registration files gone (#215, 2026-09-07).
When the organization repository became unavailable (2026-09-16) the project moved to
`seregatipich/squad-admin-panel`, returned verification to hosted VMs, and registered a
single repository-level deploy runner on tk104. Since the CI/CD redesign (2026-09) tk104
is a development stand fed by every `dev` push through hosted VMs and a forced-command
SSH key, `ci` runs on `master` after promotion, and no workflow uses a self-hosted
runner; `scripts/check-runner-health.sh` went with it.

## Completion verification

The harness also enforces *how tasks end*: CLAUDE.md's **Completion verification** checklist (part of the definition of done) requires agents to verify a finished task from every angle — requirements coverage, tests that provably exercise the change, real runtime evidence, a full local gate, a diff self-review, docs, and mechanical state. The mechanical angles are automated:

```bash
bash scripts/verify-done.sh   # exit 0 required before reporting done
```

It proves the working tree is clean, `dev` is checked out and pushed, `git-guard doctor` is clean, and — via `gh` — that the `deploy-tk104` run for the current `origin/dev` SHA succeeded and that this SHA is promoted to `master` with a green `ci` run **for that SHA specifically**, rejecting the classic failure mode of pointing at a green run for an older commit.

For the **parallel-wave flow** (many work branches integrated serially by an orchestrator), a task agent's terminal state is a pushed feature branch, not a dev merge — use `bash scripts/verify-done.sh --feature`, which checks the branch is a work branch, the tree is clean, it is pushed (`HEAD == origin/<branch>`), and it was branched off `dev`. The orchestrator runs the default mode after merging. Test suite: [`scripts/test-verify-done.sh`](../../scripts/test-verify-done.sh) (runs in CI's `branch-guard` job with a stubbed `gh`) covers both modes.

Setup helper: [`scripts/new-test-db.sh <slug>`](../../scripts/new-test-db.sh) provisions an isolated, migrated test database (real password from `.env`, `127.0.0.1` host) and prints eval-able `DATABASE_URL` + `TEST_DATABASE_URL` exports — removing the most common per-agent setup friction.

## Diagnosing a clone

```bash
bash scripts/git-guard.sh doctor
```

Warns when: `core.hooksPath` shadows lefthook without delegating to it, a `main` ref exists locally or on origin, `origin/master` has commits not on `origin/dev` (someone bypassed dev — back-merge to reconcile), or `jq` is missing (hook adapters fall back to `python3`).

## Limits

- `check-command` polices **only this repository** (worktrees included, identified by the git common dir). Commands targeting other repos — scratch fixtures under `/tmp`, clones, `git -C <elsewhere>` — are allowed, as are segments following a `cd` to a dynamically computed directory.
- `check-command` tokenizes shell strings heuristically; compound commands, `cd`/`git -C` targets, and env prefixes are handled, but exotic quoting can evade it. That layer exists for fast in-session feedback — the rulesets are the enforcement boundary.
- Client-side layers only bind clients that load them (project settings for Claude Code, installed hooks for git). New machines should run `doctor` once.
