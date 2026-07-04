## 12. Match History (Игры)

> **Ground truth:** live contracts captured 2026-07-04 via headless browser (read-only; 0 mutations blocked). Sources: `caps/games-stats/games.network.json` (3 AJAX contracts), `caps/games-stats/games.content.html` (live-rendered `#content`).

### 1. Purpose & Navigation

The **Игры** (Games / Match History) page is a searchable, server-side-paginated log of every match (round) played across all monitored Squad servers. It answers "which layer was played, on which server, when, and who won by how many tickets." Each row is a completed (or in-progress) round; clicking a row performs a full-page navigation to the per-match detail view.

- **Nav id / entry point:** `pageLoad('games')` → `GET /ajax/page.php?page=games` (`ctype text/html`, ~4 KB fragment), injected into `#content`.
- **Layout (from live HTML):** a fixed left filter sidebar (`div.col-md-3.mobile-left` → `block-box` with `style="position:fixed"`) plus a wide results panel (`col-md-9`) holding `table#games.table.table-hover` with `thead.table-dark`.
- **Data source:** the table is populated client-side via the shared `buildTable()` helper (`custom.js:605`), which issues a server-side-paginated `POST /ajax/table.php`. There is **no** `<form>` POST and **no** page-specific `Action()` mutation on this page — it is a **read-only reporting screen**.

---

### Live API Contracts

Three contracts fire on load. All observation-only; the interceptor blocked 0 mutations.

#### C1 — Page fragment

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=games` |
| **Request params** | `page` — string — required — fragment key (`games`) |
| **Response** | `text/html; charset=UTF-8`, ~4089 bytes — the `#content` inner HTML (sidebar filters + empty `#games` table shell) |
| **Capture** | `games.network.json` [0] |

#### C2 — Match rows (primary data fetch)

**`POST /ajax/table.php`** — `application/json`. Capture: `games.network.json` [1].

Request body (form-urlencoded; `search` is URL-encoded JSON):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Always `games` (server-side handler selector). |
| `table` | string | Y | Always `games` (DataTables table id). |
| `page` | int | Y | 1-based page number. |
| `numrows` | int | Y | Page size — fixed `100`. |
| `search` | JSON (url-enc) | Y | Filter object, shape `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` (see §4). |
| `order_by` | string\|`false` | Y | Sort column DB-alias, or literal `false` when unsorted (observed: `false`). |
| `order_sort` | string\|`false` | Y | `asc`/`desc`, or `false` (observed: `false`). |

Decoded `search` observed on auto-load:
```json
{"text":{"t1.start.startdate":0,"t1.start.enddate":0},"check":{},"multiselect":{},"managers":{},"slider":{}}
```

Response envelope (`response_schema`):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count — **0 on the row fetch** (count is deferred to C3). |
| `data.totalRows` | int | **0 on the row fetch** (deferred to C3). |
| `data.currentPage` | string(int) | Echoes requested page (`"1"`). |
| `data.row` | array[≤`numrows`] of Game | The match rows (schema below). |
| `data.custom` | bool | Whether a custom/saved filter is active (observed `false`). |
| `data.query_time` | int | Server row-query time (ms; `0` when cached). |
| `data.count_time` | int | Row-count time (ms; `0` here — count runs in C3). |
| `status` | string enum | `"ok"` on success. |
| `exec_time` | float | Total handler wall-time (s). |

`data.row[]` element — the **Game** entity (live sample, redacted):
```json
{ "id":"33295", "server_id":"1", "start":"1783114006", "end":"1783115978",
  "map":"Harju RAAS v1", "t1":"AFU", "t1_tickets":"0", "t2":"PLANMC",
  "t2_tickets":"366", "win":"t2", "is_seed":"0", "server":"A", "time":1972 }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | Match primary key. Carried on `tr[data-id]`; row click → `/game/<id>`. |
| `server_id` | string(int) | Numeric FK of the host server (`1,6,7,9,10,11`). Filter alias `server_id`. |
| `server` | string(1) | Server short letter (`A`,`B`,…). Rendered as `<code>[A]</code>` in column 1. |
| `start` | string(unix) | Round start, **unix seconds** as string. Date-range filter key `t1.start`. |
| `end` | string(unix) | Round end, **unix seconds** as string. Blank/`0` for ongoing rounds. |
| `map` | string | Layer name incl. mode+version, e.g. `Harju RAAS v1`, `Fallujah AAS v1`. Free-text filter alias `t1.map`. |
| `t1` | string | Team-1 faction tag/name (`AFU`, `IMF`, or full name like `58th Motorized Brigade`). |
| `t1_tickets` | string(int) | Team-1 remaining tickets at round end. |
| `t2` | string | Team-2 faction tag/name. |
| `t2_tickets` | string(int) | Team-2 remaining tickets. |
| `win` | enum `"t1"`\|`"t2"`\|`""` | Winning team; empty/falsy = draw or unfinished. |
| `is_seed` | string bool (`"0"`/`"1"`) | Whether the round was a seeding match. Present in payload but **not** rendered as a column. |
| `time` | int | Round duration in **seconds** (note: the only numeric-typed field; all others are strings). |

#### C3 — Deferred pagination / total count

**`POST /ajax/table.php`** — identical body to C2 **plus** `&pagination=true`. Capture: `games.network.json` [2].

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Total pages for the current filter (live: `286`). |
| `totalRows` | string(int) | Total matching rows (live: `"28571"`). |
| `count_time` | float | Count-query time in seconds (live: `0.02`). |
| `status` | string enum | `"ok"`. |
| `exec_time` | float | Handler wall-time (s). |

**Two-phase pattern:** C2 returns rows fast with `totalPage/totalRows = 0`; C3 (`pagination=true`) fires separately to compute the (expensive) `COUNT(*)` and fill the pager. This keeps first paint fast on the ~28.5 K-row table. Worth replicating at scale.

---

### 2. Entities & Fields

#### 2.1 Entity: `Game` — see the C2 `data.row[]` schema above (authoritative). Display-cell coupling:

- **Column 1 (server):** `<td data-contact="server"><code>[<server>]</code></td>` — uses the letter `server`, not `server_id`.
- **`t1` cell:** `<span class="label label-{success|danger}">{t1_tickets}</span> {t1}` — green (`label-success`) if this team won, red (`label-danger`) otherwise.
- **`t2` cell:** mirror image keyed on `win=='t2'`.
- **`start`/`end` cells:** `<span class="badge bg-success" data-unix="1783114006">Вчера 23:26:46</span>` — the epoch is preserved in `data-unix`; the visible text is a humanized relative/absolute local time ("Вчера" = Yesterday).
- **`time` cell:** `<code class="dark">32м 52c </code>` (`secToTime` → `<m>м <s>c`).
- **`win` cell (trophy col):** `<span class="label label-success">t2</span>` for the winner; neutral `—`/`fa-minus` when `win` is falsy.

#### 2.2 Entity: `Server` (filter option source)

Live `#games-server` multiselect options (`value` = `server_id`, `label` = name):

| server_id | Label (name) | Gloss |
|---|---|---|
| 1 | RAAS/AAS #1 | main rotation |
| 6 | БЕЗ ГОЛОСОВАНИЯ #2 | No Voting #2 |
| 7 | INVASION #3 | Invasion mode |
| 9 | Custom для FW | Custom for FW |
| 10 | Custom для MDC | Custom for MDC |
| 11 | Custom для BSS | Custom for BSS |

Server ids are sparse/non-contiguous (1, 6, 7, 9, 10, 11 — 2–5, 8 missing), implying retired/soft-deleted servers. Competitive artifact: reveals the rival's live fleet and modes.

#### 2.3 Entity: `Match Detail` (per-match player performance) — NOT in this fragment

Row click is a **full browser navigation**, not an AJAX `pageLoad`:
```js
$('#games tbody > tr').on('click', function(){ window.location.href = '/game/' + this.dataset.id; });
```
The per-match detail view (per-player K/D/score, rosters, ticket timeline) is a **separately routed, server-rendered page** at `/game/<id>` and is **not** in the captured fragment. Its schema cannot be documented from these files — see Gaps.

---

### 3. The Page's Own Table (`#games`)

Configured by a single `buildTable()` call (`custom.js:605` generic helper):

```js
$('#games').buildTable({
    table: 'games',
    collum: ["server","map","start","end","t1","t2","time","win"],
    numrows: 100,
    searchInput: ["games-map","games-date","games-server"],
    mode: 'table'
});
```

**Server table id (`action=`/`table=`):** `games`. **Page size (`numrows`):** `100`.

**Displayed columns** (live `<thead class="table-dark">`, in order):

| # | Header (RU → EN) | `<th>` width | Icon | Column key / `data-contact` | Render |
|---|---|---|---|---|---|
| 1 | (server) | 30px, center | `fa-server` | `server` | `<code>[A]</code>` |
| 2 | Карта (Map) | auto, center | — | `map` | raw layer string |
| 3 | Начало (Start) | 130px, center | — | `start` | `badge` w/ `data-unix`, humanized time |
| 4 | Конец (End) | 130px, center | — | `end` | same; blank if ongoing |
| 5 | Команда 1 (Team 1) | auto, center | — | `t1` | ticket badge + name |
| 6 | Команда 2 (Team 2) | auto, center | — | `t2` | ticket badge + name |
| 7 | (duration) | 100px, center | `fa-regular fa-clock` | `time` | `<code class="dark">` `secToTime` |
| 8 | (winner) | 40px, center | `fa-solid fa-trophy` | `win` | winner badge / `—` |

**Sorting (`order`):** the config passes **no `order` option** → header-click sorting is disabled; `order_by`/`order_sort` go out as literal `false` (confirmed in C2 body). **Default sort:** server-implicit, newest-first by `start` (live rows descend `id 33295 → 33294 → …`). Gap to beat: make columns sortable.

**Pagination:** server-side, 100/page. The pager (`#games-infoblock`) reads `Страница X из Y · Всего: N` from C3; `showPages` = 9 desktop / 3 mobile.

**Row interaction:** whole-row click → `/game/<id>`. No inline actions, checkboxes, or bulk ops.

---

### 4. Actions & Admin Capabilities

**No state-changing actions.** The only backend calls are the read fetches (C2/C3). Confirmed: `_blocked.json` = `[]` (0 mutations).

| UI element | action / table | Endpoint | Key params | Effect | Destructive? |
|---|---|---|---|---|---|
| Table load / **Поиск** `#games-btn` | `games` | `POST /ajax/table.php` | `action=games&table=games&page=<n>&numrows=100&search=<JSON>&order_by=false&order_sort=false` | Returns paginated match rows (C2) | **N** |
| Pagination click | `games` | `POST /ajax/table.php` | same + `&pagination=true` | Returns `totalPage`/`totalRows` (C3) | **N** |

**`search` payload contract** — URL-encoded JSON `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. For this page:

| Bucket | Key | Meaning |
|---|---|---|
| `text` | `t1.map` | Map/layer substring. |
| `text` | `t1.start.startdate` | Range start (unix; `0` = unbounded). |
| `text` | `t1.start.enddate` | Range end (unix; `0` = unbounded). |
| `multiselect` | `server_id` | Array of selected server ids. |

The `t1.` / `server_id` prefixes are raw SQL-ish table aliases leaking to the client — the backend likely builds `WHERE` clauses from these `data-search` keys directly (injection surface to probe; a convention to mirror with opaque keys + parameterized queries).

---

### 5. Forms, Filters & Controls (live sidebar)

No `<form>`; loose inputs wired into `buildTable` via `searchInput: ["games-map","games-date","games-server"]`. Enter in the text field, a date-range change, or clicking **Поиск** rebuilds the table (`page:1, isSearch:true`).

| Control | `#id` | Type | `data-search` | maxlength / options | Default | Behavior |
|---|---|---|---|---|---|---|
| Поиск (Search) | `games-btn` | button | — | — | — | Filtered rebuild; "Ищем" load state. |
| Карта (Map) | `games-map` | text (`fa-map` addon), placeholder "Карта" | `t1.map` | none | empty | Substring match; submits on Enter. |
| Server | `games-server` | Bootstrap multiselect (`type=multiselect multiple`) | `server_id` | 6 fixed options (§2.2), `enableHTML:true` | none selected; placeholder `- Сервер -` | Multi-pick; array into `multiselect.server_id`. |
| Date range | `games-date` | custom `dateRange` widget (`type=daterange`), label "за всё время" | `t1.start` | presets: month/day/week/year/custom/today/yesterday/current+last week/current+last month/last30days | **allTime** (`start:0,end:0`) | Fires `crm_dateRange` → rebuild; splits into `.startdate`/`.enddate`. |

**Validation:** none client-side; empty inputs are omitted from `search` (`if(val != "")`). `+` is escaped to `%2B` on multiselect/text values before submission.

---

### 6. Permission / Visibility Logic

- The fragment contains **no** `class="hide"` gating, role/group checks, or `Action`-guarded buttons. Every authenticated viewer who reaches the page sees the full match log and all six servers.
- Access control is entirely upstream: whether `pageLoad('games')` is offered in the nav, and whether `table.php action=games` authorizes the caller. Nothing here narrows visibility by admin group.
- The multiselect options are pre-filtered server-side to servers the operator may view; the client trusts and iterates them.

---

### 7. Notable UX & Competitive Notes

- **Ticket-as-badge encoding.** Remaining tickets are a colored pill fused onto each team name (green = winner, red = loser) — outcome + margin at a glance, no separate score column. Copyable pattern.
- **`data-unix` on time cells.** Epochs are preserved in `data-unix` while showing humanized local time ("Вчера 23:26:46") — clean separation of machine value and display.
- **Trophy column doubles as draw indicator** (`—`/`fa-minus` when `win` falsy).
- **Two-phase server-side pagination** (rows first, deferred `COUNT(*)` via `pagination=true`) keeps first paint fast on a ~28.5 K-row / 286-page table.
- **Fixed filter rail** (`position:fixed`) stays pinned while results scroll; `mobile-left` hints a mobile reflow (watch for collisions on short viewports).
- **Rich date presets** (~11) plus custom range — a strong baseline to match.
- **Weaknesses to beat:** (1) no column sorting wired (`order_by=order_sort=false`); (2) no CSV/stat export on this page (`downloadStat` exists elsewhere, not here); (3) raw SQL alias filter keys (`t1.map`, `t1.start`, `server_id`) suggest thin server-side validation; (4) match detail is a full page reload (`/game/<id>`), breaking the SPA flow; (5) `is_seed` is shipped in the payload but neither shown nor filterable — a free "hide seeding rounds" toggle the rival leaves on the table.

---

### Gaps / Unknowns

- **Per-match player performance schema is not in these files.** `/game/<id>` is a server-rendered route; its columns (per-player K/D/score, rosters, ticket timeline) require capturing that page's HTML.
- **Backend JOIN/column mapping** for `t1`/`t2`/`t1_tickets`/`win`/`is_seed` is inferred from the client alias keys (`t1.*`, `server_id`); `table.php` server logic was not provided.
- **`order` capability:** disabled on this page, so the set of sortable DB-aliases the backend would accept is unobserved.
