## 01. Server Dashboard & RCON Control

> Competitive functionality analysis of SQSTAT (`breaking.sqstat.ru`). This section documents the **main per-server control panel** — the largest page fragment (~332 KB rendered `#content`) and the operational heart of the panel. Everything an admin does to a live Squad server happens here. The **Live API Contracts** subsection below is captured ground truth: a headless authenticated browser rendered `/?server_id=1` and recorded the app's own auto-load AJAX (read-only; zero mutations fired — see `_blocked.json` = `[]`).

Capture provenance: `caps/dashboard/__server_id_1.network.json` (contracts), `caps/dashboard/__server_id_1.content.html` (rendered fragment), `caps/dashboard/__server_id_1.png` (screenshot). 1 live contract captured (`squad.getServer`), 0 blocked mutations.

---

### 1. Purpose & Navigation

| Attribute | Value |
|---|---|
| Nav location | `main` (default landing page) |
| Loader | `pageLoad('main')` → `GET /ajax/page.php?page=main` → fragment injected into `#content` |
| Deep links | `/?server_id=<id>` (open a specific server tab), `/?steam_id=<id>` (auto-open player modal), `/?start_seed=true` (auto-open the seeding helper) |
| Primary RPC script | `squad` → `POST /ajax/squad.php` (nearly all live-control actions) |
| Secondary scripts | `public` (rotation read / map calendar / auth), `player` (shared player-modal actions), `table` (DataTables server side) |

**Layout.** A single full-width row split into:
- **Left ~75% (`col-md-9`, `data-hide="offline"`):** live player/squad board, tab strip **Игроки (Players → `#players`)**, **Техника (Vehicles → `#vehicles`, `.hide`-gated)**, **Очередь (Queue → `#queue`)**, **Отключившиеся (Disconnected → `#disconnected`)**.
- **Right ~25% (`col-md-3`):** the control sidebar — collapsible **Управление (Control)** and **Состояние (State/monitoring)** panels, an **Онлайн (Online)** gauge + chart, a live **Чат (Chat)** feed with a broadcast input, a **Карта (Map)** widget (current/next map, rotation, calendar), and a **legend for player markers**.

**Server tabs.** A `#servers` strip lists every server as `<a data-server="<id>" data-toggle="tab">`. In the live capture the account can see server ids `1, 6, 7, 9, 10, 11`. Each tab carries live badges refreshed on the 5 s `getServer` poll:

| Badge attr | Source field | Rendering |
|---|---|---|
| `data-type="badge_online"` | `servers[id].players` | `players/100` (or `OFF` + `.bg-important` when down) |
| `data-type="badge_queue"` | `servers[id].queue` | `+N` (hidden when 0) |
| `data-type="badge_admins"` | `servers[id].admins` | admin headcount |
| `data-type="you_play"` | `you` (SteamID) | `fa-user text-danger` prepended on the tab where *you* are playing |

Header globals: **global online** rendered `N (percent%)` from `global_online`; a **Squad sale** banner when `is_sale != 0`; a **seeding** pulse when `isSeeding == true`.

---

### 2. Live API Contracts

> This is the authoritative endpoint spec, built directly from the captured schema. All requests are `POST /ajax/<script>.php` with an `application/x-www-form-urlencoded` body. The client's `Action()` helper (see §2.4) serializes an object `data` map by **raw concatenation** `&<key>=<value>` with `action=<action>` appended — values are **not** URL-encoded by the helper, so callers pre-encode any value containing `&`/`=`/spaces themselves (e.g. `encodeURIComponent(map)`).

#### 2.1 `getServer` — live server-state poll (CAPTURED)

The only auto-load read on this page. Polled every **5000 ms** for the active tab.

**Endpoint:** `POST /ajax/squad.php`
**Captured request body:** `&server_id=1&last_chat_id=false&action=getServer`

| Param | Type | Required | Meaning |
|---|---|---|---|
| `server_id` | int | Y | Active server tab id |
| `last_chat_id` | int \| `false` | Y | Chat delta cursor. `false` on first poll → full chat tail; thereafter the highest `chat[].id` seen, so each poll returns only new messages |
| `action` | const | Y | `getServer` |

**Response** `application/json; charset=utf-8`. Root envelope (`text`):

| Field | Type | Meaning |
|---|---|---|
| `status` | enum `"ok"`\|err | `Action()` runs `success` only when `== "ok"` |
| `exec_time` | float | Server render time (s) |
| `test` | object | Per-stage timing telemetry: `getAdmin`, `queue`, `stat`, `post`, `chat` — floats (seconds); `queue` also carries a unix-seconds float marker |
| `server` | object | The full server-state object (see 2.1.1) — drives `showServer()` |
| `you` | str(SteamID) \| `false` | Your SteamID if you are currently in *this* server, else `false` |
| `servers` | map<id, {players:int, admins:int, queue:int}> | Per-server tab badge counts for every visible server |
| `ips` | map<ip, str> | IP → count of active players sharing it (alt-detection source; redacted example `{"46.174.48.77":"4"}`) |
| `panelAdmins` | array<{name:str, steam_id:str, online:bool}> | Panel admins assigned to this server + presence |
| `global_online` | int | Total tracked Squad players worldwide (market-share numerator) |
| `is_sale` | int (0/1) | Steam Squad discount active flag |
| `isSeeding` | bool | Seeding-helper active pulse |
| `discord` | array | Linked Discord voice/presence rows (empty in capture) |

##### 2.1.1 `server` object (live field spec)

| Field | Type | Meaning / notes |
|---|---|---|
| `map` | str | Current layer display name, e.g. `"Sumari Seed v1"` |
| `nextMap` | str | Queued next layer; `""` when none set |
| `map_start` | str(unix-sec) | Epoch when current layer started |
| `players.active[]` | array | Live roster — see 2.1.2 |
| `players.dis[]` | array | Recently disconnected (same row shape; empty in capture) |
| `squads[]` | array | Live squads — see 2.1.3 |
| `teams[]` | array<{id, name, unit, short}> | 2 entries; `short` faction code (e.g. `WPMC`) drives banner `/assets/img/teams/<short>_bg.jpg`; `unit` e.g. `CombinedArms` |
| `server` | str | Server letter designator, e.g. `"A"` |
| `isConnect` | bool | RCON/bot connected → full board vs "Нет подключения" |
| `block_start` | bool \| {msg, code} | `false` normally; object blocks the Start button. `code == 4` → server mid-update, render `update_log` in `<pre>` |
| `update_log` | str | Live update stdout (shown when `block_start.code == 4`) |
| `need_restart` | bool | Pending-restart flag (config changed) |
| `outdated` | bool | Bot version outdated → "Обновить бота" banner |
| `eos_problem` | bool | EOS backend degraded → banner |
| `last_restart` | {day,month,year,hour,minute,seconds,ms,unix} | All **strings**; `unix` = epoch seconds |
| `bot_start` | {…same shape} | Bot process start time |
| `start_params` | {ip, port, query} | Bound IP / game port / Steam-query port; each `false` when unset, else value |
| `beacon_port` | str | RCON beacon port, e.g. `"15000"` |
| `region` | str | EOS region, e.g. `"eu-west-2"` |
| `pings` | map<region, str-ms> | EOS filter ping per region (9 regions: `ap-east-1`, `ap-southeast-1/2`, `eu-central-1`, `eu-north-1`, `eu-west-2`, `me-central-1`, `us-east-1`, `us-west-1`) |
| `eos_online` | str | EOS-monitored online count |
| `license` / `license_valid` | str / bool | License id + validity |
| `squad_version` | {version:str, build:str} | Game server version, e.g. `10.5.1` / `627303` |
| `version` | str | Panel/bot agent version, e.g. `"1.2.9a"` |
| `vote` | {isVote:bool, votes:{yes:[],no:[]}, map:str, mode:enum} | In-game map vote; `mode` ∈ `skip`\|`next`\|`current` |
| `queue_list[]` | array | Players waiting in queue (empty in capture) |
| `flags[]` | array | Server-level flags/warnings |
| `calculateOnline` | map<teamId, {time, avg, sl, median, squads:map<sqId,{avg,median}>}> | Per-team & per-squad playtime aggregates as **pre-formatted RU strings** (e.g. `"1,576ч 7м"`); `sl` = squad-leaders' avg |
| `stat.online` | {date[], players[], admins[], queue[]} | Parallel arrays (62 samples in capture) for the online mini-chart; `date` = `"HH:MM"` labels |
| `stat.maps[]` | array<{map, start(unix-str), end:bool\|unix, t1, t2, id:bool\|int}> | Recent played layers with faction shorts `t1`/`t2` |
| `monitor[]` | array (60) | Hardware time-series — see 2.1.4 |
| `chat[]` | array | Chat feed delta — see 2.1.5 |
| `playtime` | str | Your current session length (RU formatted) |
| `time` | {work:float, current_time:str, prev_time:str} | Server clock; `*_time` = `"DD.MM.YYYY HH:MM:SS"` |
| `joinlink` | bool \| str | Steam `connect` deep-link when available |

##### 2.1.2 `players.active[]` row (live)

| Field | Type | Meaning |
|---|---|---|
| `id` | str | In-server player slot id (e.g. `"11"`) |
| `steam_id` | str(17) | SteamID64 — row key `data-id`, target of every player action |
| `eos_id` | str(32) | Epic Online Services id |
| `name` | str | Display name |
| `team` | str `"1"`\|`"2"` | Team |
| `squad` | bool \| str-id | `false` = unassigned; else squad id |
| `leader` | bool | Is squad leader |
| `kit` | str | Raw kit token (e.g. `WPMC_LAT_01`); regex-reduced to base kit → `/assets/img/ico/kits/<kit>.svg` |
| `ip` | str | Player IP (used with root `ips` map for same-IP alt count) |
| `isAdmin` | bool | Player is a panel admin |
| `color` | bool \| str-hex | Clan-tag color; `false` or hex rendered `<code style="color:#…">` |
| `mark` | int | Watch/flag level (`0` = none) → row `.player_mark` |
| `warning` | bool | >3 punishments → `fa-user-secret` badge |
| `vac` | bool | Steam/VAC ban within 100 days → Steam icon |
| `baby` | bool | New player (<30 h) → baby icon |
| `playtime` | {date:int, last_seen:int} | **Unix milliseconds**: session start + last-seen |
| `requests` | {admins:bool, report:bool} | Live admin-call / report indicators |
| `location` | {iso:str(2), country:str, city:str} | Geo (e.g. `RU` / `Россия` / `Chita`) → flag + tooltip |

> Fields the earlier draft listed (`state`, `in_vehicle`) are **not present** in the live active-player row for this server; vehicle occupancy is templated (`data-template="vehicle"`) but the Техника tab is `.hide`-gated (see §6).

##### 2.1.3 `squads[]` row (live)

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Squad number (badge) |
| `name` | str | Squad name (clearable via `rename`) |
| `team` | str `"1"`\|`"2"` | Owning team |
| `size` | str | Member count, rendered `size/9` |
| `locked` | bool | Locked squad → lock icon |
| `cmd` | bool | Has a Commander → star icon; CMD squads sort to top |
| `create_id` | str(SteamID) | Creator SteamID64 (crown icon) |
| `create_name` | str | Creator display name |
| `eos_id` | str(32) | Creator EOS id |
| `message` | bool | Pending scheduled squad-message |

##### 2.1.4 `monitor[]` sample (hardware telemetry)

Each `{date:str(unix-sec), data:{…}}`:

| `data` key | Type | Meaning |
|---|---|---|
| `pid` | str | Server process id |
| `mem` | str | RSS memory (GB) |
| `network` | {send, receive, format, connections:int} | Throughput (`format` unit e.g. `"Mb"`); `connections` drives the "under attack" banner when > 300 |
| `cpu` | array<int> | Per-core / aggregate CPU load % |
| `disk` | {read, write} | Disk MB/s |
| `freq` | array<str> | Core frequency (GHz) |
| `temp` | array<int> | Core temperature (°C) |
| `tps` | str | Server tick rate |

##### 2.1.5 `chat[]` delta row

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Monotonic chat id → next poll's `last_chat_id` cursor |
| `server_id` | str | Origin server |
| `steam_id` | str | Author SteamID64 |
| `name` | str | Author name |
| `team` | str | Faction short (e.g. `MEI`) |
| `type` | enum | Channel: `ChatAll`, `ChatTeam`, `ChatSquad`, `ChatAdmin`, command (`!stats`) etc. |
| `date` | str(unix-sec) | Timestamp |
| `msg` | str | Message body (commands like `!stats` visible) |
| `group_id` | str | Author admin-group id |
| `type_format` | {name, color(hex), icon(fa-\*)} | Channel badge styling (e.g. `ChatAll` → `#00C3FF` / `fa-globe`) |
| `color` | str-hex | Author name color |

**Redacted example row:** `{ "id":"800848","server_id":"1","steam_id":"<redacted:17>","name":"<redacted:10>","team":"MEI","type":"ChatAll","date":"1783145247","msg":"!stats","group_id":"5","type_format":{"name":"<redacted:4>","color":"#00C3FF","icon":"fa-globe"},"color":"#..." }`
Cite: `caps/dashboard/__server_id_1.network.json`.

#### 2.2 Reads fired on user interaction (not auto-loaded, so not in the capture)

These only fire when the corresponding modal/panel is opened, so the read-only capturer (which performs no clicks) did not record them. Shapes below are from `main.html` render code and prior analysis — flagged as **inferred**, not captured.

| Action | Script | Params | Returns (inferred) | Destructive |
|---|---|---|---|---|
| `getRotation` | squad | `server_id` | `{rotation:{lists:map<day,str>, current, isWin:bool}, list, canEdit:bool}` | N |
| `getServerMaps` | squad | `server_id` | `{maps[], units[]}` map picker catalog | N |
| `serverMonitor` | squad | `start`, `end`, `server_id` | time-series: mem, network_send/receive, disk_read/write, tps, network_connections | N |
| `serverOnline` | squad | `start`, `end`, `server_id` | `{players[], admins[], queue[], days[], maps{}}` | N |
| `serverOnlineAdmins` | squad | `day`, `server_id` | `{events, resources}` admin presence timeline | N |
| `serverOnlineBooster` | squad | `day`, `server_id` | `{events, resources}` booster timeline | N |
| `network` | squad | `server_id` | `{network:{ips:map<ip,{conn[],country,city}>, sockets[]}}` | N |
| `mapCalendar` | public | `server_id`, `start`, `end` | played-maps calendar | N |
| `getConfigFiles` / `getConfigFile` | squad | `server_id` / file | config file list / contents | N |
| `getDefaultConfig` | squad | file | default template | N |
| `getMods` | squad | `server_id` | installed Workshop mods | N |

#### 2.3 Server tables (`script: 'table'` — DataTables server-side)

The dashboard's own Queue/Disconnected/roster panels render from the `getServer` payload directly (client-side), not via `table.php`. The `table` script backs the paginated grids on sibling pages (players, bans, chat, …). Live table headers observed in the rendered fragment:

| Panel | Column headers (RU → EN) |
|---|---|
| Отключившиеся (Disconnected) | `SteamID`, `Имя` (Name), `Время` (Time) |
| Очередь (Queue) | `Позиция` (Position, w80), `EOS` (id, w160), `Имя` (Name), `Время` (Time, w100) |
| Чат (Chat feed) | `Дата` (Date, w120), `Чат` (Channel, w80), `Сообщение` (Message) |

#### 2.4 `Action()` request serializer (from `custom.js`)

`Action({script, action, data, …})` → `$.ajax({ url:'/ajax/'+script+'.php', type:'POST' })`.

| data form | Serialization |
|---|---|
| `FormData` | appends `action`; `contentType:false` (multipart, used for uploads) |
| plain object | `$.map(data, (v,i)=>'&'+i+'='+v).join('')` then `+= action` — **no URL-encoding**; callers must pre-encode |
| string | `"action="+action+data` |

Cross-cutting flags: `retryAbort:true` aborts any in-flight request of the same `name` before firing; `pageAbort:true` cancels on navigation; `connectCheck:true` short-circuits when offline. Success gate: `text.status == 'ok'`, else `error(msg)` → `addAlert(msg,'exclamation-triangle')`.

---

### 3. Polling & State Machine

The page polls `squad.getServer` every **5000 ms** for the active tab, advancing `last_chat_id` each cycle.

Server display states (from `server.isConnect` / `server.block_start`):

| Condition | UI behavior |
|---|---|
| `isConnect === true` | Full board shown; control buttons enabled |
| `!isConnect && block_start === false` | "Нет подключения (No connection)"; **Включить (Turn on)** button shown |
| `block_start` is object | Shows `block_start.msg`; Start button hidden. `block_start.code == 4` → renders `update_log` in a `<pre>` (server mid-update) |

Alert banners (each `display:none` until triggered):
- **Версия бота неактуальна (Bot outdated)** when `outdated == true` — inline **Обновить бота (Update bot)** link (`botUpdate`).
- **Проблемы с EOS backend** when `eos_problem == true`.
- **На сервер идёт атака (Under attack)** when any `monitor[].data.network.connections > 300` — shows connection count + **Открыть подключения (Open connections)** (`network`).
- **Скидка на Squad** when `is_sale != 0`.

---

### 4. Actions / Admin Capabilities

All POST to `/ajax/<script>.php` with body `action=<id>&<params>`. "Destructive" = mutates live server/game state (⇒ these equal the permission surface). Params are the object keys passed to `Action({data:{…}})`.

#### 4.1 Server lifecycle — Управление (Control) panel — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Включить (Turn on) | `start` | `server_id`(int) | Boots the game server (confirm) | Y |
| Выключить (Turn off) | `stop` | `server_id`(int) | Shuts the server down | Y |
| Рестарт (Restart) | `restart` | `server_id`(int) | Restarts the game server | Y |
| Обновить (Update) | `update` | `server_id`(int), `afterMapChange`(bool) | Updates server; optionally defers to next map change | Y |
| RCON | `rconRestart` | `server_id`(int) | Restarts the RCON connection | Y |
| Parser | `parserRestart` | `server_id`(int) | Restarts the log parser | Y |
| (Steam Query) | `cacherRestart` | `server_id`(int) | Restarts the Steam-query cacher | Y |
| Обновить бота (Update bot) | `botUpdate` | *(none)* | Updates the sqstat bot agent | Y |
| (IP select) | `setServerIP` | `server_id`(int), `ip`(str) | Rebinds server IP (effective after restart) | Y |

Confirmation dialogs (`$.question`) gate start/stop/restart/update/rcon/parser/cacher/botUpdate. `blockServerButtons()` disables the four lifecycle buttons while an op is in flight.

#### 4.2 Player control (live-server, scoped by `server_id`) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Кик (Kick) | `kick` | `steam_id`(str), `reason_id`(int), `description`(str), `noReason`(bool) | Kicks player; `noReason:true` skips reason | Y |
| Бан (Ban) | `ban` | `server_id`(int), `steam_id`(str), `reason_id`(int), `description`(str), `days`(int) | Bans player (`days=0` → permanent) | Y |
| Разбан (Unban) | `unban` | `steam_id`(str), `unban`(bool) | Removes ban; `unban:true` fully wipes the record | Y |
| Убить (Kill) | `kill` | `server_id`(int), `steam_id`(str) | Kills player in-game | Y |
| Сменить команду (Change team) | `changeTeam` | `server_id`(int), `steam_id`(str) | Force team-swap | Y |
| Исключить из сквада (Remove from squad) | `removePlayer` | `server_id`(int), `steam_id`(str) | Removes from squad without kicking | Y |

> **Shared modal note:** the player-detail modal (tabs Chat/Kills/Deaths/Kits/Games/Comments; actions `mark`, `message`, `twink`, `twinkOnline`, `findFriends`, `addComment`, `getComments`, `changeGroup`, `kits`, `kitSave`, `checkBans`, `addBanName`, `removeBanName`, `get`, `downloadStat`, `getPlayerOnlineData`) is embedded on every page on `script: 'player'` — not owned by the dashboard. Only the six `server_id`-scoped actions above are dashboard-specific. `copyTeleport()` copies `AdminTeleportToPlayer <steam_id>` to the clipboard.

#### 4.3 Squad control (per-squad row buttons) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Расформировать (Disband) | `disband` | `server_id`(int), `team`(str), `squad`(str) | Disbands the squad (confirm) | Y |
| Сменить сторону (Transfer) | `transfer` | `server_id`(int), `team`(str), `squad`(str) | Moves whole squad to other team (confirm) | Y |
| Сбросить название (Clear name) | `rename` | `server_id`(int), `team`(str), `squad`(str) | Clears the squad name (confirm) | Y |
| Снять CMD (Demote) | `demote` | `server_id`(int), `steam_id`(str, leader) | Strips Commander (confirm) | Y |
| Сообщение скваду (Squad message) | `squadMessage` | `server_id`(int), `team`(str), `squad`(str), `time`(int), `msg`(str) | Repeating in-game message to the squad | Y |

Per-squad button row is `data-type="buttons"`; each squad table gets `data-leader=<steam_id>`; `data-type="squadMessage"` marks the envelope trigger; `data-type="avg"`/`data-type="median"` cells bind `calculateOnline` playtime aggregates.

#### 4.4 Messaging & broadcast — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Broadcast (chat input) | `broadcast` | `server_id`(int), `msg`(str) | Server-wide broadcast (min 2 chars; confirm) | Y |
| Сообщение скваду | `squadMessage` | see 4.3 | Targeted squad message with repeat cadence | Y |

Repeat-cadence `<select>` (shared by squad- and player-message forms): `1` = 1 раз (once), `30` = 30 s, `40` = 40 s, `60` = 1 min (**default**), `90` = 1 min 30 s, `120` = 2 min. The squad-message modal shows the author SteamID + Steam profile link and a `{player}` placeholder expanding to the creator name.

#### 4.5 Map & rotation — `script: 'squad'` (rotation read/write via `mapRotation.mode`, `'squad'` when opened from the dashboard cog)

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Сменить (Change map) | `changeMap` | `server_id`(int), `next`(bool), `map`(str, URI-encoded layer), `vote`(bool) | Changes current (or next) map | Y |
| Следующая (Set next) | `changeMap` | `server_id`(int), `next:true`, `map`(str), `vote`(bool) | Sets the next map only | Y |
| (Skip / next round) | `changeMap` | `server_id`(int), `next:'skip'`, `map:'skip'`, `skip:true`, `vote`(bool) | Ends current round / skips map | Y |
| Очистить следующую (Clear next) | `clearNext` | `server_id`(int) | Clears the queued next map | Y |
| (Load map catalog) | `getServerMaps` | `server_id`(int) | Returns `{maps[], units[]}` for the picker | N |
| Ротация — read | `getRotation` | `server_id`(int) | Returns `{rotation, list, canEdit}` | N |
| Ротация — Изменить (Edit) | `setRotation` | `server_id`(int), `rotation`(str, URI-encoded), `day`(str) | Overwrites rotation for a given day | Y |
| Календарь (Calendar) | `mapCalendar` | `server_id`(int), `start`, `end` | Read-only played-maps calendar (`script: 'public'`) | N |

**Map picker (`mapSelect`).** The `getServerMaps` catalog feeds a filterable grid — multiselects **Карта (`#map-name`)**, **Режим (`#map-type`)**, **Команды (`#map-team`)** each with a live count, plus free-text **Сменить по названию (`#changemap-custom`)**. Selecting a map opens a **configurator**: per-team faction `<select>` + unit `<select>`, live **tickets**, and previews of each side's **kits** (role SVGs) and **vehicles** (name, count, respawn `respawn/60`, optional delay). It assembles the RCON layer string as `<Map> <T1faction>+<T1unit> <T2faction>+<T2unit>`.

**Map entity** (`getServerMaps.maps[]`): `map`, `type` (RAAS/AAS/Invasion/…), `weather`, `markers`, `teams.t_1|t_2 = {tickets, default:{faction,unit,prefix,postfix}, factions[]:{name, default, units[]}}`. **Unit entity** (`units[]`): `{roles[], vehicles[]:{name, count, respawn, delay}}`.

**Rotation entity** (`getRotation`): `rotation.lists[day]` (newline-delimited layers; `//` comments ignored), `rotation.current` (active day), `rotation.isWin` (win-based → hides day tabs), `canEdit`. Days keyed `default`, `1`–`7` (Mon–Sun) → tabs Стандартная / Пн–Вс.

#### 4.6 Monitoring & analytics — `script: 'squad'` (calendar via `public`)

| UI label | action | data keys (type) | Returns | Destructive |
|---|---|---|---|---|
| Подробнее (Details) | `serverMonitor` | `start`, `end`, `server_id`(int) | mem, network_send/receive, disk_read/write, tps, network_connections series | N |
| Онлайн chart | `serverOnline` | `start`, `end`, `server_id`(int) | `{players[], admins[], queue[], days[], maps{}}` | N |
| Онлайн — Админы | `serverOnlineAdmins` | `day`, `server_id`(int) | `{events, resources}` per-admin presence timeline | N |
| Онлайн — Бустеры | `serverOnlineBooster` | `day`, `server_id`(int) | `{events, resources}` | N |
| Подключения (Connections) | `network` | `server_id`(int) | `{network:{ips:map<ip,{conn[],country,city}>, sockets[]}}` | N |
| (Ban IP, in network modal) | `blockIP` | `ip`(str) | Firewall-blocks an IP (confirm; button `.hide`-gated) | Y |

> The dashboard's own online mini-chart is fed inline from `server.stat.online` (see 2.1.1) — these `serverOnline`/`serverMonitor` actions back the full drill-down modals.

#### 4.7 Raw RCON console — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Выполнить (Execute) | `rconRaw` | `server_id`(int), `command`(str, URI-encoded) | Runs any raw RCON command; response in read-only CodeMirror (auto-pretty-prints JSON) | Y (command-dependent) |

Ships a **built-in command dictionary with autocomplete** (typeahead over names + RU help): `AdminKick`, `AdminKickById`, `AdminBan`, `AdminBanById`, `AdminBroadcast`, `AdminEndMatch`, `AdminChangeMap`, `AdminSetNextMap`, `AdminSetMaxNumPlayers`, `AdminSetServerPassword`, `AdminSlomo`, `AdminForceTeamChange(ById)`, `AdminListDisconnectedPlayers`, `AdminDemoteCommander(ById)`, `AdminDisbandSquad`, `AdminRemovePlayerFromSquad(ById)`, `AdminWarn(ById)`, `AdminRestartMatch`, `AdminReloadServerConfig`, `ListPlayers`, `ListSquads`, `ShowServerInfo` — each with a usage example. Exposes the full Squad admin surface even where no dedicated button exists (`AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`).

#### 4.8 Config & mod management (from the Control panel) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Редактор конфигов | `getConfigFiles` / `getConfigFile` | `server_id`(int) / file(str) | List / load config files | N |
| " → Сохранить (Save) | `saveConfigFile` | file(str), contents(str) | Writes a config file | Y |
| " → Перезагрузить (Reload) | `reloadConfig` | `server_id`(int) | Reloads server config in-game | Y |
| " → По-умолчанию (Default) | `getDefaultConfig` | file(str) | Loads the default template | N |
| Менеджер модов (Mod manager) | `getMods` | `server_id`(int) | Lists installed Workshop mods | N |
| " → Install | `installMod` | mod id(str) | Installs a Workshop mod | Y |
| " → Delete | `deleteMod` | mod id(str) | Removes a mod | Y |

Config editor also has (mostly `.hide`-gated) **backup create/delete** and **merge/rebuild** controls plus a **синхронизировать скролл** toggle for side-by-side diff editing.

---

### 5. Forms & Modals

| Modal / form | Key fields (`#id` / name / type / rule) |
|---|---|
| **Смена карты (Map select)** | `#map-name`, `#map-type`, `#map-team` multiselects; `#changemap-custom` free-text; thumbnail grid; configurator with per-team faction/unit selects, ticket counts, kit/vehicle preview, assembled layer string (readonly), **Сменить** button |
| **Ротация карт (Rotation)** | Day tabs (default/Пн–Вс); scrollable layer list with faction flags; **Изменить (Edit)** → textarea (readonly unless `canEdit`) |
| **Сообщение скваду (Squad message)** | Author SteamID/link; message `<textarea>`; repeat-cadence select (default `60`); template quick-inserts with `{player}` |
| **RCON консоль** | Command input + `<datalist>` + live search dropdown; **Выполнить**; CodeMirror read-only output (80vh) |
| **Подключения (Network)** | Tabs Подключения/Сокеты; per-IP cards (rank, IP, conn count, up/down speed, geo country+city, external-lookup link, `.hide` ban button); 15 s auto-refresh toggle; **Карта** → Leaflet geo-map |
| **Config editor** | XL modal; CodeMirror; file dropdown; save/cancel/reload/default/merge/backup |
| **Mod manager** | Workshop cards (title, description, mod id, updated date, update/delete) |
| **Player ban form** (`#player_ban`, shared) | `#player_ban-reason` grouped select (e.g. `0.1. Другое`, `0.2. Cheater neutralized by DPAC`); dynamic "Навсегда (Forever)" option; progressive ban-length radios (`data-action=kick|ban`, `data-first/second/third/four` day tiers); `#player_ban-description` |
| **Player message form** (`#player_message`, shared) | 512-char textarea; "add to player card" toggle; cadence select |
| **Group change select** (shared, `changeGroup`) | `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера, `5` Стажёр |
| **Map calendar / Server monitor / Online** | FullCalendar / Chart.js views over the monitoring actions above |

**Validation observed:** broadcast requires ≥2 chars; RCON exec requires non-empty trimmed command; nearly every destructive action is wrapped in a `$.question` confirm (many with a typed "confirm word" via `daPrevent`).

---

### 6. Permission & Visibility Logic

- **`data-hide="offline"`** blocks (player board, map widget) hide whenever `server.isConnect == false`; replaced by the start block or `update_log`.
- **`class="hide"`** gates capabilities regardless of connection: the **Техника (Vehicles)** tab (`data-template="vehicle"` exists but tab is `.hide`), the **Ban IP** button in the network modal, and most config-editor backup/merge/default controls. Latent features enabled per-role server-side.
- **`getRotation.canEdit`** — when false the rotation textarea is readonly and save/cancel hide; rotation *view* is broader than *edit*.
- **`panelAdmins[]`** in the live payload enumerates which admins are assigned to this server (and their `online` flag) — the accountability roster.
- **Group taxonomy** (from `changeGroup`): Администратор > Модератор > VIP > Камера (spectator) > Стажёр (trainee).
- All gating is presentational; the authoritative permission check is server-side in each `/ajax/*.php` action.

---

### 7. Notable UX & Competitively Interesting Details

1. **Everything on one screen, 5 s live.** One `getServer` poll hydrates the entire board — roster, squads, chat delta (cursor-paged), tab badges, global online, hardware telemetry, and playtime aggregates — with no page reloads.
2. **Rich per-player threat signals inline.** `vac` (VAC ≤100 d), `warning` (>3 punishments), same-IP alt detection (root `ips` map + `location`), `baby` (<30 h), live `requests.admins`/`requests.report` — all small icons on the live roster with a legend panel.
3. **Squad intelligence.** `calculateOnline` ships per-team and per-squad avg/median/SL playtime as ready-to-render strings; creator crown (`create_id`), lock (`locked`), CMD auto-sort (`cmd`).
4. **Map configurator, not just a picker.** Faction+unit selection with live tickets, kit icons, vehicle respawn/delay, producing the exact RCON layer string.
5. **Rotation as code, per weekday.** Editable newline-delimited lists per day (default + Mon–Sun) with `//` comments and a win-based mode.
6. **Raw RCON console with a full command dictionary + typeahead** — entire Squad admin set incl. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`; JSON auto-pretty-printed in CodeMirror.
7. **DDoS awareness built in.** `monitor[].data.network.connections` drives an auto "under attack" banner (>300); per-IP breakdown with geolocation and speeds; Leaflet world-map; one-click firewall `blockIP`.
8. **Deep hardware telemetry** beside game state: CPU/freq/temp per core, network, disk, TPS mini-charts, plus a full `serverMonitor` drill-down.
9. **Admin & booster presence timelines** (FullCalendar) per server for coverage tracking.
10. **Operational polish:** scheduled/repeating squad & player messages with `{player}` templating, config editor with backups/merge, mod manager wired to Steam Workshop, deep-link sharing (`/?steam_id=`, `/?server_id=`, `/?start_seed=true`), clipboard helpers for teleport and cheater-report templates.

---

### 8. Gaps / Notes for Analysts

- **Only `getServer` is captured live.** All modal-triggered reads (`getRotation`, `getServerMaps`, `serverMonitor`, `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster`, `network`, config/mod reads) fire on user interaction; the read-only capturer performs no clicks, so their response shapes in §2.2/§4 are **inferred from render code**, not observed. A follow-up capture that opens each modal would upgrade them to captured contracts.
- **No mutations were fired** (`_blocked.json == []`); every action in §4 is documented from client code + params, never executed.
- The `Action()` helper does **not** URL-encode object-form `data` — any endpoint whose value can contain `&`/`=`/spaces (map layer, rotation body, RCON command, broadcast text) relies on the caller to `encodeURIComponent`. A value with a raw `&` would corrupt the body: a real robustness edge worth probing.
- **Vehicles tab** is fully templated (`data-template="vehicle"`) but `.hide`-gated — in-progress/disabled feature; no `in_vehicle` field appeared on live active-player rows.
- **`createSquad`** is not wired in `main.html` — only disband/transfer/rename/demote/message on existing squads.
- The **Leaflet** map here is for network-connection geolocation, not the game map (the game "map" widget is a static image + layer metadata).
- Exact server-side role→capability matrix is not visible client-side; only presentational gates (`hide`, `canEdit`, `block_start.code`, `panelAdmins`) are observable.
