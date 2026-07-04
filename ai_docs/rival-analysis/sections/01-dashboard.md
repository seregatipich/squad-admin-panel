## 01. Server Dashboard & RCON Control

> Competitive functionality analysis of SQSTAT (`breaking.sqstat.ru`). This section documents the **main per-server control panel** — the largest page fragment (~312 KB) and the operational heart of the panel. Everything an admin does to a live Squad server happens here.

---

### 1. Purpose & Navigation

| Attribute | Value |
|---|---|
| Nav location | `main` (default landing page) |
| Loader | `pageLoad('main')` → `GET /ajax/page.php?page=main` → fragment injected into `#content` |
| Deep links | `/?server_id=<id>` (open a specific server tab), `/?steam_id=<id>` (auto-open player modal), `/?start_seed=true` (auto-open the seeding helper) |
| Primary RPC script | `squad` → `POST /ajax/squad.php` (nearly all live-control actions) |
| Secondary scripts | `public` (rotation read / map calendar / auth), `player` (shared player-modal actions) |

**Layout.** A single full-width row split into:
- **Left ~75% (`col-md-9`, `data-hide="offline"`):** live player/squad board, with tabs **Игроки (Players)**, **Техника (Vehicles, hidden by default)**, **Очередь (Queue)**, **Отключившиеся (Disconnected)**.
- **Right ~25% (`col-md-3`):** the control sidebar — collapsible **Управление (Control)** and **Состояние (State/monitoring)** panels, an **Онлайн (Online)** gauge + chart, a live **Чат (Chat)** feed with a broadcast input, a **Карта (Map)** widget (current/next map, rotation, calendar), and a **legend for player markers**.

**Server tabs.** A `#servers` tab strip lists every server as `<a data-server="<id>">`. Each carries live badges refreshed on a 5s poll (`getServer`):
- `data-type="badge_online"` → `players/100` (or `OFF` with `.bg-important` when the server is down)
- `data-type="badge_queue"` → `+N` queue overflow (hidden when 0)
- `data-type="badge_admins"` → admin headcount on the server
- A `fa-user text-danger` icon is prepended to the tab where *you* are currently playing (`text.you`).

The header also shows **global online** as `N (percent%)` — this server group's share of all tracked Squad players worldwide (`text.global_online`), plus a **Squad sale** banner (`text.is_sale`) when a Steam discount is live.

---

### 2. Polling & State Machine

The page polls `squad.getServer` every **5000 ms** for the active tab.

**Request** `getServer`: `{ server_id, last_chat_id }` (chat delta cursor).
**Response** `text.server` drives `showServer()`; `text.servers` refreshes all tab badges; `text.global_online`, `text.you`, `text.is_sale` update globals.

Server display states (from `data.isConnect` / `data.block_start`):

| Condition | UI behavior |
|---|---|
| `isConnect === true` | Full board shown; control buttons enabled |
| `!isConnect && !block_start` | "Нет подключения (No connection)"; **Включить (Turn on)** button shown |
| `block_start` set | Shows `block_start.msg`; start button hidden. If `block_start.code == 4` → shows `data.update_log` in a `<pre>` (server is mid-update) |

Alert banners (each `display:none` until triggered): **Версия бота неактуальна (Bot version outdated)** with an inline **Обновить бота (Update bot)** link; **Проблемы с EOS backend (EOS backend problems)**; **На сервер идёт атака (Server under attack)** — triggered when `network.connections > 300`, shows connection count + **Открыть подключения (Open connections)**; **Скидка на Squad (Squad discount)**.

---

### 3. Entities & Data Model

Inferred from `showServer()` rendering, hidden `<template>` blocks, and Action payloads.

#### 3.1 Server (`data.server`)

| Field | Meaning |
|---|---|
| `isConnect` / `block_start` / `outdated` / `eos_problem` | Connectivity & health flags |
| `start_params.port` / `.query` / `.beacon_port` | Game / Steam-query / RCON-beacon ports |
| `start_params.ip` / `.new_ip` | Bound IP (and pending IP after restart) |
| `license` / `license_valid` | Server license key + validity flag |
| `version` / `build` | Squad server version & build number |
| `region`, `EOS_ping`, `EOS_online` | EOS backend region, filter ping, monitored online count |
| `cores` / `mem` | CPU core count / memory |
| `last_restart`, `bot_start`, `need_restart` | Timestamps (day/month/year/hour/minute) + pending-restart flag |
| `teams[0..1]` | `{ short, name, unit }` — faction short code, full name, unit label (drives team banner images `/assets/img/teams/<short>_bg.jpg`) |
| `players.active[]` / `players.dis[]` | Live players / recently disconnected |
| `squads[]` | Live squads |
| `calculateOnline[team].squads[id]` | Per-squad `{ avg, median }` playtime aggregates; also per-team totals (`online_all`, `online_avg`, `online_median`, `online_sl`) |
| `vote` | `{ isVote, mode: skip\|next\|current, map }` — active in-game map vote |
| `monitor[]` | Time-series of `{ data: { network.connections, ... } }` for the mini-charts |

#### 3.2 Player (row in `players.active[]`)

| Field | Meaning |
|---|---|
| `steam_id` | SteamID64 — row key (`data-id`), used by every player action |
| `eos_id` | Epic Online Services ID |
| `name`, `color` | Display name; optional clan-tag color (hex, rendered in `<code style="color:#…">`) |
| `team`, `squad`, `leader` | Team 1/2, squad id, is-squad-leader flag |
| `kit` | Raw kit string; regex-reduced to a base kit → icon `/assets/img/ico/kits/<kit>.svg` |
| `state` | e.g. `Playing`; non-Playing → dimmed row + skull icon |
| `in_vehicle` | `{ id, name, vehicle, icon, class }` — vehicle occupancy |
| `playtime` | `{ date, last_seen }` → session length badge |
| `location` | `{ country, iso, same }` — geo flag + count of players sharing this IP |
| `mark` | Boolean — flagged/watched player (row gets `.player_mark`) |
| `warning` | >3 punishments → `fa-user-secret` badge |
| `vac` | Steam ban within 100 days → Steam icon |
| `baby` | New player <30h → baby icon |
| `requests` | `{ admins, report, ban_ip }` → live admin-call / report / banned-IP indicators |

#### 3.3 Squad (`data.squads[]`, hidden `[data-template="squad"]`)

| Field | Meaning |
|---|---|
| `id` | Squad number (badge) |
| `name` | Squad name (blankable via `rename`) |
| `team` | Owning team |
| `create_id` / `create_name` | SteamID / name of the squad creator (crown icon) |
| `cmd` | Has a Commander (star icon; CMD squads sort to top) |
| `locked` | Locked squad (lock icon) |
| `size` | Member count, rendered `size/9` |
| `message` | Pending scheduled squad-message flag |

Squad panels expose an inline button row (`data-type="buttons"`): open-creator (crown), **squadMessage** (envelope), **transfer** (swap sides), **demote** (if CMD) or **rename** (if not), and **disband** (✕). Each squad table gets `data-leader=<steam_id>` for its leader.

#### 3.4 Vehicle (`in_vehicle`, hidden `[data-template="vehicle"]`) — team/vehicle board (tab is `.hide` by default, feature appears disabled).

#### 3.5 Queue & Disconnected tables

| Queue columns | Disconnected columns |
|---|---|
| Позиция (Position), EOS (id), Имя (Name), Время (Time) | SteamID, Имя (Name), Время (Time) |

---

### 4. Actions / Admin Capabilities

All POST to `/ajax/<script>.php` with body `action=<id>&<params>`. "Destructive" = mutates live server/game state.

#### 4.1 Server lifecycle — Управление (Control) panel — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Включить (Turn on) | `start` | `server_id` | Boots the game server (confirm dialog) | Y |
| Выключить (Turn off) | `stop` | `server_id` | Shuts the server down | Y |
| Рестарт (Restart) | `restart` | `server_id` | Restarts the game server | Y |
| Обновить (Update) | `update` | `server_id`, `afterMapChange` (bool) | Updates server; optionally defers until next map change | Y |
| RCON | `rconRestart` | `server_id` | Restarts the RCON connection | Y |
| Parser | `parserRestart` | `server_id` | Restarts the log parser | Y |
| (Steam Query) | `cacherRestart` | `server_id` | Restarts the Steam-query cacher | Y |
| Обновить бота (Update bot) | `botUpdate` | *(none)* | Updates the sqstat bot agent | Y |
| (IP select) | `setServerIP` | `server_id`, `ip` | Rebinds the server IP (takes effect after restart) | Y |

Confirmation dialogs (`$.question`) gate start/stop/restart/update/rcon/parser/cacher/botUpdate. `blockServerButtons()` disables the four lifecycle buttons while an op is in flight.

#### 4.2 Player control (live-server, from the shared player modal but scoped by `server_id`) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Кик (Kick) | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | Kicks player; `noReason:true` path skips reason | Y |
| Бан (Ban) | `ban` | `server_id`, `steam_id`, `reason_id`, `description`, `days` | Bans player (`days=0` → permanent) | Y |
| Разбан (Unban) | `unban` | `steam_id`, `unban` (bool: erase vs lift) | Removes ban; `unban:true` fully wipes the record | Y |
| Убить (Kill) | `kill` | `server_id`, `steam_id` | Kills the player in-game (drops their squad) | Y |
| Сменить команду (Change team) | `changeTeam` | `server_id`, `steam_id` | Force team-swap | Y |
| Исключить из сквада (Remove from squad) | `removePlayer` | `server_id`, `steam_id` | Removes from squad without kicking | Y |

> **Shared modal note:** the player-detail modal (tabs Chat/Kills/Deaths/Kits/Games/Comments and actions `mark`, `message`, `twink`, `twinkOnline`, `findFriends`, `addComment`, `getComments`, `changeGroup`, `kits`, `kitSave`, `checkBans`, `addBanName`, `removeBanName`, `get`, `downloadStat`, `getPlayerOnlineData`) is embedded on every page and is **not** owned by the dashboard. Those actions run on `script: 'player'`. Only the six live-server actions above (which require a `server_id`) are dashboard-specific. `copyTeleport()` copies an `AdminTeleportToPlayer <steam_id>` RCON string to the clipboard.

#### 4.3 Squad control (per-squad row buttons) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Расформировать (Disband) | `disband` | `server_id`, `team`, `squad` | Disbands the squad (confirm) | Y |
| Сменить сторону (Transfer) | `transfer` | `server_id`, `team`, `squad` | Moves whole squad to other team (confirm) | Y |
| Сбросить название (Rename/clear) | `rename` | `server_id`, `team`, `squad` | Clears the squad name (confirm) | Y |
| Снять CMD (Demote) | `demote` | `server_id`, `steam_id` (leader) | Strips Commander (confirm) | Y |
| Сообщение скваду (Squad message) | `squadMessage` | `server_id`, `team`, `squad`, `time`, `msg` | Sends a repeating in-game message to the squad | Y |

#### 4.4 Messaging & broadcast — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Broadcast (chat input) | `broadcast` | `server_id`, `msg` | Server-wide broadcast (min 2 chars; confirm) | Y |
| Сообщение скваду | `squadMessage` | see 4.3 | Targeted squad message with repeat cadence | Y |

Repeat-cadence `<select>` options (shared by squad-message and player-message forms): `1` = 1 раз (once), `30` = 30s, `40` = 40s, `60` = 1 min (default), `90` = 1 min 30s, `120` = 2 min. The squad-message modal shows the author's SteamID + Steam profile link, and a `{player}` placeholder that expands to the creator's name from message templates.

#### 4.5 Map & rotation — `script: 'squad'` (rotation read/write via `mapRotation.mode`, which is `'squad'` when opened from the dashboard cog)

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Сменить (Change map) | `changeMap` | `server_id`, `next` (bool), `map` (URI-encoded layer string), `vote` (bool) | Changes current (or next) map | Y |
| Следующая (Set next) | `changeMap` | `server_id`, `next:true`, `map`, `vote` | Sets the next map only | Y |
| (Skip / next round) | `changeMap` | `server_id`, `next:'skip'`, `map:'skip'`, `skip:true`, `vote` | Ends current round / skips map | Y |
| Очистить следующую (Clear next) | `clearNext` | `server_id` | Clears the queued next map | Y |
| (Load map catalog) | `getServerMaps` | `server_id` | Returns `{ maps[], units[] }` for the picker | N |
| Ротация — read | `getRotation` | `server_id` | Returns `{ rotation, list, canEdit }` | N |
| Ротация — Изменить (Edit) | `setRotation` | `server_id`, `rotation` (URI-encoded), `day` | Overwrites the rotation for a given day | Y |
| Календарь (Calendar) | `mapCalendar` | `server_id`, `start`, `end` | Read-only played-maps calendar (`script: 'public'`) | N |

**Map picker (`mapSelect`).** The `getServerMaps` catalog feeds a filterable grid (multi-selects **Карта (Map name)**, **Режим (Type)**, **Команды (Teams/factions)**, each showing a live count; plus a free-text "Сменить по названию (change by name)" input). Selecting a map opens a **configurator**: per-team faction `<select>` + unit `<select>`, live **tickets**, and a preview of each side's **kits** (role SVGs) and **vehicles** (name, count, respawn time `respawn/60`, optional delay). It assembles the RCON layer string as `<Map> <T1faction>+<T1unit> <T2faction>+<T2unit>`.

**Map entity fields** (`getServerMaps.maps[]`): `map` (layer name), `type` (mode: RAAS/AAS/Invasion/…), `weather`, `markers`, `teams.t_1|t_2 = { tickets, default:{faction,unit,prefix,postfix}, factions[]:{ name, default, units[] } }`. **Unit entity** (`units[]`): `{ roles[], vehicles[]:{ name, count, respawn, delay } }`.

**Rotation entity** (`getRotation`): `rotation.lists[day]` (newline-delimited layer list; `//` comments ignored), `rotation.current` (active day), `rotation.isWin` (win-based rotation → hides day tabs), `canEdit`. Days keyed `default`, `1`–`7` (Mon–Sun), rendered as tabs (Стандартная / Пн–Вс).

#### 4.6 Monitoring & analytics — `script: 'squad'` (calendar via `public`)

| UI label | action | Params | Returns | Destructive |
|---|---|---|---|---|
| Подробнее (Details) | `serverMonitor` | `start`, `end`, `server_id` | Time-series: mem, network_send/receive, disk_read/write, tps, network_connections | N |
| Онлайн chart | `serverOnline` | `start`, `end`, `server_id` | `{ players[], admins[], queue[], days[], maps{} }` | N |
| Онлайн — Админы (Admins timeline) | `serverOnlineAdmins` | `day`, `server_id` | `{ events, resources }` (per-admin presence timeline) | N |
| Онлайн — Бустеры (Boosters timeline) | `serverOnlineBooster` | `day`, `server_id` | `{ events, resources }` | N |
| Подключения (Connections) | `network` | `server_id` | `{ network.ips{ip:{conn[],country,city}}, network.sockets[] }` | N |
| (Ban IP, in network modal) | `blockIP` | `ip` | Blocks an IP at the firewall level (confirm; button is `.hide`-gated) | Y |

#### 4.7 Raw RCON console — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Выполнить (Execute) | `rconRaw` | `server_id`, `command` (URI-encoded) | Runs any raw RCON command; response rendered in a read-only CodeMirror pane (auto-pretty-prints JSON) | Y (depends on command) |

The console ships a **built-in command dictionary with autocomplete** (typeahead over both names and Russian help text): `AdminKick`, `AdminKickById`, `AdminBan`, `AdminBanById`, `AdminBroadcast`, `AdminEndMatch`, `AdminChangeMap`, `AdminSetNextMap`, `AdminSetMaxNumPlayers`, `AdminSetServerPassword`, `AdminSlomo`, `AdminForceTeamChange`, `AdminForceTeamChangeById`, `AdminListDisconnectedPlayers`, `AdminDemoteCommander(ById)`, `AdminDisbandSquad`, `AdminRemovePlayerFromSquad(ById)`, `AdminWarn(ById)`, `AdminRestartMatch`, `AdminReloadServerConfig`, `ListPlayers`, `ListSquads`, `ShowServerInfo` — each with a usage example. This exposes the full Squad admin command surface even for actions without a dedicated button (e.g. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`).

#### 4.8 Config & mod management (opened from the Control panel) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Редактор конфигов (Config editor) | `getConfigFiles` / `getConfigFile` | `server_id`, file | List / load config files | N |
| " → Сохранить (Save) | `saveConfigFile` | file, contents | Writes a config file | Y |
| " → Перезагрузить (Reload) | `reloadConfig` | `server_id` | Reloads server config in-game | Y |
| " → По-умолчанию (Default) | `getDefaultConfig` | file | Loads the default template | N |
| Менеджер модов (Mod manager) | `getMods` | `server_id` | Lists installed Workshop mods | N |
| " → Install | `installMod` | mod id | Installs a Workshop mod | Y |
| " → Delete | `deleteMod` | mod id | Removes a mod | Y |

The config editor also has (mostly `.hide`-gated) **backup create/delete** and **merge/rebuild** controls, and a **синхронизировать скролл (sync-scroll)** toggle for side-by-side diff editing.

---

### 5. Forms & Modals

| Modal / form | Key fields |
|---|---|
| **Смена карты (Map select)** | `#map-name`, `#map-type`, `#map-team` multiselects; `#changemap-custom` free-text; grid of thumbnails; configurator with per-team faction/unit selects, ticket counts, kit/vehicle preview, assembled layer string (readonly), **Сменить** button |
| **Ротация карт (Rotation)** | Day tabs (default/Пн–Вс), scrollable layer list with faction flag icons, **Изменить (Edit)** → textarea (readonly unless `canEdit`) |
| **Сообщение скваду (Squad message)** | Author SteamID/link, message `<textarea>`, repeat-cadence select (default 60s), template quick-inserts with `{player}` |
| **RCON консоль** | Command input with datalist + live search dropdown, **Выполнить**, CodeMirror read-only output (80vh) |
| **Подключения (Network)** | Tabs Подключения / Сокеты; per-IP cards (rank, IP, conn count, up/down speed, geo country+city, external lookup link, `.hide` ban button); a 15s auto-refresh toggle; **Карта (Map)** → Leaflet geo-map of connections |
| **Config editor** | XL modal, CodeMirror, file dropdown, save/cancel/reload/default/merge/backup |
| **Mod manager** | Workshop cards (title, description, mod id, updated date, update/delete buttons) |
| **Player ban form** (`#player_ban`, shared) | `#player_ban-reason` select (grouped reasons, e.g. `<strong>0.1.</strong> Другое`, `0.2. Cheater neutralized by DPAC`), a dynamically-added "Навсегда (Forever)" option, progressive ban-length radios (`data-action=kick\|ban`, `data-first/second/third/four` day tiers), `#player_ban-description` |
| **Player message form** (`#player_message`, shared) | 512-char textarea, "add to player card" toggle, cadence select |
| **Group change select** (shared, `changeGroup`) | `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (Camera), `5` Стажёр (Trainee) |
| **Map calendar** / **Server monitor** / **Online** | FullCalendar/Chart.js views over the monitoring actions above |

**Validation observed:** broadcast requires ≥2 chars; RCON exec requires non-empty trimmed command; nearly every destructive action is wrapped in a `$.question` confirm dialog (many with a typed "confirm word" via `daPrevent`).

---

### 6. Permission & Visibility Logic

- **`data-hide="offline"`** blocks (player board, map widget) are hidden whenever the server is not connected; replaced by the start block / update log.
- **`class="hide"`** gates several capabilities regardless of connection state: the **Техника (Vehicles)** tab, the **Ban IP** button in the network modal, and most config-editor **backup/merge/default** controls. These are latent features enabled per-role server-side.
- **`getRotation` returns `canEdit`** — when false the rotation textarea becomes readonly and the save/cancel buttons hide, i.e. rotation *view* is broader than rotation *edit*.
- **Group taxonomy** (from `changeGroup` options) reveals the role model: Администратор > Модератор > VIP > Камера (spectator/camera) > Стажёр (trainee).
- All gating is presentational; the authoritative permission check is server-side in each `/ajax/*.php` action (the client simply hides controls the current role shouldn't invoke).

---

### 7. Notable UX & Competitively Interesting Details

1. **Everything on one screen, 5s live.** Multi-server tabs with inline online/queue/admin badges + a global-online market-share figure. The whole board self-refreshes without page reloads.
2. **Rich per-player threat signals inline.** VAC-recent, >3 punishments, same-IP alt detection (`location.same` with a count badge), new-player (<30h), active admin-call/report/banned-IP flags — all as small icons directly on the live roster, with a documented legend panel. Strong anti-cheat/anti-alt affordance worth beating.
3. **Squad intelligence.** Per-squad avg/median playtime, creator crown, "created squad then left" indicator, lock state, CMD detection with auto-sorting to top.
4. **Map configurator, not just a picker.** Faction + unit selection with live tickets, kit icons, and vehicle respawn/delay preview, producing the exact RCON layer string — far beyond a plain map dropdown.
5. **Rotation as code, per weekday.** Editable newline-delimited rotation lists per day (default + Mon–Sun), with comment support and a win-based mode.
6. **Raw RCON console with a full command dictionary + typeahead** — power users get the entire Squad admin command set (incl. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`) even where no button exists; JSON responses are auto-pretty-printed in CodeMirror.
7. **DDoS awareness built in.** Live connection count with an auto-triggered "server under attack" banner (>300 conns), a per-IP connection breakdown with geolocation (country/city + speeds), a Leaflet world-map of connections, and a one-click firewall **blockIP**.
8. **Deep hardware telemetry** beside game state: CPU load, network, disk, frequency, temperature, TPS, and socket-count mini-charts, plus a full `serverMonitor` time-series drill-down.
9. **Admin & booster presence timelines** (FullCalendar) per server — accountability/coverage tracking.
10. **Operational polish:** scheduled/repeating squad & player messages with `{player}` templating, config editor with backups/merge, mod manager wired to Steam Workshop, deep-link sharing (`/?steam_id=`, `/?server_id=`, `/?start_seed=true`), clipboard helpers for teleport commands and pre-formatted cheater-report templates.

---

### 8. Gaps / Notes for Analysts

- **Seeding controls** (`seeding`, `seedingSet*`) referenced by the dashboard only via `seedHelper.open()` and an `isSeeding` pulse indicator; the seeding-helper modal itself and its actions live in the shared/global template (see `player_profile.html`), not in this fragment.
- **`createSquad`** is *not* present in `main.html` despite being in scope — no create-squad action is wired here (only disband/transfer/rename/demote/message on existing squads).
- The **Vehicles** tab and per-vehicle board are fully templated but `.hide`-gated and commented-out in the render path — appears to be an in-progress/disabled feature.
- The **Leaflet** map on this page is used for **network-connection geolocation**, not the game map (the game "map" widget is a static image + layer metadata). OSM tiles are loaded lazily on first open.
- Exact server-side role→capability matrix is not visible client-side; only the presentational gates (`hide`, `canEdit`, `block_start.code`) are observable.
