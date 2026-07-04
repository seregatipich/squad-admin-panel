## 09. Ban Management

### 1. Purpose and Navigation

- **Nav id / entry point:** `bans` → `pageLoad('bans')` → `GET /ajax/page.php?page=bans`, HTML fragment injected into `#content`.
- **Purpose:** A searchable, paginated register of every ban ever issued on the project (the "ban archive"). It is a *read/lookup* surface: the list shows who is/was banned, why, when, and until when. All *mutation* of a ban (issue, extend, revoke) is performed not from a row form but from the **shared player-detail modal** that opens when you click a row.
- **Related pages that reuse the exact same machinery:** `collabans` (collaborative / shared cross-community ban list — identical fragment, action set, and modal) and `admins` / `chat` / `clan_*` (which also embed the same player modal with `ban`/`unban`/`checkBans`). This section documents `bans`; where behavior is shared it is called out.

The page is a two-column layout: a fixed left **filter sidebar** (`col-md-3`, `position:fixed`) and a right **results table** (`col-md-9`).

---

### Live API Contracts

> Ground truth captured 2026-07-04 from `breaking.sqstat.ru` with a read-only headless browser. Source: `caps/bans/bans.network.json`. Mutations were network-intercepted and aborted (`caps/bans/_blocked.json` = `[]`), so ban/unban/addBanName request shapes below are reconstructed from the inline modal JS in `caps/bans/bans.content.html` / `collabans.content.html`, not from a fired write.

#### C-1. Page fragment load

| Attribute | Value |
|---|---|
| Method + path | `GET /ajax/page.php?page=bans` |
| Response | `text/html; charset=UTF-8`, ~114 KB HTML fragment injected into `#content` |
| Body | filter sidebar + `#banPlayers` table shell + full shared player-detail modal markup + inline `<script>` |

#### C-2. Ban list read — `POST /ajax/table.php` (action `banPlayers`)

This is the sole data read of the page (fired once on load by `buildTable`).

**Request (form-urlencoded):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string const `banPlayers` | Y | Server table id / router key. |
| `table` | string const `banPlayers` | Y | Duplicated table id. |
| `page` | int (1-based) | Y | Page number. |
| `numrows` | int, `100` | Y | Page size. |
| `search` | URL-encoded JSON | Y | Filter object (5 buckets, see below). |
| `order_by` | string \| `false` | Y | Sort column key (one of the `collum` set) or literal `false` = default order. |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction or `false`. |
| `pagination` | `true` | N | When appended, returns only the count envelope (§C-3) instead of rows. |

`search` JSON shape (captured verbatim, default state): `{"text":{},"check":{"permanent":"false"},"multiselect":{},"managers":{},"slider":{}}`. Buckets: `text` = free-text inputs keyed by their `data-search` SQL alias; `check` = checkbox flags (`permanent` = `"true"`/`"false"` string); `multiselect`, `managers`, `slider` unused on this page.

**Response** `application/json`, `status:"ok"`:

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 in the row-fetch call; real value comes from the `pagination=true` call). |
| `data.totalRows` | int | Row count (0 in row-fetch; real value from pagination call). |
| `data.currentPage` | string | Echo of requested page ("1"). |
| `data.row[]` | array of ban objects | The page of bans (see per-row shape). |
| `data.custom` | bool | Custom-render flag (observed `false`). |
| `data.query_time` | float (seconds) | Server SQL time for the row query. |
| `data.count_time` | int/float (seconds) | Server SQL time for the count query (0 when not counting). |
| `status` | string enum `"ok"` | Result status; anything else / `auth:true` forces a client reload. |
| `exec_time` | float (seconds) | Total server handler time. |

**Per-row object `data.row[i]` (LIVE-captured field set — this supersedes prior column inference):**

| Field | Type | Meaning |
|---|---|---|
| `id` | string (numeric) | Ban record PK (`t1.id`), used as `data-id` / `trID-<id>` on the row. |
| `steam_id` | string (Steam64) | Banned player identity; rendered hidden in `<hashtag>`, drives `player.open()`. |
| `name` | string | Player nick at ban time (may contain markup escaped by server). |
| `reason` | string | Reason text; **note it embeds the expiry as trailing `… до DD.MM.YYYY HH:MM`** in the same string. |
| `description` | string (may be empty `""`) | Free-text admin comment. |
| `admin_id` | string (Steam64) | **Issuing admin's SteamID** (raw id, NOT a resolved name — the modal resolves the name separately). |
| `date` | string (**unix seconds**) | When the ban was issued, e.g. `"1783085160"`. Client formats via `data-unix` badge. |
| `expire` | string (**pre-rendered HTML**) | Server returns a ready `<span class="badge …">DD.MM.YYYY HH:MM</span>` fragment, NOT a raw timestamp. Permanent bans render a distinct badge. Client injects it verbatim. |
| `unban` | string enum `"0"`/`"1"` | Boolean-as-string: `"1"` = ban was revoked (kept in history), `"0"` = active. |

Redacted example row:

```json
{ "id": "30900", "steam_id": "<steam64>", "date": "1783085160",
  "reason": "Спец кит   тех пех до 04.07.2026 16:26", "description": "",
  "admin_id": "<steam64>", "expire": "<span class=\"badge bg-primary\" style=\"…\">04.07.2026 16:26</span>",
  "unban": "0", "name": "<nick>" }
```

#### C-3. Lazy pagination count — `POST /ajax/table.php` … `&pagination=true`

A second, deferred call (same body + `&pagination=true`) returns only the count envelope so the pager can be drawn without blocking the row render:

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Number of pages at the current `numrows`. |
| `totalRows` | int \| string | Total matching rows. **Type is inconsistent across tables** — `ban_names` returns it as a string (`"371"`), `collabans` as an int (`17510`). Treat as numeric. |
| `count_time` | int/float (seconds) | SQL count time (logged to console). |
| `status` | `"ok"` | Status. |
| `exec_time` | float | Handler time. |

#### C-4. Ban mutation contracts (reconstructed from modal JS — never fired)

`Action({script, action, data})` → `POST /ajax/<script>.php` with body `action=<action>&<data>`. Success predicate: `text.status == 'ok'`; `text.auth === true` ⇒ session expired ⇒ full reload.

| Action | script → endpoint | Request data | Response (on success) | Destructive |
|---|---|---|---|---|
| `ban` | `squad` → `POST /ajax/squad.php` | query string: `server_id` (only when `player.info.online`), `steam_id`, `reason_id` (= `#player_ban-reason` select value), `description` (= textarea), `days` (= checked `player_ban-reason_type` radio value; `0` = permanent, `-1` = kick) | `{status:'ok'}`; client removes player from `#players` and refreshes active server | **Y** |
| `unban` | `squad` → `POST /ajax/squad.php` | JSON `{steam_id: string, unban: bool}` — `unban:true` (the `#unban-error` toggle) **fully erases** the ban; `false` lifts it but keeps history (`unban="1"`) | `{status:'ok'}`; modal flips + reloads player | **Y** |
| `addBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` (the current nick) | `{status:'ok'}`; reopens player | **Y** |
| `removeBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` | `{status:'ok'}`; reopens player | **Y** |
| `checkBans` | `player` → `POST /ajax/player.php` | JSON `{steam_id: string}` | `{status:'ok', projects:[…]}` (see §C-5) | N (read) |
| `changeExpire` | `clan` → `POST /ajax/clan.php` | ban-expiry edit (defined on `clan_16`, not on `bans`) — adjusts an existing ban's `expire` | `{status:'ok'}` | **Y** |
| `get` | `player` → `POST /ajax/player.php` | JSON `{steam_id}` (fired on row-click) | full `player.info` object | N (read) |

#### C-5. `checkBans` response — cross-project ban intelligence

Consumed by `player.checkbans()`; renders one card per federated community in `#player_findban-list`.

```
{ status:'ok',
  projects: [ {
    name:     string,           // community/project name
    discord?: string(url),      // optional Discord invite → icon link when present
    online:   int (seconds),    // player's total playtime on that project (secToTime)
    ban: {
      total:   int,             // punishment count → "Наказаний: N" (0/absent ⇒ "Нет наказаний")
      current: null | {         // presence flips icon red-ban vs green-check
        reason: string,
        date:   int (unix),     // ban start
        expire: int (unix) | "0"  // "0" ⇒ "Перманент", else From/To range
      }
    }
  } ] }
```

#### DataTables config (client `buildTable`, from `bans.content.html`)

| Setting | Value |
|---|---|
| `table` (action id) | `banPlayers` |
| `collum` (column keys) | `["steam_id","name","reason","date","expire"]` |
| `order` (sortable keys) | `["steam_id","name","reason","date","expire"]` |
| `numrows` (page size) | `100` |
| `mode` | default (table) |
| `searchInput` | `["banPlayers-name","banPlayers-admin","banPlayers-startdate","banPlayers-enddate","banPlayers-permanent","banPlayers-reason","banPlayers-description"]` |
| default sort | `order_by=false`, `order_sort=false` (server default) |
| row click | `player.open( td[data-contact=steam_id] > hashtag .text() )` |

---

### 2. Entities & Fields

#### 2.1 Ban (the row entity — table `banPlayers`, server-side view over `t1`)

Field set is now confirmed against the live `banPlayers` response (§C-2); the `Origin / alias` column maps each response field to its filter `data-search` SQL alias.

| Field | Response key / filter alias | Type | Meaning |
|---|---|---|---|
| `id` | `row.id` | string (numeric) | Ban record PK (`t1.id`); becomes `data-id`/`trID-<id>`. |
| `steam_id` | `row.steam_id` / filter `t2.player` | string (Steam64), rendered in `<hashtag>` | Banned player identity. Column CSS-hidden (`class="hide"` + `td:first-child{display:none}`) but drives row-click. NB other panels migrated identity to a UUID; here it is still the SteamID. |
| `name` | `row.name` / filter `t2.player` | string | Player nick at ban time. |
| `reason` | `row.reason` / filter `t1.reason` | string | Reason text; **embeds the expiry as trailing `… до DD.MM.YYYY HH:MM`**. |
| `date` | `row.date` | string (**unix seconds**) | When issued ("Забанен"); e.g. `"1783085160"`. |
| `expire` | `row.expire` (column "До") | string (**pre-rendered HTML badge**) | Server returns a ready `<span class="badge …">` — not a raw timestamp. Empty/permanent renders a distinct badge. |
| `unban` | `row.unban` | string `"0"`/`"1"` | `"1"` = ban revoked (kept in history), `"0"` = active. |
| `description` | `row.description` / filter `t1.description` | string, may be `""` (≤512 chars) | Free-text admin comment; searchable + shown in modal. |
| `admin_id` | `row.admin_id` / filter `t3.player` | string (Steam64) | **Issuing admin's SteamID** (raw id in the row; name resolved separately in `#player_info_ban-admin`). |
| `impact` | `ban.impact` (modal only) | bool | Whether this ban counts toward *progressive* escalation ("Влияет на наказание"). |
| `permanent` | filter `permanent` (check bucket) | bool-as-string `"true"`/`"false"` | Filter-only flag (`expire == 0`). |

SQL aliasing exposed by the `data-search` attributes reveals the underlying join: **`t1` = bans**, **`t2` = banned player**, **`t3` = issuing admin**.

#### 2.2 Player (context object `player.info`, loaded by `script:'player', action:'get'`)

The row click loads the full player object; ban-relevant sub-fields:

| Field | Meaning |
|---|---|
| `player.info.ban` | The *current active* ban ( `{reason, expire, date, admin_name, description}` ), or falsy if none. |
| `player.info.bans[]` | Full ban **history** array (`{admin_name, date, reason, description, impact, unban}`), rendered in the modal's "Наказания" accordion. |
| `player.info.canBan` | Permission flag — may this admin issue bans on this player. |
| `player.info.canUnban` | Permission flag — may this admin revoke the current ban. |
| `player.info.canPermanent` | Permission flag — may issue a permanent ban. |
| `player.info.progressiveBan` | Whether progressive/escalating durations apply to this player. |
| `player.info.name_banned` | Whether the player's *nick* is currently name-banned. |
| `player.info.online` | If set, contains `online.server.id` — used to scope live bans to a server. |

#### 2.3 Reason (rules catalog — the ban `<select>`)

| Attr | Meaning |
|---|---|
| `value` | Rule id (`reason_id`) sent to backend, e.g. `1`=`0.1 Другое (Other)`, `2`=`0.2 DPAC anti-cheat`, `110`=`1.1 Оскорбления (Insults)`, `160`=`1.6 Cheating/exploits`, `173`=`Teamdamage`. |
| `data-first` / `data-second` / `data-third` / `data-four` | Escalating ban length in **days** for the 1st/2nd/3rd/4th qualifying offense (progressive ban tiers). `data-four="30"` is the common cap. |
| `<optgroup>` | Rule category: Особые (Special), Общие (General), Для сквадных (Squad leaders), Для техники (Vehicles), Милсим (Milsim). |

---

### 3. The Page's OWN Table & Controls

**Table `#banPlayers`** — DataTables-style *server-side* grid built by the custom `$.fn.buildTable` helper (`custom.js`), not native DataTables.

**Columns (own table only — NOT the modal):**

| # | Header | Key | Notes |
|---|---|---|---|
| 0 | SteamID | `steam_id` | Hidden; wrapped in `<hashtag>`, feeds row-click. |
| 1 | Ник (Nick) | `name` | 200px, centered. |
| 2 | Причина (Reason) | `reason` | Flexible width. |
| 3 | Забанен (Banned) | `date` | 130px. |
| 4 | До (Until) | `expire` | 130px; empty/`0` ⇒ permanent. |

`buildTable` config: `numrows: 100`, `collum/order: ["steam_id","name","reason","date","expire"]`. Full contract in §C-2.

**Data request (competitively important):** `POST /ajax/table.php` with `action=banPlayers&table=banPlayers&page=<n>&numrows=100&search=<urlencoded-json>&order_by=<col|false>&order_sort=<asc|desc|false>`. The `search` JSON has 5 buckets `{text,check,multiselect,managers,slider}` (see §C-2). A **separate** call with `&pagination=true` returns `{totalPage,totalRows,count_time,status,exec_time}` so page count is computed lazily (server logs the SQL count time to the browser console).

**Filter sidebar controls** (each carries a `data-search` SQL alias; all feed the JSON `search` payload):

| Control | id | `data-search` | Type | Effect |
|---|---|---|---|---|
| Поиск (Search) button | `banPlayers-btn` | — | button | Triggers rebuild. |
| Ник или SteamID | `banPlayers-name` | `t2.player` | text | Match player nick/SteamID. Enter key submits. |
| Админ (Admin) | `banPlayers-admin` | `t3.player` | text | Match issuing admin. |
| Причина (Reason) | `banPlayers-reason` | `t1.reason` | text | Match reason text. |
| Комментарий (Comment) | `banPlayers-description` | `t1.description` | text | Match admin comment. |
| Перманенты (Permanents) | `banPlayers-permanent` | `permanent` | checkbox | Show only permanent bans; `change` re-runs the table immediately. |
| Start/End date | `banPlayers-startdate` / `-enddate` | — | datetimepicker (ru) | Wired in `searchInput` as a date range (pickers initialized even though the visible inputs are collapsed in this fragment). |

**Sorting:** click a `<th>` (each carries a `data-sort`); toggles `order_by`/`order_sort` asc↔desc, page resets to 1.
**Pagination:** numeric pager with first/prev/next/last, window of 9 pages (3 on mobile); shows "Страница X из Y — Всего: N".
**Row click:** `player.open( <hashtag> text )` opens the shared player-detail modal for that SteamID.

---

### 4. Actions / Admin Capabilities

All ban mutations route through the shared player modal. `Action` helper posts `action=<id>&<data>` to `/ajax/<script>.php`; success requires `text.status=='ok'` (else `text.auth===true` forces a full reload — session expiry).

| UI label | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| Наказать (Punish) → issue ban | `ban` | `squad` → `/ajax/squad.php` | `server_id` (if online), `steam_id`, `reason_id` (rule value), `description`, `days` (radio value: N days, `0`/`-1`=permanent) | Creates/records a ban; removes player from live `#players` grid and refreshes active server. | **Y** |
| Кикнуть (Kick) | `kick` | `squad` → `/ajax/squad.php` | `steam_id`, `reason_id`, `description`, `noReason:false` | Kicks online player with a reason. | **Y** |
| Кикнуть без причины (Kick, no reason) | `kick` | `squad` | same + `noReason:true` | Kick without stated reason (confirm dialog). | **Y** |
| Разбанить (Unban) | `unban` | `squad` → `/ajax/squad.php` | `steam_id`, `unban` (bool: "issued in error" → **fully erase** the ban vs. just lift it) | Revokes the active ban; re-opens modal with flip animation. | **Y** |
| Забанить ник (Ban nick) | `addBanName` | `player` → `/ajax/player.php` | `name` | Name-ban: blocks the player's current nick. | **Y** |
| Разбанить ник (Unban nick) | `removeBanName` | `player` → `/ajax/player.php` | `name` | Lifts a name-ban. | **Y** |
| Проверить баны (Check bans) | `checkBans` | `player` → `/ajax/player.php` | `steam_id` | **Cross-project ban lookup** — returns `{projects:[{name, discord, online, ban:{total, current:{reason, date, expire}}}]}` and renders a per-community grid of ban status. | N (read) |
| Скачать статистику (Download stats) | `downloadStat` | `player` → `/ajax/player.php` | `steam_id` | Builds a hidden auto-submitting form (`post_to_url`) → file download. | N |
| Заявка в OWI (OWI report) | (client only) | — | — | `copyReport()` copies a formatted cheat-report (Name / EOSID / SteamID / Steam URL) to clipboard for the official Offworld ban appeal channel. | N |
| Метка (Mark) 1–8 / снять | `mark` | `player` | mark id | Flags suspicion (WallHack/AimBot/SpeedHack/spawn/reload/grief/config/toxic). | Y |
| Смена группы (Change group) | `changeGroup` | `player` | group id, expire | Assigns role/VIP (gated by `canChangeGroup`). | Y |
| Команда (Change team) | `changeTeam` | `squad` | `server_id`, `steam_id` | Force-swap team (online only). | Y |
| Убить (Kill) | `kill` | `squad` | `server_id`, `steam_id` | Kills player, dissolves their squad. | Y |
| Поиск твинков (Find alts) | `twink` | `player` | steam_id | Alt-account detection. | N |
| Комментарии (Comments) | `addComment`/`getComments` | `player` | steam_id, text | Internal admin notes on the player. | Y/N |

*(kick/kill/team/mark/kits/message/twink/comments belong to the shared modal and appear on every page — listed here for completeness, but the **ban-specific** capabilities are `ban`, `unban`, `addBanName`, `removeBanName`, `checkBans`.)*

---

### 5. Forms & Modals

#### 5.1 Punishment form (`#player_ban`, reached via `player.flipBan()` — a card *flip*)

- **Reason select** `#player_ban-reason` (multiselect, filterable, HTML-enabled) — the rules catalog (§2.3). Value `false` = "-Выберите причину- (Choose reason)".
- **Duration radios** `name="player_ban-reason_type"` — preset tiles rendered as colored boxes: **Кикнуть (Kick)** `value=-1 data-action=kick`; **Забанить N дн.** for N ∈ {1,2,3,4,5,6,7,10,14,30} (`data-action=ban data-day=N`, amber); **Забанить навсегда (Ban forever)** `value=-1 data-action=ban data-day=0` (crimson).
- **Progressive-ban logic (`banRadio`):** when `player.info.progressiveBan` is on, the reason's `data-first/second/third/four` values relabel the tiers, and only tiers up to `(#prior impact bans + 1)` are enabled; deeper tiers are disabled with a tooltip "Необходимо наказаний N (need N more punishments)". The last enabled tier is auto-checked and tooltipped "Рекомендуемое (Recommended)". Non-progressive players get all tiers enabled.
- **Permanent tier** only injected when `canPermanent && progressiveBan`.
- **Comment** `#player_ban-description` — textarea, `maxlength=512`.
- **Submit** `#player_ban-btn` → `player.actionPlayer()` — dynamically relabels to "Забанить на Nдн." / "Кикнуть" / "Забанить навсегда", disabled until a valid reason+tier is chosen. Routes to `banPlayer()` or `kickPlayer()` by the checked radio's `data-action`. "Игрок (Player)" button flips back.

#### 5.2 Unban dialog (`player.unban`)

Confirmation modal with a toggle **"Бан был выдан по ошибке" (Ban was issued by mistake)** → `unban-error` checkbox. Help text: *"Если включить, то бан полностью будет стёрт" (if enabled the ban is fully erased)*. Distinguishes a normal lift (kept in history, `unban=1`) from an error-erase.

#### 5.3 Check-bans modal (`#player_findban-modal`)

Grid of community cards from `checkBans`: per project shows name, Discord link, aggregate online time, total punishments, and current ban (reason + From/To dates, or "Перманент"), with a red ban / green check icon.

#### 5.4 Active-ban banner (`#player_info_ban`)

When `player.info.ban` exists: shows "до <date>" or "НАВСЕГДА", reason, admin, issue date, and comment (or "Без комментария"). The "Наказать" button is hidden and, if `canUnban`, an "Unban" button + corner badge appear.

---

### 6. Permission / Visibility Logic

Visibility is server-driven via boolean flags on `player.info`; the client shows/hides buttons accordingly (default state is `display:none` / `class="hide"`, revealed on load):

| Element | Gate |
|---|---|
| "Наказать" (issue ban) | shown only if **no active ban** AND `canBan`. |
| "Разбанить" (unban) + corner | shown only if active ban AND `canUnban`. |
| Забанить/Разбанить ник | requires `canBan`; which one shows depends on `name_banned`. |
| Киты (kits) menu | requires `canBan`. |
| Смена группы (group) | requires `canChangeGroup`. |
| Проверить баны / Поиск твинков / Скачать статистику / Копировать телепорт | ungated (visible to all admins who can open the modal). |

The ban list page itself has no per-row gating — filtering/reading is available to anyone who can open `bans`. The distinction between the regular `bans` page and `collabans` (collaborative/cross-community ban list) is the primary scope boundary.

---

### 7. Notable UX & Competitive Takeaways

1. **Progressive ban engine** — the single strongest feature to match/beat. Each rule carries escalating day-counts (1st→2nd→3rd→4th offense), the UI auto-recommends the correct tier based on the player's prior *impact* bans, and locks tiers the player hasn't "earned" yet. This turns ban duration into policy-as-data, not admin discretion. Note the visible cap at 30 days before permanent.
2. **Cross-project ban check (`checkBans`)** — one click surfaces the player's ban status across *every* federated community, with Discord links and current-ban details. This is a network-effect moat (shared reputation). `collabans` is the collaborative list backing it.
3. **Error-erase vs. lift** on unban — preserving revoked bans in history (`unban=1`, still shown greyed with "Игрок был разбанен") vs. fully deleting mistaken bans is a thoughtful audit distinction worth copying.
4. **Server-scoped issuance, global archive** — `ban` sends `server_id` when the target is online (live enforcement on that server) but the archive/list is project-wide.
5. **Rich, aliased server-side search** (`t1/t2/t3` joins over reason, banned player, admin, comment, permanent flag, date range) with lazy pagination counting — fast even over very large ban tables.
6. **OWI report generator** — pre-formats an official cheater-report payload (Name/EOSID/SteamID/Steam URL) to clipboard, smoothing the appeal-to-developer workflow.
7. **Everything runs inside one draggable, flip-animated player modal** shared across all pages — consistent muscle memory for admins; the ban list is just one of many entry points into it.
8. **Name bans** are a distinct axis from account bans (`addBanName`/`removeBanName` on nick text), useful against impersonation/tag abuse.

> Scope note: the shared modal's tabbed tables (Chat/Kills/Deaths/Kits/Games/Comments and columns Дата/Чат/Сообщение/Убил/Кит/Карта/Оружие/Урон/Техника…) are **not** part of the bans page's own schema — they are the ubiquitous player-detail modal and are documented with the player entity, not here.
