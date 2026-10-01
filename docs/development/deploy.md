# Dev stand and promotion

Details behind the "Dev stand and promotion" rules in [`CLAUDE.md`](../../CLAUDE.md). Pipeline internals, runner history and deploy troubleshooting are in [agent-harness.md](agent-harness.md); the operator view of the stack is in [../operations/deployment.md](../operations/deployment.md).

- **Every push to `dev` deploys the development stand** — the stand is for development, not production. `deploy.yml` builds the `api`, `web`, `workers` and `caddy` images in parallel on hosted runners, pushes them to GHCR (`ghcr.io/seregatipich/squad-panel-<image>:<sha>`), and hands the four digests to the stand host over SSH. The host pulls only the images whose digest changed, runs a `pg_dump` and the migrator only when `packages/db/drizzle` changed, and recreates only the services whose image or configuration changed; a push that changes neither is a no-op. Pushes that only touch Markdown or `docs/` do not deploy. Nothing is tested on this path — the local pre-check is the only gate before the stand.
- **Redeploy or roll back** by dispatching the workflow with the commit you want: `gh workflow run deploy.yml --ref dev -f sha=<40-hex sha>` — images of every deployed SHA stay in GHCR. On the host, `bash scripts/rollback-stand.sh` switches back to the previous release. Neither undoes migrations, so **every migration must stay compatible with the release before it** — add columns and tables first, drop what the previous release still reads only in a later release.
- **Promote** only by **fast-forwarding `master` to the dev tip** — never merge commits, cherry-picks, or direct commits onto `master`:
  ```bash
  git fetch origin
  git push origin origin/dev:master
  ```
  The push runs the full `ci` workflow on `master`; `branch-guard` goes red if the SHA is not reachable from `dev`. Nothing deploys from `master` yet — production CD from `master` is a later step.
- Promote **right after pushing `dev`**, not after the deploy finishes: the two run concurrently and `bash scripts/verify-done.sh --wait` waits for both. Nothing deploys from `master` yet, so a tip that turns out red on the stand or in `ci` costs a fix-forward commit, not an incident. A red run is fixed forward on `dev` and promoted again.

See [ci.md](ci.md) for what the `ci` run on `master` checks.
