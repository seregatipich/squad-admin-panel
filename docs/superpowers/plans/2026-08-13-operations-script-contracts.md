# Implementation plan: operations script and audit chain checks

> Tracking: #283. Base: the current `origin/dev`. Follow TDD in small
> commits; do not merge the old accumulating branch.

## Task 1. Red contracts for production deploy

**Files:**

- create `scripts/operations-scripts.test.ts`;
- change `scripts/deploy-stand.sh` only after a red result.

1. Create an isolated deploy fixture with a path containing spaces and
   logging stand-ins for `docker`, `sleep` and `curl`.
2. Prove with a red test that the current script declares success after 40
   `api starting` responses.
3. Prove with a red test that the current script suppresses a non-zero `curl` exit code.
4. Add an explicit check of the final API status and remove the suppression of the HTTP error;
   enable `curl --fail`.
5. Get green tests: env missing, normal order, API timeout,
   build failure, HTTP failure.
6. Check `bash -n` and Biome, commit.

## Task 2. Remaining operational boundaries

**Files:**

- change `scripts/operations-scripts.test.ts`.

1. Add a syntax and strict-mode check for all target Bash scripts.
2. Add safe fixtures for the `bootstrap` and `install-host-bridge`
   preflight; prove there are no mutations before admission.
3. Add exact confirmations and stop-on-failure for `rebuild` and `uninstall`.
4. Add a real temporary Unix server for the eight framed calls of
   `verify-bridge` and a negative case with a truncated response.
5. Run the whole file and Biome, commit.

## Task 3. The real audit chain

**Files:**

- create `scripts/verify-audit-chain.test.ts`.

1. Create one migrated temporary template DB and a separate DB for each
   scenario; use the original `DATABASE_URL` only as an administrative
   connection point.
2. Check an empty and a two-row intact chain, and the presence of the three live
   `audit_log` triggers.
3. Corrupt `row_hash` and `prev_hash` separately, check the exact `id` and reason.
4. Check exit 2 when `DATABASE_URL` is missing and when the DB is unreachable.
5. Drop all temporary DBs in teardown, run the file and Biome, commit.

## Task 4. Wiring into the mandatory gate and documentation

**Files:**

- change `package.json`;
- change `.github/workflows/ci.yml` if needed, only in the name or in the
  static ordering guarantee;
- change `docs/development/testing.md`;
- change `docs/operations/deployment.md`.

1. First prove that the current `pnpm test:scripts` does not run the new files.
2. Include the three files with `--test-concurrency=1` after the panel-bridge build.
3. Record that CI applies migrations before `test:scripts`, and describe a
   safe local command.
4. Run `pnpm test:scripts` with real temporary PostgreSQL/Redis,
   typecheck and Biome, commit.

## Task 5. Branch acceptance

1. Run the full local pre-push gate with a migrated isolated DB.
2. Run a separate gitleaks scan over `origin/dev..HEAD`.
3. Read the whole diff, map each #283 criterion to a test and check that
   there are no real host mutations.
4. Publish the branch with a plain `git push`, run
   `bash scripts/verify-done.sh --feature`.
5. Record the handoff evidence in #283 and move the task to Review. Merge
   only after runner #281 is restored and CI is green on the exact
   `dev`.
