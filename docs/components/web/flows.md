# Web — UX Flows

## First-time install (no users yet)

1. Operator navigates to `https://panel.host/` (or any sub-path).
2. Root page (`app/page.tsx`) checks for `__Host-sid` cookie; none found → redirects to `/login`.
3. Login page renders. Operator clicks "Войти через Steam".
4. Browser follows `GET /api/v1/auth/steam/login` → Steam OpenID redirect.
5. Steam callback hits `GET /api/v1/auth/steam/callback`.
6. API reads `panel_meta.first_owner_claimed`. If it is still false, the first authenticated Steam user is granted the Owner role, the informational sentinel file is written, and a session cookie is set.
7. API redirects to `/`; root redirects the fresh session to `/dashboard`.
8. Dashboard layout calls `GET /api/v1/setup/status`; if `setup_completed=false`, it redirects to `/setup`.
9. `/setup` asks the Owner for the organization name and calls `POST /api/v1/setup/complete`.
10. After setup completion the browser returns to `/dashboard`; the dashboard starts polling its data sources every 4 s.

If the first-owner claim already happened and the user has no role, the API redirects to `/no-access?steam_id64=<id>` and does not set a session cookie.

---

## Ordinary login (session cookie absent)

1. User opens `/` (or any protected path); root page redirects to `/login`.
2. Login page fires `GET /api/v1/me` silently; if a valid session already exists (cookie in another tab was set) the page redirects to `/dashboard` immediately.
3. Otherwise user clicks "Войти через Steam"; Steam OpenID flow runs.
4. On callback the API verifies Steam identity, checks the `players` table for a `role_id`, sets the `__Host-sid` cookie, and redirects to `/dashboard`.
5. If `role_id IS NULL` the API redirects to `/no-access?steam_id64=<id>`.

---

## Returning session (cookie present)

1. User opens any page under `/(dashboard)/`.
2. `DashboardLayout` server component calls `requireSession()`.
3. `requireSession` reads `__Host-sid`, calls `GET /api/v1/me`; if the session is still valid the Me object is returned and the layout renders.
4. If the cookie is expired or invalid, `getSession()` returns null → `requireSession()` calls `redirect('/login')`.

---

## Role assignment — /users modal

1. Admin opens `/users` (requires `user:view`).
2. Page loads user list and `/me`. "Назначить роль игроку" button appears when `user:manage_roles` is in permissions.
3. Admin clicks button → `AssignModal` opens.
4. Admin types a player name or SteamID64 in the search field; after 250 ms debounce, `GET /api/v1/players?q=...` fires and shows up to 20 matches.
5. Admin picks a player, selects a role from the dropdown.
6. If the selected role is the Owner system role, a confirm dialog fires: "Это даст пользователю полный доступ к панели."
7. On confirm: `PUT /api/v1/players/:steam_id64/role` with `{role_id}`.
8. Modal closes; user list reloads.

---

## Role assignment — /players/[steam_id64] PanelAccessSection

1. Admin opens `/players/:steam_id64` (any authenticated user can view profiles).
2. `PanelAccessSection` is rendered when the caller has `user:manage_roles`.
3. Section loads the player's current role via `GET /api/v1/players/:steam_id64/role` and the full role list.
4. Admin clicks "Изменить" → a select dropdown appears with all available roles.
5. Admin picks a role and clicks "Сохранить".
6. If the selected role is Owner, a confirm dialog fires.
7. `PUT /api/v1/players/:steam_id64/role` is called.
8. If the API returns 409 (last Owner), an error message is shown: "Нельзя снять роль у последнего Owner."
9. On success the section refreshes and shows the new role.
10. "Снять роль" button calls `PUT` with `{role_id: null}`.

---

## Role editor — create

1. Admin opens `/roles` (requires `role:view`) and clicks "Создать роль" (requires `role:create`).
2. Browser navigates to `/roles/new`.
3. `RoleEditor` renders with empty defaults. `GET /api/v1/permissions` loads the full permission registry.
4. Admin fills in name, picks a color, optionally writes a description, checks permissions.
5. Admin clicks "Создать".
6. `POST /api/v1/roles` fires with `{name, color, description, permissions}`.
7. On 409 (name taken): error message shown inline.
8. On 201: `router.push('/roles')`.

---

## Role editor — edit

1. Admin opens `/roles` and clicks "Редактировать" on a role.
2. Browser navigates to `/roles/:id`.
3. Page fetches `GET /api/v1/roles/:id`; `RoleEditor` pre-fills with the fetched data.
4. If the role is the system Owner role, `isOwner: true` is passed → the form is read-only, only a Back button is shown.
5. For non-Owner roles: admin edits fields, clicks "Сохранить".
6. `PUT /api/v1/roles/:id` fires.
7. On 409 (name taken) or 400 (Owner protected): error shown inline.
8. On 200: `router.push('/roles')`.

---

## Server delete + archive + restore

### Delete (from `/servers/[id]`)

1. Operator clicks "Удалить сервер".
2. Confirm modal renders the warning copy: «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов).»
3. On confirm: `DELETE /api/v1/servers/:id` fires.
4. API returns `DeleteResult` (see API data-model). UI shows a toast with `files_backed_up`/`container_removed` summary; non-empty `errors[]` surfaces a red badge linking to `/audit?target_id=<id>`.
5. The page redirects to `/servers`. The live-bus `server.deleted` event removes the row from any other open `/servers` tab without a refetch.

### Archive list (`/servers/archive`)

1. Operator opens `/servers/archive` (sidebar entry gated by `server:view`).
2. `GET /api/v1/servers/archive` populates the table.
3. Row click → `/servers/archive/[id]`.

### Archive detail (`/servers/archive/[id]`)

1. `GET /api/v1/servers/archive/:id` returns settings snapshot + backup file list.
2. Each cfg row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`.
3. "Восстановить" button → `/servers/archive/[id]/restore`.

### Restore wizard (`/servers/archive/[id]/restore`)

1. Operator enters a slug (default = `${old_slug}-restored`) and optional display_name.
2. `POST /api/v1/servers/archive/:id/restore` fires.
3. On 409 `slug_in_use`: inline error, slug field flagged red. Operator picks a different slug.
4. On 201: store `new_server_id` and `archive_id`; transition to "Установка" phase.
5. `POST /api/v1/servers/:newId/install` fires. WebSocket `/api/v1/servers/:newId/install/ws` streams progress through `LogConsole`.
6. On install `done` frame: transition to "Восстановление конфигов".
7. `POST /api/v1/servers/:newId/restore-configs` body `{from_archive_id: archiveId}`.
8. Summary card shows `files_restored`, `files_skipped` (always includes `Rcon.cfg`), `files_missing`, and any `errors[]` per file.
9. "Запустить сервер" button → `POST /api/v1/servers/:newId/start` and navigate to `/servers/:newId`.

## Connection banner

1. `apps/web/src/app/(dashboard)/layout.tsx` mounts `<ConnectionBanner />` at the top of every authenticated page.
2. The banner subscribes to the singleton `live-bus` handle via `useLiveBusState()` and `useBridgeState()`.
3. On `server.status` / `rcon.status` events the dashboard's `/servers` page patches its local row state directly — REST polling drops to 120 s as a focus-refetch fallback.
4. On WS close the banner turns red (`Связь с панелью потеряна — переподключаемся…`) and the singleton runs `BACKOFF_STEPS_MS` reconnect.
5. On `bridge.connection: down` the banner turns amber. On `bridge.connection: up` it disappears.

## Dashboard disk breakdown

1. On mount the dashboard kicks off a one-shot fetch of `GET /api/v1/host/disk-usage` and starts a 30 s interval that re-fetches the same endpoint. The handler is independent from the 4 s host-metrics poll so the slower bridge sampling does not block the rest of the page.
2. The response (`DiskBreakdown`) is stored in component state. On any non-OK status or thrown error the state stays at its previous value; transient failures are tolerated silently because the bar gracefully degrades to its single-segment threshold rendering.
3. The `HostBlock` component receives the breakdown and forwards it to `DiskCard`.
4. `DiskCard` computes `usedPct = (disk_used_bytes / disk_total_bytes) * 100` from `host_metrics` (the source of truth for the title number) and clamps `panelPct = min(diskBreakdown.panel_pct, usedPct)` and `otherPct = max(0, usedPct - panelPct)`. This absorbs any drift between the bridge's `panel_disk_usage` cache (5 min TTL) and the live `host_metrics` sample.
5. The bar renders two stacked segments inside the existing track — `Панель` in `bg-purple-500` first, then `Прочее` in `bg-purple-300` — followed by a swatch legend with one-decimal percentages. While `diskBreakdown` is `null` the bar reverts to its single-segment threshold-tinted rendering and the legend is hidden.

## Dashboard disk-card click → DiskBreakdownModal

1. The disk card is wrapped in a `<button data-testid="disk-card">`. Clicking it does NOT open `MetricHistoryModal` (CPU/RAM/Network cards still do). Instead it sets the dashboard-local `diskModalOpen` state to `true`.
2. `<DiskBreakdownModal>` is mounted near the bottom of the dashboard JSX with `open={diskModalOpen}`, `onOpenChange={setDiskModalOpen}`, `initialData={diskBreakdown}` (the polled state from the 30 s interval), and `onRefresh={refreshDiskBreakdown}`.
3. On `open` flipping to `true` the modal seeds its own local `data` from `initialData` — no network call. It renders the summary line, the per-type list (configs / saved-total / squad-depot / docker volumes / docker images / audit-archive sorted by bytes descending) and the per-server saved table (only when `saved_per_server.length > 0`).
4. The refresh button calls `onRefresh`, which fires `GET /api/v1/host/disk-usage?refresh=1`. The API forwards `{ force: true }` to `bridge.panelDiskUsage`, the bridge skips its 5-min cache, recomputes (`du -sb` + `docker system df` + `statvfs`), updates the cache, and returns the fresh payload. The dashboard's `diskBreakdown` state is also updated so closing and re-opening the modal sees the latest data, and the disk card's sub-segment bar updates too.
5. While the refresh is in flight the button is disabled and the `↻` glyph spins. Failures (non-OK or thrown) leave the previous data intact.
6. Backdrop click and Escape both close the modal via `onOpenChange(false)`.

## Server install wizard

1. Admin navigates to `/servers/new`.
2. Form shows: display_name, slug (auto-generated from display_name by Cyrillic-to-Latin transliteration, editable), port fields, max_players.
3. Admin fills in the form and clicks "Установить".
4. `POST /api/v1/servers` fires with form data. On validation error, a human-readable message is shown.
5. On 200: the created server's `id` is stored; the wizard transitions to the "installing" phase.
6. `POST /api/v1/servers/:id/install` fires.
7. A WebSocket connection opens to `ws://host/api/v1/servers/:id/install/ws`.
8. Install progress lines arrive as JSON frames `{ts, step, stream, message}`. `LogConsole` renders them with the step label prefix.
9. A `{done: true, final: "done" | "error"}` frame closes the WS.
10. On success: "Готово ✓" heading appears and a "Открыть сервер" button navigates to `/servers/:id`.
11. On error: "Ошибка установки" heading and the last error message are shown.

---

## Settings editor (`/servers/:id/settings`)

1. Admin opens `/servers/:id` and clicks "Настройки →" in the header action links.
2. Browser navigates to `/servers/:id/settings`.
3. `GET /api/v1/servers/:id` fires; the response populates `serverInfo` (status, display_name, tags) and `settings` (ports, game params, resource limits).
4. The page renders three sections:
   - **Сеть** — `game_port`, `query_port`, `beacon_port`, `rcon_port`. All four inputs are disabled when `isRunning` is true (server status is not `stopped`, `ready`, or `pending`). An amber warning "Остановите сервер для изменения портов" appears.
   - **Игра** — `max_players` (1–100), `tickrate` (10–60).
   - **Ресурсы** — `memory_high_mb`, `memory_max_mb`, `cpu_weight`, `io_weight`, `niceness` (all nullable number inputs with "Нет лимита" placeholder), `cpu_affinity` (nullable text input with "Нет ограничения" placeholder). A note reads "Применяется при следующем запуске".
5. Editing any field adds it to a `draft` object; the "Сохранить" button is disabled until `draft` is non-empty.
6. On save: `PUT /api/v1/servers/:id/settings` fires with only the changed fields. On success the response replaces the local `settings` state, the draft resets, and a green "Сохранено" banner appears for 2 seconds. On error an error banner shows the API message.

---

## Config editor — Editor tab

1. Admin opens `/servers/:id/configs` (requires `config:view`).
2. Monaco editor loads lazily. Current file content is fetched from `GET /api/v1/servers/:id/configs/:file`.
3. User edits content. Dirty-tracking shows an unsaved indicator.
4. User clicks "Сохранить" (requires `config:write`). Optional commit message field.
5. `PUT /api/v1/servers/:id/configs/:file` fires with `{content, commit_message}`.
6. If the sha256 is unchanged (no-op write), the API short-circuits: no new config_version row is created and the editor resets dirty state.
7. On success the editor resets.

---

## Config editor — History tab

1. User clicks the История tab.
2. `GET /api/v1/servers/:id/configs/:file/versions` returns the config_versions list.
3. Each row shows version_id short hash, author email, commit message, sha256, timestamp.
4. "Diff" button: fetches old and tip content, opens Monaco diff editor.
5. "Restore" button: sends the old content as a new `PUT` request (creates a new version, never mutates history).

---

## Config editor — Blame tab

1. User clicks the Blame tab.
2. `GET /api/v1/servers/:id/configs/:file/blame` returns per-line attribution (cached in Redis, computed by Myers diff walk).
3. Each line renders with version_id short hash, author email, and date in the gutter.
