# Web — Troubleshooting

## Page returns 404 after code changes

**Symptom:** Navigating to any route returns a 404 or the browser shows stale content after a deployment.

**Cause:** The Next.js build artifact inside the `web` container is outdated. `docker compose up -d` does not rebuild unless `--build` is passed, and the container image has not been updated.

**Fix:**
```bash
docker compose build web
docker compose up -d web
```

---

## Sidebar link for /roles or /users is missing

**Symptom:** The Roles or Users link does not appear in the left sidebar.

**Cause:** The sidebar renders these links conditionally based on `me.permissions`. The links require `role:view` and `user:view` respectively. If the current user's role does not include those keys, the links are hidden.

**Diagnostics:**
1. Open `/settings/account` to see how many permission keys the current role has.
2. Ask an Owner to check the role's permissions at `/roles/:id`.

---

## Steam login returns `not_authorized`

**Symptom:** After completing Steam OpenID the browser redirects to `/login?error=not_authorized&steam_id64=...`.

**Cause:** The Steam account authenticated successfully but the player has `role_id = NULL` in the database. The user has not been granted a panel role.

**Fix:** An existing Owner user must assign a role to the player via `/users` → "Назначить роль" or via `/players/:steam_id64` → PanelAccessSection.

---

## Slug field does not auto-fill for Cyrillic server names

**Symptom:** Typing a Cyrillic display_name in `/servers/new` leaves the slug field empty or garbled.

**Cause:** Was a bug fixed in commit 6f17b3d — `nameToSlug` was not properly handling Cyrillic characters. If the issue persists the web container is running an outdated image.

**Fix:**
```bash
docker compose build web
docker compose up -d web
```

---

## LogConsole shows no output during install

**Symptom:** The install wizard transitions to the "installing" phase but the log console stays empty.

**Cause:** Multiple possible:
1. WebSocket connection to `/api/v1/servers/:id/install/ws` failed. Check the browser network tab for a failed WS upgrade.
2. The API container is not running or is unhealthy. Check `/ready`.
3. The bridge is offline — the depot check or container_run call in the install flow will hang.

**Diagnostics:**
```bash
docker compose logs api --since 2m
docker compose logs web --since 2m
sg panel -c 'bash scripts/verify-bridge.sh'
```

---

## Dashboard host block shows "bridge: недоступен"

**Symptom:** The Host widget on the dashboard shows a red status and the bridge as unavailable.

**Cause:** `GET /api/v1/host/bridge-status` returned `connected: false`. The Go bridge daemon is either not running or failed its last ping.

**Fix:**
```bash
sudo systemctl status panel-host-bridge
sudo systemctl restart panel-host-bridge
```

---

## MetricHistoryModal shows "Ошибка загрузки"

**Symptom:** Clicking a metric card (CPU, RAM, Disk, Net) on the dashboard opens the modal but shows an error.

**Cause:** `GET /api/v1/host/metrics/history` failed, likely because the bridge is offline or the API returned a non-OK response.

**Fix:** Resolve the bridge connectivity issue first. Verify with the dashboard bridge-status indicator.

---

## `RoleEditor` shows "Не удалось загрузить список permissions"

**Symptom:** The permission checkboxes on `/roles/new` or `/roles/:id` do not appear and an error message is shown.

**Cause:** `GET /api/v1/permissions` returned a non-OK response. This endpoint does not require any specific permission beyond being authenticated, so a 401 indicates an expired session.

**Fix:** Refresh the page to trigger a session re-check, or navigate to `/login` and re-authenticate.

---

## `/no-access` page hint about `.first-owner-claimed`

**Symptom:** Fresh installation: you authenticated via Steam but landed on `/no-access`.

**Cause:** The first-owner auto-claim did not fire because the sentinel file `/var/lib/squad-panel/.first-owner-claimed` was already present (e.g., from a previous installation), or there is already at least one Owner in the database.

**Diagnostics:**
```bash
ls -la /var/lib/squad-panel/.first-owner-claimed
docker compose exec api node -e "require('./dist/scripts/check-owners.js')"
```

**Fix:** An existing Owner must assign the Owner role manually via the `/users` page or directly in the database.
