## 20. Top Online Leaderboard (Топ онлайна)

### 1. Purpose and nav location

A player activity leaderboard that ranks players across the whole database by cumulative online time, accrued bonuses, or boost. It is a pure read/browse page: a left-hand search/filter rail plus a right-hand ranked table. Clicking any row opens the shared **player-detail modal** for that player.

- **Page id:** `top`
- **Invoked by:** `pageLoad('top')` → `GET /ajax/page.php?page=top` → HTML fragment injected into `#content`.
- **Nav visibility:** marked **[hidden]** — there is no `top-menu` link that calls `pageLoad('top')`. The page is reachable only by directly invoking `pageLoad('top')` (e.g. console, deep link, or a conditionally-rendered menu entry). See §6 for the visibility inference.
- **Fragment file:** `frags/top.html`. Lines 1–88 are the page's own content; lines ~90–2811 are the **shared player-detail modal** (`#playerModal` / `#player_info`) that is embedded on every page and must NOT be attributed to this page.

The page's own footprint is deliberately tiny: one filter rail, one table, one inline `$(document).ready` bootstrap.

---

### 2. Entities & fields

#### 2.1 Leaderboard row (the `topPlayers` table dataset)

Server-side rows are fetched via `script:'table'` (DataTables-style). The client maps six columns by key (`custom.js` `buildTable` call, top.html:75): `['place', 'steam_id', 'name', 'online', 'bonuses', 'boost']`.

| Field | Source key | Type | Meaning |
|---|---|---|---|
| Rank | `place` | int | 1-based rank position within the current sort/filter/page. |
| Steam ID | `steam_id` | string(17) | Player SteamID64. Rendered inside a `<hashtag>` element (via the `hashtag` column formatter) and used as the click key to open the modal. |
| Nickname | `name` | string | Player's display nick (aliased in search as `t2.name`, i.e. the joined player/identity table `t2`). |
| Online | `online` | duration | Cumulative playtime metric — the primary ranking value (clock icon `fa-clock-o`). Rendered server-side as human-readable time. |
| Bonuses | `bonuses` | int | Accumulated bonus points (gift icon `fa-gift`). |
| Boost | `boost` | number | Boost metric / multiplier contribution (double-up icon `fa-angle-double-up`). |

Row-level `data-*` (generic to `buildTable`): each `<tr>` may carry `data-id`, `data-toggle="tooltip"`/`data-original-title`, plus any keys under a row `dataset` object. The SteamID cell carries `data-contact="steam_id"` and wraps the value in `<hashtag>`, which the click handler reads.

#### 2.2 Player (as surfaced by the shared modal, for context)

The three leaderboard metrics correspond to fields on the player object loaded into the modal (`player.info`, top.html:1051–1056):
- `playtime.online` (Онлайн / Online), also flagged with a warning icon when a threshold/anomaly condition holds (top.html:1052–1053).
- `bonus` (Бонусы / Bonuses).
- `playtime.boost` (Буст / Boost).

Per-player time-series `online_data` (keyed by timestamp; each point has `minute`, `boost`, `queue`) powers the modal's activity chart — this is the granular counterpart of the leaderboard's aggregate `online`.

---

### 3. The page's OWN table

**Table id:** `topPlayers` — `<table class="table table-hover">`, empty `<tbody>` filled by `buildTable`.

**Columns (as authored in `<thead>`, top.html:42–47):**

| # | Header | Icon | Bound key | Notes |
|---|---|---|---|---|
| 1 | `#` | — | `place` | Width 25px. Rank. |
| 2 | `SteamID` | — | `steam_id` | Width 151px. Click target. |
| 3 | `Ник` (Nick) | — | `name` | Centered. |
| 4 | (icon only) | `fa-clock-o` | `online` | Width 100px, centered. Online time. |
| 5 | (icon only) | `fa-gift` | `bonuses` | Width 70px, centered. Bonuses. |
| 6 | (icon only) | `fa-angle-double-up` | `boost` | Width 100px, centered. Boost. |

**Fetch contract (via `buildTable` → `Action`):**
- Endpoint: `POST /ajax/table.php`
- `action = topPlayers` (the table name is used as the action id).
- `data`: `&table=topPlayers&page=<n>&numrows=30&search=<urlencoded JSON>&order_by=<col|false>&order_sort=<asc|desc|false>`
- Pagination count is a second call with `&pagination=true` returning `totalPage`/`totalRows`.

**Pagination:** server-side, **30 rows/page** (`numrows: 30`). Numbered pager with first/prev/next/last, plus an info line `Страница N из M / Всего: K` (Page N of M / Total: K). Windowed to ±9 page links (±3 on mobile).

**Sorting:** No clickable header sort is wired on this page (`buildTable` `order` option is not passed, so it defaults to `[]` and no `data-sort` handlers/icons are attached to the `<th>`s). Ordering is driven **only** by the sidebar sort selector (§4.1), which sets the server `sort` search key. Default ordering is by online time descending (implied by the `online` option being `selected`).

**Search binding:** the `searchInput` array `["topPlayers-name", "topPlayers-steam_id", "topPlayers-sort"]` is serialized into the `search` JSON: text inputs go under `search.text[<data-search>]`, the multiselect under `search.multiselect['sort']`.

---

### 4. Actions available here

#### 4.1 Page-own controls

| UI label | Element | Kind | Endpoint / effect | Params | State-changing? |
|---|---|---|---|---|---|
| Поиск (Search) | `#topPlayers-btn` | button | Rebuilds `topPlayers` table with current filters. `POST /ajax/table.php` action `topPlayers`. | `table=topPlayers`, `page`, `numrows=30`, `search` (JSON of name/steam_id/sort), `order_by`, `order_sort` | N (read) |
| Ник (Nick filter) | `#topPlayers-name` `data-search="t2.name"` | text input | Adds `t2.name` to `search.text`. Placeholder "Ник". | free text | N |
| Steam ID filter | `#topPlayers-steam_id` `data-search="t2.steam_id"` | text input, `maxlength=17` | Adds `t2.steam_id` to `search.text`. Placeholder "Steam ID". | 17-char SteamID64 | N |
| Sort selector | `#topPlayers-sort` `data-search="sort"` | single-value `multiselect` | Sets `search.multiselect['sort']`; server ranks by chosen metric. Placeholder `- Сортировка -`. | `online` \| `bonus` \| `boost` | N |
| (row click) | `#topPlayers tbody > tr` | click handler | Opens shared player-detail modal for that row: `player.open(<steam_id>)`. Suppressed when Alt/Ctrl held (to allow text selection). | SteamID from `<hashtag>` | N (opens modal) |

Sort options (top.html:25–27):

| Value | Label | Metric |
|---|---|---|
| `online` (default) | По онлайну (By online) | Cumulative playtime |
| `bonus` | По бонусам (By bonuses) | Bonus points |
| `boost` | По бусту (By boost) | Boost |

There are **no destructive/state-changing actions on the page itself** — it is entirely a read/browse surface.

#### 4.2 Actions reachable via the row-click modal (shared component)

All state-changing capabilities on this page come from the **shared player-detail modal** opened on row click, not from the leaderboard. The `action_catalog` tokens for `top.html` are those shared-modal actions; they hit `script:'player'` (`POST /ajax/player.php`) or `script:'squad'`. Documented in full in the shared-modal section; the two most relevant to this leaderboard's domain (online/activity) are:

| UI label | action id | Script / endpoint | Params | Effect | State-changing? |
|---|---|---|---|---|---|
| Скачать статистику (Download statistics) | `downloadStat` | `player` → `POST /ajax/player.php` (via `post_to_url` form submit, file download) | `steam_id` | Downloads the player's statistics export. | N (export) |
| (activity chart load) | `getPlayerOnlineData` | `player` → `POST /ajax/player.php` | `steam_id`, `start`, `end` | Returns `online_data` time-series (`minute`, `boost`, `queue` per timestamp) to render the modal's online chart over a chosen date range. | N (read) |

Other shared-modal action ids present in `top.html` (belonging to the modal, listed for completeness, all state-changing unless noted): `ban`, `unban`, `kick`, `kill`, `mark`, `message`, `changeGroup`, `changeTeam`, `twink`/`twinkOnline`, `findFriends` (read), `checkBans` (read), `addComment`/`getComments` (read), `addBanName`/`removeBanName`, `removePlayer`, `kits`/`kitSave`, `get` (read). These are the admin permissions surfaced by the modal, not by the leaderboard.

---

### 5. Forms & modals

The page has **no form of its own** and **no page-specific modal** — only the three filter inputs in the left rail and the embedded shared `#playerModal`/`#player_info`.

- **Steam ID input:** hard `maxlength="17"` (SteamID64 length). No other client-side validation; empty inputs are simply omitted from the search JSON.
- **Sort:** rendered by the `multiselect` plugin (`enableHTML: true`, `nonSelectedText: '- Сортировка -'`) with HTML labels (icon + text). Single-select in practice; `online` pre-selected.
- **Vestigial datepicker (bug/dead code):** the ready-handler initializes `datetimepicker` on `#topPlayers-startdate, #topPlayers-enddate` (top.html:62–66, Russian locale, `pickTime`, `sideBySide`) — **but those inputs do not exist in this fragment.** So the leaderboard has **no date-window control**; the online metric is an all-time cumulative aggregate. A date range only exists inside the modal chart (`getPlayerOnlineData` `start`/`end`). This looks like leftover code from a planned per-window ranking that was never shipped on this page.

---

### 6. Permission / visibility logic

- **Nav gating:** the page is hidden from the nav (no `top-menu` entry calling `pageLoad('top')`). There is no per-element `class="hide"` or role check inside `top.html`'s own content — the only `hide` element is `#player_info` (the shared modal's template holder, hidden by design and cloned into the modal on open). So visibility gating is at the **nav/routing layer**, not inside the fragment.
- **Inference on why hidden:** the page exposes every player's cumulative online/bonus/boost ranking across the whole database, which is (a) staff/internal-facing rather than public, (b) partially superseded — the same three metrics are shown per-player in the modal and the intended date-window control was never wired (§5). It reads as an internal/legacy or admin-only tool kept out of the normal menu. This is an inference from structure, not an explicit ACL in the fragment.
- **Row actions inherit modal permissions:** any actual authority (ban/kick/kits/group changes, etc.) is enforced by the shared modal's own action endpoints, so who can *do* things from here is governed by the same role checks as everywhere else the modal appears; the leaderboard itself grants only browse + open.

---

### 7. Notable UX & competitively interesting details

- **Three-axis activity ranking in one view.** A single leaderboard pivots between playtime, bonuses, and boost from one selector — a clean pattern for surfacing "most active / most rewarded / most boosted" players. Worth copying, and worth beating by making the three metrics **sortable columns** (this panel's headers are non-sortable; ranking is selector-only).
- **Icon-only metric headers** (clock/gift/double-up) keep the table compact but are unlabeled — an accessibility gap (no visible text/`title`/`aria-label`). Easy to beat with labeled, tooltipped, sortable headers.
- **Fixed sidebar filter rail** (`position:fixed`) keeps search controls in view while scrolling long result sets — good UX to replicate.
- **Row-click-to-drilldown** into the full player dossier (with Alt/Ctrl escape hatch to allow copy/select) is a slick interaction; the SteamID is embedded as a `<hashtag>` so it doubles as a copyable token.
- **Server-side pagination at 30/page with a separate count query** scales to a large player base; the info line shows total rows via `Intl.NumberFormat` (thousands separators).
- **Missing time window is the key competitive gap.** Because the datepicker targets non-existent inputs, there is no "top online this week/month" — the leaderboard is all-time only. A competitor can win immediately by offering selectable windows (daily/weekly/monthly/custom) on the leaderboard, reusing the same `online_data` (`minute`/`boost`/`queue`) time-series that already backs the per-player chart.
- **Anomaly flag on online time** (warning icon prepended when a condition holds, seen in the modal) hints at anti-boost/cheat-detection logic tied to playtime — a signal worth investigating and matching.
