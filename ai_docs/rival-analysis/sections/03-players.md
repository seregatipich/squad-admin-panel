## 03. Players Directory (Все игроки)

> Canonical reference for the master player list **and** the shared **player-detail modal** that appears on virtually every page of SQSTAT. The modal's tabs, forms and ~25 actions are documented here in full; other sections should cross-reference this file rather than re-document the modal.
>
> **Ground truth:** contracts, schemas, table configs, column sets and payloads in this chapter were captured live (read-only, headless) from `https://breaking.sqstat.ru`. Capture files: `caps/players/players.network.json`, `caps/players/players.content.html`, `caps/players/players.modaltabs.json`.

---

### 1. Purpose & Navigation

- **Nav id / entry point:** `players` → `pageLoad('players')` → `GET /ajax/page.php?page=players`, HTML fragment injected into `#content`. Captured live: `200 text/html; charset=UTF-8`, fragment length ≈ 115 KB.
- **Purpose:** Global searchable directory of every player ever seen across the project's servers (not just those currently online). Live scale observed: **`totalRows = 385 350`** players, `totalPage = 3854` at 100/page. It is the primary entry point to open a player card and perform moderation actions (ban, kick, group change, VIP, mark, message, twink hunt, kit denial, etc.).
- **Layout:** Two-column. Left (`col-md-3 mobile-left`, `position:fixed`) is a search/filter sidebar; right (`col-md-9`) is the results table `#allPlayers`.
- The fragment ALSO embeds the entire shared player-detail modal machinery (`#player_info`, `#player_ban`, `#player_group`, `#player_message`, `#player_twink-modal`, `#player_kits-modal`, `#player_findban-modal`, `#player_map-modal`, and the `.player_comments` drawer). The near-identical `playersOnline.html` reuses the same modal and action set (action catalog: both expose the identical full action set).

---

### 2. Live API Contracts

Every table on the panel — the directory list and all twelve modal sub-tabs — funnels through **one** transport endpoint, `POST /ajax/table.php`. Read/forensic player actions funnel through `POST /ajax/player.php`; live-server (RCON) actions through `POST /ajax/squad.php`.

#### 2.1 `POST /ajax/table.php` — directory list (`action=allPlayers`)

**Request (captured, form-urlencoded body):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id. `allPlayers`. |
| `table` | string | Y | Duplicate of `action` (`allPlayers`). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size. `100` for this table. |
| `search` | JSON (URL-encoded) | Y | Filter object, shape `{text:{}, check:{with_other_names, full_match}, multiselect:{}, managers:{}, slider:{}}`. Each `check` value is the string `"true"`/`"false"`. |
| `order_by` | string\|`false` | Y | DB column alias to sort by, or literal `false` for default. |
| `order_sort` | `asc`\|`desc`\|`false` | Y | Sort direction, or `false`. |
| `pagination` | `true` | N | When present, the request is the **count-only** variant (see 2.2). |

Redacted captured body:
```
action=allPlayers&table=allPlayers&page=1&numrows=100
&search=%7B%22text%22%3A%7B%7D%2C%22check%22%3A%7B%22with_other_names%22%3A%22false%22%2C%22full_match%22%3A%22false%22%7D%2C%22multiselect%22%3A%7B%7D%2C%22managers%22%3A%7B%7D%2C%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

**Response** (`200 application/json; charset=utf-8`), captured schema:

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 on the data request — the real count comes from the paginate request, 2.2). |
| `data.totalRows` | int | Row count (0 on the data request; real value from 2.2). |
| `data.currentPage` | string | Echoed page index (string, e.g. `"1"`). |
| `data.row[]` | array | Result rows (length = `numrows`). Per-row schema below. |
| `data.custom` | bool | Whether a custom/manager-scoped query was applied. |
| `data.query_time` | float | Data-query wall time (s) — perf telemetry. |
| `data.count_time` | int/float | Count-query wall time (s). |
| `status` | string | `"ok"` on success. |
| `exec_time` | float | Total server exec time (s). |

**Per-row object `data.row[i]` — document field-by-field (this is the directory record):**

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `steam_id` | string(17) | N | SteamID64, primary identity. Rendered in a `<hashtag>` (click-to-copy). |
| `eos_id` | string(32) | N | Epic Online Services id (Squad's newer identity). **Returned even though it is not a visible column.** |
| `name` | string | N | Current in-game nickname. |
| `date` | string — **unix ts** | N | Last login ("Заходил"). 10-digit seconds. |
| `create_date` | string — **unix ts** | N | First seen ("Создан"). **Returned though not a visible column.** |
| `mark` | string enum `"0".."8"` | N | Suspicion tag (see §5.4). `"0"` = none. Drives a `player_mark` row class. |
| `bonus` | string(int) | N | Accumulated bonus/currency balance. |
| `discord` | string(id) \| `null` | Y | Linked Discord user id, or `null`. |
| `expire` | string — **unix ts** \| `"0"` | N | Privilege-group expiry; `"0"` = none/permanent. |
| `group_id` | string enum `"0".."5"` | N | Current privilege group (0 none, 1 Admin, 2 Moderator, 3 VIP, 4 Camera, 5 Trainee). |

> **Privacy / competitive note:** the list endpoint returns a **denormalized identity+moderation payload per row** (`eos_id`, `create_date`, `mark`, `bonus`, `discord`, `expire`, `group_id`) even though the rendered table shows only `steam_id`, `name`, `date`. A scraper with a valid admin session harvests the full identity graph for all 385 K players from the list endpoint alone.

#### 2.2 `POST /ajax/table.php` — count/pagination variant (`&pagination=true`)

Fired as a **second, parallel** request with the same body plus `pagination=true`. This splits the expensive `COUNT(*)` from the data page for latency. Captured response schema:

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Real page count (captured: `3854`). |
| `totalRows` | string(int) | Real row count (captured: `"385350"`). |
| `count_time` | float | Count-query time (s). |
| `status` | string | `"ok"`. |
| `exec_time` | float | Total exec (s). |

#### 2.3 `POST /ajax/table.php` — modal sub-tab tables

Each modal detail tab (§4.1) is the same endpoint with `action=<tableName>` and an appended `&steam_id=<id>`. Captured page-size `numrows` and `showPages` per table are in §4.1. Response envelope is identical to 2.1 (`data.row[]` + telemetry), with per-tab row columns equal to that tab's `collum` array.

#### 2.4 `POST /ajax/player.php` — read/forensic actions (no live server required)

Payloads captured from the embedded modal script (`players.content.html`). "Destructive" = mutates state.

| action | `data:{...}` (captured) | Response shape (from render code) | Destr. |
|---|---|---|---|
| `get` | `{steam_id}` | `{player: {...}}` — the full player entity (§3). | N |
| `mark` | `{steam_id, mark}` | ack | Y |
| `getComments` | `{steam_id}` | comment list | N |
| `addComment` | `{steam_id, text}` (≤256) | ack | Y |
| `changeGroup` | `{steam_id, group_id, date, description, prefix, prefix_rgb, image}` | ack | Y |
| `message` | `{steam_id, time, msg, log}` | ack | Y |
| `addBanName` | `{name}` | ack | Y |
| `removeBanName` | `{name}` | ack | Y |
| `kits` | `{steam_id}` | `{kits:[...]}` per-kit deny state | N |
| `kitSave` | `{steam_id, kits}` (JSON `{kit:bool}`) | ack | Y |
| `twink` | `{steam_id}` | `{list:[{steam_id, name, perm, min_date, ips:[{loc, date, owner_date}]}]}` (§5.3) | N |
| `twinkOnline` | `{steam_id, compare_steam_id, start, end}` (unix) | `{calendar:[<fullcalendar events>]}` | N |
| `findFriends` | `{steam_id, compare_steam_id}` | `{in_friend: bool}` | N |
| `checkBans` | `{steam_id}` | `{projects:[{name, discord, online, ban:{total, current:{reason, date, expire}}}]}` (§5.6) | N |
| `getPlayerOnlineData` | `{steam_id, start, end}` | online/boost/queue time series | N |
| `downloadStat` | form POST (`post_to_url`), `{action, steam_id}` | file download | N |

**`twink` list row** — `perm: bool` (candidate carries a permanent ban), `min_date: unix-seconds delta` (rendered via `moment.duration(min_date*1000).humanize()`), `ips[]` each `{loc, date(unix), owner_date(unix)}` where the UI shows both accounts' seen-times side by side.

**`checkBans` project row** — `online: seconds` (rendered `secToTime`), `ban.total: int`, `ban.current` present ⇒ active ban with `{reason, date(unix), expire(unix)}`; `expire == "0"` ⇒ "Перманент" (permanent).

#### 2.5 `POST /ajax/squad.php` — live-server (RCON) actions (player must be online)

Payloads captured from the modal script:

| action | `data:{...}` (captured) | Effect | Destr. |
|---|---|---|---|
| `kick` | `{steam_id, reason_id, description, noReason}` | Kick from live server. `noReason:true` = no-rule kick. | Y |
| `ban` | `{server_id, steam_id, reason_id, description, days}` | Ban N days; `days=0` (via permanent radio) / `-1` = permanent. | Y |
| `unban` | `{steam_id, unban}` | Lift ban; `unban:true` fully erases record. | Y |
| `removePlayer` | `{server_id, steam_id}` | Eject from squad/fireteam. | Y |
| `changeTeam` | `{server_id, steam_id}` | Force team swap. | Y |
| `kill` | `{server_id, steam_id}` | Kill in-game. | Y |

> The capture interceptor **aborted zero mutations** (`_blocked.json = []`) because auto-load fires only reads; the mutation payloads above are transcribed from the page's own JS, not executed.

---

### 3. Entity: Player (`player.info`) — the core data model

`player.open(steam_id)` → `Action({script:'player', action:'get', data:{steam_id}})` → `POST /ajax/player.php`. The success handler sets `player.info = text.player` then `player.setInfo()` + `player.stats.init(player.info.stats)`. The returned `player` object is the richest entity in the app. Fields (from `setInfo()` + captured render code):

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | SteamID64 (primary identity). |
| `eos_id` | string | Epic Online Services id. |
| `name` | string | Current nickname. |
| `names[]` | `{name, date}` | Historical nicknames dropdown ("Другие ники"). |
| `date` | unix ts | Last login ("Заходил"). |
| `create_date` | unix ts | First seen ("Создан"). |
| `baby` | bool | "New/young account" flag — red warning icon next to online time. |
| `bonus` | int | Bonus/currency balance ("Бонусы"). |
| `playtime` | `{online, boost, server}` | Aggregate playtime, boost time, favourite server. |
| `mark` | int 0–8 | Suspicion tag (see §5.4). |
| `group` | `{name, color, icon, description}` | Current privilege badge; special art for `QueuePriority` (VIP) / `Moderator`. |
| `group_id`, `expire`, `group_description`, `prefix`, `prefix_rgb`, `image` | mixed | Group-assignment fields consumed by the group form. |
| `ban` | `{expire, reason, admin_name, date, description}` | Active ban → red "забанен" panel + corner ribbon. |
| `bans[]` | `{admin_name, date, reason, description, impact, unban}` | Full punishment history (Наказания tab). `impact`=counts toward escalation; `unban="1"`=reversed. |
| `canBan` | bool | Gates "Наказать", kill, banname, kits. |
| `canUnban` | bool | Gates "Разбанить". |
| `canChangeGroup` | bool | Gates "Группа". |
| `canSelfKick` | bool | Gates "Кикнуть без причины". |
| `is_you` | bool | If true, group select + expire disabled (can't edit self). |
| `name_banned` | bool | Current nick on banned-names list → toggles banname/unbanname items. |
| `vac` | `{ban, days}` | VAC ban status. |
| `steam_info` | `{ban:{vac, ban, days}, squad:{time}}` | Steam enrichment — VAC/game-ban badge + Squad hours. |
| `discord` | string(id) \| false | Discord user id → link to `discord.com/users/<id>`. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history (flag, city, tz, coords, **raw IP**, seen date). First = current. |
| `primetime[]` | `{start, end}` | Typical active hours (unix → HH:mm). |
| `clans[]` | `{clan_id, name}` | Clan memberships (link to `/clan.php?id=`). |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` \| false | Live session — enables message/kill/changeTeam/removePlayer. |
| `stats` | object | Aggregate combat stats (kill, die, revive, winrate, kit, kit_name) for the stat cards. |

Derived/rendered: `kill, die, revive, winrate, kd`, favourite `kit`+`kit_name` (stat cards); an online chart (`getPlayerOnlineData`) with three series **Онлайн / Буст / Очередь** (online minutes / boost / queue).

---

### 4. The Shared Player-Detail Modal (`#player_info`)

Draggable modal. Header shows name, other-nicks dropdown (`#player_info-names`), clan labels (`#player_info-clans`), group/VAC/ban badges (`#player_info-badges`), last-login/created, Steam hours + `<hashtag id="player_info-steam_id">` + Steam link, EOS id, VAC, geo-location (`#player_info-location` + other-locations dropdown → Leaflet map via `player.map.open(lat,lng)`), Discord (`#player_info-discord` + link), primetime, online/bonus/boost tiles, an online activity chart (`#player_info-chart`) with **График / Календарь / По серверам** (Chart / Calendar / Per-server) sub-tabs, a read-only `#player_info-description` textarea (`maxlength=1024`), six stat cards (Winrate `#player_info-winrate`, Kit, K-D, Kills, Deaths, Revives), then a second tab strip of detail tables.

#### 4.1 Detail sub-tabs — server table id + columns + page size (captured buildTable configs)

Each tab lazy-loads on `show.bs.tab`, POSTing to `/ajax/table.php` with `action=<table>` + `&steam_id=<id>`. `numrows` and `showPages` are exact from `players.content.html`.

| Tab (RU / EN) | server table (`action=`) | columns (`collum`) | numrows | showPages |
|---|---|---|---|---|
| Наказания (Bans) | *(from `player.info.bans`; accordion `#player_info_accordion-bans`, not a table call)* | admin, date, reason, description, impact, unban | — | — |
| Варны (Warns) | `playerWarn` | `admin, text, date` (list mode via `#player_info_warn-template`) | 10 | 3 |
| Чат (Chat) | `playerChat` | `server, date, team, type, msg` | 20 | 3 |
| Тимкиллы (Teamkills) | `playerTeamkill` | `server, date, killed, kit` | 10 | 3 |
| Киты (Kits) | `playerKits` | `kit, cnt` | 10 | 3 |
| Сквады (Squads) | `playerSquad` | `server, team, date, squad_id, name` | 10 | 3 |
| Убийства (Kills) | `playerKills` | `server, name, weapon, date` | 10 | 3 |
| Смерти (Deaths) | `playerDeath` | `server, weapon, date` | 10 | 3 |
| Игры (Games) | `playerGames` | `server, map, win, date` | 10 | 3 |
| Поднятия (Revives) | `playerRevive` | `server, name, date` | 10 | 3 |
| Урон (Damage) | `playerDamage` | `server, weapon, name, damage, date` | 10 | 3 |
| Техника (Vehicle) | `playerVehicle` | `server, vehicle, weapon, damage, date` | 10 | 3 |

- **Chat tab** post-processes each `msg` cell: `isObscene(text)` prepends a red warning icon (client-side obscenity flag).
- **Chat `type` column** callback renders `<code style="color:type.color">type.name</code>` — so each row's `type` is an object `{color, name}` (chat channel: All/Team/Squad/Admin).
- Panel id ↔ table id map (captured `data-table`/`#id` markup): `#player_info_warn-table`, `#player_info_chat-table`, `#player_info_teamkill-table`, `#player_info_kits-table`, `#player_info_squad-table`, `#player_info_games-table`, `#player_info_kills-table`, `#player_info_death-table`, `#player_info_revive-table`, `#player_info_damage-table`, `#player_info_vehicle-table`.

#### 4.2 Full action set — moderation capabilities (= permissions)

State-changing actions POST to `/ajax/player.php` (`script:'player'`) or `/ajax/squad.php` (`script:'squad'` = live-server RCON, requires the player online). Payloads verbatim from captured JS (§2.4/§2.5).

| UI label (RU / EN) | action | script → endpoint | `data` params | Effect | Destr.? |
|---|---|---|---|---|---|
| open card | `get` | player → player.php | `steam_id` | Load full `player.info`. | N |
| `Добавить` (Add player) | `add` | player | `steam_id` | Create a record from a SteamID64, then open it. | Y |
| `Наказать`→`Кикнуть` (Kick w/ reason) | `kick` | squad | `steam_id, reason_id, description, noReason:false` | Kick with a rulebook reason. | Y |
| `Кикнуть без причины` (Kick no reason) | `kick` | squad | `steam_id, reason_id, description, noReason:true` | Kick without a rule (confirm). Gated by `canSelfKick`. | Y |
| `Наказать`→`Забанить` (Ban) | `ban` | squad | `server_id, steam_id, reason_id, description, days` | Ban N days or permanent (`days=0`). `server_id` sent if online. | Y |
| `Разбанить` (Unban) | `unban` | squad | `steam_id, unban:<bool>` | Lift ban; `unban:true` erases record fully. Gated by `canUnban`. | Y |
| `Сообщение`→`отправить` (Message) | `message` | player | `steam_id, time, msg, log` | In-game warning repeated for `time` s; `log` mirrors it on card. | Y |
| `Команда` (Switch team) | `changeTeam` | squad | `server_id, steam_id` | Force team swap (confirm). Online only. | Y |
| `Убить` (Kill) | `kill` | squad | `server_id, steam_id` | Kill in-game. Gated by `canBan`+online. | Y |
| `Кик из сквада` (Remove from squad) | `removePlayer` | squad | `server_id, steam_id` | Eject from fireteam/squad. Online + in a squad. | Y |
| tag menu → `Подозрение…` / `Снять метку` | `mark` | player | `steam_id, mark` | Set/clear suspicion tag 0–8. | Y |
| `Группа`→`Сменить группу` (Change group) | `changeGroup` | player | `steam_id, group_id, date, description, prefix, prefix_rgb, image` | Assign group + expiry + custom prefix/color/image (**VIP grant** path). Gated `canChangeGroup`; disabled for self. | Y |
| `Забанить ник` (Ban nickname) | `addBanName` | player | `name` | Add current nick to banned-names blacklist. | Y |
| `Разбанить ник` (Unban nickname) | `removeBanName` | player | `name` | Remove nick from blacklist. | Y |
| `Проверить баны` (Check bans) | `checkBans` | player | `steam_id` | Cross-project ban lookup → `#player_findban-modal` (§5.6). | N |
| `Поиск твинков` (Find twinks/alts) | `twink` | player | `steam_id` | Alt-account detection (§5.3). | N |
| twink → `Онлайн` (compare online) | `twinkOnline` | player | `steam_id, compare_steam_id, start, end` | Overlay two accounts' sessions on a FullCalendar (weekly) to prove co-presence. | N |
| twink → `Проверить друзья` (friends) | `findFriends` | player | `steam_id, compare_steam_id` | Steam-friends check between two accounts → `in_friend`. | N |
| `Киты` (Kit deny) → `Сохранить` | `kits` / `kitSave` | player | get: `steam_id`; save: `steam_id, kits` (JSON `{kit:bool}`) | View & toggle per-kit denial. Modal warns it "may violate server license terms." | Y (save) |
| comments drawer (load) | `getComments` | player | `steam_id` | Load admin comments. | N |
| comments drawer (send) | `addComment` | player | `steam_id, text` | Internal admin comment (≤256 chars). | Y |
| `Скачать статистику` (Download stats) | `downloadStat` | player.php (`post_to_url` form) | `action, steam_id` | Download the player's stats file. | N |
| online chart data | `getPlayerOnlineData` | player | `steam_id, start, end` | Online/boost/queue time series. | N |
| `Копировать телепорт` (Copy teleport) | *(clientside)* | — | — | Copies `AdminTeleportToPlayer <steam_id>`. | N |
| `Заявка в OWI` (OWI report) | *(clientside)* | — | — | Copies a cheat-report template (name/EOS/Steam URL). | N |
| card link | *(clientside)* | — | — | Copies `https://<host>/?steam_id=<id>` deep-link. | N |

Note: `players.html` and `playersOnline.html` are the only fragments exposing the FULL set including `ban/kick/kill/kits/changeGroup/changeTeam/checkBans/add`; other pages embed the same modal but a reduced action set (per action catalog: `bans/chat/admins/collabans` expose `twink/twinkOnline/findFriends/checkBans/removePlayer/getPlayerOnlineData` but not the write actions).

#### 4.3 Twin / alt detection (`twink`) — competitively notable

`Поиск твинков` → `text.list[]` (§2.4). Per candidate the UI renders:
- Name + SteamID + `/?steam_id=<id>` "открыть" deep-link.
- Red flag **"Есть перманентный бан"** when `perm` is truthy.
- Collapsible **matching-IP** list: header `Совпадений: <ips.length>, разница: <humanize(min_date*1000)>`; each row shows `loc`, the candidate's seen-time (`date`) and the owner's seen-time (`owner_date`) side by side, plus `humanize(date−owner_date)` delta.
- **`Проверить друзья`** → `findFriends` → button flips to "В друзьях"/"Не найдено" from `in_friend`.
- **`Онлайн`** → `compareOnline` builds an `agendaWeek` FullCalendar (`locale:ru`, `HH:mm`), and on each `viewRender` calls `twinkOnline(start.unix, end.unix)` → `renderEvents(text.calendar)`, overlaying both accounts' sessions.

A complete shared-IP + Steam-friends + co-presence alt-hunting workflow — a standout anti-ban-evasion tool.

#### 4.4 Suspicion marks (`mark` enum, values `0–8`)

| value | Label (RU / EN) |
|---|---|
| 1 | Подозрение на WallHack |
| 2 | Подозрение на AimBot |
| 3 | Подозрение на SpeedHack |
| 4 | Подозрение на спавн объектов (object spawning) |
| 5 | Подозрение на перезарядку (reload exploit) |
| 6 | Подозрение на гриф (griefing) |
| 7 | Подозрение на конфиг (config exploit) |
| 8 | Токсичный игрок (toxic) |
| 0 | Снять метку (clear) |

A set mark adds a `player_mark` CSS class to the player's rows across all tables and shows a pulsing `#player_info_mark` warning banner.

---

### 5. Forms & Modals (fields, options, validation — captured `#id` / `name` / attrs)

#### 5.1 Search / filter sidebar (drives `search` JSON of `action=allPlayers`)

| Control | `#id` | `data-search` alias | Input | Default | Meaning |
|---|---|---|---|---|---|
| Поиск (Search) | `#allPlayers-btn` | — | button | — | `buildTable('rebuild')`. |
| Ник или SteamID | `#allPlayers-name` | `t1.player` | text | empty | Free-text on nick or SteamID. `paste` auto-rebuilds. |
| Прошлые ники (Past nicks) | `#with_other_names` | `with_other_names` | checkbox | `false` | Extend search to historical nicknames. |
| Полное совпадение (Exact match) | `#full_match` | `full_match` | checkbox | `false` | Exact vs partial match. |
| Заходил c (Seen from) | `#allPlayers-startdate` | `startdate` | text (datetimepicker, readonly) | empty | Lower bound on last-login. |
| Заходил до (Seen until) | `#allPlayers-enddate` | `enddate` | text (datetimepicker, readonly) | empty | Upper bound on last-login. |
| Добавить (Add) | `#addPlayer-btn` | — | button | — | Opens `#addPlayer_modal` (§5.7). |

`searchInput: ["allPlayers-name","allPlayers-startdate","allPlayers-enddate","with_other_names","full_match"]`. `buildTable` harvests these into the `search` JSON (`text` for text inputs, `check` for checkboxes).

#### 5.2 Results table `#allPlayers` (captured `buildTable` config)

```
$('#allPlayers').buildTable({
  table: 'allPlayers',
  collum: ["steam_id", "name", "date"],
  numrows: 100,
  searchInput: ["allPlayers-name","allPlayers-startdate","allPlayers-enddate","with_other_names","full_match"],
  template: $('#player_template > div'),           // mobile 'list' card
  mode: isMobile ? 'list' : 'table',
  callback: { date: (d)=> formatDate(d,false,true) }
});
```

| Visible column (RU / EN) | `collum` key / `data-table` | Render |
|---|---|---|
| SteamID | `steam_id` | `<hashtag>` (copy). Row click → `player.open(steam_id)`. |
| Ник (Nickname) | `name` | plain span. |
| Заходил (Last seen) | `date` | `formatDate(data,false,true)` (unix → local). |

- Row `click` handler ignores `altKey`/`ctrlKey` (so admins can select/copy text without opening the card).
- **Auto-open:** if exactly one row is returned, `tr:eq(0).trigger('click')` opens that player immediately.
- Mobile switches to `mode:'list'` using `#player_template` (steam_id/name/date card).

#### 5.3 Ban form (`#player_ban`)

- **Reason select `#player_ban-reason`** (`type=multiselect`, `enableHTML`): grouped rulebook `<optgroup>`s — **Особые / Общие / Для сквадных / Для техники / Милсим**. Each `<option>` has `value` = rule id (e.g. `1`, `110`, `111`, `120`, `510`, `520`), an HTML `label` with the rule number (e.g. `<strong>1.1.</strong> Оскорбления…`), and **escalation attrs** `data-first / data-second / data-third / data-four` = ban-day tier per offense count (captured examples: general rules `0/0/0/30`, flood rule `1/1/1/30`). `value="false"` = "-Выберите причину-".
- **Punishment radios `player_ban-reason_type`**: Кикнуть (`value=-1 data-action=kick`), Забанить 1/2/3/4/5/6/7/10/14/30 дн (`data-action=ban data-day=N`), Забанить навсегда (`value=-1 data-action=ban data-day=0`, permanent, dark-red).
- **`Дополнительный комментарий`** textarea `#player_ban-description` (≤512).
- Submit `player.actionPlayer()` routes kick vs ban by the checked radio's `data-action`.

#### 5.4 Group / VIP form (`#player_group`)

- **`#player_group-groups`** multiselect: `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator), `5` Стажёр (trainee).
- **`#player_group-expire`** dateRange button presets: justDay, +1/2/3/6 Month, +1 Year, infinity, reset. Existing VIPs default to `expire` (permanent → infinity).
- `Комментарий` (≤128), `Префикс` (≤64), `Цвет префикса (RGB)` (color picker + `r,g,b` text), `Ссылка на изображение` (≤256).
- Buttons: `Игрок` (flip back), `Сменить группу`, hidden `VIP +1 месяц` quick-grant. Self-editing disabled when `is_you`.

#### 5.5 Message form (`#player_message`)

- Scrollable list of ~18 canned messages (`player.message.set`) — VIP-grant notice, vehicle solo/tandem warnings, squad-lock rules, mic requirement, TK apology, report-received, etc.
- `Добавить запись в карточку игрока` checkbox `#player_message-log` → mirrors message onto the card.
- `Сообщение` textarea (≤512), repeat-`Время` select (1 раз / 30 / 40 сек / 1 мин / 1:30 / 2 мин).

#### 5.6 Cross-project ban modal (`#player_findban-modal`, action `checkBans`)

Renders `text.projects[]` as a grid of `col-md-4` cards, one per federated project. Per card (captured render): project `name`, optional `discord` link, `online` time (`secToTime`), `Наказаний: <ban.total>` or "Нет наказаний", a ban/check icon by `ban.current` presence, and for an active ban a detail line with `ban.current.reason` and either "Перманент" (`expire=="0"`) or `От: <date> До: <expire>`.

#### 5.7 Add-player, Kit-deny & other modals

- **`#addPlayer_modal`**: single `SteamID64` input `#addPlayer_steam_id` → `addPlayer()` → `action:'add'`; on success opens the new card.
- **`#player_kits-modal`** (`kits`/`kitSave`): license-risk warning banner; list of kits each with a danger toggle (`data-kit`, checked = denied, shows "От <date>"); `Сохранить` serializes `{kit:bool}` JSON.
- **`#player_twink-modal`** (alt list `#player_twink-list`), **`#player_map-modal`** (Leaflet OSM map of a `location`), **`#player_info-placeholder`** (skeleton/glow loading), and the sliding **`.player_comments`** drawer (input `maxlength=256`, `getComments`/`addComment`).

---

### 6. Permission / Visibility Logic

Buttons default hidden (inline `display:none` or `.hide`) and are revealed by `setInfo()` per server-provided capability flags — the **server is the source of truth**, the client only reflects it:

- `canBan` → shows "Наказать"; when online, shows "Убить" and kit/banname items.
- `canUnban` → shows "Разбанить" + the `.panel_corner` ban ribbon.
- `canChangeGroup` → shows the "Группа" button (`#player_info-group_btn`).
- `canSelfKick` → shows "Кикнуть без причины".
- `is_you` → group select + expiry disabled (no self-promotion).
- `name_banned` → toggles "Забанить ник" vs "Разбанить ник".
- Online-only actions (message, changeTeam, kill, removePlayer) appear only when `player.info.online` (and its squad/team sub-objects) is present. When online, `player.info.online.squad.id` is prepended as a badge on the name.
- Mark menu, twink, checkBans, copy-teleport, OWI report, download-stat are shown to everyone who can open a card.

Group ids (0 None, 1 Admin, 2 Moderator, 3 VIP, 4 Camera, 5 Trainee) define the role hierarchy; special header art for VIP/Moderator groups.

---

### 7. Notable UX / Competitive Details (worth copying or beating)

1. **One universal player card** embedded on every page — open a player from chat, kills, bans, clans, anywhere; no context switch. Draggable, flippable (ban/group/message forms flip in-place rather than stacking modals).
2. **Alt-account hunting suite** (`twink` + shared-IP timeline + Steam-friends check + co-presence calendar) is the standout — a serious anti-cheat / ban-evasion tool.
3. **Cross-project ban check** (`checkBans`) aggregates bans across a federation of projects, with per-project online time and current-ban reason/expiry; `expire=="0"` = permanent.
4. **Escalating rulebook** encoded in `<option data-first/second/third/four>` — automatic day-tier per repeat offense, plus one-click canned kick/ban durations up to permanent.
5. **Rich identity graph**: SteamID64 + EOS id + Discord + VAC/game-ban + Steam hours + geo-IP history (raw IPs, timezones, map) + nickname history + primetime + clans — all on one screen.
6. **Group grant as branding**: custom prefix text, RGB color and image URL per group (monetizable VIP cosmetics).
7. **Split count/data queries**: the list fires the data page and a separate `pagination=true` `COUNT` in parallel, and every table response ships `query_time`/`count_time`/`exec_time` telemetry — a deliberate latency optimization for a 385 K-row table.
8. **Search depth**: search across historical nicknames + exact/partial toggle + last-seen date range — beats a naive "search by current name only."
9. **Data-exposure gap to exploit/avoid**: the directory list endpoint over-returns per row (`eos_id, create_date, mark, bonus, discord, expire, group_id`) beyond the three visible columns — a privacy/attack-surface note when designing a competitor.

---

### 8. Capture Provenance

- `caps/players/players.network.json` — 3 live contracts: `GET /ajax/page.php?page=players`, `POST /ajax/table.php` (`action=allPlayers`, data), `POST /ajax/table.php` (`pagination=true`, count).
- `caps/players/players.content.html` — live `#content` (search sidebar, `#allPlayers` config, full embedded modal + all sub-tab `buildTable` configs + every `Action()` payload).
- `caps/players/players.modaltabs.json` — modal `data-table` column tokens.
- `caps/players/_blocked.json` — `[]` (zero mutations attempted/blocked).
