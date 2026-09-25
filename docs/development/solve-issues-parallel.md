# Solving GitHub issues in parallel with Claude Managed Agents

`scripts/solve-issues-parallel.ts` fans the issue backlog out to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): one cloud-sandbox session per issue, each with this repository mounted and checked out on `dev`. Every session implements its issue on a `feature/issue-<n>-<slug>` branch, runs the local gate, pushes the branch, and publishes a reviewable feature-branch handoff evidence comment on the issue. That pushed branch plus its verified comment is the session's terminal state — the "parallel-wave handoff" defined in `CLAUDE.md` — and you (or an orchestrator agent) then merge the branches into `dev` serially and promote as usual.

## Prerequisites

| Requirement | Why |
| --- | --- |
| `ANTHROPIC_API_KEY` | Managed Agents beta (`managed-agents-2026-04-01`, set automatically by the SDK). Sessions are billed API usage. |
| `GITHUB_TOKEN` with `repo` read/write scope (falls back to `gh auth token`) | Passed to the API as the `github_repository` resource's `authorization_token` so the sandbox can clone and push. It is never embedded in prompts. |
| Authenticated `gh` CLI | Issue lookup (`gh issue view/list`) and the token fallback. |

## Usage

```bash
# Solve three specific issues, up to 3 sessions at once (the default)
pnpm solve:issues -- 207 203 194

# Solve up to 5 open issues labeled "bug", 2 at a time, on a cheaper model
pnpm solve:issues -- --label bug --limit 5 --concurrency 2 --model claude-sonnet-5

# Inspect the plan and the exact prompts without creating any sessions
pnpm solve:issues -- 207 --dry-run

# Watch the agents work (tool calls + messages)
pnpm solve:issues -- 207 --verbose
```

Run `pnpm solve:issues -- --help` for the full flag list (`--timeout-min`, `--repo`, …).

## How it works

1. **Issue selection** — explicit numbers or `--label`, fetched via `gh` from the current repository (override with `--repo owner/name`).
2. **Agent + environment** — a reusable agent (`squad-admin-panel issue solver`, full `agent_toolset_20260401` toolset) and a cloud environment are found by name or created on first run. `--model` applies per session through an `agent_with_overrides` reference, so runs with different models share one agent resource.
3. **One session per issue** — each session mounts the repo with `checkout: dev`, receives a task prompt encoding the `CLAUDE.md` rules (work branch off `dev`, mandatory tests, local gate, conventional commit referencing the issue, `verify-done.sh --feature`, a visible handoff evidence comment, no merges/PRs), and streams events until `session.status_idle`.
4. **Concurrency pool** — at most `--concurrency` sessions run at once; each has a `--timeout-min` wall-clock budget (default 45 min), after which the stream is aborted and the session reported as timed out (it keeps its state server-side and can be inspected or resumed in the [Console](https://platform.claude.com)).
5. **Report** — per-issue status (`solved` / `failed` / `timed-out`), session ID, expected branch name, and the agent's final message. Exit code is non-zero if any session did not finish cleanly.

## After a run

The runner never merges anything. Integrate the pushed branches the same way as any parallel wave:

1. Review each `feature/issue-<n>-*` branch (diff against `origin/dev`, check the tests the agent added).
2. Open the handoff evidence URL from each agent's final report and confirm that the published issue comment covers requirements, exact tests and gates, runtime verification, provenance, and all limitations. The comment is explicitly not a final completion claim.
3. Merge the branches into `dev` one at a time per the `CLAUDE.md` workflow, re-running the local gate between merges.
4. Watch the `deploy-tk104` run for the `dev` tip, promote it (`git push origin origin/dev:master`), watch the `ci` run on `master` to green, and run `bash scripts/verify-done.sh`.
5. For each integrated issue, post and verify the final `Completion evidence — 100% verified` issue comment required by `CLAUDE.md`. It must identify the current `dev` SHA, its deploy run and the `master` CI run; only then may the issue be reported complete or closed.

A `timed-out` or `failed` result means no trustworthy branch was pushed for that issue — check the session in the Console before assuming anything landed.

## Tests

The runner's orchestration logic (CLI parsing, branch naming, prompt building, concurrency pool) is covered by `scripts/solve-issues-parallel.test.ts`, run in CI's `node-lint` job and locally with:

```bash
pnpm solve:issues:test
```
