# Agent enforcement harness

The branch model in [`AGENTS.md`](../../AGENTS.md) — `master` = production fed only from `dev`, `dev` = integration fed only by work-branch merges, no `main` branch, tests + CI mandatory — is enforced mechanically, in depth, for every coding agent and human contributor. This document describes each layer, how to set it up, and its limits.

## The shared guard

[`scripts/git-guard.sh`](../../scripts/git-guard.sh) is the single source of truth. Every layer is a thin adapter around it. Exit code `0` allows, `2` denies with the reason on stderr.

| Subcommand | Used by | What it does |
| --- | --- | --- |
| `check-command "<shell string>"` | Claude Code / Codex PreToolUse hooks | Parses a proposed shell command and denies branch-model violations before they run |
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

Deliberately **not** blocked: `--no-verify`. The pre-push test gate is environment-dependent (DB/Redis/Linux-only bridge tests), and CI is the source of truth per `AGENTS.md`; the agent-layer hooks and GitHub rulesets still check every command and every push regardless.

Read-only `git branch` query forms (`git branch --list main`, `git branch -a`, `git branch --contains …`) are **not** blocked — only create/rename/checkout/push of a `main` ref is. Test suite: [`scripts/test-git-guard.sh`](../../scripts/test-git-guard.sh) (runs in CI as part of the `branch-guard` job) builds throwaway repositories and asserts the allow/deny decision for 69 scenarios. Run it locally with `bash scripts/test-git-guard.sh`.

## Layer 1 — Claude Code

[`.claude/settings.json`](../../.claude/settings.json) registers [`scripts/git-guard-hook.sh`](../../scripts/git-guard-hook.sh) as a `PreToolUse` hook for the `Bash` tool. The hook receives the tool-call JSON on stdin, extracts `tool_input.command`, and delegates to `check-command`. A denial (exit 2) is fed back to the model with the reason, so the agent self-corrects onto the documented workflow.

Committed project settings load automatically — no per-user setup.

## Layer 2 — Codex

Two repo-shipped mechanisms, both loaded only when the project is **trusted**:

- [`.codex/rules/git-policy.rules`](../../.codex/rules/git-policy.rules) — execpolicy prefix rules marking the violating commands `forbidden`. Verify any change with:
  ```bash
  codex execpolicy check --rules .codex/rules/git-policy.rules -- git push origin master
  ```
- [`.codex/hooks.json`](../../.codex/hooks.json) — a `PreToolUse` hook running the same `scripts/git-guard-hook.sh` (Codex uses the same stdin shape and exit-2-denies contract as Claude Code).

One-time per-user setup:

1. Trust the project when Codex prompts (records `trust_level = "trusted"` for this path in `~/.codex/config.toml`).
2. Review and approve the repo hook with the `/hooks` command in the Codex CLI.

Known limits (upstream): `codex exec` (non-interactive) currently does not dispatch repo hooks ([openai/codex#26383](https://github.com/openai/codex/issues/26383)) — the rules layer and the GitHub rulesets still apply. Prefix rules match argv prefixes, so exotic refspec spellings can slip past them; the hook and the rulesets catch those.

## Layer 3 — git hooks (lefthook)

[`lefthook.yml`](../../lefthook.yml) runs `branch-guard` on `pre-commit` (`check-commit`, as a command) and on `pre-push` (`check-push`, as the script [`.lefthook/pre-push/branch-guard`](../../.lefthook/pre-push/branch-guard)). The pre-push guard is a lefthook *script* deliberately: lefthook skips *commands* whenever the current branch has no unpushed diff — which is exactly the state during a cross-ref push such as the dev→master promotion — while scripts always run and receive the refspec lines on stdin. This layer binds humans and any tool that shells out to git with hooks enabled. Hooks install via the `prepare` script on `pnpm install`; if `core.hooksPath` is set globally it must delegate to lefthook (run `doctor` to check).

## Layer 4 — GitHub rulesets (authoritative)

Client-side layers can be bypassed by a client that doesn't load them (e.g. Codex cloud/web agents). The rulesets bind **every** client, with no bypass actors — including repository admins:

| Ruleset | Target | Rules |
| --- | --- | --- |
| `block-main` | `refs/heads/main` | creation and update restricted — the branch cannot exist |
| `protect-master` | `refs/heads/master` | no deletion, no force-push, and **required status checks** `branch-guard`, `node`, `go`, `docker` on the pushed SHA |
| `protect-dev` | `refs/heads/dev` | no deletion, no force-push |

Because a SHA can only carry those green checks by having been pushed to `dev` (the `ci` workflow runs on `dev` pushes, and `branch-guard` fails PRs targeting `master` from anything but `dev`), **the only way to update `master` is to fast-forward it to a CI-green `dev` tip**:

```bash
git fetch origin
git push origin origin/dev:master
```

The rulesets live as code in [`.github/rulesets/`](../../.github/rulesets/) and are applied (create-or-update by name, idempotent) with:

```bash
scripts/apply-rulesets.sh   # requires gh with admin access
```

> **Plan gating (2026-07-06):** GitHub rejects rulesets and branch protection on this repository with HTTP 403 — for **private** repositories they require GitHub Pro/Team; public repositories get them free. Until the repo is made public or the plan upgraded, this layer is dormant (the JSON and applier are ready — rerun `scripts/apply-rulesets.sh` the moment it's unlocked). The active free-plan fallback is **detection**: the `branch-guard` CI job's "Audit master ancestry" step fails the `ci` run on any push to `master` whose SHA is not reachable from `dev`, so a bypass turns master's CI red immediately instead of passing silently.

Emergency escape hatch: edit or disable the ruleset in GitHub → Settings → Rules → Rulesets (deliberately manual and audited).

> **Code scanning plan gating (2026-07-29, issue #211):** GitHub's default CodeQL code-scanning setup (the dynamic `github-code-scanning/codeql` workflow, never a repo-committed file) requires **GitHub Advanced Security**, which was not licensed on the former private Free-plan organization repository — `gh api repos/breaking-squad/squad-admin-panel/code-scanning/default-setup` returned HTTP 403, and attempting to disable the workflow via the Actions API (`PUT .../actions/workflows/294697655/disable`) returns HTTP 422 `Unable to disable this workflow`. The dynamic workflow produced zero runs, successful or failed, after 2026-07-16 despite 8+ subsequent `master` pushes through 2026-07-28, so it is already out-of-band disabled and cannot be re-enabled from this repo without GHAS. There is no repo-committed `codeql*.yml`/`codeql*.yaml` workflow — creating one would fail identically. The regression guard [`scripts/test-codeql-default-setup.sh`](../../scripts/test-codeql-default-setup.sh) asserts both facts stay true: no such workflow file exists, and this note is present.

## CI and deployment runners

The repository is `seregatipich/squad-admin-panel`, a **public repository on a personal
account**. Two facts follow: GitHub-hosted minutes are free, and there are no runner
groups (they are an organization feature). The split is therefore:

| Workflow | Runner | Why |
|---|---|---|
| `ci.yml` (`branch-guard`, `node`, `go`, `docker`) | `runs-on: ubuntu-24.04` | Ephemeral VMs, jobs in parallel, and no verification code ever executes on the production host. |
| `deploy-tk104.yml` (every job) | `runs-on: [self-hosted, tk104-deploy]` + `environment: production` | The only jobs that need the host. The runner is registered on the repository and runs on tk104 under the unprivileged `gh-runner` account (no sudo, no Docker group); it reaches the deploy account over SSH. |

[`scripts/test-ci-runner-strategy.sh`](../../scripts/test-ci-runner-strategy.sh) fails
CI when a `ci` job leaves the hosted image, when a deploy job leaves the labelled runner
or the `production` environment or loses its `github.repository` guard, or when any
workflow selects a runner group — a group a personal account does not have would leave
the job `queued` forever without an error.

**Outside code must never reach the tk104 runner.** CI accepts only trusted `push`
events for `dev`/`master` and explicit dispatches — never `pull_request`.
[`scripts/test-workflow-security.sh`](../../scripts/test-workflow-security.sh) enforces
that no workflow combines a `pull_request`/`pull_request_target` trigger with a
self-hosted job, recognising the bare label, inline and block label lists, and runner
groups, and it checks its own detector against fixtures first (#217, #286). That guard
only sees workflow files already in the repository: a fork's pull request can bring its
own workflow file. Two repository settings close that gap and must stay on — Settings →
Actions → General → *Require approval for all outside collaborators*, and *Workflow
permissions: read repository contents*. Deploy secrets (`TK104_SSH_KEY`,
`TK104_SSH_KNOWN_HOSTS`) live only in the `production` environment, which admits the
`master` branch alone.

`cancel-in-progress: true` discards a superseded SHA so a merge wave does not spend
runner time on commits that are already replaced. The `node` timeout stays at 45
minutes because a hosted VM starts without a Turbo cache.

The `go` job runs natively: the hosted image ships a C compiler, so `go test -race`
needs no container, and `actions/setup-go` caches modules keyed by
`apps/bridge/go.sum`. `govulncheck` is pinned to `v1.7.0`, and the job fails if the
bridge binary is not statically linked.

The `node` job's PostgreSQL and Redis service containers keep their data on bounded
`tmpfs` mounts (1 GiB and 128 MiB), so an interrupted job never leaves anonymous
volumes behind; the exact options are locked in `test-ci-runner-strategy.sh`.

Для снижения локальной нагрузки перед `git push` можно задать
`VITEST_MAX_FORKS=2`. Переменная включена в `globalPassThroughEnv` Turbo: она
доходит до Vitest, но не меняет ключи кэша, поскольку влияет только на число
одновременных процессов. Stryker также ограничен двумя процессами в своём
конфигурационном файле, поэтому мутационная проверка не занимает все ядра
рабочей машины. Предварительный шлюз одновременно запускает не больше двух
затронутых пакетных тестов; для осознанной локальной настройки служит
`PREPUSH_TURBO_CONCURRENCY`, значение по умолчанию — `2`.

## Runner recovery runbook

`ci` never waits for a self-hosted runner. If a **deployment** run stays `queued`, run
[`scripts/check-runner-health.sh`](../../scripts/check-runner-health.sh): it lists the
repository's runners with `status`/`busy` and exits non-zero unless at least one is
`online`. There is no organization endpoint to consult. Its suite,
[`scripts/test-check-runner-health.sh`](../../scripts/test-check-runner-health.sh), stubs
`gh` and covers online, offline, none-registered, and failed-query cases, and fails if
the script ever queries an organization.

On tk104 the runner is the systemd unit
`actions.runner.seregatipich-squad-admin-panel.tk104-deploy.service`, installed in
`/home/gh-runner/actions-runner`:

```bash
ssh -i ~/.ssh/tk104_deploy seregatipich@tk104.duckdns.org \
  'sudo systemctl status actions.runner.seregatipich-squad-admin-panel.tk104-deploy.service'
```

If its registration is gone (`Not configured. Run config.(sh/cmd)`), mint a
repository registration token and re-register in place; a repository admin's `gh`
token is enough, no organization scope is involved:

```bash
gh api -X POST repos/seregatipich/squad-admin-panel/actions/runners/registration-token --jq .token
# on tk104, as gh-runner, in /home/gh-runner/actions-runner:
./config.sh --url https://github.com/seregatipich/squad-admin-panel --token <token> \
  --name tk104-deploy --labels tk104-deploy --unattended --replace
sudo ./svc.sh install gh-runner && sudo ./svc.sh start
```

**History.** Verification first ran hosted with a separate self-hosted deploy runner
(#286), then moved onto the `breaking-squad` organization's `selfhost-group-1` group
(2026-08-24). Organization runners could only be re-registered with an `admin:org`
credential, and they failed twice with their registration files gone (#215, 2026-09-07).
When the organization repository became unavailable (2026-09-16) the project moved to
`seregatipich/squad-admin-panel`, returned verification to hosted VMs, and registered a
single repository-level deploy runner on tk104; the old organization runners were
uninstalled and archived on the host.

## Completion verification

The harness also enforces *how tasks end*: AGENTS.md's **Completion verification** checklist (part of the definition of done) requires agents to verify a finished task from every angle — requirements coverage, tests that provably exercise the change, real runtime evidence, a full local gate, a diff self-review, docs, and mechanical state. The mechanical angles are automated:

```bash
bash scripts/verify-done.sh   # exit 0 required before reporting done
```

It proves the working tree is clean, `dev` is checked out and pushed, `git-guard doctor` is clean, and — via `gh` — that the `ci` workflow is green **for the current `origin/dev` SHA specifically**, rejecting the classic failure mode of pointing at a green run for an older commit.

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
- Client-side layers only bind clients that load them (trusted project for Codex, project settings for Claude Code, installed hooks for git). New machines should run `doctor` once.
