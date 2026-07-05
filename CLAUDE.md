# Project rules — squad-admin-panel

## Commit & CI gate (MANDATORY)

1. **Before every commit, the relevant tests must pass.** Never commit red. Run the affected package's tests plus `typecheck` and `biome check` and confirm green first.
2. **After every commit/push, check the CI result and fix if needed.** CI is the source of truth (local checks can pass while CI is red). Fetch it from GitHub and, if the `ci` workflow fails, diagnose the failing step, fix it, re-push, and re-check — iterate until green:
   ```bash
   gh run list --branch <branch> --workflow ci --limit 1 --json databaseId,conclusion
   gh run view <run-id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'
   gh run view <run-id> --log-failed   # logs of the failing step
   ```

### CI shape (`.github/workflows/ci.yml`)
The `node` job runs, in order: `pnpm turbo run typecheck` → `pnpm turbo run build` → `pnpm --filter @squad/db migrate` → panel-bridge tests → **`pnpm exec biome check .`** (whole repo) → `pnpm test:cov`. The step that most often breaks after a merge is `biome check .` — an `error`-severity diagnostic such as `assist/source/organizeImports` (commonly from union-merged imports) fails it; fix with `pnpm exec biome check --write <file>`. `noNonNullAssertion` is `warn` and does not fail CI.

## Git flow
Two-tier, direct-merge (no PRs): branch `feature/<name>` off `dev`, commit + push each chunk, merge into `dev`, promote `dev` → `master` (this repo's production branch; `origin/HEAD` → `master`) only when done. Never commit to or branch from `master`.
