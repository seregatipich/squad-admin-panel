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

**Symptom:** The Roles or Users link does not appear in the top-bar menus.

**Cause:** The top bar renders these links conditionally based on `me.permissions`. The links require `role:view` and `user:view` respectively. If the current user's role does not include those keys, the links are hidden.

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

## ConnectionBanner stuck red after refresh

**Symptom:** The top of every dashboard page shows «Связь с панелью потеряна — переподключаемся…» and never disappears.

**Cause:** Either the session expired (the WS `Sec-WebSocket-Protocol` upgrade fails because the cookie is no longer valid) or the API was restarted and the singleton lost its socket. The reconnect schedule walks `BACKOFF_STEPS_MS = [1s, 2s, 4s, 8s, 16s, 30s]` and stops re-trying when the page goes idle.

**Fix:** refresh the page. If the banner returns immediately, log out and back in to mint a fresh session.

## ConnectionBanner stuck amber

**Symptom:** Banner shows «Bridge не отвечает — операции с сервером временно недоступны».

**Cause:** API is fine and the WS is open, but `bridge-heartbeat` reports `bridge.connection: down`. The Go daemon at `/run/panel-host-bridge/bridge.sock` died or the systemd unit failed.

**Fix:** `sudo systemctl status panel-host-bridge` and `sudo systemctl restart panel-host-bridge.service`. The banner clears within ~5 s of the next successful ping.

## "Архив серверов" page is empty after I deleted servers

**Symptom:** `/servers/archive` shows zero rows even though servers were deleted in the past.

**Cause:** Pre-Bundle-C deletions did NOT soft-delete — the row was removed entirely and configs were not backed up. Only deletions that happened on or after the Bundle C release ship into the archive.

**Fix:** none. Old deletions are gone; future ones will appear here.

## Restore wizard fails at "Установка"

**Symptom:** `/servers/archive/[id]/restore` got past the slug step (server row created), but the install WS shows red errors.

**Cause:** Same as the standard install failure path — bridge offline, depot empty, or `container_run` error. The new server row is `pending` and visible at `/servers`; the operator can retry `POST /api/v1/servers/:id/install` directly.

**Fix:** resolve the install failure (see the install-wizard troubleshooting above), then return to `/servers/[id]` and run the install again. The restore-configs step still works against the same `from_archive_id` once the server reaches `ready`.

## Restore wizard says `files_missing[]` on every cfg

**Cause:** `from_archive_id` is from a deletion that pre-dates Bundle C, so no `deletion-backup-marker` rows exist. The new server keeps install-time defaults.

**Fix:** there is no fallback — re-edit configs by hand at `/servers/<newId>/configs`.

## Steam login lands on `/me` instead of the panel

**Symptom:** Fresh installation: you authenticated via Steam but landed on the «Мой VIP» self-service page (`/me`) rather than the dashboard. Since VIPSUB-5 (#171) every successful Steam login gets a session; a player whose role has no `panel_access` — including a player with no role at all — gets a `self_service`-scoped one and is redirected to `/me`. Typing a `(dashboard)` URL by hand bounces back to `/me` as well: the layout redirects any session whose `permissions` array is empty.

**Cause:** The first-owner auto-claim did not fire, so your player has no panel role. `claimFirstOwner` skips when `panel_meta.first_owner_claimed` is already `true` or when some player already holds the Owner role — typically because someone else logged in first. The host sentinel `/var/lib/squad-panel/.first-owner-claimed` is written after a successful claim but is never consulted; the DB is the only source of truth.

**Diagnostics:**
```bash
docker compose exec -T postgres psql -U admin admin -c "SELECT * FROM panel_meta;"
docker compose exec -T postgres psql -U admin admin -c \
  "SELECT p.steam_id64, p.canonical_name FROM players p
   JOIN roles r ON r.id = p.role_id WHERE r.name = 'Owner';"
# who the sentinel says claimed it (informational only)
sudo cat /var/lib/squad-panel/.first-owner-claimed
```

**Fix:** An existing Owner must assign you a role with `panel_access` via the `/users` page or directly in the database. Re-login is not required: the `self_service` downgrade stops applying the moment the player actually holds `panel_access`, so a refresh of `/` moves you into the dashboard (allow up to the 30 s permission-cache TTL after a direct DB edit). If the panel has no Owner at all, follow "Owner lockout" in [`docs/components/rbac/troubleshooting.md`](../rbac/troubleshooting.md).
