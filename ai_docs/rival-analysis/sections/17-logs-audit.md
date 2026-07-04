## 17. Admin Audit Journal (Журнал)

### 1. Purpose and Navigation

The **Журнал** (Journal / Audit Log) is a read-only, server-side-paginated audit trail of admin actions performed through the SQSTAT panel. It answers "who did what, on which server, and when."

- **Nav item:** calls `pageLoad('logs')` → `GET /ajax/page.php?page=logs` (`ctype: text/html`, ~114 KB fragment), whose HTML is injected into `#content`.
- **Table bootstrap:** an inline `<script>` at the bottom of the fragment calls `$('#logTable').buildTable({ table:'logs', collum:['serverName','name','date','log'], numrows:100, searchInput:[...], end:<hashtag binder> })`.
- The page is a single filter bar plus one server-driven table (`#logTable`). It has **no state-changing controls of its own** — the only interaction beyond filtering is clicking a `<hashtag>` player token inside a row to open the shared player modal.

**Ground truth:** all contract facts below are captured from a live authenticated headless session against `https://breaking.sqstat.ru`. Capture files: `caps/logs/logs.network.json` (3 AJAX contracts), `caps/logs/logs.content.html` (rendered `#content`). `_blocked.json` is empty — no mutating request was issued (read-only page, as expected).

---

### 2. Live API Contracts

The page issues **one GET** (fragment) and **two POSTs** to `/ajax/table.php` — a deliberate two-phase load: phase 1 returns the page rows fast (`count_time: 0`, `totalRows: 0` deferred); phase 2 runs the expensive `COUNT(*)` only when needed. Both POSTs are dispatched through the generic `Action({script:'table', action:'logs', data:...})` helper (`custom.js:284`), which posts `application/x-www-form-urlencoded` to `/ajax/<script>.php`.

#### 2.1 `GET /ajax/page.php?page=logs` — page fragment

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | string enum | yes | View id; `logs` for this page. |

Returns the raw HTML `#content` fragment (filter bar + empty `<table id="logTable">`). No JSON. `status: 200`, `text/html; charset=UTF-8`.

#### 2.2 `POST /ajax/table.php` (phase 1 — rows) — the audit query

Captured body (`caps/logs/logs.network.json`, contract #2), URL-decoded:

```
action=logs
table=logs
page=1
numrows=100
search={"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}
order_by=false
order_sort=false
```

**Request params:**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string enum | yes | Server handler = table id. Always `logs`. |
| `table` | string enum | yes | Same value `logs` (redundant with `action`; `buildTable` sends both). |
| `page` | int (1-based) | yes | Page number. Row window is `[(page-1)*numrows, page*numrows)`. |
| `numrows` | int | yes | Page size. Bootstrap value `100`. |
| `search` | JSON string (URL-encoded) | yes | Filter object, always the 5 fixed buckets `{text,check,multiselect,managers,slider}`; empty `{}` = no filter. See §5 for key set. |
| `order_by` | string \| `"false"` | yes | Sort column DB-alias, or literal `false` when unsorted. Logs page always sends `false`. |
| `order_sort` | `"asc"` \| `"desc"` \| `"false"` | yes | Sort direction, or literal `false`. Logs page always sends `false`. |

**Response** (`application/json`, `status:200`), schema from capture:

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `"ok"` | Request status. On `auth===true` (not `ok`) the client calls `location.reload()` (re-auth bounce). |
| `exec_time` | float — seconds | Total server handler time (e.g. `0.022`). |
| `data.totalPage` | int | `0` in phase 1 (count deferred to phase 2). |
| `data.totalRows` | int | `0` in phase 1 (deferred). |
| `data.currentPage` | string — 1-based | Echo of requested page, as string (`"1"`). |
| `data.custom` | bool | Whether a custom result set is returned. `false` for logs. |
| `data.query_time` | float — seconds | Row-fetch time (e.g. `0.02`). |
| `data.count_time` | int/float — seconds | `0` in phase 1 (no COUNT run). |
| `data.row` | array (len ≤ `numrows`) | Audit rows. Row object schema below. |

**`data.row[]` object** (per captured `response_schema` / redacted `response_sample`):

| Field | Type | Meaning |
|---|---|---|
| `id` | string — numeric PK (6-digit observed, e.g. `"262459"`) | Audit-row primary key. Monotonic, gaps present (`262459, 262458, 262457, 262456, 262455, 262453…`) → auto-increment, effectively newest-first. Rendered as `<tr id="trID-<id>" data-id="<id>">`. |
| `server_id` | string int (`"0"`, `"1"`…) | FK to server. `"0"` = panel-global event (no game server; e.g. login) → `serverName` empty. |
| `steam_id` | string — 36 chars (UUID-shaped) | Internal player identity of the event subject. **Returned but not rendered** — no column maps it (see §3 Finding). Distinct from the 17-digit SteamID64 embedded inside `log` text. |
| `date` | string — **UNIX timestamp** (10-digit seconds, e.g. `"1783146994"`) | Event time. Rendered client-side (§3) into a relative badge. |
| `log` | string — free text / HTML | Human-readable action description (Russian). May embed `<b>`, `<i>`, and `<hashtag>SteamID64</hashtag>` tokens. Example values in §6. |
| `name` | string | Display name of the acting admin (e.g. `[BSS] seregatipich`). |
| `serverName` | string (may be empty) | Denormalized server label (e.g. `RAAS/AAS #1`). Empty when `server_id="0"`. |

Redacted phase-1 sample row:

```json
{ "id":"262459", "server_id":"0", "steam_id":"<uuid:36>",
  "date":"1783146994", "log":"Авторизовался",
  "name":"<redacted>", "serverName":"" }
```

#### 2.3 `POST /ajax/table.php` (phase 2 — pagination count)

Identical body to phase 1 **plus `&pagination=true`**. Fired by `getPagination()` (`custom.js:986`) only when the phase-1 page came back full (`rows == numrows`) **or** `currentPage != 1` — i.e. it's skipped entirely when the whole result fits on page 1 (then `Всего` is taken from the row count directly).

**Response** (captured contract #3):

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `"ok"` | Status. |
| `exec_time` | float — seconds | Handler time (e.g. `0.069`). |
| `totalPage` | int | Total pages = `ceil(totalRows/numrows)`. Live value `1105`. |
| `totalRows` | **string** — integer | Total matching rows, as string. Live value `"110488"` (~110 K audit records). |
| `count_time` | float — seconds | Cost of the `COUNT(*)` (e.g. `0.06`) — isolated here so it never blocks the row render. |

`totalRows` / `totalPage` drive the pager and the `Страница X из Y — Всего: N` (Page X of Y — Total: N) info line, both `Intl.NumberFormat`-grouped.

---

### 3. The Page's Own Table (`#logTable`)

**Rendered columns** (`<thead class="table-dark">`, from `logs.content.html`):

| # | `<th>` | Width | Align | `collum` key → `data-contact` | Render |
|---|---|---|---|---|---|
| 1 | Сервер (Server) | 200px | left | `serverName` | Raw string wrapped in `<code>` when non-empty; blank for global events. |
| 2 | Админ (Admin) | auto | left (`class="contact_name"`) | `name` | `<p class="text-center mb-0"><b>{name}</b></p>`. |
| 3 | Дата (Date) | 120px | center | `date` | `formatDate(unix, badge=true, checkdate=true)` → `<span class="badge bg-success" data-unix="{unix}">{label}</span>`. |
| 4 | Действие (Action) | auto | left | `log` | Free HTML string, verbatim (may contain `<b>`/`<i>`/`<hashtag>`). |

**Date badge logic** (`formatDate`, `custom.js:132-158`): label is relative via `checkToday()` — same calendar day → `Сегодня` (Today), day-1 → `Вчера` (Yesterday), else `DD.MM.YYYY`; time suffix `HH:MM:SS` always appended. Badge color: `bg-important` only if `!checkdate && date*1000 < Date.now()`; because the logs column passes `checkdate=true`, all rows render `bg-success` (green). Example: `<span class="badge bg-success" data-unix="1783146994">Сегодня 08:36:34</span>`.

**DataTables config (exact):**

| Property | Value | Note |
|---|---|---|
| Server table id (`action`/`table`) | `logs` | |
| `collum` | `["serverName","name","date","log"]` | Column→row-key map. `steam_id`, `server_id`, `id` are returned but unmapped (see Finding). |
| `numrows` (page size) | `100` | |
| `order` | `[]` (omitted) | **No column sorting wired.** `buildTable` only attaches header sort handlers + `<i data-sort>` icons when `order` is non-empty (`custom.js:797-838`); logs opts out. |
| `order_by` / `order_sort` | `false` / `false` | Always literal false → server default order (id-desc ≈ newest-first). |
| `showPages` | `9` desktop / `3` mobile | Pager window radius around current page. |
| `showOnePage` | `true` | Renders the `Всего` info line even for a single page. |
| `floatHead` | `true` | Sticky header; scrolls table into view on (re)build. |
| Default sort | none sent → **server default** (newest first) | |

**Finding — returned-but-unrendered identity.** The phase-1 row carries `steam_id` (36-char UUID) and `server_id`, yet `collum` maps neither. The clickable player token in column 4 is a **17-digit SteamID64** embedded inside the `log` free-text (e.g. `<hashtag>7656119XXXXXXXXXX</hashtag>`), not the row's `steam_id` field. So the audit surface exposes two different identifiers for the same subject (a UUID it doesn't display + a SteamID64 baked into prose), and drill-down keys off the string inside the message, not a structured FK.

---

### 4. Two-Phase Request Sequence (reference)

```
buildTable(#logTable)
  ├─ preGetTable() → query = ["logs", "&table=logs&page=1&numrows=100&search=<json>&order_by=false&order_sort=false"]
  ├─ getTable()               POST /ajax/table.php  (rows; timeout 120 s)   → data.row[], currentPage
  │     └─ build()            renders <tbody>, then getPagination(rows)
  └─ getPagination(rows)
        └─ if rows==100 or currentPage!=1:
             Action(...data + "&pagination=true")  POST /ajax/table.php     → totalPage, totalRows
             → renders pager + "Страница X из Y — Всего: N"
```

`Action()` (`custom.js:284`) aborts any in-flight request of the same name before firing (`retryAbort`), so rapid re-filters don't stack. On non-`ok` with `auth===true` it forces `location.reload()`.

---

### 5. Filters / Search Controls

Wired via `searchInput: ["logTable-user","logTable-name","logTable-startdate","logTable-enddate","logTable-server"]`. `buildTable` reads each input's `data-search` alias + `type` and bins it into the `search` JSON (`custom.js:733-778`). Only non-empty inputs are emitted; `+` is escaped to `%2B` in multiselect values.

| Control | `#id` | `data-search` alias | Input type | Placeholder | Search bucket | Behavior / validation |
|---|---|---|---|---|---|---|
| Admin name | `logTable-user` | `t2.player` | text | Администратор (Administrator) | `text` | Substring match on acting admin. |
| Action text | `logTable-name` | `t1.log` | text | Действие (Action) | `text` | Free-text substring over the `log` description. |
| From date | `logTable-startdate` | `t1.startdate` | text, `readonly` (datetimepicker) | От (From) | `text` | Lower bound. Bootstrap datetimepicker `language:'ru'`, `pickTime:true`, side-by-side. `readonly` → only picker sets it. Clear addon `onclick="$('#logTable-startdate').val('')"`. |
| To date | `logTable-enddate` | `t1.enddate` | text, `readonly` (datetimepicker) | До (To) | `text` | Upper bound. Same picker. Clear addon zeroes it. |
| Server | `logTable-server` | `server_id` | `multiselect` (`multiple`) | `- Сервер -` | `multiselect` | `bootstrap-multiselect`, HTML-enabled, multi-value → array of `server_id`. |
| Search | `logTable-btn` | — | button | Поиск (Search) | — | Fires `buildTable` rebuild with `isSearch:true, page:1`. |

**Server multiselect options** (live `<option value label>` set — non-contiguous ids confirm `server_id` is a DB PK):

| `server_id` | Label |
|---|---|
| `1` | RAAS/AAS #1 |
| `6` | БЕЗ ГОЛОСОВАНИЯ #2 (No-voting #2) |
| `7` | INVASION #3 |
| `9` | Custom для FW |
| `10` | Custom для MDC |
| `11` | Custom для BSS |

`server_id=0` (panel-global) is **not** a filter option — global events are only reachable by leaving the server filter empty.

**Resulting `search` JSON shape** (empty when unfiltered, as captured):

```json
{
  "text":        { "t2.player":"<admin>", "t1.log":"<text>",
                   "t1.startdate":"<unix|datestr>", "t1.enddate":"<unix|datestr>" },
  "check":       {},
  "multiselect": { "server_id":["1","7"] },
  "managers":    {},
  "slider":      {}
}
```

Filter aliases reveal the server join: `t1` = the logs table (`t1.log`, `t1.startdate`, `t1.enddate` range on the timestamp, `server_id`), `t2` = the admins/players table (`t2.player`). Note: clearing a date field does **not** auto-refresh — the user must press Поиск (or Enter in a text field).

---

### 6. Logged Action Strings (`log` semantics)

`log` is stored/returned as a **rendered Russian string**, not a normalized `{action_type,target,params}` record — filtering is substring-only. Distinct action templates observed in the live 100-row page (counts in parentheses):

| `log` template (Russian) | English gloss | Structure |
|---|---|---|
| `Авторизовался` (n=2) | Logged in / Authenticated | Bare verb. `server_id=0`, no server, no target. Session-level audit. |
| `Зашёл в камеру` (n=94) | Entered admin cam (spectator) | Bare verb; carries `server_id`/`serverName`. Dominant event type. |
| `Забанил <b>{name}</b> <hashtag>{steamid64}</hashtag> на <b>{N}</b> дн <i>"{reason + до DD.MM.YYYY HH:MM}"</i>` | Banned {player} for {N} days, reason … | Target SteamID64 as clickable token; duration + expiry + reason embedded in prose. |
| `Разбанил <b>{name}</b> <hashtag>{steamid64}</hashtag> ({steamid64})` | Unbanned {player} | Target twice (token + parenthetical). |
| `Отправил сообщение <b>{tag}</b> <hashtag>{steamid64}</hashtag> - "{message}"` | Sent message to {player} — "…" | In-game admin DM; message body quoted. |

The panel writes login, admin-camera entry, ban, unban, and admin-message events (and, per the shared action catalog, presumably kick/kits/mark/twink/group-change etc.) as free text. Because everything is one string, "all bans by admin X this week" is only answerable by substring-matching `Забанил` in `t1.log` — brittle.

---

### 7. Actions Available on This Page (Permissions/Capabilities)

The audit journal is deliberately **read-only** — no ban/kick/edit/delete/export control of its own.

| UI trigger | Action | Endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Load / filter / paginate | `Action({script:'table', action:'logs'})` | `POST /ajax/table.php` | `table=logs&page&numrows=100&search&order_by=false&order_sort=false[&pagination=true]` | Fetch audit rows / count. | N (read) |
| Click a `<hashtag>` in a row | `player.open($(this).text())` | — (opens shared `#playerModal` via `player`/`squad` scripts) | SteamID64 from the token text | Opens player-detail modal for the referenced subject. | N |

`end` callback binds: `$('#logTable tbody > tr hashtag').on('click', …) → player.open($(this).text())` — every SteamID64 rendered in a log line is a drill-down into the shared modal.

> The action tokens pre-extracted for `logs.html` in `action_catalog.txt` (`ban, kick, kill, kits, mark, message, twink, unban, addComment, getComments, changeGroup, changeTeam, checkBans, findFriends, removePlayer, addBanName, removeBanName, twinkOnline, getPlayerOnlineData, downloadStat, kitSave, get`) plus `script:'player'`/`script:'squad'` all belong to the **embedded shared player modal**, NOT to the audit journal. They are what the modal can do to whatever player you open from a log row — do not attribute them to this page.

---

### 8. Permission / Visibility Logic

- The journal's own markup contains no per-element `hide`/role gating — it is one filterable table. (All `hide`/`display:none` in the fragment are inside the shared `#playerModal`.)
- Access control is therefore **page-level**: server-side gating of `pageLoad('logs')` by admin group. The fragment assumes the requester is authorized.
- Session expiry is handled transparently by `Action()`: a non-`ok` response with `auth===true` triggers `location.reload()` → login bounce (no stale audit data).
- The server-global rows (`server_id=0`, e.g. logins) have no server filter path, so a per-server admin filtering by their server would never see panel-level login events — an intrinsic visibility gap.

---

### 9. Retention & Scale (observed)

- Live `totalRows = 110488` across `totalPage = 1105` at 100/page. `page` is unbounded and the date filter defaults to empty (full history). No client-side age cap or rotation notice.
- `id` is a dense-ish auto-increment (small gaps from deleted/rolled-back events) — the sequence itself implies long-lived accumulation, not a rolling window.
- Retention/rotation, if any, is enforced server-side and is not observable from the client. The isolated `count_time` (§2.3) suggests the count query is non-trivial at this row volume — hence the two-phase deferral.

---

### 10. Competitively Interesting Details

- **Free-text `log`, not a structured event.** Filtered by substring on `t1.log`; duration, reason, expiry, target are baked into prose. **Opportunity:** store audit events as `{actor, action_enum, target_entity+id, before/after, server_id, ts}` so you can filter by exact action type, join every target, and render a real timeline. Their model can't reliably answer "all bans by admin X this week."
- **Two identifiers, neither clean.** Row carries a 36-char UUID `steam_id` it never renders, while drill-down keys off a SteamID64 string parsed out of the message HTML. A normalized target FK + one canonical id would be strictly better.
- **No column sorting** (empty `order`) — filter but can't re-sort. Trivial to beat by enabling Date/Admin/Server sort (engine already supports it via `order_by`/`order_sort`).
- **Two separate readonly date pickers** rather than one daterange widget (`t1.startdate`/`t1.enddate`); clearing a date doesn't auto-refresh — minor friction.
- **Deferred count (two-phase load)** is a genuinely good pattern at 110 K rows — worth copying: render rows immediately, compute `COUNT(*)` in a second request so pagination never blocks first paint.
- **Global vs per-server split** (`server_id=0`) means login/session events live outside every server filter — an accountability blind spot to avoid.
- **Drill-down via `<hashtag>`** turns the audit log into an investigation entry point. Worth copying — but make *every* actor and target a structured entity link, not a regex over rendered text.
