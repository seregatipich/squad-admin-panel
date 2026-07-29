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

> **Code scanning plan gating (2026-07-29, issue #211):** GitHub's default CodeQL code-scanning setup (the dynamic `github-code-scanning/codeql` workflow, never a repo-committed file) requires **GitHub Advanced Security**, which is not licensed on this private Free-plan repository — `gh api repos/breaking-squad/squad-admin-panel/code-scanning/default-setup` returns HTTP 403, and attempting to disable the workflow via the Actions API (`PUT .../actions/workflows/294697655/disable`) returns HTTP 422 `Unable to disable this workflow`. The dynamic workflow produced zero runs, successful or failed, after 2026-07-16 despite 8+ subsequent `master` pushes through 2026-07-28, so it is already out-of-band disabled and cannot be re-enabled from this repo without GHAS. There is no repo-committed `codeql*.yml`/`codeql*.yaml` workflow — creating one would fail identically. The regression guard [`scripts/test-codeql-default-setup.sh`](../../scripts/test-codeql-default-setup.sh) asserts both facts stay true: no such workflow file exists, and this note is present.

## Self-hosted runner

CI executes on a dedicated self-hosted GitHub Actions runner rather than GitHub-hosted VMs: a Multipass VM sized 2 vCPU / 4 GB RAM / 20 GB disk, with Docker and the runner agent installed inside. It's registered under the org's default runner group and labels (just `self-hosted` — no custom tags), visible to org admins at [github.com/organizations/breaking-squad/settings/actions/runners](https://github.com/organizations/breaking-squad/settings/actions/runners). All four jobs in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) target it via `runs-on: self-hosted`.

Unlike GitHub-hosted runners, this VM is **not ephemeral**: it has no auto-refresh or periodic recreation yet, so anything a job leaves behind — Docker images, build cache, stray containers — persists indefinitely on the 20 GB disk instead of vanishing at the end of the run. Two things in the workflow compensate:

- The `docker` job prunes dangling images, build cache, and stray containers after every run (`if: always()`), so a failed build doesn't leave the disk any fuller than a green one.
- Every job sets a `timeout-minutes`, so one wedged job can't block the queue on the single shared runner indefinitely.

The box is also small enough that test/build parallelism is deliberately capped rather than left at each tool's default: the `node` job sets the `VITEST_MAX_FORKS` and `PNPM_WORKSPACE_CONCURRENCY` env vars (read by [`apps/api/vitest.config.ts`](../../apps/api/vitest.config.ts) and root [`package.json`](../../package.json)'s `test:cov` script respectively) and passes `--concurrency=2` to `turbo`, so parallel work fits 2 vCPU / 4 GB instead of thrashing or getting OOM-killed.

Not solved yet: the operator described the VM as cloud-init-based and may later add automatic environment cleanup and/or periodic VM recreation. The open design questions there — dynamic naming for the replacement VM, and gracefully draining/stopping the previous one before swapping — are unaddressed for now.

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
