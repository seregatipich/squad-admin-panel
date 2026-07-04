## 13. Combat Logs: Kills, Deaths, Revives, Damage, Teamkills

> Spec-grade chapter. All endpoint/response facts below are taken from LIVE captured contracts on `https://breaking.sqstat.ru` (read-only headless capture, 0 blocked mutations). Capture files: `caps/combat/{kills,deaths,revives,damages,teamkills}.network.json` and `.content.html`. Client behavior is cross-referenced against `custom.js` (`$.fn.buildTable` at L605, `Action()` at L284, `dateRange` presets at L1206+). Russian UI labels are kept with an English gloss.

### 13.1 Purpose and Navigation

SQSTAT exposes five near-identical combat-event log pages. Each is a filterable, server-side-paginated table over one class of in-game combat event. Nav click → `pageLoad('<page>')` → **`GET /ajax/page.php?page=<page>`** returns an HTML fragment (~114 KB) injected into `#content`. The fragment ships an inline `<style>` hiding the first column, the left filter rail, the empty results `<table>`, one inline `<script>` that calls `$('#<tableId>').buildTable({...})`, and the full shared player-detail modal markup.

| Page id | `page.php` fragment (bytes) | Table DOM id | `table=`/`action=` name | Event logged | Page size (`numrows`) |
|---|---|---|---|---|---|
| `kills` | 115029 | `#playerKills` | `playerKills` | Player A killed player B (weapon + kit recorded) | 500 |
| `deaths` | 113955 | `#playerDeath` | `playerDeath` | A player died (subject + weapon/actor that killed them) | 500 |
| `revives` | 113974 | `#playerRevive` | `playerRevive` | A medic revived a downed player | 500 |
| `damages` | 114070 | `#playerDamage` | `playerDamage` | A damage-dealt event (attacker, victim, weapon, **amount**) | 500 |
| `teamkills` | 114004 | `#playerTeamkill` | `playerTeamkill` | A friendly-fire kill (offender + team victim) | 100 |

All five share an identical two-pane layout: a fixed left filter rail (`div.col-md-3.mobile-left > .block-box` with `position:fixed`) and a right results table (`col-md-9`). All five embed the shared player-detail modal (`#player_info` / `#playerModal`) with its Chat/Kills/Deaths/Kits/Games/Comments tabs and ~22 actions — documented in the shared-modal chapter, not here. Modal-tab columns (Чат/Сообщение/Кит/Карта/Победа/Урон, etc.) are **not** attributed to these pages.

### 13.2 Live API Contracts

Every page drives exactly two POST calls to a single endpoint, plus the one-time page GET. This is the ground-truth upgrade of this chapter.

#### 13.2.1 `GET /ajax/page.php` — fragment loader

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | enum: `kills` \| `deaths` \| `revives` \| `damages` \| `teamkills` | yes | Which combat-log fragment to render |

Response: `text/html; charset=UTF-8`, the `#content` fragment. Status `200`. No JSON envelope.

#### 13.2.2 `POST /ajax/table.php` — row fetch (data call)

The core read. Sent by `buildTable → Action({script:'table', action:'<table>', data:'&table=<table>&page=...'})`. Body is `application/x-www-form-urlencoded`.

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string = the table name | yes | Mirrors `table`; `Action()` appends `action=<table>` |
| `table` | enum: `playerKills` \| `playerDeath` \| `playerRevive` \| `playerDamage` \| `playerTeamkill` | yes | Server table/query id |
| `page` | int (1-based) | yes | Page number |
| `numrows` | int | yes | Rows per page (500 for k/d/r/dmg, 100 for teamkills) |
| `search` | URL-encoded JSON | yes | Filter object (see §13.4.2). Default `{"text":{"t1.date.startdate":0,"t1.date.enddate":0},"check":{},"multiselect":{},"managers":{},"slider":{}}` |
| `order_by` | string \| `false` | yes | Column DB-alias to sort by; ships as literal `false` (no sort) |
| `order_sort` | `asc` \| `desc` \| `false` | yes | Sort direction; ships as `false` |

Response envelope: `application/json; charset=utf-8`, status `200`.

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum: `ok` \| (error) | Request status; `Action()` treats non-`ok` as error, `auth:true` → `location.reload()` |
| `exec_time` | float (seconds) | Server-measured total execution time |
| `data.totalPage` | int | Always `0` on the data call (real value comes from the pagination call) |
| `data.totalRows` | int | Always `0` on the data call |
| `data.currentPage` | string (numeric) | Echoed page, e.g. `"1"` |
| `data.custom` | bool | Custom-payload flag; `false` for these tables |
| `data.query_time` | int \| float (seconds) | Row-query time (0 when cached; `0.21` observed on teamkills) |
| `data.count_time` | int | `0` on the data call (counting deferred to pagination call) |
| `data.row` | array[`numrows`] of row objects | The log rows; per-table schema in §13.3 |

#### 13.2.3 `POST /ajax/table.php` … `&pagination=true` — count call

Identical body plus a trailing `&pagination=true`. Returns only the count envelope (no rows). This is a **separate, expensive `SELECT COUNT(*)`** — `count_time` runs 0.1 s–2.76 s in captures.

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Total page count = ceil(totalRows / numrows) |
| `totalRows` | string (numeric) | Total matching rows (string, e.g. `"13413500"`) |
| `count_time` | float (seconds) | COUNT query time; logged to console by client |
| `status` | string enum: `ok` | |
| `exec_time` | float (seconds) | Total execution time |

**Live totals observed** (indicative table scale, default all-time filter):

| Table | totalRows | totalPage @ numrows | count_time |
|---|---|---|---|
| `playerKills` | 4,402,799 | 8,806 @ 500 | 1.37 s |
| `playerDeath` | 5,630,431 | 11,261 @ 500 | 1.36 s |
| `playerRevive` | 1,217,973 | 2,436 @ 500 | 0.27 s |
| `playerDamage` | 13,413,500 | 26,827 @ 500 | 2.76 s |
| `playerTeamkill` | 653,590 | 6,536 @ 100 | 0.10 s |

### 13.3 Per-Table Row Schemas (from captured `data.row[]`)

Types are as returned on the wire (all scalars are JSON strings unless noted). Field lengths shown are the redaction lengths of the sample row, not schema constraints. `date` is a **Unix epoch seconds** string in every table. `server` is pre-rendered HTML (a `<code>[X]</code>` badge). `steam_id`/`victim_steam_id` are 17-char SteamID64 strings.

**`playerKills`** — client `collum: ["steam_id","server","date","player_name","name","weapon"]`

| Field | Type | Meaning | Rendered as column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK (e.g. `4402799`) | no |
| `steam_id` | string(17) | Killer SteamID64 — drives row-click modal | hidden col 1 |
| `victim_steam_id` | string(17) | Victim SteamID64 — makes target openable (kills only) | no (used by `#kill_template`) |
| `game_id` | string(numeric) | Match/game id (e.g. `33295`) | no |
| `date` | string(unix-sec) | Event time (e.g. `1783115934`) | Дата |
| `weapon` | string | Weapon/entity id (e.g. `QBZ192_Optic_QMK171A_Grippod`) | Оружие |
| `kit` | string | Killer kit id (e.g. `PLANMC_Rifleman_06`) | no (not in `collum`) |
| `player_name` | string | Killer display name | Кто (Who) |
| `name` | string | Victim display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id (1/6/7/9/10/11) | no |
| `map` | string | Map + layer (e.g. `Harju RAAS v1`) | no (not in `collum`) |
| `server` | HTML string | Server badge `<code>[A]</code>` | server icon col 2 |

**`playerDeath`** — `collum: ["steam_id","server","date","player_name","weapon"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `steam_id` | string(17) | The deceased player | hidden col 1 |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Death time | Дата |
| `weapon` | string | Weapon/actor that killed them (e.g. `Soldier_AFU_SquadLeader01`) | Оружие |
| `kit` | string | Deceased's kit (e.g. `CMD`) | no |
| `player_name` | string | Deceased display name | Игрок (Player) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

Note: no `victim_steam_id`/`name` in payload — deaths table has no second-party column, though the killer is still **filterable** via the Кого input (§13.4).

**`playerRevive`** — `collum: ["steam_id","server","date","player_name","name"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `steam_id` | string(17) | Reviving medic | hidden col 1 |
| `victim_steam_id` | string(17) | Revived player SteamID64 | no |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Revive time | Дата |
| `kit` | string | Medic kit id | no |
| `player_name` | string | Medic display name | Кто (Who) |
| `name` | string | Revived player display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

No `weapon` (revives have none).

**`playerDamage`** — `collum: ["steam_id","server","date","player_name","name","weapon"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK (8-digit, largest table) | no |
| `steam_id` | string(17) | Attacker | hidden col 1 |
| `victim_steam_id` | string(17) | Victim | no |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Damage time | Дата |
| **`damage`** | string(numeric) | **Damage amount** (e.g. `"32"`) — present in payload but NOT in `collum`, so never shown/sortable on this grid | no (**omitted**) |
| `weapon` | string | Weapon id (e.g. `QBZ192_Holo_Grippod_Suppressor`) | Оружие |
| `player_name` | string | Attacker display name | Кто (Who) |
| `name` | string | Victim display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

**`playerTeamkill`** — `collum: ["steam_id","server","date","player","killed"]` (distinct keys vs other tables)

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `server_id` | string(numeric) | Server id | no |
| `steam_id` | string(17) | Offender (teamkiller) — drives row-click | hidden col 1 |
| `killed` | HTML string | Team victim, **pre-rendered** `<p class="mb-0">…name…</p>` (includes clan tag) | Кого (Whom) |
| `date` | string(unix-sec) | Teamkill time | Дата |
| `killed_group` | null | Victim admin-group (null when none) | no |
| `player` | HTML string | Offender, pre-rendered name markup | Кто (Who) |
| `player_group` | null | Offender admin-group (null when none) | no |
| `kit` | HTML string | Offender kit as `<img src="/assets/img/ico/kits/…">` | no (not in `collum`) |
| `server` | HTML string | Server badge | server col 2 |

Teamkills uniquely (a) server-renders `player`/`killed`/`kit` as HTML, (b) carries `*_group` join columns, (c) uses `numrows:100`, (d) has no `weapon` and no `victim_steam_id`. It is a **passive log**: no forgive/punish/auto-kick/TK-count workflow on the page.

### 13.4 Filters, Search, Sort, Pagination

#### 13.4.1 Left-rail controls (per page; ids prefixed with the table id)

Structure is identical across all five; only the `data-search` DB-aliases differ. Example ids use `playerKills-*`.

| Control | `#id` suffix | Input type | `data-search` alias | Options / behavior | Validation |
|---|---|---|---|---|---|
| Поиск (Search) | `-btn` | `button` (`btn btn-default btn-100`) | — | Triggers `buildTable()` re-fetch | — |
| Кто (Who) | `-name` | `text` (`form-control`, placeholder `Кто`) | page-specific (table below) | Substring on primary player name; Enter (`which==13`) submits | free text |
| Кого (Whom) | `-killed` | `text` (placeholder `Кого`) | page-specific | Substring on secondary player name; Enter submits | free text |
| Сервер (Server) | `-server` | Bootstrap `multiselect` (`multiple`, `type="multiselect"`) | `server_id` | 6 checkboxes; IN-list filter; placeholder `- Сервер -`; `enableHTML` | — |
| Date range | `-date` | `button` (`type="daterange"`) | `t1.date` | `dateRange` picker; fires `crm_dateRange`; writes `t1.date.startdate`/`t1.date.enddate` into search `text` | — |

Server `<option>` set (shared across all five — this tenant's own servers only; note id gaps 2–5, 8):

| `server_id` | `label` |
|---|---|
| 1 | `RAAS/AAS #1` |
| 6 | `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2) |
| 7 | `INVASION #3` |
| 9 | `Custom для FW` |
| 10 | `Custom для MDC` |
| 11 | `Custom для BSS` |

**Page-specific `data-search` aliases (leaked raw SQL join aliases).** The same physical event table (`t1`, holding `date`, `server_id`) is joined to player tables under different aliases depending on which side the page treats as primary:

| Page | Кто (`-name`) → | Кого (`-killed`) → | Server | Date |
|---|---|---|---|---|
| kills | `t2.player` | `t4.player` | `server_id` | `t1.date` |
| deaths | `t5.player` | `t2.player` | `server_id` | `t1.date` |
| revives | `t5.player` | `t2.player` | `server_id` | `t1.date` |
| damages | `t2.player` | `t5.player` | `server_id` | `t1.date` |
| teamkills | `t5.player` | `t2.player` | `server_id` | `t1.date` |

#### 13.4.2 Search object assembly

`buildTable` collects `searchInput` controls into a five-bucket object keyed by each control's raw `data-search` value, then JSON-stringifies and URL-encodes it (`+`→`%2B`) into the `search` param:

```json
{
  "text":        { "t1.date.startdate": 0, "t1.date.enddate": 0, "<who-alias>": "<query>", "<whom-alias>": "<query>" },
  "check":       {},
  "multiselect": { "server_id": ["1","7", ...] },
  "managers":    {},
  "slider":      {}
}
```

Text inputs land in `text.<alias>`; the date button always seeds `text.t1.date.startdate` / `text.t1.date.enddate` (0/0 = all-time default); the server multiselect lands in `multiselect.server_id`. `check`, `managers`, `slider` are unused on combat pages.

`searchInput` per page: `["<table>-name", "<table>-killed", "<table>-server", "<table>-date"]` (exact ids from the captured configs).

#### 13.4.3 Sort

The engine supports sorting (`order_by`/`order_sort` params, and `order` config mapping columns→aliases in `buildTable`), but **none of the five page-own configs set `order`**, so both params ship as literal `false` and server default ordering applies (newest-first by PK/date in practice). No sortable column headers are wired on these grids.

#### 13.4.4 Pagination

Two-request model per load: the data call (`&page=N`) returns rows with `totalPage/totalRows = 0`; a parallel count call (`&pagination=true`) returns real `totalRows`/`totalPage`. Client shows `showPages: isMobile?3:9`. Concurrency guard `tmpTable[tableID]=true` blocks a second load of the same table (logs `Такая таблица уже грузится`). Ajax timeout / retry-abort handled by `Action()` (`retryAbort:true` aborts the prior in-flight request of the same `name`).

### 13.5 Column Rendering

Rendering is driven by `buildTable`'s `collum` array (order = visual column order after the hidden `steam_id`). Header cells (`<thead class="table-dark">`) with widths:

| Header (Ru → En) | class / style | Applies to |
|---|---|---|
| `SteamID` | `hide` (also CSS `td:first-child{display:none}`) | all (col 1, hidden) |
| (server icon) | `text-center; width:50px` | all (col 2) |
| `Дата` (Date) | `text-center; width:130px` | all |
| `Кто` (Who) | `text-center` | kills, revives, damages, teamkills |
| `Игрок` (Player) | `text-center` | deaths (single-party) |
| `Кого` (Whom) | `text-center` | kills, revives, damages, teamkills |
| `Оружие` (Weapon) | `text-center` | kills, deaths, damages |

Each `<td>` gets `data-contact="<collum key>"` (used by row-click to read `steam_id`). Kills has a `callback.date` → `formatDate(data,false,true)` render; the other four rely on default rendering (dates rendered raw or by the shared default). `server` and (teamkills) `player`/`killed`/`kit` arrive as HTML and are injected as-is.

### 13.6 Row Interactions & Templates

- **Row click** (all five): `end` handler binds `$('#<tableId> tbody > tr').on('click', …)` → reads `td[data-contact="steam_id"]` → `player.open(steam_id)` → opens the shared player-detail modal for the **primary** actor (killer / deceased / medic / attacker / offender).
- **Kills only**: config sets `template: $('#kill_template > div')` and `mode: isMobile ? 'list':'table'`. `#kill_template` (a `.hide` panel) renders each event as a card with two `[data-action="player"]` "открыть" (open) buttons — one carrying `data-table="steam_id"` (killer), one `data-table="victim_steam_id"` (victim) — so on kills **both parties are one-click openable**. The other four pages have no bespoke template and only the primary `steam_id` is openable from the grid.

### 13.7 Actions / Admin Capabilities

**Page-owned action surface** (all reads; `Action()` → `POST /ajax/<script>.php`, body starts `action=<action>`):

| UI trigger | `action` | `script` → endpoint | Body params | Effect | Destructive |
|---|---|---|---|---|---|
| Load/paginate rows | `<table>` (e.g. `playerKills`) | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` [`, pagination`] | Fetch/count log rows | N |

The only mutation surface reachable from these pages is the **shared player-detail modal** opened on row click. Those actions belong to the shared-modal chapter; catalogued here (from the embedded modal markup + `action_catalog.txt`) as the admin capabilities exposed *while triaging a combat-log row*:

| Modal action | `script` → endpoint | Body (key params) | Destructive | Purpose |
|---|---|---|---|---|
| `ban` | `squad` → `/ajax/squad.php` | `server_id, steam_id, reason_id, description, days` | Y | Ban player |
| `kick` | `squad` | `server_id, steam_id` | Y | Kick from server |
| `kill` | `squad` | `server_id, steam_id` | Y | Force-kill in game |
| `changeTeam` | `squad` | `server_id, steam_id` | Y | Swap team |
| `removePlayer` | `squad` | `server_id, steam_id` | Y | Remove from squad/server |
| `unban` | `squad` | `ban_id` | Y | Lift ban |
| `changeGroup` | `player` → `/ajax/player.php` | `steam_id, group_id` | Y | Change admin/permission group |
| `mark` | `player` | `steam_id` | Y | Flag/mark player |
| `message` | `player` | `steam_id, msg` | Y | In-game message |
| `addComment` / `getComments` | `player` | `steam_id[, text]` | Y / N | Admin comments |
| `addBanName` / `removeBanName` | `player` | `name` | Y | Forbidden-name list |
| `kitSave` | `player` | `steam_id, kit` | Y | Save player kit |
| `checkBans` | `player` | `steam_id` | N | Cross-check ban status |
| `twink` / `twinkOnline` | `player` | `steam_id` | N | Alt-account detection |
| `findFriends` | `player` | `steam_id` | N | Social-graph lookup |
| `kits` | `player` | `steam_id` | N | Kit history |
| `getPlayerOnlineData` | `player` | `steam_id` | N | Online-time chart |
| `downloadStat` | `player` | `steam_id` | N (export) | Stat export via `post_to_url()` form-submit |

`Action()` semantics (`custom.js` L284): non-`ok` `status` → `error()` alert; `text.auth===true` → `location.reload()` (session/permission failure); `retryAbort` aborts a prior in-flight call of the same `name`; body built by mapping the `data` object to `&k=v` pairs with `action=<action>` prepended.

### 13.8 Permission / Visibility Logic

- No role/group gating in the page-own markup — filter rail and table are unconditionally present. Page-level access is enforced server-side by `page.php`; mutation authorization server-side by `squad.php`/`player.php`. Client only reacts to `auth:true` by reloading.
- `class="hide"` and the inline `#<tableId> > tbody > tr > td:first-child{display:none}` CSS are pure layout/data-plumbing (hidden `steam_id` cell, hidden `#kill_template`, hidden `#player_info`), **not** role-based visibility.
- Server multiselect is pre-scoped to this tenant's six servers, implicitly constraining every query to owned servers.
- Teamkills' `player_group`/`killed_group` are the only role/group data surfaced, and only as null placeholders in the payload (no UI treatment).

### 13.9 Date-Range Presets (shared `dateRange` widget)

The `-date` button opens the shared picker (`custom.js` L1206+). Full preset set (writes `t1.date.startdate`/`.enddate` epoch bounds into the search `text` bucket):

`justDay, justWeek, justMonth, justYear, range (custom), allTime (default, 0/0), last24h, today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days, last60days, last90days, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year`.

Default is `allTime` → `startdate:0, enddate:0` (matches every captured request body).

### 13.10 Competitively Interesting Details

- **Five pages, one event model.** kills/deaths/revives/damages/teamkills are the same `t1`-anchored event join re-projected under swapped player aliases. A competing panel could unify them into one "Combat Log" view with an event-type facet — less nav clutter, one query template.
- **Damage magnitude is captured but hidden.** `playerDamage.damage` (e.g. `"32"`) ships in every row yet is excluded from `collum`, so it is never displayed or sortable. Surfacing + sorting by damage is a clear differentiator.
- **Teamkills is passive.** Payload even carries `player_group`/`killed_group`, but there is no forgive/punish/auto-kick, no per-player TK tally, no repeat-offender surfacing. Friendly-fire moderation tooling is an obvious gap to beat.
- **Two queries per load, one a full `COUNT(*)`.** The pagination call runs 0.1–2.76 s over 0.65M–13.4M-row tables. Keyset/cursor pagination and cached/approximate counts would dramatically outperform.
- **Raw SQL aliases leak to the client** (`data-search="t2.player"`, `t1.date`, etc.) — maintenance smell + mild info-leak. Map filters to opaque field names server-side.
- **Uneven interaction affordance.** Only kills makes the victim one-click openable (via `#kill_template`); on the other four grids only the primary subject opens. Making every named party openable everywhere is a small, high-value polish.
- **Server pre-renders HTML into JSON** (`server` badge everywhere; `player`/`killed`/`kit` on teamkills). Convenient but couples data to presentation and inflates payloads — a clean data/view split is a maintainability win.
- **Generous date presets** (21 presets incl. relative and forward-looking `plus*`, `allTime` default) — a solid baseline to match.
