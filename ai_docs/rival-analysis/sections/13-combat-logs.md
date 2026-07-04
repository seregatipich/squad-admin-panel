## 13. Combat Logs: Kills, Deaths, Revives, Damage, Teamkills

### 13.1 Purpose and Navigation

SQSTAT exposes five near-identical combat-event log pages, each a filterable, server-side-paginated table over one class of in-game combat event. They are separate nav entries that call `pageLoad('<page>')` → `GET /ajax/page.php?page=<page>`, each returning an HTML fragment injected into `#content`.

| Page id | Fragment file | Table DOM id | Event logged |
|---|---|---|---|
| `kills` | `kills.html` | `#playerKills` | A player killed another player (weapon recorded) |
| `deaths` | `deaths.html` | `#playerDeath` | A player died (subject + weapon that killed them) |
| `revives` | `revives.html` | `#playerRevive` | A medic revived a downed player |
| `damages` | `damages.html` | `#playerDamage` | A damage-dealt event (attacker, victim, weapon) |
| `teamkills` | `teamkills.html` | `#playerTeamkill` | A friendly-fire kill (attacker + victim, same team) |

All five share the identical two-pane layout: a fixed left filter rail (`col-md-3`, `position:fixed`) and a right results table (`col-md-9`). All five also embed the shared **player-detail modal** (`#player_info`, `#playerModal`) with its Chat/Kills/Deaths/Kits/Games/Comments tabs and ~22 actions. That modal is documented separately; below, the page's OWN table/controls are strictly separated from the shared modal, and the modal's columns (Чат/Сообщение/Кит/Карта/Победа/Урон etc.) are NOT attributed to these pages.

### 13.2 Data Model (inferred)

Each row of a combat log is a **combat event** joining an event table to one or two **player** records. The client column keys (`collum` array in `buildTable`) plus the row template reveal the fields.

**Combat event entity (per row)**

| Field key | UI column | Meaning / type | Present in |
|---|---|---|---|
| `steam_id` | (hidden, `class="hide"`) | SteamID64 of the primary/subject player; used to open the player modal on row click | all 5 |
| `victim_steam_id` | (hidden, in row template) | SteamID64 of the secondary player (the "Кого"/victim); makes the target clickable | kills (confirmed in template); implied for damage/revive/teamkill |
| `server` | server icon column | Server the event occurred on (rendered as an icon/badge; backing value is `server_id`) | all 5 |
| `date` | Дата (Date) | Event timestamp; rendered client-side via `formatDate(data,false,true)` | all 5 |
| `player_name` | Кто (Who) / Игрок (Player) | Display name of the primary actor (killer / medic / attacker / the deceased) | kills, deaths, revives, damages |
| `player` | Кто (Who) | Same role as `player_name` but keyed `player` on the teamkill table | teamkills |
| `name` | Кого (Whom) | Display name of the secondary player (victim / revived player) | kills, revives, damages |
| `killed` | Кого (Whom) | Same role as `name` but keyed `killed` on the teamkill table | teamkills |
| `weapon` | Оружие (Weapon) | Weapon/entity used | kills, deaths, damages |

**Server entity (filter `<option>` set, shared across all 5 pages)**

| server_id | Label |
|---|---|
| 1 | `RAAS/AAS #1` |
| 6 | `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2) |
| 7 | `INVASION #3` |
| 9 | `Custom для FW` |
| 10 | `Custom для MDC` |
| 11 | `Custom для BSS` |

Note the id gap (no 2–5, 8): the server list is filtered to this panel's own servers.

**Underlying SQL join aliases (leaked via `data-search`).** The filter inputs carry raw table-alias.column references, exposing the server-side query shape. The same physical event table is joined to player tables under different aliases depending on which side each page treats as "primary":

| Page | "Кто" filter → | "Кого" filter → | Date → |
|---|---|---|---|
| kills | `t2.player` | `t4.player` | `t1.date` |
| deaths | `t5.player` | `t2.player` | `t1.date` |
| revives | `t5.player` | `t2.player` | `t1.date` |
| damages | `t2.player` | `t5.player` | `t1.date` |
| teamkills | `t5.player` | `t2.player` | `t1.date` |

`t1` is the event row (holds `date`, `server_id`); `t2`/`t4`/`t5` are player joins. This confirms combat events are stored once and both parties resolved by join, and it exposes internal schema aliases to the client (a competitive/security note — our panel should not leak raw SQL identifiers into `data-search`).

### 13.3 Page-Own Tables

The primary results table is DataTables-style but driven by SQSTAT's custom `$.fn.buildTable` (in `custom.js`), which fetches rows server-side. The first `<thead class="table-dark">` in each fragment is the page's own table; every later `<thead>` in the file belongs to the shared player-detail modal tabs and is out of scope here.

**Kills — `#playerKills`** (`numrows: 500`)

| # | Column (icon/label) | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (`class="hide"`) | `steam_id` | Hidden; drives modal open |
| 2 | server icon | `server` | 50px, centered |
| 3 | Дата (Date) | `date` | 130px |
| 4 | user icon + Кто (Who) | `player_name` | Killer |
| 5 | crosshairs + Кого (Whom) | `name` | Victim |
| 6 | gun icon + Оружие (Weapon) | `weapon` | |

**Deaths — `#playerDeath`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Subject (the player who died) |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Игрок (Player) | `player_name` | The deceased player |
| 5 | gun + Оружие (Weapon) | `weapon` | Weapon that killed them |

Deaths shows only 5 columns (no explicit "killer" column) yet its filter rail still offers both Кто/Кого inputs — the killer is filterable but not displayed as a table column.

**Revives — `#playerRevive`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Reviving medic |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player_name` | Medic |
| 5 | crosshairs + Кого (Whom) | `name` | Revived player |

No weapon column (revives have no weapon).

**Damages — `#playerDamage`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Attacker |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player_name` | Attacker |
| 5 | crosshairs + Кого (Whom) | `name` | Victim |
| 6 | gun + Оружие (Weapon) | `weapon` | |

Notable: the damages table does **not** surface a numeric damage-amount column, even though the shared modal's own "damage" tab has a Урон (Damage) column. Damage magnitude exists in the model but is omitted from this page's grid — an easy win for a competing panel (show/sort by damage).

**Teamkills — `#playerTeamkill`** (`numrows: 100`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Offender (teamkiller) |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player` | Offender |
| 5 | crosshairs + Кого (Whom) | `killed` | Team victim |

Teamkills uses a lower page size (`numrows: 100` vs 500) and distinct data keys (`player`/`killed` instead of `player_name`/`name`). No weapon column. There is **no dedicated teamkill flag, punishment, forgive, or auto-action UI** on this page — it is a passive log; teamkills are simply the event class filtered to friendly-fire. Enforcement, if any, happens only via the shared modal's ban/kick actions against the offender.

### 13.4 Filters, Search, Sort, Pagination

Left rail controls (identical structure across all five pages; ids prefixed with the table id, e.g. `playerKills-*`):

| Control | id suffix | Type | `data-search` key | Behavior |
|---|---|---|---|---|
| Поиск (Search) button | `-btn` | button | — | Triggers `buildTable()` re-fetch |
| Кто (Who) | `-name` | text | `t2.player` / `t5.player` (page-specific) | Substring match on primary player name; Enter key submits |
| Кого (Whom) | `-killed` | text | `t4.player` / `t2.player` / `t5.player` | Substring match on secondary player name |
| Сервер (Server) | `-server` | Bootstrap multiselect (`multiple`) | `server_id` | IN-list filter; placeholder `- Сервер -`; `enableHTML` |
| Date range | `-date` | `dateRange` button | `t1.date` | Range picker; presets: `justMonth, justDay, justWeek, justYear, range, today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days`; default `allTime` |

Search assembly (`buildTable`, custom.js): filters are collected into a structured object `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` keyed by the raw `data-search` value, URL-encoded (`+` → `%2B`), and sent as the `search` param. Text inputs submit on Enter (`e.which==13`); the date picker re-fetches on its `crm_dateRange` event.

**Fetch mechanism.** `buildTable` issues `Action({script:'table', action:'<tableName>', data:'&table=<tableName>&page=<n>&numrows=<n>&search=<json>&order_by=<col>&order_sort=<dir>'})` → `POST /ajax/table.php`. Pagination is a second `script:'table'` call with `&pagination=true` returning `totalPage`/`totalRows` and a server-timed count (`count_time` logged to console). Sorting is supported by the engine (`order_by`/`order_sort`) but these pages ship with no explicit `order` config, so default server ordering applies. Row fetch timeout is 120 s. Client-side rebuild guard (`tmpTable`) prevents concurrent double-loads of the same table.

### 13.5 Row Interactions & Templates

- **Row click** → `player.open(<steam_id from hidden cell>)`: opens the shared player-detail modal for the primary actor. Wired on all five pages.
- **Kills page only** additionally binds `[data-action="player"]` buttons so the *victim* is also clickable (`player.open` on `victim_steam_id`), and defines a custom mobile-list `kill_template` (`#kill_template`) with `mode: isMobile ? 'list':'table'` and a `date` render callback. The other four pages use the default table renderer, bind only the primary `steam_id` click, and rely on the default responsive table (no bespoke list template). So on kills the target is directly openable; on damages/revives/teamkills only the primary subject is one-click openable from the grid.

### 13.6 Actions / Admin Capabilities

**Page-owned actions (originate on the combat pages themselves):**

| UI label | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| (implicit) load rows | `<tableName>` (e.g. `playerKills`) | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` | Fetch/paginate log rows | N |
| Скачать статистику (Download statistics) | `downloadStat` | `player` → `/ajax/player.php` | `steam_id` | Triggers a stat-export download (`post_to_url`, form-submit) for the opened player | N (read/export) |

The only mutation surface reachable from these pages is via the **shared player-detail modal** opened on row click. Those are not combat-log features per se, but they are the admin capabilities exposed *through* this screen. Summarized (all present in these fragments' embedded modal):

| Modal action | script → endpoint | Destructive | Purpose |
|---|---|---|---|
| `ban` | `squad` → `/ajax/squad.php` | Y | Ban player (`server_id, steam_id, reason_id, description, days`) |
| `kick` | `squad` | Y | Kick from server |
| `kill` | `squad` | Y | Force-kill in game |
| `changeTeam` | `squad` | Y | Move player to other team |
| `changeGroup` | `player` | Y | Change admin/permission group |
| `removePlayer` | `squad` | Y | Remove player from squad/server |
| `unban` | `squad` | Y | Lift ban |
| `mark` | `player` | Y | Flag/mark player |
| `message` | `player` | Y | Send in-game message |
| `addComment` / `getComments` | `player` | Y / N | Admin comments on player |
| `addBanName` / `removeBanName` | `player` | Y | Manage forbidden-name list |
| `checkBans` | `player` | N | Cross-check ban status |
| `twink` / `twinkOnline` | `player` | N | Alt-account (twink) detection |
| `findFriends` | `player` | N | Social-graph lookup |
| `kits` / `kitSave` | `player` | N / Y | Player kit history / save |
| `getPlayerOnlineData` | `player` | N | Online-time chart data |

(Full modal spec belongs to the shared-modal section; listed here only to document what an admin can do while triaging a combat-log entry.)

### 13.7 Permission / Visibility Logic

- No role/group gating is expressed in these fragments' page-own markup — the filter rail, table, and Download-statistics link are unconditionally present. Access control to the pages themselves is enforced server-side (`page.php`) and to mutations server-side (`squad.php`/`player.php`); the `Action` wrapper reloads the page if a response carries `auth:true` (session/permission failure).
- `class="hide"` is used purely for layout/data plumbing (hidden `steam_id`/`victim_steam_id` cells, hidden `#player_info` template), not for role-based visibility on these pages.
- Server multiselect is pre-populated only with this tenant's six servers, implicitly scoping every query to servers the admin owns.

### 13.8 Competitively Interesting Details

- **Five separate pages for one event model.** Kills/deaths/revives/damages/teamkills are the same joined event table re-projected. A competing panel could unify these into one "Combat Log" view with an event-type facet, cutting nav clutter and code duplication.
- **Damage magnitude is captured but never shown** on the damages grid (only the killer/victim/weapon). Surfacing and sorting by actual damage numbers is a clear differentiator.
- **Teamkills is a passive log** — no forgive/punish/auto-kick/teamkill-count workflow, no per-player TK tally on the page. Friendly-fire moderation tooling (thresholds, auto-flag, repeat-offender surfacing) is an obvious gap to beat.
- **Big page sizes** (`numrows: 500` for most, 100 for teamkills) with a separate count query per page — heavy for large servers; cursor/keyset pagination would outperform.
- **Raw SQL aliases leak to the client** via `data-search="t2.player"` etc. This is both a maintenance smell and a mild info-leak; our panel should map filters to opaque field names server-side.
- **Consistent UX**: fixed filter rail, icon-labeled columns, one-click row → rich player modal with immediate moderation actions. The row→modal→ban/kick flow is tight and worth matching. Weakness: on non-kills pages only the primary player is clickable from the grid; making every named party openable everywhere is a small, high-value polish.
- **Date presets** are generous (12 range presets incl. `allTime` default) — a good baseline to match.
