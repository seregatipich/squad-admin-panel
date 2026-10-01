# Plan for accepting the GitHub Actions updates

**Goal:** accept PRs #262, #264, #265, #274 and #275 as one compatible wave,
without breaking the `work branch -> dev -> master` route.

## Constraints

- The working base is a fresh `origin/dev`; `dev` and `master` are not changed directly.
- The original Dependabot commit SHAs are kept in history so that GitHub can
  recognize the PRs as absorbed after promotion.
- All `uses:` references stay pinned to full SHAs.
- The Node 24 versions require a self-hosted runner no older than 2.327.1; compatibility
  is finally confirmed by CI on `dev`.
- `master` is advanced only by fast-forward from a verified `dev`.

## Changes

1. Confirm that the heads of PRs #262, #264 and #265 are already in `origin/dev`:
   - `actions/checkout` 7.0.1;
   - `actions/setup-node` 7.0.0;
   - `docker/setup-buildx-action` 4.2.0;
2. Merge the remaining PRs #274 and #275 into the working branch:
   - `actions/upload-artifact` 7.0.1;
   - `pnpm/action-setup` 6.0.10.
3. Check the combined diff: only pinned versions in
   `.github/workflows/ci.yml`, with no weakening of conditions or permissions.
4. Run the workflow guard tests, `pnpm turbo run typecheck`,
   `pnpm exec biome check .`, the applicable tests and
   `bash scripts/verify-done.sh --feature`.
   The full run must also confirm there is no redundant repeated
   statistics request when the initial server-selection delay completes.
5. After independent acceptance, merge the branch into `dev`, push `origin/dev` and
   wait for green CI on the current SHA.
6. Run `bash scripts/verify-done.sh`; only then fast-forward
   `origin/dev:master` and check CI/deployment.

## Stop condition

If the runner version or a green CI on the current `dev` cannot be verified,
the updates stay in `dev`, and promotion to production `master` is blocked.
