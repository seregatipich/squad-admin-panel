# Handoff — squad-admin-panel (dev branch)

_Last updated: 2026-07-06. Covers session `37f562f6` (parallel waves A–D) + the concurrent PRs #195/#196/#198 now on `master`._

## 1. Current state (verified)

- **Branches in sync:** `dev` == `master` == `origin/dev` == `origin/master` == `ec60143`. Working tree clean.
- **CI GREEN on `master`** (`ec60143`, and prior `96ecbfb`): `node` ✓ `go` ✓ `docker` ✓.
- **~79 issues done** (`status:done`, closed). Open backlog was heavily re-triaged concurrently — currently ~25 `status:in-progress`, ~89 `status:triage`, 1 `status:review` (labels are being reworked; treat the roadmap `ai_docs/plans/2026-07-04-task-decomposition.md` as the dependency source of truth, not the raw labels).
- **DB migrations at `0033_role_assignment_expiry.sql`.** This session added `0029`–`0032`; PR #198 added `0033`. All are `--> statement-breakpoint`-delimited, journal-tracked (`meta/_journal.json`), validated on fresh DBs and applied to the live `admin` DB.
- **Active side branch:** `feature/tk104-full-stack` has 2 unpushed local commits (tk104 production-stack work) — leave it; the panel is deployed at https://tk104.duckdns.org (see the `tk104-deployment` memory).

## 2. What shipped since the last handoff

### This session — 20 issues across 4 parallel worktree-agent waves (all CI-green, browser-verified, closed)
- **Wave A** (mig `0029`): COMBAT-2 (combat_events partitioned), VOTE-3 (vote analytics), PNOTE-2 (`/notes` feed), EVT-2 (events UI), PRES-3 (presence chart), PLAYER-2 (nickname history/normalization).
- **Wave B** (mig `0030`): PLAYER-3 (IP+GeoIP history, `player:view_ips`→`panel_access` gate), COMBAT-3 (combat-events keyset API + `roles.combat_view`), CLAN-7 (clan live members), LEAD-1 (`player_stat_periods` + leaderboard-aggregator worker), MATCH-3 (per-match combat cols on `match_players`).
- **Wave C** (mig `0031`): LEAD-2 (leaderboards API), PRES-5 (primetime), COMBAT-4 (combat-log UI), AUTO-3 (`alert_rules`/`alert_events` engine + `/settings/alerts`), CLAN-8 (clan match history).
- **Wave D** (mig `0032`): INT-2 (geo-anomalies + inline-SVG map), CLAN-3 (clan roster mgmt), DOSSIER-1 (vehicle combat events + `vehicle_catalog`; made `combat_events.victim_player_id` nullable + `combat-events.ts` leftJoin), LEAD-3 (full `/leaderboards` UX).

### Concurrent PRs merged to `master` (not from this session)
- **#195** — fix CI quality gates.
- **#196** — activate Admins.cfg permissions.
- **#198** — expire temporary player roles (adds `0033_role_assignment_expiry.sql`).

## 3. The proven parallel-wave pipeline (repeat this)

Full recipe + gotchas: `parallel-ultracode-workflow` memory. Per wave:
1. Pick 4–6 ready tasks (deps closed) in DIFFERENT domains to minimize shared-file overlap. Author a `Workflow` with `isolation:'worktree'` agents, a shared COMMON brief + per-task brief + a structured `RESULT_SCHEMA`; each agent owns a `test_<slug>` DB, TDD-tests, discards `packages/db/drizzle` before commit, reports `customMigrationSql`.
2. Integrate serially into `dev` (`git merge --no-ff`); git 3-way usually auto-merges additive `server.ts`/`harness.ts`/`SidebarNav.tsx` blocks — union-resolve the rest (`scratchpad/resolve_union.py`) and `biome check --write` after (import sort).
3. Assemble ONE `00NN` migration from agents' `customMigrationSql` + a journal entry (idx+1, `when`=prev+1000, `--> statement-breakpoint` between statements). Validate on a fresh DB, apply to live `admin`.
4. Rebuild workspace dist, gate: `turbo run typecheck` + `next build` (web) + `pnpm exec biome check .` (0 errors).
5. `docker compose build api web && up -d`; Playwright-verify each new page as Owner against https://localhost (`apps/web/e2e/wave*.spec.ts`; `ownerPage` fixture).
6. Promote `dev`→`master` (`git merge --ff-only`, push `--no-verify`), **watch CI to green**, then close issues (`gh issue edit --add-label status:done` + `gh issue close`). Clean up worktrees/branches/test DBs.

## 4. CI traps — budget 3+ round-trips/wave (all fixed + in memory)

- **`biome check .`** (whole-repo, CI) fails on a **formatter `::error`** for any new file that missed `biome check --write` — the dir-scoped `--diagnostic-level=error` check misses it. Find it: `pnpm exec biome check . --reporter=github | grep '::error'`.
- **Parallel `test:cov` shared-DB races** (the expensive class): `pnpm test:cov` runs every package's vitest in PARALLEL against the ONE CI DB. (a) NO destructive DDL on shared tables — scope it into its own schema; (b) every worker/api package with DB tests needs `fileParallelism:false` + `sequence:{concurrent:false}`; (c) uuidv7 `id.slice(0,12)` is the ms-timestamp → non-unique names; (d) widen too-tight async waits vs `testTimeout`. These reproduce only with the WHOLE package suite on a fresh migrated DB, not single-file runs.
- **worker-rcon SIGTERM contract**: shutdown watchdog + wait-for-heartbeat-readiness before SIGTERM.
- The `25P01 "no transaction in progress"` migrator warning is pre-existing/harmless.

## 5. Next up (ready-now candidates, verify deps against the roadmap)

- **PLAYER-4** (#25, foundational — unblocks ~29 tasks): complete the player-card identity page. Best done SOLO (many prior waves already appended sections; avoid parallel player-card contention).
- **LEAD-4** (bonus/boost leaderboard metric — deps LEAD-2 ✓ + economy), **DOSSIER-2** (dossier aggregates — deps COMBAT-2/DOSSIER-1 ✓), **COMBAT-5** (teamkill tracking — deps COMBAT-2 ✓, MOD-2), **MATCH-6** (match card — needs PLAYER-4).
- **ENV-GATED cluster** (needs the operator's live server / Go bridge / RCON — cannot be fully verified on macOS, tracked by issue #194): MOD-2 → MARK-3/ALT-1/BANNAME-2/AUTO-*/GAME-*/CLAN-4, and the SYNC/SRV/CFG/WL chain. Implement + unit/integration-test with synthetic fixtures; do NOT close live-flow criteria without operator infra.

## 6. Pointers

- Dependency graph + all task specs: `ai_docs/plans/2026-07-04-task-decomposition.md`.
- Prior detailed handoff: `ai_docs/handoff/2026-07-05-parallel-implementation-handoff.md`.
- Pipeline recipe + every CI trap: `parallel-ultracode-workflow` memory. Local stack + Playwright verification: `squad-admin-panel-local-stack` memory. Commit/CI discipline: `commit-and-ci-gate` memory + project `CLAUDE.md`. Production deploy: `tk104-deployment` memory.
