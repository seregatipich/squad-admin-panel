## 17. Admin Audit Journal (Журнал)

### 1. Purpose and Navigation

The **Журнал** (Journal / Audit Log) is a read-only, server-side-paginated audit trail of admin actions performed through the SQSTAT panel. It answers "who did what, on which server, and when."

- **Nav item:** calls `pageLoad('logs')` → `GET /ajax/page.php?page=logs`, whose HTML fragment is injected into `#content`.
- **Fragment file analyzed:** `frags/logs.html`. Lines 1–107 are the page's own content; lines 108+ are the shared **player-detail modal** (`#playerModal`) embedded on every page — its columns and ~22 actions are NOT part of this page and are documented in the shared-modal section, not here.
- **Table bootstrap:** an inline `<script>` (bottom of fragment) calls `$('#logTable').buildTable({ table: 'logs', ... })`.

The page consists of a single filter bar plus one DataTable-style table (`#logTable`). There are **no state-changing controls of its own** — the only interaction beyond filtering is clicking a `<hashtag>` inside a row to open the shared player modal.

---

### 2. Entities & Fields

#### 2.1 Log Entry (`logs` table, alias `t1`)

The audit record. Inferred from the returned column set (`collum: ["serverName","name","date","log"]`), the `<thead>`, and the `data-search` aliases used by the filters.

| Field (returned) | UI column | SQL source (from filter aliases) | Meaning / Type |
|---|---|---|---|
| `serverName` | Сервер (Server) | joined via `server_id` | Human-readable server name (e.g. `RAAS/AAS #1`). String. |
| `name` | Админ (Admin) | `t2.player` (admins table `t2`) | Display name of the admin who performed the action. Joined from the admin/player table. String. |
| `date` | Дата (Date) | `t1.startdate` / `t1.enddate` filter on the row's timestamp | Timestamp of the action. Rendered ~120px column, centered. |
| `log` | Действие (Action) | `t1.log` | Free-text/structured description of the logged action. String; may embed `<hashtag>` tokens (clickable player references). |

Implied underlying columns not shown but used for filtering/joins: `server_id` (FK to server), an admin FK (joins `t2.player`), and the timestamp used by `t1.startdate`/`t1.enddate` range filters.

#### 2.2 Server (referenced entity)

Populated as `<option value="<id>" label='<name>'>` in the multiselect. Observed IDs are non-contiguous (`1, 6, 7, 9, 10, 11`), confirming `server_id` is a stable DB primary key, not a UI index.

| Field | Type | Example |
|---|---|---|
| `server_id` | int PK | `1` |
| server label | string | `RAAS/AAS #1`, `INVASION #3`, `Custom для FW` |

#### 2.3 Admin (referenced entity, alias `t2`)

The audit joins to a players/admins table aliased `t2`; the filterable field is `t2.player` (the admin's identity/name). This is the same identity that the shared modal opens when a `<hashtag>` is clicked.

---

### 3. The Page's Own Table (`#logTable`)

**Columns** (`<thead class="table-dark">`):

| # | `<th>` | Width | Align | Data key |
|---|---|---|---|---|
| 1 | Сервер (Server) | 200px | left | `serverName` |
| 2 | Админ (Admin) | auto | left | `name` |
| 3 | Дата (Date) | 120px | center | `date` |
| 4 | Действие (Action) | auto | left | `log` |

**Data source / request.** `buildTable` issues the row request through the generic `Action()` helper:

- **Endpoint:** `POST /ajax/table.php`
- **Body:** `action=logs&table=logs&page=<n>&numrows=100&search=<urlencoded JSON>&order_by=<false|col>&order_sort=<asc|desc>`
- `action` = the table name (`logs`); response is `{status:'ok', data:{ row:[...], query_time, count_time, ... }}`.
- **Page size:** `numrows: 100` per page.
- **Sorting:** no `order` array is passed in the bootstrap call, so **column-header sorting is not enabled** on this page (rows come back in the server's default order, effectively newest-first by date). The `buildTable` engine *supports* sort via `order_by`/`order_sort`, but the logs page opts out.
- **Pagination:** server-side; `buildTable` renders a pager (`showPages: 9` desktop / `3` mobile) below the table when total rows exceed 100.

**Search JSON shape** (built by `buildTable` from the `searchInput` list, then `encodeURIComponent(JSON.stringify(...))`):

```
{
  "text":        { "t2.player": "<admin>", "t1.log": "<action text>",
                   "t1.startdate": "<from>", "t1.enddate": "<to>" },
  "check":       {},
  "multiselect": { "server_id": ["1","7", ...] },
  "managers":    {},
  "slider":      {}
}
```

Only non-empty inputs are included. `+` characters are pre-escaped to `%2B`.

---

### 4. Filters / Search Controls

Declared in the filter bar and wired via `searchInput: ["logTable-name","logTable-startdate","logTable-enddate","logTable-user","logTable-server"]`.

| Control | Element id | `data-search` alias | Type | Placeholder | Behavior |
|---|---|---|---|---|---|
| Admin name | `logTable-user` | `t2.player` | text | Администратор (Administrator) | Substring filter on the acting admin. Enter key triggers search. |
| Action text | `logTable-name` | `t1.log` | text | Действие (Action) | Free-text filter over the log/action description. Enter key triggers search. |
| From date | `logTable-startdate` | `t1.startdate` | text (readonly, datetimepicker) | От (From) | Lower bound of date range. Bootstrap datetimepicker, `language: 'ru'`, `pickTime: true`, side-by-side. Clear icon zeroes the field. |
| To date | `logTable-enddate` | `t1.enddate` | text (readonly, datetimepicker) | До (To) | Upper bound of date range. Same picker config; clear icon resets. |
| Server | `logTable-server` | `server_id` | multiselect (`multiple`) | `- Сервер -` | `bootstrap-multiselect`, HTML-enabled, multi-value. Filters to selected `server_id`s. |
| Search button | `logTable-btn` | — | button | Поиск (Search) | Fires the query with current filter state. |

Notes:
- Date fields are `readonly` — values only settable via the picker (prevents malformed input).
- The two date-clear `<span>` addons run inline `$('#...').val('')`; they clear the field but do **not** auto-refresh — the user must press Поиск (or Enter in a text field).

---

### 5. Actions Available on This Page (Permissions/Capabilities)

The audit journal is deliberately **read-only**. It exposes no ban/kick/edit/delete/export controls of its own.

| UI trigger | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Load / filter / paginate the table | `logs` | `POST /ajax/table.php` | `table=logs&page&numrows=100&search&order_by&order_sort` | Fetch audit rows (server-side paginated/filtered). | N (read-only) |
| Click a `<hashtag>` in a row | (opens modal) `player.open(steamid)` | — (then shared modal loads via `player`/`squad` scripts) | steam id from the clicked token | Opens the shared player-detail modal for the referenced identity. | N |

The `end` callback binds: `$('#logTable tbody > tr hashtag').on('click', ...) → player.open($(this).text())`. So any player reference rendered inside a log line is a drill-down link into the shared modal.

> The action tokens pre-extracted for `logs.html` in `action_catalog.txt` (`ban`, `kick`, `kill`, `kits`, `mark`, `message`, `twink`, `unban`, `addComment`, `getComments`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `removePlayer`, `addBanName`, `removeBanName`, `twinkOnline`, `getPlayerOnlineData`, `downloadStat`, `kitSave`, `get`) together with `script:'player'` and `script:'squad'` all belong to the **embedded shared player modal**, NOT to the audit journal. They are the actions the modal can perform on whatever player you open from a log row — do not attribute them to this page.

---

### 6. Forms & Modals

The page has **no forms/modals of its own** beyond the filter bar. The only modal in the fragment is the shared `#playerModal` (player-detail), reached by clicking a player `<hashtag>` in a log row. Its fields, tabs, and actions are covered in the shared-modal section.

---

### 7. Permission / Visibility Logic

- The fragment contains no per-element `class="hide"` or role gating within the journal's own markup — the entire page is a single filterable table. (All `hide`/`display:none` elements in the file are inside the shared player modal.)
- Access control for the journal is therefore expected to be **page-level** (server-side gating of `pageLoad('logs')` by admin group). The client fragment assumes the requester is already authorized to see it.
- `Action()` transparently handles session expiry: if `table.php` responds `auth === true`, it triggers `location.reload()` (re-auth), so an expired session on the audit page bounces to login rather than showing stale data.

---

### 8. Notable UX & Competitively Interesting Details

- **Minimal, single-purpose page.** Four columns, five filters, one button. It reads as an accountability/compliance view (who-did-what) rather than an operations console — the deliberate absence of any mutating control is the point: an audit log you can't edit is more trustworthy.
- **The `log` column is free-text**, filtered by substring on `t1.log`. This implies actions are stored as rendered strings, not as a normalized `{action_type, target, params}` schema. **Competitive opportunity:** store audit events structurally (actor, action enum, target entity + id, before/after diff, server, timestamp) so you can filter by exact action type, link every target, and render a rich timeline. Their text-search-only model can't reliably answer "show all *bans* by admin X this week."
- **No column sorting** is wired here (order array omitted) — you can filter but not re-sort. Easy to beat by enabling sort on Date/Admin/Server.
- **Date range uses two separate readonly pickers** (`t1.startdate` / `t1.enddate`) rather than a single daterange widget (the engine supports a `daterange` type elsewhere). Clearing a date does not auto-refresh, a minor friction point.
- **Server filter keys off DB `server_id`** (non-contiguous ids), and the server label is denormalized into the row (`serverName`) — cheap to render, but means historical server renames would rewrite past display names unless snapshotted.
- **Drill-down via `<hashtag>`:** player identities embedded in log lines are live links into the shared modal — a nice touch that turns the audit log into an investigation entry point. Worth copying: make every actor and target in an audit row a clickable entity link.
- **Retention:** nothing in the client indicates a retention/rotation policy or an age cap on queries — pagination is unbounded (`page` increments, `numrows=100`), and the date filter defaults to empty (all history). Retention, if any, is enforced server-side and is not observable from the fragment.
