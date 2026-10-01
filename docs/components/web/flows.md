# Web — UX Flows

## First-time install (no users yet)

1. Operator navigates to `https://panel.host/` (or any sub-path).
2. Root page (`app/page.tsx`) checks for `__Host-sid` cookie; none found → redirects to `/login`.
3. Login page renders. Operator clicks "Войти через Steam" (Sign in with Steam).
4. Browser follows `GET /api/v1/auth/steam/login` → Steam OpenID redirect.
5. Steam callback hits `GET /api/v1/auth/steam/callback`.
6. API reads `panel_meta.first_owner_claimed`. If it is still false, the first authenticated Steam user is granted the Owner role, the informational sentinel file is written, and a session cookie is set.
7. API redirects to `/`; root redirects the fresh session to `/dashboard`.
8. Dashboard layout calls `GET /api/v1/setup/status`; if `setup_completed=false`, it redirects to `/setup`.
9. `/setup` asks the Owner for the organization name and calls `POST /api/v1/setup/complete`.
10. After setup completion the browser returns to `/dashboard`; the dashboard starts polling its data sources every 4 s.

If the first-owner claim already happened and the user's role has no `panel_access` (including a user with no role), the API still sets a `__Host-sid` cookie — the session is scoped `self_service` — and redirects to `/me` instead of `/`.

---

## Ordinary login (session cookie absent)

1. User opens `/` (or any protected path); root page redirects to `/login`.
2. Login page fires `GET /api/v1/me` silently; if a valid session already exists (cookie in another tab was set) the page redirects to `/dashboard` immediately.
3. Otherwise user clicks "Войти через Steam" (Sign in with Steam); Steam OpenID flow runs.
4. On callback the API verifies Steam identity, resolves the player's permissions, sets the `__Host-sid` cookie on a `panel`-scoped session, and redirects to `/`; the root page forwards to `/dashboard`.
5. If the player's role has no `panel_access` (or there is no role), the session is created with scope `self_service` and the API redirects to `/me`. That scope is honoured only on routes declaring `config.selfService`, so every panel route treats the request as anonymous.

---

## Returning session (cookie present)

1. User opens any page under `/(dashboard)/`.
2. `DashboardLayout` server component calls `requireSession()`.
3. `requireSession` reads `__Host-sid`, calls `GET /api/v1/me`; if the session is still valid the Me object is returned and the layout renders.
4. If the cookie is expired or invalid, `getSession()` returns null → `requireSession()` calls `redirect('/login')`.
5. `GET /api/v1/me` is a `selfService` route, so a `self_service` session also gets past step 3. The layout therefore checks `me.permissions.length === 0` and redirects such a session to `/me` before rendering the admin shell — otherwise a direct `(dashboard)` URL would render the panel shell around widgets that every panel-gated route answers 401 for.

---

## Role assignment — /users modal

1. Admin opens `/users` (requires `user:view`).
2. Page loads user list and `/me`. "Назначить роль игроку" (Assign role to player) button appears when `user:manage_roles` is in permissions.
3. Admin clicks button → `AssignModal` opens.
4. Admin types a player name or SteamID64 in the search field; after 250 ms debounce, `GET /api/v1/players?q=...` fires and shows up to 20 matches.
5. Admin picks a player, selects a role from the dropdown and optionally selects an inclusive expiry day through the full-width `ДД/ММ/ГГГГ` (DD/MM/YYYY) calendar field. Empty expiry means a permanent role.
6. The optional comment is identified as a grant reason visible to other admins.
7. `PUT /api/v1/players/:playerId/role` receives `{role_id, expires_at, comment}`. A selected day becomes `23:59:59.999Z` on that same UTC date.
8. Modal closes; user list reloads.

---

## Role assignment — /players/[steam_id64] PanelAccessSection

1. Admin opens `/players/:steam_id64` (any authenticated user can view profiles).
2. `PanelAccessSection` is rendered when the caller has `user:manage_roles`.
3. Section loads the player's current role via `GET /api/v1/players/:steam_id64/role` and the full role list.
4. Admin clicks "Выдать роль" (Grant role) → a role dropdown, the same `ДД/ММ/ГГГГ` (DD/MM/YYYY) expiry field and an explained optional comment appear.
5. Admin picks a role and clicks "Сохранить" (Save).
6. `PUT /api/v1/players/:playerId/role` is called with the same date/comment semantics as the `/users` modal.
7. If the API returns 409 (last Owner), an error message is shown: "Нельзя снять роль у последнего Owner." (Cannot remove the role from the last Owner)
8. On success the section refreshes and shows the new role.
9. "Снять роль" (Remove role) button calls `DELETE /api/v1/players/:playerId/role`.

---

## Server delete + archive + restore

### Delete (from `/servers/[id]`)

1. Operator clicks "Удалить сервер" (Delete server).
2. Confirm modal renders the warning copy: «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов).» (Files will be erased from disk. The `.cfg` backup is kept in the archive (the Server archive section).)
3. On confirm: `DELETE /api/v1/servers/:id` fires.
4. API returns `DeleteResult` (see API data-model). UI shows a toast with `files_backed_up`/`container_removed` summary; non-empty `errors[]` surfaces a red badge linking to `/audit?target_id=<id>`.
5. The page redirects to `/servers`. The live-bus `server.deleted` event removes the row from any other open `/servers` tab without a refetch.

### Archive list (`/servers/archive`)

1. Operator opens `/servers/archive` (top-bar «Серверы» (Servers) entry, gated by `server:view`).
2. `GET /api/v1/servers/archive` populates the table.
3. Row click → `/servers/archive/[id]`.

### Archive detail (`/servers/archive/[id]`)

1. `GET /api/v1/servers/archive/:id` returns settings snapshot + backup file list.
2. Each cfg row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`.
3. "Восстановить" (Restore) button → `/servers/archive/[id]/restore`.

### Restore wizard (`/servers/archive/[id]/restore`)

1. Operator enters a slug (default = `${old_slug}-restored`) and optional display_name.
2. `POST /api/v1/servers/archive/:id/restore` fires.
3. On 409 `slug_in_use`: inline error, slug field flagged red. Operator picks a different slug.
4. On 201: store `new_server_id` and `archive_id`; transition to "Установка" (Installation) phase.
5. `POST /api/v1/servers/:newId/install` fires. WebSocket `/api/v1/servers/:newId/install/ws` streams progress through `LogConsole`.
6. On install `done` frame: transition to "Восстановление конфигов" (Restoring configs).
7. `POST /api/v1/servers/:newId/restore-configs` body `{from_archive_id: archiveId}`.
8. Summary card shows `files_restored`, `files_skipped` (always includes `License.cfg` and `Rcon.cfg`), `files_missing`, and any `errors[]` per file.
9. "Запустить сервер" (Start server) button → `POST /api/v1/servers/:newId/start` and navigate to `/servers/:newId`.

## Connection banner

1. `apps/web/src/app/(dashboard)/layout.tsx` mounts `<ConnectionBanner />` at the top of every authenticated page.
2. The banner subscribes to the singleton `live-bus` handle via `useLiveBusState()` and `useBridgeState()`.
3. On `server.status` / `rcon.status` events the dashboard's `/servers` page patches its local row state directly — REST polling drops to 120 s as a focus-refetch fallback.
4. On WS close the banner turns red (`Связь с панелью потеряна — переподключаемся…`, "Connection to the panel lost — reconnecting…") and the singleton runs `BACKOFF_STEPS_MS` reconnect.
5. On `bridge.connection: down` the banner turns amber. On `bridge.connection: up` it disappears.

## Dashboard disk breakdown

1. On mount the dashboard kicks off a one-shot fetch of `GET /api/v1/host/disk-usage` and starts a 30 s interval that re-fetches the same endpoint. The handler is independent from the 4 s host-metrics poll so the slower bridge sampling does not block the rest of the page.
2. The response (`DiskBreakdown`) is stored in component state. On any non-OK status or thrown error the state stays at its previous value; transient failures are tolerated silently because the bar gracefully degrades to its single-segment threshold rendering.
3. The `HostBlock` component receives the breakdown and forwards it to `DiskCard`.
4. `DiskCard` computes `usedPct = (disk_used_bytes / disk_total_bytes) * 100` from `host_metrics` (the source of truth for the title number) and clamps `panelPct = min(diskBreakdown.panel_pct, usedPct)` and `otherPct = max(0, usedPct - panelPct)`. This absorbs any drift between the bridge's `panel_disk_usage` cache (5 min TTL) and the live `host_metrics` sample.
5. The bar renders two stacked segments inside the existing track — `Панель` (Panel) in `bg-purple-500` first, then `Прочее` (Other) in `bg-purple-300` — followed by a swatch legend with one-decimal percentages. While `diskBreakdown` is `null` the bar reverts to its single-segment threshold-tinted rendering and the legend is hidden.

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
3. Admin fills in the form and clicks "Установить" (Install).
4. `POST /api/v1/servers` fires with form data. On validation error, a human-readable message is shown.
5. On 200: the created server's `id` is stored; the wizard transitions to the "installing" phase.
6. `POST /api/v1/servers/:id/install` fires.
7. A WebSocket connection opens to `ws://host/api/v1/servers/:id/install/ws`.
8. Install progress lines arrive as JSON frames `{ts, step, stream, message}`. `LogConsole` renders them with the step label prefix.
9. A `{done: true, final: "done" | "error"}` frame closes the WS.
10. On success: "Готово ✓" (Done ✓) heading appears and a "Открыть сервер" (Open server) button navigates to `/servers/:id`.
11. On error: "Ошибка установки" (Installation error) heading and the last error message are shown.

---

## Settings editor (`/servers/:id/settings`)

1. Admin opens `/servers/:id` and clicks "Настройки →" (Settings →) in the header action links.
2. Browser navigates to `/servers/:id/settings`.
3. `GET /api/v1/servers/:id` fires; the response populates `serverInfo` (status, display_name, tags) and `settings` (ports, game params, resource limits).
4. The page renders two sections:
   - **Сеть** (Network) — `game_port`, `query_port`, `beacon_port`, `rcon_port`. All four inputs are disabled when `isRunning` is true (server status is not `stopped`, `ready`, or `pending`). An amber warning "Остановите сервер для изменения портов" (Stop the server to change ports) appears.
   - **Игра** (Game) — `max_players` (1–100), `tickrate` (10–60).
   - Resource limits and `cpu_affinity` are not shown: the API stores them but nothing applies them to the container (#43).
5. Editing any field adds it to a `draft` object; the "Сохранить" (Save) button is disabled until `draft` is non-empty.
6. On save: `PUT /api/v1/servers/:id/settings` fires with only the changed fields. On success the response replaces the local `settings` state, the draft resets, and a green "Сохранено" (Saved) banner appears for 2 seconds. On error an error banner shows the API message.

---

## Config editor — Editor tab

1. Admin opens `/servers/:id/configs` (requires `config:view`).
2. Monaco editor loads lazily from `/monaco/vs` — the bundle is vendored same-origin, not fetched from a CDN (see [configuration](./configuration.md)). Current file content is fetched from `GET /api/v1/servers/:id/configs/:file`.
3. **The file opens read-only.** These files drive a live game server, so the editor does not accept keystrokes until the operator asks for it: a green "Изменить" (Edit) button sits in the bottom-right corner of the editor. The save bar (commit message, "Отмена" (Cancel), "Сохранить" (Save)) is hidden in view mode — there is nothing to save yet.
4. Clicking "Изменить" (Edit) arms editing for the open file. Dirty-tracking shows an unsaved indicator.
5. User clicks "Сохранить" (Save) (requires `config:write`). Optional commit message field.
6. `PUT /api/v1/servers/:id/configs/:file` fires with `{content, commit_message}`. CRLF endings are preserved (the model's EOL is pinned to CRLF on load, so `getValue()` round-trips `\r\n`).
7. If the sha256 is unchanged (no-op write), the API short-circuits: no new config_version row is created and the editor resets dirty state.
8. On success the editor resets **and returns to view mode**. "Отмена" (Cancel) does the same while discarding uncommitted changes; it stays enabled even with nothing changed, so arming editing by accident is always reversible. Opening another file also starts in view mode.

Files whose whole content is panel-owned (a `LayerRotation.cfg` carrying the managed segment) get no "Изменить" (Edit) button at all — they are read-only by nature, and the banner points at the screen that does own them.

### Managed-segment read-only (Admins.cfg)

`Admins.cfg` carries a panel-owned `//SQUAD-PANEL BEGIN … //SQUAD-PANEL END` segment (regenerated by the config-sync worker from Groups/roles). On mount the editor computes its 1-based line range (`managed-segment.ts` over `findManagedSegment`), paints it with a `.squad-managed-segment` decorations overlay, and installs an `onDidChangeModelContent` guard that `undo`s any edit whose range intersects the segment (monaco 0.56.0 has no read-only-range API). The rest of the file stays editable; a banner links to `/settings/groups` to change the roster there.

### Restart button (requires_restart files)

On mount the page reads `GET /api/v1/me` once. When the selected file's `behavior` is `requires_restart` **and** the caller holds `server:restart`, a "Рестарт сервера" (Restart server) button appears; it `POST /api/v1/servers/:id/restart` behind a `confirm()` and is disabled while in flight. The RCON auto-reload no longer fires for these files (`reload.reason='not_hot_reload'`), so the restart is the operator's apply path.

---

## Config editor — History tab

1. User clicks the История (History) tab.
2. `GET /api/v1/servers/:id/configs/:file/versions` returns the config_versions list.
3. Each row shows version_id short hash, author email, commit message, sha256, timestamp.
4. "Diff" button: fetches old and tip content, opens Monaco diff editor.
5. "Restore" button: sends the old content as a new `PUT` request (creates a new version, never mutates history).

---

## Map auto-vote (`/servers/:id/map-vote`)

The screen controls which layer the panel sets next. It **writes nothing to the game server's `.cfg` files** — not to `LayerRotation.cfg`, not to `Server.cfg`, not to any `LayerVoting*.cfg`. The whole decision lives in the panel database and is applied over RCON by the `AdminSetNextLayer` command, which the scheduler tick (`apps/workers/scheduler/src/map-vote-tick.ts`) sends once per match. This is why the screen also works for an external server whose files the panel does not hold. File-based rotation is the neighboring section «Ротация» (Rotation) (`/servers/:id/rotation`), which really does rewrite `LayerRotation.cfg`.

### What each parameter does

| Field on the screen | Where it is stored | What it changes |
|---|---|---|
| «Автовыбор карты» (Map auto-vote) (toggle) | `server_settings.map_vote_enabled` | The scheduler tick takes the server into work only when this is on. For a server with it off, the game runs its own rotation and the panel does not interfere. |
| «Правило выбора» (Selection rule) | `server_settings.map_vote_selection` | `weighted_random` — a draw weighted by the candidates' weights; `least_recently_played` — the layer that has gone longest without being played is taken. The rule is executed by `selectNextLayer` from `@squad/shared-config`, the same code in the preview and in the tick. |
| «Кулдаун слоя» (Layer cooldown) | `server_settings.map_vote_layer_cooldown` | How many of the most recent matches rule out a repeat of **the same layer**. 0 — a repeat is allowed immediately. |
| «Кулдаун карты» (Map cooldown) | `server_settings.map_vote_map_cooldown` | The same, but per **map**: prevents issuing Yehorivka RAAS and Yehorivka AAS back to back. |
| «Шаблон объявления» (Announcement template) | `server_settings.map_vote_broadcast_template` | The text with which the server announces the chosen layer. An empty field means no announcement. |
| Candidate row: layer, weight, «включён» (enabled) checkbox | `map_vote_candidates` | The pool the choice is made from. Weight affects only `weighted_random`. A disabled row stays in the pool but takes no part in the choice — this is a way to temporarily remove a layer without losing its weight. |

A layer marked `deprecated` in the catalog is added only with explicit confirmation (409 `deprecated_layer_confirmation_required`) and is always excluded from the choice — the «Предпросмотр» (Preview) card shows the reason for exclusion for each candidate.

### Preview and pick history

`GET /map-vote/preview` computes the decision with the same `selectNextLayer` and the same seed (the id of the last match) as the tick, so «Будет выбран» (Will be picked) is exactly what will be applied, not an estimate. «История выборов» (Pick history) reads `map_vote_picks`: one row per match, with a mark showing whether the command reached the server.

### Change history — shared with the config editor

Every save (rules and pool) writes a version into **the same `config_versions` table** as the config editor, under the file name `map-vote.json`: a `parent_version_id` chain, author, IP, message and the sha256 of the content. The version content is the canonical JSON of the screen state (candidates sorted by layer name), so saving again without changes creates no new record.

- `GET /api/v1/servers/:id/map-vote/versions` — list of versions (`can_restore` depends on the `changemap` permission).
- `GET /api/v1/servers/:id/map-vote/versions/:vid` — the content and the parsed snapshot.
- `POST /api/v1/servers/:id/map-vote/versions/:vid/restore` — rollback: restores the rules and the pool, writes the `server.map_vote.restore` audit entry and **itself becomes a new version**, so the history never loses a step.

The name `map-vote.json` is intentionally not part of `ALLOWED_CONFIG_FILES`: the «Конфиги» (Configs) section must not show it, offer it for editing, or compare it against the disk, where no such file exists. If a version references a layer that has disappeared from the catalog, the rollback answers 409 `unknown_layers_in_version` with a list — the screen shows it and offers «Откатить без них» (Roll back without them).

---

## Config editor — Blame tab

1. User clicks the Blame tab.
2. `GET /api/v1/servers/:id/configs/:file/blame` returns per-line attribution (cached in Redis, computed by Myers diff walk).
3. Each line renders with version_id short hash, author email, and date in the gutter.
