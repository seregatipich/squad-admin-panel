## 07. Players Online (live)

Implementation-spec documentation for the SQSTAT (breaking.sqstat.ru) **Players Online** page. This revision is built from **live captured API contracts** (headless authenticated browser, read-only interceptor — 0 mutations fired) plus the live rendered `#content` fragment, the shared client library `custom.js`, and `action_catalog.txt`. Russian UI labels are preserved with an English gloss in parentheses.

Capture provenance: `caps/online/playersOnline.network.json` (2 contracts), `caps/online/playersOnline.content.html` (live `#content`, 165 623 B), `caps/online/_blocked.json` = `[]` (no mutation attempted or blocked).

---

### 1. Purpose and nav location

| Property | Value |
|---|---|
| Nav id / loader | `playersOnline` → `pageLoad('playersOnline')` → `GET /ajax/page.php?page=playersOnline` |
| Injected into | `#content` |
| Purpose | A cross-server leaderboard of players who accumulated playtime **within a selected time window**, ranked by total playtime and broken down by time spent in each in-game role (kit). It doubles as the launchpad for the shared **player-detail modal**, from which admins run live RCON actions (kick / ban / kill / move team / message) against players **currently** on a server. |
| Primary data source | Server-side table `playersOnline` via `$('#playersOnline').buildTable({table:'playersOnline', …})` → `POST /ajax/table.php` |

> **Scope note (confirmed against live capture).** Despite the section brief naming `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster` and `downloadOnline`, **none of those actions is invoked by this page.** The only reads this page fires on load are the page fragment and one `table.php` query (see §2). Per `action_catalog.txt`, `serverOnline*` live only on `main.html` (the per-server dashboard). This page's "online" concept is a **historical playtime aggregation over a date range** — a *report*, not a real-time roster snapshot. The genuinely real-time element here is the RCON action set that lights up when a listed player happens to be online right now (`player.info.online` non-null). Real-time roster vs. historical aggregation distinction is made explicit in §7 and §9.

---

### 2. Live API Contracts

Two network contracts were captured on page load. Ground truth: `caps/online/playersOnline.network.json`.

#### 2.1 `GET /ajax/page.php?page=playersOnline` — fragment loader

| Property | Value |
|---|---|
| Method / path | `GET /ajax/page.php` |
| Query param | `page` — string — required — must equal `playersOnline` |
| Status / ctype | `200` / `text/html; charset=UTF-8` |
| Response | Raw HTML fragment (115 844 B) injected into `#content`; contains the filter bar, the `#playersOnline` table skeleton, the inline `buildTable` bootstrap script, and the entire shared player-detail modal markup |

No JSON; this is a server-rendered partial. The inline `<script>` it carries wires the date-range picker, the server multiselect, and the table (§4).

#### 2.2 `POST /ajax/table.php` — the leaderboard query (main data contract)

**Request** — `application/x-www-form-urlencoded` body (captured verbatim):

```
action=playersOnline&table=playersOnline&page=1&numrows=100
&search=<urlencoded JSON>&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server handler selector — fixed `playersOnline` |
| `table` | string | Y | Table id echoed for routing — fixed `playersOnline` |
| `page` | int | Y | 1-based page number |
| `numrows` | int | Y | Page size; this page sends `100` (from `buildTable.numrows`) |
| `search` | urlencoded JSON | Y | Filter envelope, see below |
| `order_by` | string \| `false` | Y | DB alias of the sort column, or literal `false` for default sort |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction, or `false` for default |
| `pagination` | `true` | N | When appended (`…&pagination=true`), server returns the page/row **count** query used to build the pager (`custom.js:993`); the row-fetch call omits it |

**`search` envelope** — `encodeURIComponent(JSON.stringify(searches))`, five always-present buckets (`custom.js:711`). Captured decoded value (default "today" window, no other filter):

```json
{
  "text": {
    "custom.period.startdate": 1783116000,
    "custom.period.enddate":   1783202399
  },
  "check": {}, "multiselect": {}, "managers": {}, "slider": {}
}
```

| Bucket | Populated by | Key(s) | Value type |
|---|---|---|---|
| `text` | `#playersOnline-user` (free text) and the date-range picker | `player`; `custom.period.startdate`, `custom.period.enddate` | string; **unix seconds** for the two period keys |
| `multiselect` | `#playersOnline-server` | `server_id` | array of server-id strings |
| `check`, `managers`, `slider` | (none on this page) | — | always empty objects here |

**Response** — `200` / `application/json; charset=utf-8`. Schema (`field: type — meaning`):

| Field | Type | Meaning |
|---|---|---|
| `status` | string — enum `ok` (`"ok"` observed) | Query outcome flag |
| `exec_time` | float | Total server handling time, seconds |
| `data.totalPage` | int | Total pages for current filter (0 in the count-less row call; populated by the `pagination=true` call) |
| `data.totalRows` | int | Total matching rows (same caveat) |
| `data.currentPage` | string | Echoed page number, as a string (`"1"`) |
| `data.custom` | bool | Whether a custom (non-preset) period is active |
| `data.query_time` | float | Row-query time, seconds |
| `data.count_time` | int | Count-query time, seconds (0 unless `pagination=true`) |
| `data.row[]` | array | Leaderboard rows; **93 rows** in the captured page |
| `data.row[].steam_id` | string(17) | Steam64 ID — identity key, feeds `player.open()` |
| `data.row[].name` | string | Player display name |
| `data.row[].online` | string | **Pre-formatted duration**, Russian `"Xч Yм"` (h/m) — total playtime in window. NOT raw minutes |
| `data.row[].boost` | string | Pre-formatted duration `"Xч Yм"` — boosted playtime in window |
| `data.row[].queue` | string | Pre-formatted duration `"Xч Yм"` — time spent in join queue. **Returned but NOT rendered** (absent from `buildTable.collum`) |
| `data.row[].SL` | string | Duration `"Xч Yм"` as Squad Leader |
| `data.row[].CMD` | string | Duration as Commander |
| `data.row[].Rifleman` | string | Duration as Rifleman |
| `data.row[].Medic` | string | Duration as Medic |
| `data.row[].LAT` | string | Duration as Light Anti-Tank |
| `data.row[].MachineGunner` | string | Duration as Machine Gunner |
| `data.row[].Marksman` | string | Duration as Marksman |
| `data.row[].Engineer` | string | Duration as Engineer |
| `data.row[].Pilot` | string | Duration as Pilot |
| `data.row[].Crewman` | string | Duration as vehicle Crewman |

Redacted example row (`caps/online/playersOnline.network.json`):

```json
{
  "steam_id": "<redacted:17>", "name": "<redacted:36>",
  "online": "5ч 32м", "boost": "3ч 56м", "queue": "0ч 0м",
  "SL": "0ч 27м", "CMD": "0ч 0м", "Rifleman": "0ч 55м", "Medic": "0ч 0м",
  "LAT": "0ч 0м", "MachineGunner": "0ч 0м", "Marksman": "0ч 0м",
  "Engineer": "0ч 0м", "Pilot": "0ч 0м", "Crewman": "0ч 0м"
}
```

> **Contract implications for a re-implementer.** (1) All duration metrics are formatted **server-side** into `Xч Yм` strings — the client does no numeric parsing, so sorting must be done server-side on the underlying seconds, not on the string. (2) `queue` is part of the wire contract even though this page never shows it — the same `playersOnline` handler evidently serves callers that do. (3) The count query is a **separate round-trip** (`&pagination=true`); the initial row call returns `totalPage/totalRows = 0`.

---

### 3. Entities & fields

#### 3.1 `PlayerOnlineRow` — one leaderboard row

Row shape is fixed by the `data.row[]` schema in §2.2. Column→DB-alias mapping (used for sort and for the `data-search` protocol) is in §4. All metric fields are pre-formatted `Xч Yм` duration strings.

#### 3.2 `PlayerInfo` — the shared player-detail entity (`player.info`)

Loaded by `action:'get'` (script `player` → `/ajax/player.php`) when a row's `<hashtag>` is clicked (`player.open(steam_id)`). Shared panel-wide; only fields this page reads/renders are listed.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | Steam64 ID — identity key for every downstream action |
| `name` | string | Current nickname |
| `eos_id` | string | Epic Online Services ID |
| `discord` | string | Discord user id (links `discord.com/users/<id>`) |
| `vac` | mixed | VAC status |
| `steam_info.ban` | object `{vac, ban, days}` | VAC / game-ban flags from Steam |
| `steam_info.squad.time` | number | Steam hours played in Squad |
| `location[]` | array `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history; index 0 = current |
| `primetime[]` | array `{start, end}` (unix ranges) | Player's habitual online hours |
| `playtime.server` | string | "Home" server label |
| `group_id`, `expire`, `prefix`, `prefix_rgb` | mixed | Admin-group membership (§3.4) |
| `ban` | object `{expire, reason, admin, date, description}` | Active punishment |
| **`online`** | object \| null | **Presence — non-null only if the player is on a server right now** |
| `online.server` | object `{id, name}` | Server the player is currently on — required by every RCON action |
| `online.team` | object `{short}` | Current team — drives "change team" |
| `online.squad` | object `{id}` | Current squad number — drives "kick from squad"; rendered as a badge in `#player_info-name` (`content.html:1177`) |

`online` is the pivot for every live/RCON capability; when null the destructive live buttons stay hidden (§7).

#### 3.3 `PlayerOnlineData` — live activity chart (`getPlayerOnlineData`)

Returned by `action:'getPlayerOnlineData'` (script `player`), request keys `steam_id, start, end`. Keyed by timestamp bucket; each entry `{minute, boost, queue}` (minutes online / boost value / queue time). Rendered as a 3-dataset line chart in the modal (chart config at `content.html:~1330`).

#### 3.4 Reference / enum entities

- **Ban reason** (`player_ban-reason` select): rule catalog; each `<option>` carries `data-first/second/third/four` = recommended ban lengths (days) for the 1st–4th offence. Value `-1` = permanent.
- **Ban duration radios** (`player_ban-reason_type`): `data-action` = `kick`|`ban`; `data-day` ∈ `{0,1,2,3,4,5,6,7,10,14,30}` (0 = permanent). One is auto-selected "Рекомендуемое" (Recommended) from the reason's offence data.
- **Admin groups** (`player_group-groups`): `0` -Нет группы- (None), `1` Администратор (Admin), `2` Модератор (Moderator), `3` VIP, `4` Камера (Camera/spectator), `5` Стажёр (Trainee).
- **Suspicion marks** (`player.mark.set`): `1` WallHack, `2` AimBot, `3` SpeedHack, `4` object-spawn, `5` reload exploit, `6` griefing, `7` config, `8` toxic, `0` = clear.
- **Message durations** (`player_message-time`): `1` (once), `30`, `40`, `60` (default), `90`, `120` seconds.

---

### 4. DataTables spec: `#playersOnline`

Config from the live inline bootstrap (`content.html:71-104`) and the `buildTable` engine (`custom.js:620-1100`).

| Property | Value |
|---|---|
| Server table id | `playersOnline` (sent as both `action=` and `table=`) |
| Endpoint | `POST /ajax/table.php` |
| Page size (`numrows`) | `100` |
| Row click | `#playersOnline tbody > tr hashtag` → `player.open($(this).text())` (opens shared modal on the SteamID) |
| Default sort | none explicit (`order_by=false&order_sort=false`) — server default (playtime desc) |

**Column set** — `collum` order and sortability (`order` array). Header labels from live `<thead>` tooltips (`content.html`). `data-search` DB alias = the field name (server-side aggregation aliases):

| # | `collum` key / DB alias | Header (`data-original-title`) | English | Sortable (`order`) | Rendered as |
|---|---|---|---|---|---|
| 1 | `name` | Игрок | Player | No | clickable `<hashtag>` carrying SteamID |
| 2 | `online` | Наигранное время за период | Playtime in period | **Yes** | `Xч Yм` |
| 3 | `boost` | Буст за период | Boost in period | **Yes** | `Xч Yм` |
| 4 | `SL` | Сквадной | Squad Leader | **Yes** | kit icon + `Xч Yм` |
| 5 | `CMD` | CMD | Commander | **Yes** | kit icon + duration |
| 6 | `Rifleman` | Стрелок | Rifleman | **Yes** | kit icon + duration |
| 7 | `Medic` | Медик | Medic | **Yes** | kit icon + duration |
| 8 | `LAT` | Гранатомётчик | Grenadier / LAT | **Yes** | kit icon + duration |
| 9 | `MachineGunner` | Пулемётчик | Machine Gunner | **Yes** | kit icon + duration |
| 10 | `Marksman` | Снайпер | Marksman | **Yes** | kit icon + duration |
| 11 | `Engineer` | Инженер | Engineer | **Yes** | kit icon + duration |
| 12 | `Pilot` | Пилот | Pilot | **Yes** | kit icon + duration |
| 13 | `Crewman` | Водитель | Crewman | **Yes** | kit icon + duration |

Kit icons resolve to `/assets/img/ico/kits/<Kit>.svg`. `queue` is present in the response but **not** in `collum`, so it is fetched and discarded here. Sort clicks toggle `order_by`/`order_sort` and rebuild (`custom.js:819-830`).

---

### 5. Filter bar & search protocol

Filter bar markup + wiring from live `content.html:56-104`. `buildTable.searchInput = ["playersOnline-user","playersOnline-period","playersOnline-server"]`. Each control's `type` attribute selects a serializer branch in `custom.js:721-774`.

| Control | `#id` | `name` / `data-search` | input `type` | Serializer → bucket | Options / default | Validation |
|---|---|---|---|---|---|---|
| Игрок (Player) | `playersOnline-user` | `player` | `text` | `searches.text["player"]` | placeholder "Игрок"; empty by default | Enter (keyCode 13) sets `page=1`, `isSearch=true`, rebuilds; empty value omitted; `+`→`%2B` |
| Period picker | `playersOnline-period` | `custom.period` | `daterange` | `searches.text["custom.period.startdate"]` + `.enddate` (unix seconds from `data-start`/`data-end`) | presets `['justMonth','justDay','justWeek','justYear','range','today','yesterday','currentWeek','lastWeek','currentMonth','lastMonth','last30days']`; **default `{type:'today'}`**; on change fires `crm_dateRange` → `buildTable()` | always populated |
| Сервер (Server) | `playersOnline-server` | `server_id` | `multiselect` | `searches.multiselect["server_id"]` (array) | `nonSelectedText:'- Сервер -'`; values below | null selection omitted |
| Поиск (Search) | `playersOnline-btn` | — | button | — | rebuilds with current filters | — |

**Server multiselect options** (live `content.html`): `1` RAAS/AAS #1, `6` БЕЗ ГОЛОСОВАНИЯ #2, `7` INVASION #3, `9` Custom для FW, `10` Custom для MDC, `11` Custom для BSS.

Envelope is `encodeURIComponent(JSON.stringify({text,check,multiselect,managers,slider}))` (`custom.js:778`).

---

### 6. Actions / admin capabilities (from the shared modal)

Every state-changing action originates in the **shared player-detail modal**, not the leaderboard table. Two script endpoints:

- **`/ajax/squad.php`** — live RCON layer. Require `player.info.online.server.id`; act on the running server. All destructive.
- **`/ajax/player.php`** — database/record layer (marks, comments, groups, name-bans, twink analysis, exports).

Each row lists the exact `Action({script, action, data:{…}})` call. "Dest." = destructive.

| # | UI label | `action` | `script` → endpoint | `data` keys (type) | Effect | Dest. |
|---|---|---|---|---|---|---|
| 1 | (open card) | `get` | player → `/ajax/player.php` | `steam_id`(str) | Load full player card | N |
| 2 | График (online chart) | `getPlayerOnlineData` | player | `steam_id`(str), `start`(unix), `end`(unix) | Fetch minute/boost/queue series | N |
| 3 | Кикнуть (Kick, with reason) | `kick` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(int) | RCON kick from server | **Y** |
| 4 | Кикнуть без причины (Kick, no reason) | `kick` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(empty) | RCON kick without a reason record | **Y** |
| 5 | Забанить (Ban N days / perma) | `ban` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(int), `description`(str≤512), `days`(int; `-1`=perma) | Ban + kick | **Y** |
| 6 | Разбанить (Unban) | `unban` | **squad** | `steam_id`(str), `unban`(bool) | Lift active ban; `unban` also clears error/appeal | **Y** |
| 7 | Кик из сквада (Kick from squad) | `removePlayer` | **squad** | `server_id`(int), `steam_id`(str) | RCON remove from squad, keep on server | **Y** |
| 8 | Команда (Change team) | `changeTeam` | **squad** | `server_id`(int), `steam_id`(str) | RCON force to other team | **Y** |
| 9 | Убить (Kill) | `kill` | **squad** | `server_id`(int), `steam_id`(str) | RCON kill character | **Y** |
| 10 | Сообщение (Warn / message) | `message` | player | `steam_id`(str), `time`(int sec), `msg`(str≤512), `log`(bool) | In-game warning; `time`=repeat, `log` writes to card | **Y** |
| 11 | Метка (Set suspicion mark) | `mark` | player | `steam_id`(str), mark(int 1–8 or 0) | Flag/clear cheat suspicion; highlights `.player_mark` | **Y** |
| 12 | Группа (Change group / VIP) | `changeGroup` | player | `steam_id`(str), `date`(expire), `group`(int 0–5), `description`(str≤128), `prefix`(str≤64), `prefix_rgb`(str≤16), `image`(str≤256) | Assign admin/VIP group w/ expiry, chat prefix, colour, image | **Y** |
| 13 | Проверить баны (Check bans) | `checkBans` | player | `steam_id`(str) | Query external/community ban lists | N |
| 14 | Поиск твинков (Find alts) | `twink` | player | `steam_id`(str) | Alt accounts sharing IPs (`name, steam_id, ips[], min_date`) | N |
| 15 | Онлайн compare | `twinkOnline` | player | `steam_id`(str), `compare_steam_id`(str) | Compare online calendars of player vs suspected alt | N |
| 16 | Проверить друзья (Check friends) | `findFriends` | player | `steam_id`(str), `compare_steam_id`(str) | Cross-check Steam friend links | N |
| 17 | Забанить ник (Ban nickname) | `addBanName` | player | `steam_id`(str) (+ nick context) | Add nick to banned-names list | **Y** |
| 18 | Разбанить ник (Unban nickname) | `removeBanName` | player | `steam_id`(str) | Remove nick from banned-names list | **Y** |
| 19 | Киты (Kits editor open) | `kits` | player | `steam_id`(str) | Load per-player kit permissions | N |
| 20 | Сохранить (Save kits) | `kitSave` | player | `steam_id`(str), `kits[]`(array) | Persist edited kit permissions | **Y** |
| 21 | Комментарии (Get comments) | `getComments` | player | `steam_id`(str) | Load internal admin comments | N |
| 22 | (add comment) | `addComment` | player | `steam_id`(str), text(str) | Append admin comment | **Y** |
| 23 | Скачать статистику (Download stats) | `downloadStat` | player (`post_to_url` form) | `steam_id`(str) | File download of player stats | N |

Client-only helpers (no server call): **Копировать телепорт** (`copyTeleport` → clipboard `AdminTeleportToPlayer <steam_id>`), **Заявка в OWI** (`copyReport` → clipboard OWI/BattleMetrics report template), **ссылка** (`copylink` → clipboard `?steam_id=`).

Full `player.php` surface reachable from this modal (`action_catalog.txt`): `addBanName, addComment, ban, changeGroup, changeTeam, checkBans, findFriends, get, getComments, getPlayerOnlineData, kick, kill, kits, kitSave, mark, message, removeBanName, removePlayer, twink, twinkOnline, unban, downloadStat` — with `ban/kick/kill/changeTeam/removePlayer/unban` routed through `script:'squad'`.

---

### 7. Forms, modals & visibility predicates

**Ban / punish** (`#player_ban`): reason multiselect (rule catalog, `data-first..four` recommended days) + duration radio group `player_ban-reason_type` (kick or ban 1–30d / perma, one auto-recommended) + comment textarea `player_ban-description` (max 512). Submit `player.actionPlayer()` branches `kick` vs `ban` on `squad`; if online, `server_id` = `player.info.online.server.id`.

**Group** (`#player_group`): group select 0–5; expiry daterange `player_group-expire` (**disabled when group=0**); comment (max 128); prefix text (max 64); prefix RGB color picker `player_group-prefix_rgb-color` synced to `r,g,b` text (max 16); image URL (max 256). Submit `player.group.set()` → `changeGroup`. "VIP +1 месяц" quick-action is `.hide`-gated.

**Message / warn** (`#player_message`): ~18 canned warnings selectable via `player.message.set()`; free-text `player_message-msg` (max 512); repeat select `player_message-time`; **"Добавить запись в карточку игрока"** checkbox `player_message-log` to also log to card. Submit → `message`.

**Kits** (`#player_kits-modal`): per-role permission list saved via `kitSave` with a client-assembled `kits[]` payload.

**Twink panel**: alt list with per-alt **Проверить друзья** / **Онлайн** buttons firing `findFriends` / `twinkOnline` against `compare_steam_id`; shows IP-overlap counts and time deltas.

**Visibility predicates** (`player.open()` reveals conditionally; default `display:none` / `class="hide"`):

| Element | Shown iff (predicate) |
|---|---|
| Сообщение (message) | `player.info.online` truthy |
| Команда (change team) | `player.info.online.team` present |
| Кик из сквада (removePlayer) | `player.info.online.squad` present |
| Убить (kill) / Кикнуть без причины | `player.info.online` truthy |
| Разбанить (unban) | active ban exists on player |
| Забанить ник / Разбанить ник | toggled by current name-ban state |
| Киты (kits) | card data confirms kit-permission availability |
| VIP quick-grant | `.hide` until group flow selects VIP |

Net effect: the entire destructive RCON toolset (kick/kill/team/squad) is **inert for offline players** and only lights up for live ones; the server enforces the `server_id` requirement, the client mirrors it by presence-gating. No visible client-side role check beyond presence; group-level authorization assumed server-side. A few SteamIDs are special-cased in `player.open()` (owner/dev badges) — cosmetic only.

---

### 8. Competitively interesting details

- **Playtime-by-role leaderboard.** 11 kit columns turn "who was online" into a role-competency table — surfaces medics/SLs/pilots and role-stackers; useful for recruiting, not just moderation.
- **One shared player-detail modal everywhere.** The same ~23-action card is embedded on every page. An admin never leaves context to punish. High leverage, expensive to out-build piecemeal.
- **Presence-driven action gating.** Clean split: DB actions on `player.php`, live actions on `squad.php`, gated by `player.info.online.server.id`.
- **Recommended ban-length engine.** Each rule encodes escalating 1st–4th-offence durations; correct duration radio auto-checked and tooltipped "Recommended." A fairness/consistency feature to beat.
- **Canned warnings + optional card logging.** Pre-written warnings with a "log to card" toggle and configurable in-game repeat interval — fast, auditable moderation.
- **Twink hunting.** IP-overlap alt detection with drill-down (shared IPs, time deltas, friend-graph cross-check, online-calendar comparison).
- **Clipboard integrations.** `AdminTeleportToPlayer` and a ready-to-paste OWI/BattleMetrics cheat-report template are copy-to-clipboard.
- **Rich per-player intel.** Geo-IP history with flags/timezones, primetime hours, Steam hours, VAC/game-ban badges, Discord link.
- **Server-side formatted durations.** All metrics arrive as `Xч Yм` strings — cheap on the client, but forces server-side sort on underlying seconds.

---

### 9. Gaps / uncertainties

- **Real-time roster vs historical aggregation:** confirmed — this page is a *period aggregation report*. The live roster (`serverOnline`/`serverOnlineAdmins`/`serverOnlineBooster`/`downloadOnline`) lives on `main.html`; document the real-time roster in the servers/main section.
- `queue` is in the wire contract but never rendered here — its display consumer is another page/caller; exact semantics (queue time vs queue count) inferred from the `Xч Yм` format = time.
- `totalPage`/`totalRows` are 0 in the row-fetch response; the count is a separate `&pagination=true` round-trip not captured here (no user paged during capture).
- Server-side field set for `action:'get'` beyond what the modal reads is not observable from the client.
- `reason_id`→rule-text mapping lives server-side; only the option catalog is visible client-side.
- Kit-permission payload shape (`kits[]` from `player.kits.collect()`) is assembled client-side; server schema not exposed here.
- `boost`/`primetime` precise definitions inferred from usage, not a schema.
