## 12. Match History (Игры)

### 1. Purpose & Navigation

The **Игры** (Games / Match History) page is a searchable log of every match (round) played across all monitored Squad servers. It answers "which layer was played, on which server, when, and who won by how many tickets." Each row is a completed (or in-progress) round; clicking a row drills into a full per-match detail page.

- **Nav id / entry point:** `pageLoad('games')` → `GET /ajax/page.php?page=games`, HTML fragment injected into `#content`.
- **Fragment file analyzed:** `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/games.html` (110 lines).
- **Layout:** a fixed left filter sidebar (`col-md-3`, `position:fixed`) plus a wide results panel (`col-md-9`) holding table `#games`.
- **Data source:** the table is populated client-side via the shared `buildTable()` helper (defined in `custom.js`), which issues a server-side-paginated request to the `table` script endpoint. There is **no** `<form>` POST and **no** page-specific `Action()` mutation on this page — it is a **read-only reporting screen**.

---

### 2. Entities & Fields

#### 2.1 Entity: `Game` (a match / round) — the page's list rows

Inferred from the `collum` array in `buildTable`, the `<thead>`, and the row fields referenced by the render callbacks (`row.t1_tickets`, `row.t2_tickets`, `row.win`, `this.dataset.id`).

| Field | Column key | Type | Meaning |
|---|---|---|---|
| Server | `server` | int (server_id) | Which monitored server hosted the round; rendered as `[<id>]` in a `<code>` chip. Filterable via multiselect. |
| Map / Layer | `map` | string | The Squad layer name (e.g. `Gorodok_RAAS_v1`). Free-text searchable via `t1.map`. |
| Start | `start` | datetime (epoch) | Round start timestamp; rendered with `formatDate(data, true, true)`. Also the date-range filter key (`t1.start`). |
| End | `end` | datetime (epoch) | Round end timestamp; same date formatting. Empty/ongoing rounds render blank. |
| Team 1 name | `t1` | string | Faction/team-1 label. Rendered as a ticket badge + name. |
| Team 2 name | `t2` | string | Faction/team-2 label. Rendered as a ticket badge + name. |
| Team 1 tickets | `t1_tickets` | int | Remaining tickets for team 1 at round end. Not a separate column; injected into the `t1` cell as a colored label. |
| Team 2 tickets | `t2_tickets` | int | Remaining tickets for team 2. Injected into the `t2` cell. |
| Duration | `time` | int (seconds) | Round length; rendered `secToTime(data)` inside a dark `<code>` chip. |
| Winner | `win` | enum `'t1' | 't2' | null` | Which team won. Drives the green/red coloring of the ticket badges and the trophy column. |
| Match id | (row `id`) | int | Primary key of the game row. Not shown as a cell; carried on `tr[data-id]` and used to navigate to `/game/<id>`. |

Note the win/ticket coloring logic couples three raw fields into two display cells:
- `t1` cell: `<span class="label label-{success if win=='t1' else danger}">{t1_tickets}</span> {t1_name}`.
- `t2` cell: mirror image keyed on `win=='t2'`.
- `win` cell (trophy): shows the winner label as a green `label-success` badge, or a neutral `—` (`fa-minus`) badge when `win` is falsy (draw / unfinished).

#### 2.2 Entity: `Server` (filter option source)

Rendered as `<option value=... label=...>` inside the `#games-server` multiselect. `value` = `server_id`, `label` = human server name.

| server_id | Label (name) |
|---|---|
| 1 | RAAS/AAS #1 |
| 6 | БЕЗ ГОЛОСОВАНИЯ #2 (No Voting #2) |
| 7 | INVASION #3 |
| 9 | Custom для FW (Custom for FW) |
| 10 | Custom для MDC (Custom for MDC) |
| 11 | Custom для BSS (Custom for BSS) |

This list is a useful competitive artifact: it reveals the rival's live server fleet, their game modes, and that server ids are sparse/non-contiguous (1, 6, 7, 9, 10, 11 — implying deleted/retired servers 2–5, 8).

#### 2.3 Entity: `Match Detail` (per-match player performance) — NOT in this fragment

Row click executes a **full browser navigation**, not an AJAX `pageLoad`:

```js
$('#games tbody > tr').on('click', function(){
    window.location.href = '/game/' + this.dataset.id;
});
```

So the per-match detail view (per-player kills/deaths/score, team rosters, ticket graph, etc.) is a **separately routed, server-rendered page** at `/game/<id>` and is **not** part of this captured fragment. Its schema cannot be documented from the local files — see Gaps.

---

### 3. The Page's Own Table (`#games`)

Configured by a single `buildTable()` call:

```js
$('#games').buildTable({
    table: 'games',
    collum: ["server","map","start","end","t1","t2","time","win"],
    numrows: 100,
    searchInput: ["games-map","games-date","games-server"],
    mode: 'table'
});
```

**Displayed columns (in order):**

| # | Header | Icon | Column key | Render |
|---|---|---|---|---|
| 1 | (server) | `fa-server` | `server` | `[<id>]` code chip |
| 2 | Карта (Map) | — | `map` | raw layer string |
| 3 | Начало (Start) | — | `start` | `formatDate` |
| 4 | Конец (End) | — | `end` | `formatDate` |
| 5 | Команда 1 (Team 1) | — | `t1` | ticket badge + name |
| 6 | Команда 2 (Team 2) | — | `t2` | ticket badge + name |
| 7 | (duration) | `fa-clock` | `time` | `secToTime` chip |
| 8 | (winner) | `fa-trophy` | `win` | winner badge / `—` |

**Pagination:** server-side, `numrows: 100` rows per page. A second `table` request with `&pagination=true` returns `totalPage` / `totalRows` and renders a numeric pager (`#games-infoblock`) showing `Страница X из Y · Всего: N` (Page X of Y · Total: N). `showPages` = 9 on desktop, 3 on mobile.

**Sorting:** the generic `buildTable` supports header-click sorting (`order_by` / `order_sort` asc/desc) **only** for columns listed in `settings.order` and only when a `<th>` carries an `i[data-sort]` marker. This page passes **no `order` option**, so sorting is effectively disabled here — the list is server-ordered (implicitly newest-first by start). This is a gap worth beating: a competitor should make every column sortable.

**Row interaction:** whole-row click → navigate to `/game/<id>` (see 2.3). No inline row actions, checkboxes, or bulk operations.

---

### 4. Actions & Admin Capabilities

This page exposes **no state-changing actions**. It is purely read/report. The only backend call is the DataTables-style row fetch.

| UI element | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Table load / Поиск (Search) button `#games-btn` | `games` (table name used as action) | `POST /ajax/table.php` | `action=games&table=games&page=<n>&numrows=100&search=<urlencoded JSON>&order_by=<>&order_sort=<>` | Returns paginated match rows (`text.data.row[]`, `data.currentPage`) | **N** (read) |
| Pagination click | `games` | `POST /ajax/table.php` | same + `&pagination=true` | Returns `totalPage`, `totalRows` for the pager | **N** (read) |

The `search` payload is a URL-encoded JSON object of the form `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. For this page it carries:
- `text["t1.map"]` — map substring,
- `text["t1.start.startdate"]` / `text["t1.start.enddate"]` — date range bounds,
- `multiselect["server_id"]` — array of selected server ids.

Note the `t1.` / `server_id` prefixes are raw SQL-ish table aliases leaking through to the client — a hint that the backend builds `WHERE` clauses directly from these `data-search` keys (potential injection surface to probe, and a naming convention to mirror or avoid).

---

### 5. Forms, Filters & Controls (left sidebar)

There is no `<form>`; filters are loose inputs wired into `buildTable` via `searchInput: ["games-map","games-date","games-server"]`. Pressing Enter in the text field, changing the date range, or clicking **Поиск** rebuilds the table (`page:1, isSearch:true`).

| Control | id | Type | `data-search` key | Behavior |
|---|---|---|---|---|
| Поиск (Search) button | `games-btn` | button | — | Triggers a filtered rebuild; shows "Ищем" (Searching) load state. |
| Карта (Map) | `games-map` | text input (`fa-map` addon) | `t1.map` | Substring match on layer name; submits on Enter. |
| Server multiselect | `games-server` | Bootstrap multiselect (`type=multiselect`, `multiple`) | `server_id` | Multi-pick from the 6 servers; placeholder `- Сервер -`; `enableHTML:true`. |
| Date range | `games-date` | custom `dateRange` widget (`type=daterange`) | `t1.start` | Presets: month, day, week, year, custom range, today, yesterday, current/last week, current/last month, last 30 days. Default `allTime` (start:0,end:0). Fires `crm_dateRange` → rebuild. Splits into `.startdate`/`.enddate`. |

**Validation:** none client-side; empty inputs are simply omitted from the search JSON (`if(val != "")`). The `+` character is escaped to `%2B` before submission (multiselect and text values) to survive form-encoding.

---

### 6. Permission / Visibility Logic

- This fragment contains **no** `class="hide"` gating, no role/group checks, and no `Action`-guarded buttons. Every authenticated viewer who can reach the page sees the full match log and all six servers.
- Access control is therefore entirely upstream: whether `pageLoad('games')` is offered in the nav and whether `/ajax/table.php?action=games` authorizes the caller. Nothing here narrows visibility by admin group.
- Contrast with the shared player-detail modal (embedded elsewhere) whose ~22 moderation actions are permission-sensitive — none of those appear on this read-only page.

---

### 7. Notable UX & Competitive Notes

- **Ticket-as-badge encoding.** Remaining tickets are shown as a colored pill fused onto each team name (green = winner, red = loser), so the outcome and margin read at a glance without a separate "score" column. Clean, copyable pattern.
- **Trophy column doubles as draw indicator.** A single `fa-trophy` column shows the winning faction, degrading to a neutral `—` when `win` is null (draw/ongoing) — compact status signaling.
- **Fixed filter rail.** The sidebar is `position:fixed`, staying pinned while the (up-to-100-row) result set scrolls — good for large logs; note it can collide with content on short viewports (`mobile-left` class hints at a mobile reflow).
- **Rich date presets.** The `dateRange` widget ships ~11 presets (today/yesterday/this-week/last-30-days/…) plus custom range — a strong baseline to match or exceed.
- **Server-side pagination with async page-count.** Row fetch and total-count are two separate requests; the count request is deferred and logged with timing (`Подсчёт страниц занял …`), keeping first paint fast on huge tables. Worth replicating for scale.
- **Weaknesses to beat:** (1) no column sorting wired up; (2) no CSV/stat export on this page (the rival exposes `downloadStat` elsewhere, not here); (3) raw SQL alias keys (`t1.map`, `t1.start`, `server_id`) sent from the client suggest thin server-side validation — a competitor should use opaque filter keys and parameterized queries; (4) match detail lives on a full page reload (`/game/<id>`) rather than an in-app modal/route, breaking the SPA flow.

---

### Gaps / Unknowns

- **Per-match player performance schema is not in these files.** The detail view is a server-rendered route `/game/<id>`; its columns (per-player kills/deaths/score, rosters, ticket timeline) cannot be documented from the captured fragment. Requires capturing `/game/<id>` HTML.
- **Exact backend column mapping** for `t1`/`t2`/`t1_tickets`/`win` (table/JOIN structure) is inferred from client keys only; the `table.php` server logic was not provided.
- **Sort defaults** (implicit ordering) are assumed newest-first but not confirmed server-side.
