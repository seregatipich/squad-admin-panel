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
5. **The push to `dev` triggers the `ci` workflow on GitHub. All checks must pass.** Watch the run and fix forward until green (see CI gate). Work is not done while `dev` CI is red.
6. Delete the merged work branch.

## CI gate

Local green is not proof — **CI is the source of truth**. After every push to `dev` (and to `master`), fetch the run result and iterate until every check passes:

```bash
gh run list --branch <branch> --workflow ci --limit 1 --json databaseId,conclusion
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
gh run view <run-id> --log-failed   # logs of the failing step
```

The `node` job runs, in order: `pnpm turbo run typecheck` → `pnpm turbo run build` → `pnpm --filter @squad/db migrate` → panel-bridge tests → `pnpm exec biome check .` (whole repo) → `pnpm test:cov` → gitleaks. The step that most often breaks after a merge is `biome check .` — an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it; fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail CI. The `go` job covers `apps/bridge`; the `docker` job builds all images.

## Testing policy (MANDATORY)

- **Every change must be covered by tests.** Code without tests is not done and must not be merged into `dev`.
- **Bug fixes must include a regression test** that reproduces the bug — failing before the fix, passing after it.
- **New modules and features must include integration tests** that exercise the module wired into the system end-to-end (API route → service → database, worker → queue, etc.), not only unit tests.
- Never skip, disable, `.skip`, or weaken existing tests to get CI green. Fix the code or fix the test's legitimate expectation.

## Promotion `dev` → `master`

- Promote only by merging `dev` into `master`; never cherry-pick or commit onto `master` directly.
- Promote only when the work on `dev` is complete: implemented, tested, documented, committed, pushed, and **`dev` CI is green**.
- A non-docs push to `master` triggers the `deploy-tk104` workflow and **deploys to production**. Promote deliberately and watch both the `ci` and deploy runs to completion.

## Repository hygiene

- Never commit secrets; keep sensitive configuration in environment variables and document required vars in `.env.example`.
- Do not add `.md` files to the repository root. The only permitted root docs are `README.md` and the agent rule files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). Planning notes, roadmaps, handoffs, and other artifacts go in `ai_docs/` or `docs/`.
- Update README/runbooks/migration notes when behavior, setup, or operations change.
