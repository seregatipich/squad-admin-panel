# Solving GitHub issues in parallel with Claude Managed Agents

`scripts/solve-issues-parallel.ts` fans the issue backlog out to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): one cloud-sandbox session per issue, each with this repository mounted and checked out on `dev`. Every session implements its issue on a `feature/issue-<n>-<slug>` branch, runs the local gate, pushes the branch, and publishes a reviewable feature-branch handoff evidence comment on the issue. That pushed branch plus its verified comment is the session's terminal state — the "parallel-wave handoff" defined in `CLAUDE.md` — and you (or an orchestrator agent) then merge the branches into `dev` serially and promote as usual.

## Prerequisites

| Requirement | Why |
| --- | --- |
| `ANTHROPIC_API_KEY` | Managed Agents beta (`managed-agents-2026-04-01`, set automatically by the SDK). Sessions are billed API usage. |
| `GITHUB_TOKEN`: a **fine-grained** personal access token (`github_pat_…`) limited to this repository, with *Contents* and *Issues* read/write and **no** *Workflows* permission | Passed to the API as the `github_repository` resource's `authorization_token` so the sandbox can clone, push its branch and comment on the issue. It is never embedded in prompts. Classic (`ghp_…`) and OAuth tokens — including `gh auth token`, which used to be the fallback — are refused: they reach every repository of their owner. |
| Authenticated `gh` CLI | Issue lookup (`gh api repos/{repo}/issues…`). |

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

## Security model

The repository is public, so anyone can open an issue, and the issue text becomes the first message of an agent that can push. The runner treats that text as untrusted input (#33):

- **Only trusted authors.** An issue is solved only when its author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`; every other issue — explicitly numbered or matched by `--label` — is skipped with a message and its text never reaches a session. An issue body can be edited only by its author and by repository writers, so a selected issue cannot be rewritten by an outsider afterwards. If an outsider reports something worth solving, re-file it yourself.
- **Fenced as data.** The title and body sit inside a block whose opening and closing tags carry a fresh random 128-bit value per prompt, so the body cannot close the block early (the old `--- END ISSUE BODY ---` marker could be forged). The prompt and the agent's system prompt both state that issue text, comments and other GitHub content are data, never instructions, and restate the hard limits: push only the work branch, never touch `dev`/`master` or `.github/workflows`, never send credentials anywhere.
- **Least-privilege credential.** The fine-grained token above cannot reach other repositories or change workflows.
- **Limited egress.** The environment uses `networking: limited` — `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `proxy.golang.org`, `sum.golang.org`, plus the public package registries (`allow_package_managers`) and no MCP servers — so an injected instruction cannot post data to an arbitrary host. An environment or agent left by an older runner (unrestricted egress, old system prompt) is updated in place on the next run.

These controls narrow the risk; they do not replace server-side branch protection. Apply the rulesets (`scripts/apply-rulesets.sh`) so that `dev` and `master` reject force-pushes and deletions regardless of what a session attempts.

## How it works

1. **Issue selection** — explicit numbers or `--label` (at most 100 per run; pull requests are ignored), fetched via `gh api` from the current repository (override with `--repo owner/name`), then filtered to trusted authors (see "Security model").
2. **Agent + environment** — a reusable agent (`squad-admin-panel issue solver`, full `agent_toolset_20260401` toolset) and a cloud environment with limited egress are found by name or created on first run; a reused one whose system prompt or network policy is outdated is updated. `--model` applies per session through an `agent_with_overrides` reference, so runs with different models share one agent resource.
3. **One session per issue** — each session mounts the repo with `checkout: dev`, receives a task prompt encoding the `CLAUDE.md` rules (work branch off `dev`, mandatory tests, local gate, conventional commit referencing the issue, `verify-done.sh --feature`, a visible handoff evidence comment, no merges/PRs), and streams events until `session.status_idle`. A `session.error` whose `retry_status` is `retrying` (model overloaded, rate limited) is transient — the server retries on its own, so the stream keeps being read; an `exhausted` or `terminal` error ends the session as `failed`.
4. **Concurrency pool** — at most `--concurrency` sessions run at once; each has a `--timeout-min` wall-clock budget (default 45 min), after which the stream is aborted and the session reported as timed out (it keeps its state server-side and can be inspected or resumed in the [Console](https://platform.claude.com)).
5. **Report** — per-issue status (`solved` / `failed` / `timed-out`; only an idle status with `stop_reason: end_turn` is `solved`, while `retries_exhausted` and `requires_action` are `failed`), session ID, expected branch name, and the agent's final message. Exit code is non-zero if any session did not finish cleanly.

## After a run

The runner never merges anything. Integrate the pushed branches the same way as any parallel wave:

1. Review each `feature/issue-<n>-*` branch (diff against `origin/dev`, check the tests the agent added).
2. Open the handoff evidence URL from each agent's final report and confirm that the published issue comment covers requirements, exact tests and gates, runtime verification, provenance, and all limitations. The comment is explicitly not a final completion claim.
3. Merge the branches into `dev` one at a time per the `CLAUDE.md` workflow, re-running the local gate between merges.
4. Push `dev`, promote it straight away (`git push origin origin/dev:master`) — once for the whole wave, since `ci` cancels superseded `master` runs — and run `bash scripts/verify-done.sh --wait`, which waits for the `deploy` run and the `ci` run on `master` to go green.
5. For each integrated issue, post and verify the final `Completion evidence — 100% verified` issue comment required by `CLAUDE.md`. It must identify the current `dev` SHA, its deploy run and the `master` CI run; only then may the issue be reported complete or closed.

A `timed-out` or `failed` result means no trustworthy branch was pushed for that issue — check the session in the Console before assuming anything landed. When the runner gives up on a session that may still be running (timeout, `session.error`, or a stream that ends without going idle) it sends `user.interrupt` and archives the session, so it stops spending compute and cannot push or comment later; the report's `stopped:` line says whether each step succeeded. If either step failed, stop the session in the Console yourself.

## Tests

The runner's orchestration logic (CLI parsing, branch naming, prompt building and fencing, author trust, credential and network policy, concurrency pool) is covered by `scripts/solve-issues-parallel.test.ts`, run in CI's `lint` job and locally with:

The runner's orchestration logic (CLI parsing, branch naming, prompt building, concurrency pool, and the remote stop of abandoned sessions against a fake client) is covered by `scripts/solve-issues-parallel.test.ts`, run in CI's `lint` job and locally with:

```bash
pnpm solve:issues:test
```
