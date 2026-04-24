# Clean-install verification — 2026-04-24

Full teardown + fresh install + manual e2e of every panel surface, driven with Playwright + curl against the live stack (`https://squad-panel.lan`).

Evidence: 60 screenshots + 59 DOM dumps in `ai_docs/clean-install-evidence-20260424/`.

## Outcome

Panel works end-to-end — setup wizard, auth, dashboard, servers, install flow, RCON, live logs, events, config editor (save/history/blame/diff/restore), hot-reload, stop, delete. Audit hash-chain stays intact across 23 actions.

**But the out-of-the-box install path is broken in two places.** A fresh `docker compose up -d` per README leaves the panel unusable until two manual fixes are applied.

---

## Bugs blocking a README-only fresh install

### B1 — Only 4 of 8 migrations apply (blocker)

`packages/db/drizzle/_journal.json` has entries for `0000_init` … `0003_config_versions` only. Four files exist on disk but are absent from the journal:

| file | impact if missing |
|---|---|
| `0004_config_versions_cascade.sql` | `DELETE /api/v1/servers/:id` raises `"config_versions is append-only"`. Servers cannot be deleted. |
| `0005_backfill_config_role_perms.sql` | No impact on fresh installs (seed helper already emits these rows per the file's own comment). |
| `0006_rcon_host_bridge_network.sql` | new servers keep `server_credentials.rcon_host='127.0.0.1'` (table default). |
| `0007_rcon_host_null_default.sql` | same — drops NOT NULL + default, lets each caller resolve `RCON_HOST_DEFAULT`. |

Combined effect of 0006+0007 missing: API container hits its own loopback when it tries `AdminReloadServerConfig` or graceful-stop RCON AdminBroadcast → every `PUT /configs/:name` returns 200 but `reload.applied=false, reason=rcon_failed, detail=connect ECONNREFUSED 127.0.0.1:21114`. Worker-rcon is unaffected (runs with `--network host`).

**Fix**: regenerate the journal via `pnpm --filter @squad/db exec drizzle-kit generate` against the current schema or, if those `.sql` files are hand-authored, append them to `_journal.json` with matching tags/timestamps so `tsx src/migrate.ts` picks them up. After applying the missing four, hot-reload returned `reload.applied:true, via:rcon, command:AdminReloadServerConfig, response:"Reloading server config..."`.

### B2 — Migrations are never triggered automatically (blocker)

Neither `docker-compose.yml` nor the API entrypoint runs `pnpm db:migrate` on startup. On a fresh install, postgres comes up empty, then `worker-rcon` and `worker-log-ingest` enter a crash-loop (`Failed query: select ... from "servers" ...`) until migrations are run manually from the host:

```bash
DATABASE_URL=postgres://admin:${PG_PW}@127.0.0.1:5432/admin pnpm db:migrate
```

The README's "run `docker compose up -d` → wait ~2 min → done" instruction is not sufficient.

**Fix**: either (a) add a one-shot `migrator` service to compose (`depends_on: postgres (healthy)`, `command: pnpm --filter @squad/db migrate`) that api/worker-* `depends_on: service_completed_successfully`, or (b) run migrations in the api entrypoint before `node dist/index.js`.

### B3 — `scripts/install-host-bridge.sh` does not create `/var/lib/squad-panel`

Unit file pins `ReadWritePaths=/var/lib/squad-panel /var/log/panel-host-bridge /etc/ufw /run/docker.sock`. systemd refuses to start the service if any path on that list is missing (`status=226/NAMESPACE: Failed to set up mount namespacing: /var/lib/squad-panel: No such file or directory`). `scripts/uninstall.sh` removes the directory on teardown, and the installer's existing `mkdir -p /etc/ufw` block never recreates it.

**Patched in this session** — added three lines to `install-host-bridge.sh`:

```bash
mkdir -p /var/lib/squad-panel/configs /var/lib/squad-panel/saved
chmod 0755 /var/lib/squad-panel
chmod 0750 /var/lib/squad-panel/configs /var/lib/squad-panel/saved
```

After the fix, `systemctl start panel-host-bridge.service` comes up clean, `bash scripts/verify-bridge.sh` reaches every method, and the allowlist rejects `/etc/shadow` and `/opt/squad-servers/*` as expected.

### B4 — Logout button in nav bar returns HTTP 415

Top-nav «Выйти» renders as:

```html
<form action="/api/v1/auth/logout" method="post">
  <button type="submit" ...>Выйти</button>
</form>
```

A plain HTML form submits `Content-Type: application/x-www-form-urlencoded`, but the Fastify route is JSON-only. The browser gets `{"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE"}` and lands on `/api/v1/auth/logout` with an error body. Audit log shows every real logout attempt as `status_code=415`. Empty-body JSON is also rejected (`400 FST_ERR_CTP_EMPTY_JSON_BODY`), so simply switching the form to `Content-Type: application/json` isn't enough — the endpoint also needs to accept a body-less POST (or the client needs to send `{}`).

**Fix**: replace the nav form with a client-side handler that `fetch('/api/v1/auth/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })` and then navigates to `/login`, or loosen the Fastify content-type parser for that route.

### B5 — `scripts/verify-bridge.sh` is stale

Tests four methods that were removed from the bridge: `systemctl_action`, `apt_install` (×2), `steamcmd_run`. Each currently returns `{"code":"invalid_args","message":"unknown method"}`. The intent (per `verify-N` comments) was a `forbidden` response. Functionally harmless — the methods genuinely don't exist — but the smoke test is misleading; either drop those cases or replace them with bridge surface that actually exists (container_stop on a non-allowlisted image, `file_write` on `/opt/squad-servers/*`, etc.).

### B6 — Rate-limiter starves the config editor UI

`/configs/:name` is aggressively rate-limited. The Monaco editor page loads the file list, then issues a burst of `GET /configs/:name` requests (one per click, plus dashboard/reconciler polling in the background), and the bucket runs out almost immediately — the page renders "HTTP 429" and Monaco stays empty (`value_len=0` even after 90s of waiting). Tabs Редактор/История/Blame render correctly once a file is picked, so they're not the problem; the config-content GET itself is throttled too hard for a single-user panel.

**Fix**: raise the per-minute allowance on `/api/v1/servers/:id/configs/:name` (or exempt authenticated owner sessions), or coalesce duplicate in-flight requests client-side.

### B7 — No `server.install.completed` audit row

The install flow audits `server.install.started` and then falls silent. `server.status` flips from `installing` → `running`, but there is no `server.install.completed` / `server.install.failed` entry. For a hash-chained audit log this is an observability gap — a third-party reading the audit trail can't tell whether the install succeeded without joining against `servers.status`.

---

## Surfaces verified end-to-end

### Infrastructure

| Check | Result |
|---|---|
| `panel-host-bridge.service` after clean install (+B3 fix) | `active (running)`, socket `0660 root:panel` on `/run/panel-host-bridge.sock` |
| `scripts/verify-bridge.sh` — `ping / host_info / host_metrics` | all 200 |
| `scripts/verify-bridge.sh` — forbidden paths | `/etc/shadow` forbidden, `/opt/squad-servers/*` forbidden |
| `docker compose up -d` (after B2 mitigated) | 10/10 containers healthy: caddy, web, api, postgres, redis, worker-rcon/log-ingest/event-partition/audit-archiver |
| Worker heartbeats in Redis | `worker:heartbeat:{log-ingest,event-partition,audit-archiver,rcon}` all present |
| Audit chain integrity (`pnpm verify:audit-chain`) | `ok: audit chain intact (23 rows)` at end of run |

### Web app routes

| Route | Evidence file | Note |
|---|---|---|
| `/setup` step 1 (env check) | `01_step1_env_check.png` | button enables; clicking moves to step 2 |
| `/setup` step 2 (org) | `03_step2_org_filled.png`, `04_after_org_submit.png` | `organizations.name="Breaking Squad"` row committed |
| `/setup` step 3 (owner) | `05_step3_owner_filled.png`, `06_after_owner_submit.png` | `users.email="owner@squad-panel.lan"` + display_name committed. No 2FA step in wizard (setup skips it; 2FA enrolment lives in `/settings/account`) |
| `/login` | `10_login_page.png`, `11_login_filled.png`, `12_after_login.png` | `__Host-sid` cookie set (secure, httpOnly), redirect to `/dashboard` |
| `/dashboard` | `13_dashboard.png` | СЕРВЕРЫ / ИГРОКОВ / BRIDGE connected (`v 7b8caee-dirty`) / ALERTS tiles render |
| `/servers` | `19_servers_list.png`, `33_servers_list.png`, `40_servers_list_running.png` | empty → 1 row (installing) → 1 row (running) |
| `/servers/new` | `20_servers_new.png`, `22_servers_new_filled.png` | all 7 fields present; required validation works |
| `/servers/:id` (running) | `41_server_detail_running.png` | RUNNING badge, RCON connected, all 5 port rows, Start/Stop/Restart/Delete buttons, live Docker log stream (`LogStreaming` lines from Squad visible) |
| `/servers/:id/events` | `42_server_events.png` | 2 events (rcon.connected, rcon.players_polled) with full envelope payload |
| `/servers/:id/configs` | `43_configs_initial.png`, `56_monaco_final.png` | 19 .cfg files listed with correct reload-behavior badges (live-reload / рестарт / next match). Tabs Редактор/История/Blame visible after picking a file. Monaco content blocked by B6. |
| `/players` | `31_players.png` | empty state "Ни один игрок ещё не подключался" |
| `/audit` | `30_audit.png` | 12+ rows, sortable, includes the failing 415 logout entries |
| `/settings/account` | `32_settings_account.png` | Profile (email, display name, clearance=1000, 27 permission keys), 2FA section with Подключить 2FA button |

### API + config editor backend (direct)

Full CRUD surface exercised via curl with the session cookie — every endpoint returned 200 with the expected shape:

- `POST /api/v1/servers` → 201, row created
- `POST /api/v1/servers/:id/install` → 200, depot-init container spawned, SteamCMD streamed 0 → 12.8 GB, 19 `.cfg` seeded into `/var/lib/squad-panel/configs/:id/ServerConfig/`, ufw rules added, `container_run` produced a live Squad container with `--network host`
- `GET /api/v1/servers/:id/configs` → 19 items with sha256 + behavior flag
- `GET /api/v1/servers/:id/configs/Admins.cfg` → real SteamCMD default (`Group=Admin:kick,ban,changemap` …)
- `PUT /api/v1/servers/:id/configs/Admins.cfg` → 200, new `version_id`, sha256 flipped, `reload.applied:true, via:rcon, command:AdminReloadServerConfig, response:"Reloading server config..."` (after applying 0006/0007 migrations)
- `GET …/configs/Admins.cfg/history` → 3 versions at end of run (baseline + edit + restore)
- `GET …/configs/Admins.cfg/blame` → 51 lines, correct per-line `version_id` attribution (appended line tagged to the edit, rest to baseline)
- `GET …/configs/Admins.cfg/diff?from=…&to=…` → unified-diff `patch` field with the single `+` line
- `POST …/configs/Admins.cfg/restore/:vid` → 200, created new version with baseline's sha256 (non-destructive as designed)
- `POST /api/v1/servers/:id/stop` → 200 `{"status":"stopping"}` → status-reconciler flipped DB to `stopped` within 5s; container was gracefully terminated
- `DELETE /api/v1/servers/:id` → 200 `{"ok":true}`; `servers` / `server_credentials` / `config_versions` all cascaded to zero rows; container fully removed; no orphans on disk. **Only works after migration 0004 is applied (B1).**

### Items not covered

- **User management / invites** — not surfaced in P0 (no `/settings/users` or `/settings/members` route, no invite API). `users` / `roles` / `role_permissions` schema is in place (Clearance 1000, 27 perm keys visible in `/settings/account`) but owner is the sole user until Phase 1.
- **2FA enrolment flow** — button `Подключить 2FA` rendered on `/settings/account` but not exercised; skipping it avoided complicating the headless session for the later Playwright runs.
- **Alternative logout button «Выйти из панели»** on `/settings/account` — same endpoint as the nav form, so expected to hit the same 415 (B4).
- **Restart action** — not exercised; the stop+delete path was sufficient to prove the lifecycle.

---

## Patches applied during this session

- `scripts/install-host-bridge.sh` — added `mkdir -p /var/lib/squad-panel/{configs,saved}` + chmod (fix B3).
- Applied `0004_config_versions_cascade.sql`, `0005_backfill_config_role_perms.sql`, `0006_rcon_host_bridge_network.sql`, `0007_rcon_host_null_default.sql` by hand via `psql` (mitigates B1 for this install only; the journal still needs to be updated so future installs pick these up).

## Recommended follow-ups

1. Fix `_journal.json` so the remaining four migrations run on fresh install (B1).
2. Add an automatic migration step to the startup path so `docker compose up -d` on an empty DB doesn't leave two workers crashlooping (B2).
3. Replace the nav logout form with a JSON fetch (B4).
4. Refresh `scripts/verify-bridge.sh` to match the current bridge method set (B5).
5. Relax or coalesce the per-config rate limit so Monaco can actually read file content through the UI (B6).
6. Emit `server.install.completed` / `server.install.failed` audit rows to close the observability gap (B7).

---

## Follow-up round — all 6 recommendations applied (same day)

After the audit above, every bug was fixed in-repo and the whole stack re-validated from an empty DB via one command: `docker compose up -d --build`.

### What changed

| # | Change | Touches |
|---|---|---|
| B1 | Added `0004`–`0007` entries to `packages/db/drizzle/meta/_journal.json` so drizzle-migrate picks them up on a fresh DB. | `meta/_journal.json` |
| B2 | New `migrator` compose service (reuses api image, runs `node packages/db/dist/migrate.js`, exits). `api` and all DB-touching workers now `depends_on: migrator: service_completed_successfully`. | `docker-compose.yml` |
| B3 | `install-host-bridge.sh` now `mkdir -p /var/lib/squad-panel/{configs,saved}` + chmod. | `scripts/install-host-bridge.sh` |
| B4 | New client component `apps/web/src/components/LogoutButton.tsx` replaces the `<form action="/api/v1/auth/logout" method="post">` in the dashboard nav; sends `POST /api/v1/auth/logout` with `Content-Type: application/json` and `body: '{}'`. `settings/account` `logout()` updated to send the same shape. | `apps/web/src/components/LogoutButton.tsx` (new), `apps/web/src/app/(dashboard)/layout.tsx`, `apps/web/src/app/(dashboard)/settings/account/page.tsx` |
| B5 | `verify-bridge.sh` now exercises `ping / host_info / host_metrics / process_info` on the success side and `file_read /etc/shadow`, `file_atomic_write /opt/squad-servers/*`, `container_inspect` (missing container), `container_run alpine:latest` on the forbidden side. Stale `systemctl_action / apt_install / steamcmd_run` cases removed. | `scripts/verify-bridge.sh` |
| B6 | Global rate limit raised from `300/min` to `1200/min` per `ip:user_id` so the SPA + status-reconciler + Monaco content load don't fight over the same bucket. Login-endpoint 5/15-min limit kept. | `apps/api/src/server.ts` |
| B7 | `server-install.ts` now emits `server.install.completed` (200) on the happy path and `server.install.failed` (500, with error context) on catch — both carry `durationMs` in context. | `apps/api/src/routes/server-install.ts` |

### One-command validation

Teardown: `docker compose down -v --remove-orphans` + `rm -rf /var/lib/squad-panel/{configs,saved}/<server_id>`. Depot volume `squad-depot` kept (12.8 GB).

One command: **`docker compose up -d --build`** — completed in **102 s** (includes api/web/worker rebuilds). Sequence from `docker compose logs`:

1. `postgres` + `redis` come up healthy.
2. `migrator` starts, runs all 8 migrations against empty DB, exits 0 (`migrations applied`).
3. `api`, `worker-log-ingest`, `worker-rcon`, `worker-audit-archiver`, `worker-event-partition` start (all `depends_on: migrator: service_completed_successfully`) — **no crash-loops**, heartbeats in Redis within 30 s.
4. `web` and `caddy` come up, healthchecks green.

Post-up state:

- `SELECT count(*) FROM drizzle.__drizzle_migrations` → **8** (was 4).
- `information_schema.columns` for `server_credentials.rcon_host`: `column_default=NULL, is_nullable=YES` — fix 0007 persisted on empty DB.
- All 9 containers: `Up X min (healthy)` where healthchecks are configured.

End-to-end exercised by Playwright (`/tmp/panel-tests/final_e2e.py`, evidence in `ai_docs/clean-install-evidence-final-20260424/`):

- Setup wizard: 8.8 s, owner committed.
- Login + `__Host-sid` cookie.
- Server create + install — depot was cached, so `status` flipped `installing → running` inside 1 s. `rcon_state=connected` within 30 s.
- Config editor opens, Monaco loads file content, tabs Редактор / История / Blame render, console shows no 429 spam after the rate-limit bump.
- Stop: 200 + `status=stopped`. Delete: 200, cascade clean (servers / server_credentials / config_versions all 0). The 0004 fix is what makes Delete work on a freshly-migrated DB.
- Logout button in the nav: `POST /api/v1/auth/logout` → **200 `{"ok":true}`**, `sessions` table empties to 0. No more 415.

Final audit log holds `server.install.started` + **`server.install.completed`** (new) + `server.stop` + `server.delete` + `user.logout` (200, not 415). `pnpm verify:audit-chain` → `ok: audit chain intact (9 rows)` — hash chain stays connected across the new action types.

### Round 2 — B8: `ERR_TOO_MANY_REDIRECTS` on stale session cookie

**Symptom**: user with a `__Host-sid` cookie from a previous install (e.g. after a `docker compose down -v`) hits `https://squad-panel.lan/` and the browser aborts with `ERR_TOO_MANY_REDIRECTS`. `curl -L --max-redirs 12` shows the bounce: `/ → /dashboard → /login → /dashboard → /login → …` indefinitely.

**Root cause**: `apps/web/src/middleware.ts` has

```ts
if (hasSession && pathname === '/login') {
  return NextResponse.redirect(new URL('/dashboard', req.url));
}
```

Middleware runs on the edge and can't touch the DB, so it redirects based solely on cookie presence. Meanwhile `(dashboard)/layout.tsx` runs `requireSession()`, which validates against `sessions` in Postgres — the stale cookie's `session_id` isn't there, so layout redirects back to `/login`. Middleware then sees the cookie is still there and bounces to `/dashboard` again.

**Fix**:

1. `apps/web/src/middleware.ts` — removed the `hasSession && pathname === '/login'` branch entirely. `/login` also dropped from the matcher; middleware now only handles the "no cookie + visiting a protected area" case.
2. `apps/web/src/app/login/page.tsx` — on mount the client calls `GET /api/v1/me`; on 200 it redirects to `/dashboard` (same UX as before), on 401 it calls `POST /api/v1/auth/logout` with `{}` body to have the server clear the dead cookie, then renders the form normally.

**Verification**:

```
anonymous GET / →   HTTP 307 /login → HTTP 200     (2 hops)
stale-cookie GET / → HTTP 307 /dashboard → HTTP 307 /login → HTTP 200  (3 hops, terminates)
stale-cookie GET /login →   HTTP 200 directly   (middleware no longer bounces it)
```

Loop gone. Browsers reload cleanly without clearing cookies manually.

### Remaining, cosmetic only

- `Pattern attribute value ^[a-z0-9][a-z0-9-]{0,63}$ is not a valid regular expression` — Chromium with the `v` regex flag rejects unescaped `{0,63}`. Slug validation still happens server-side (Fastify/Zod), so it's a console warning, not a functional problem. Could be silenced by switching `pattern="^[a-z0-9][a-z0-9\\-]{0,63}$"` or by dropping the attribute and relying on the server-side schema.
- `chrome-error://chromewebdata/` after programmatic logout in headless Chromium — purely a Playwright test artifact; the session is correctly revoked (`sessions` → 0) and a real browser lands on `/login`.
