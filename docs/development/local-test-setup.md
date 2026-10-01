# Local test setup

Read this before running any DB-backed test. The rules in [`CLAUDE.md`](../../CLAUDE.md) point here.

The local stack runs in Docker (`postgres`, `redis`, `api`, `web`). Getting an isolated, migrated test database right is the #1 time-sink for agents; the facts:

- **The Postgres password is NOT `admin`.** It is the `POSTGRES_PASSWORD` token in `.env`. From the host, Postgres is at **`127.0.0.1:5432`** (the `.env` `DATABASE_URL` uses the docker-internal host `postgres`, which does not resolve on the host).
- **Two env vars, one DB.** Workers and `@squad/db migrate` read `DATABASE_URL`; the API integration harness (`reusePublicSchema`) reads **`TEST_DATABASE_URL`**. Point BOTH at your isolated DB or tests silently hit the shared `admin` database (every mutating route then 500s).
- **Just run the helper** — it does all of the above (real password, `127.0.0.1`, create + migrate, exports both vars):
  ```bash
  eval "$(bash scripts/new-test-db.sh <slug>)"   # sets DATABASE_URL and TEST_DATABASE_URL
  pnpm --filter @squad/api exec vitest run test/<your>.test.ts   # run only your files, not test:cov
  ```
- **Adding an API route?** Add the import and `await app.register(...)` call to `registerRoutes()` in `apps/api/src/routes/index.ts` — both `apps/api/src/server.ts` and `apps/api/test/integration/harness.ts` call that single function, so there is no second list to keep in sync. `apps/api/test/route-registration-parity.test.ts` fails the build if a route file under `apps/api/src/routes/` is ever added without being imported and registered there.
- **API tests that mutate `players`/`roles`/`panel_meta`** must scope the mutation by `steamId64` (a unique/test-range value), never a bare `uuid` — the parallel `test:cov` shares one DB and `apps/api/test/test-isolation.regression.test.ts` fails any unguarded `delete(players)` / `update(players).roleId` / …. A single-file `vitest run <your.test.ts>` does NOT run that guard, so before pushing also run `pnpm --filter @squad/api exec vitest run test/test-isolation.regression.test.ts`.
- **The pre-push checklist auto-provisions a test DB when it can.** If `DATABASE_URL` is unset but Docker and `.env` are present, `scripts/pre-push-checklist.sh` runs `scripts/new-test-db.sh` for you; without any DB it skips the DB-backed suites with a warning instead of blocking the push. The checklist is a fast local pre-check, not the gate — **`ci` on `master` is the source of truth.** The Go bridge build cannot run on macOS and Docker image builds are not run locally, so `--no-verify` remains available for genuine emergencies; `ci` still catches anything skipped locally when the tip is promoted.

See also [testing.md](testing.md) for the test tiers and [ci.md](ci.md) for the pre-push checklist.
