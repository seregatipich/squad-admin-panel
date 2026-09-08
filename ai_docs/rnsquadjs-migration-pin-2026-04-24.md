# RNSquadJS upstream pin — 2026-04-24

> **Superseded (2026-09-08).** Движок сайдкара мигрирует на SquadJS2 —
> см. [`squadjs2-pin-2026-08-24.md`](squadjs2-pin-2026-08-24.md) и ADR
> «SquadJS2 replaces RNSquadJS as the sidecar engine». Этот документ остаётся
> историческим свидетельством прежнего пина и действует, пока RNSquadJS
> сохраняется как путь отката.

**Pinned SHA:** `d76fb4a84bc64ae09b654d4dc17ab06ef308d295`
**Upstream commit date:** 2026-04-06T19:56:27Z
**Pinned in:** `docker/rnsquadjs.Dockerfile` (`ARG RNSQUADJS_SHA`)

## §7 Compatibility checklist (from design spec)

| Check | Result | Evidence |
|---|---|---|
| `squad-logs` regex change | Not audited against previous pin (first pin — no previous to diff) | Parity fixture captured in `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log` (5000 lines, 4964 parsed by our own parser). Phase-1 shadow-stream soak will be the live parity gate before cutover. |
| EventEmitter event rename / payload shape | No mismatch detected | `panelBridge/src/eventMap.ts` covers 17 event types; panelBridge vitest suite 23/23 green after upstream install in Dockerfile. |
| `squad-rcon` two-packet AUTH workaround | Not audited | Inherited from upstream. Phase-1 canary soak will catch AUTH failures. Hold the next SHA bump if AUTH regresses in shadow logs. |
| `rnsdb.ts` new mongo-coupled plugins | Mitigated by config renderer | `apps/api/src/routes/internal/rnsquadjs-config.ts` marks `autoUpdateMods`, `chatCommands`, `voteMap`, `warnings`, `broadcasts`, `autoKick`, `squadLeader` as `enabled: false` — no mongo plugin ever starts. |
| Node version >18.18 required | No | Upstream `package.json` at `d76fb4a` targets `<=18.18`. Dockerfile base is `node:18.18-bookworm-slim`. |

## Addendum — 2026-07-29 (issue #251)

`docker/rnsquadjs.Dockerfile:11` and `:34` were bumped from `node:18.18-bookworm-slim` to `node:22-bookworm-slim` on both the `upstream` and `runtime` stages, closing the gap the §7 checklist row above recorded at pin time. That row is left unmodified as the historical record of the original migration decision (Node 18.18 matched upstream's own `<=18.18` engine constraint at SHA `d76fb4a` on 2026-04-24); it no longer describes the current Dockerfile.

## Full-stack green (prerequisites for Phase-3 handoff)

- `pnpm turbo run typecheck` → 20 packages (web not built; not in migration scope), all green.
- `cd apps/bridge && go test -race -count=1 ./...` → 5 packages with tests, all green (fsx/metrics/rpc/runner/validate).
- `cd docker/rnsquadjs/plugins/panelBridge && npx vitest run` → 23/23 tests across 3 files green.
- `pnpm --filter @squad/api test` → 137 passed + 2 skipped (139 total), 0 regressions against live Postgres + Redis.
- `docker build -f docker/rnsquadjs.Dockerfile ...` → image `squad-panel/rnsquadjs:latest` (99 MB), `/UPSTREAM_SHA` inside equals pinned SHA, plugin dist at `/app/lib/plugins/panelBridge/{index,eventMap,redisPublisher,rconUnixServer,heartbeat}.js`.

## Deployment gates for Phase-3 cutover (operator)

These are sudo/deploy steps not runnable from this session:

1. **Redeploy bridge binary** (T14 added `container_run_rnsquadjs`; running binary is pre-T14):
   ```bash
   cd apps/bridge && make build
   sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/
   sudo systemctl daemon-reload
   sudo systemctl restart panel-host-bridge
   sg panel -c 'bash scripts/verify-bridge.sh'
   ```
2. **Rebuild + restart panel API** (T12/T16/T17 need new api image):
   ```bash
   docker compose build api
   docker compose up -d api
   ```
3. **Run live e2e** to confirm sidecar lifecycle end-to-end:
   ```bash
   export PANEL_TEST_URL=https://squad-panel.lan
   export PANEL_TEST_COOKIE=<__Host-sid from browser>
   pnpm --filter @squad/api test:e2e
   ```
   Both `install-lifecycle.e2e.test.ts` and `bridge-rpc.e2e.test.ts` must pass. The former asserts sidecar runs, publishes events, hearts, and exits with Squad; the latter exercises the new `container_run_rnsquadjs` RPC success + forbidden paths.

Once all three gates are green, the Phase-3 canary cutover runbook can begin (see `docs/superpowers/specs/2026-04-24-rnsquadjs-migration-design.md` §9).
