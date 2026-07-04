## 11. Statistics Dashboards

> **Ground truth:** live contracts captured 2026-07-04 via headless browser (read-only; 0 mutations blocked). Sources: `caps/games-stats/statistics.network.json` (2 AJAX contracts), `caps/games-stats/statistics.content.html` (live-rendered `#content`, 20 chart canvases).

### 1. Purpose and Nav Location

- **Nav item:** `statistics` — `pageLoad('statistics')` → `GET /ajax/page.php?page=statistics` (`text/html`, ~41 KB fragment), injected into `#content`.
- **Purpose:** a single-page, all-graphical analytics dashboard rendering **20 Chart.js canvases** covering server population (online/max/queue), staff coverage (admins/maxAdmins), moderation volume (bans), match throughput (games/modes/maps), social volume (chat/teamkill), player growth (new), and per-server combat aggregates (kills/death/revival/damage/wound). It is **read-only** — no table, no row actions, no export button. All data comes from **one** RPC (`action=statistics`, `POST /ajax/squad.php`) driven by two controls: a date-range picker and a multi-server selector.
- Unlike the DataTables list pages, this page carries **no** `downloadStat` export and no player-detail modal wiring — a pure visualization surface.

---

### Live API Contracts

Two contracts fire on load. Observation-only; `_blocked.json` = `[]`.

#### C1 — Page fragment

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=statistics` |
| **Request params** | `page` — string — required — `statistics` |
| **Response** | `text/html; charset=UTF-8`, ~41 KB — the `#stat_wrapper` markup: date button, server multiselect, spinner overlay, and 20 `<canvas>` cards. |
| **Capture** | `statistics.network.json` [0] |

#### C2 — Aggregated statistics RPC (the whole dashboard)

**`POST /ajax/squad.php`** — `application/json; charset=utf-8`. Capture: `statistics.network.json` [1].

Request body (form-urlencoded; note the leading `&`):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `start` | int (unix s) | Y | Range start (live: `1780560007`). From `#stat_date` `data-start`. |
| `end` | int (unix s) | Y | Range end (live: `1783152007`). From `data-end`. |
| `servers` | CSV of ints | Y | **Comma-joined** server ids, e.g. `1,6,7,9,10,11` — *not* a JSON/PHP array. |
| `action` | string | Y | Always `statistics` (server-side handler selector on `squad.php`). |

Full observed body: `&start=1780560007&end=1783152007&servers=1,6,7,9,10,11&action=statistics`

**Response shape.** One JSON object. Values are either flat time-series `{label: value}`, **nested per-server** `{serverId: {label: value}}`, or shared axis-label arrays. Numeric values are frequently returned **as strings** (`"37"`) — clients must coerce. Top-level keys:

| Key | Shape | Value type | Feeds chart | Meaning |
|---|---|---|---|---|
| `test` | object | float per section | — | **Server-side profiling** timings (s) for sub-queries: `online, maps, players, chat, bans, teamkill, onlineHour, onlineDay`. Diagnostic, not charted. |
| `days` | array[N] | `"DD.MM.YYYY"` | X labels | Day buckets across the range (live N=31). |
| `hours` | array[24] | `"HH:00"` | X labels | Hour-of-day buckets `00:00`…`23:00`. |
| `dayofweek` | array[7] | RU weekday | X labels | `Понедельник`…`Воскресенье` (Mon…Sun). |
| `online` | `{sid:{day:val}}` | string(int) | `chartOnline` | Avg online per server/day (business-hours window). |
| `max` | `{sid:{day:val}}` | string(int) | `chartOnlineMax` | Peak players incl. queue, per server/day. |
| `queue` | `{sid:{day:val}}` | string(int) | `chartQueue` | Avg queue length per server/day. |
| `admins` | `{day:val}` | int | `chartAdmins` | Avg admins online per day (single series). |
| `maxAdmins` | `{day:val}` | int | `chartAdminsMax` | Peak admins online per day (single series). |
| `bans` | `{day:val}` | string(int) | `chartBans` | Punishments issued per day (single series). |
| `onlineHour` | `{sid:{HH:00:val}}` | string(int) | `chartOnlineHour` | Avg online by hour, per server. |
| `onlineDay` | `{sid:{weekday:val}}` | string(int) | `chartOnlineDay` | Avg online by weekday, per server. |
| `games` | `{sid:{day:val}}` | string(int) | `chartGames` | Matches per server/day. |
| `modes` | `{mode:count}` | int | `chartModes` | Match count per mode: `AAS, Invasion, RAAS, Seed, Skirmish`. |
| `maps` | `{mapName:count}` | int **or** string(int) | `chartMaps` | Match count per map (**inconsistent typing** — some values int, some string; excludes Skirmish/Seed). |
| `new` | `{day:val}` | int | `chartNew` | New/first-seen players per day. |
| `chat` | `{sid:{day:val}}` | string(int) | `chartChat` | Chat messages per server/day. |
| `teamkill` | `{sid:{day:val}}` | string(int) | `chartTeamkill` | Teamkills per server/day. |
| `kills` | `{sid:{day:val}}` | string(int) | `chartKills` | Kills per server/day. |
| `death` | `{sid:{day:val}}` | string(int) | `chartDeaths` | Deaths per server/day. |
| `revival` | `{sid:{day:val}}` | string(int) | `chartRevivals` | Revives per server/day. |
| `damage` | `{sid:{day:val}}` | string(int) | `chartDamage`* | Damage dealt per server/day. |
| `wound` | `{sid:{day:val}}` | string(int) | `chartWounds` | Wounds (downs) per server/day. |
| `unique` | array | (empty `[]`) | `chartUnique` | Unique players — **returned empty** in this deployment. |
| `kits` | array | (empty `[]`) | `chartKits` | Kit counts — **returned empty** in this deployment. |
| `status` | string enum | `"ok"` | — | Result status. |
| `exec_time` | float | — | — | Total RPC wall-time (live: `1.507` s). |

\* A `chartDamage` series maps to the `damage` key; the fragment ships a `chartWounds` and a `chartDeaths` etc. — see §7 for the canvas-to-key map.

Per-server sub-keys are the server ids `1,6,7,9,10,11`. Redacted samples:
```
test    = {"online":0.538,"maps":0.005,"players":0.062,"chat":0.044,"bans":0.004,"teamkill":0.082,"onlineHour":0.355,"onlineDay":0.393}
modes   = {"AAS":168,"Invasion":57,"RAAS":171,"Seed":68,"Skirmish":60}
maps    = {"Narva":65,"Mutaha":50,"Fallujah":43,"Gorodok":40,...,"Sanxian Islands":"3","Kohat Toi":"2"}
online.1= {"04.06.2026":"37","05.06.2026":"1","06.06.2026":"47", ...}
admins  = {"04.06.2026":5,"05.06.2026":5,"06.06.2026":7, ...}
bans    = {"04.06.2026":"16","05.06.2026":"69","06.06.2026":"7", ...}
new     = {"04.06.2026":174,"05.06.2026":254,"06.06.2026":170, ...}
```

**Live-capture correction to prior notes:** the `chartKits` and `chartUnique` canvases are **present and rendered** in the live `#content` (not commented out) — they simply receive empty `kits`/`unique` arrays, so they draw blank. All 20 canvases exist in the DOM (§7).

---

### 2. Entities & Fields (client-side model)

#### 2.1 Server (`servers` map, inlined in fragment `<script>`)

Drives dataset creation, per-server coloring, and legend labels. Anonymized example:
```json
"1": { "id":"1","ip":"80.242.59.123","port":"0","pass":"","name":"RAAS/AAS #1",
       "short":"A","ext_short":"","mods":false,"types":false,
       "licensed":"1","sort":"1","chan_id":"","disabled":"0" }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | PK; used as dataset id, `colors[id]` index, and response-map key. |
| `ip` / `port` / `pass` | string | Connection info (all six share one host here; pass empty in fragment). |
| `name` | string | Full display name (e.g. `БЕЗ ГОЛОСОВАНИЯ #2`). |
| `short` | string(1) | Legend/axis short code (A, B, C, E, F, G). |
| `ext_short` | string | Extended short (empty). |
| `mods` / `types` | bool | Mods / layer-type restriction flags. |
| `licensed` | string(int) | 1 = licensed. |
| `sort` | string(int) | Display order. |
| `chan_id` | string | Discord channel id (empty). |
| `disabled` | string(int) | 0 = active. |

Server ids are non-contiguous (1, 6, 7, 9, 10, 11 → 2–5, 8 retired/soft-deleted).

#### 2.2 Statistics payload — see the C2 response table (authoritative).

---

### 3. The Page's OWN Table

**None.** Zero DataTables, zero HTML `<table>`. Entirely `<canvas>`-based Chart.js output inside Bootstrap `block-box` cards. No per-row sort/search/pagination. The only filters are the global date range and server multiselect (§5).

---

### 4. Actions / Admin Capabilities

Exactly **one** action, a pure read.

| UI trigger | action | Endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Auto-run on load; on date-range change; on server-select dropdown close (`getStatistic()`) | `statistics` | `POST /ajax/squad.php` | `start` (unix), `end` (unix), `servers` (CSV of ids), `action=statistics` | Returns the aggregated JSON (§ C2); client redraws all charts inside a single `Promise.all`. | **N** |

There is **no** `downloadStat`/CSV/Excel export on this dashboard, unlike nearly every list page (admins, bans, chat, kills, players all carry `downloadStat`). Server statistics are visualized only, not exportable here — a competitive gap.

---

### 5. Forms & Controls

No `<form>`; two standalone controls at the top of `#stat_wrapper`.

**5.1 Date range — `#stat_date`** (`<button type="daterange">`, live label "30 дней")
- `.dateRange({...})` plugin. Presets: `justMonth, justDay, justWeek, justYear, range (custom), today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days`.
- **Default:** `last30days` (live `start=1780560007`, `end=1783152007` ≈ 30-day span). Emits `crm_dateRange` → `getStatistic()`; exposes `data-start`/`data-end`.

**5.2 Server multiselect — `#stat-server`** (`<select multiple type="multiselect">` → Bootstrap `multiselect`)
- Six options = the configured servers (`value`=id, `label`=name). **All selected by default** (live button text "Все выбраны (6)" = All selected (6); each `<li class="active">`).
- Placeholder when empty: `- Сервер -`. `enableHTML: true`.
- **Debounced to dropdown close:** an `onChange` flag is set; `getStatistic()` fires in `onDropdownHide` only if something changed — avoids one RPC per checkbox toggle.

**Loading state:** during a fetch, the date button and multiselect are disabled (`.multiselect('disable')`), `#stat_wrapper` gets class `load`, and the `.load_block` spinner overlay (`fa-spinner fa-pulse`, positioned `top:0;left:5px`) shows. Controls re-enable on completion; charts redraw together via `Promise.all`.

---

### 6. Permission / Visibility Logic

- No `class="hide"`, role checks, or group gating inside the fragment. Access is enforced upstream: whether the `statistics` nav item renders and whether `squad.php action=statistics` authorizes the caller.
- The inlined `servers` map is pre-filtered server-side to servers the operator may view; the client iterates it directly.
- `chartKits`/`chartUnique` are gated by **empty data**, not a permission class — they render blank.

---

### 7. Chart Inventory (20 live canvases) & Competitive Details

All 20 `<canvas id="chart…">` confirmed present in `statistics.content.html`. Grid width from the wrapping `col-md-*`; series model per §1 key shape.

| # | Canvas id | Type | Title (RU → EN) | col width | Feeds key | Series |
|---|---|---|---|---|---|---|
| 1 | `chartOnline` | bar (stacked) | Средний онлайн → Avg online (10:00–03:00) | 6 | `online` | per-server |
| 2 | `chartOnlineMax` | bar (stacked) | Максимально игроков (с очередью) → Peak players incl. queue | 6 | `max` | per-server |
| 3 | `chartAdmins` | line | Среднее кол-во админов → Avg admins | 4 | `admins` | single |
| 4 | `chartAdminsMax` | bar | Максимально админов → Peak admins | 4 | `maxAdmins` | single |
| 5 | `chartBans` | bar | Выдано наказаний → Punishments issued | 4 | `bans` | single |
| 6 | `chartOnlineHour` | bar (stacked) | Средний онлайн по часам → Avg online by hour | 6 | `onlineHour` | per-server |
| 7 | `chartOnlineDay` | bar (stacked) | Средний онлайн по дням недели → Avg online by weekday | 6 | `onlineDay` | per-server |
| 8 | `chartMaps` | bar | Количество карт (не Skirmish/Seed) → Map counts | 8 | `maps` | single |
| 9 | `chartModes` | doughnut | Game-mode distribution | 4 | `modes` | single |
| 10 | `chartNew` | bar | Новых игроков → New players | 7 | `new` | single |
| 11 | `chartChat` | bar (stacked) | Сообщений чата → Chat messages | 5 | `chat` | per-server |
| 12 | `chartTeamkill` | bar (stacked) | Тимкиллы → Teamkills | 6 | `teamkill` | per-server |
| 13 | `chartQueue` | bar (stacked) | Очередь → Queue | 6 | `queue` | per-server |
| 14 | `chartGames` | bar (stacked) | Игр → Matches | 6 | `games` | per-server |
| 15 | `chartKills` | bar (stacked) | Убийств → Kills | 6 | `kills` | per-server |
| 16 | `chartDeaths` | bar (stacked) | Смертей → Deaths | 4 | `death` | per-server |
| 17 | `chartRevivals` | bar (stacked) | Поднятий → Revives | 4 | `revival` | per-server |
| 18 | `chartWounds` | bar (stacked) | Ранений → Wounds | 4 | `wound` | per-server |
| 19 | `chartKits` | horizontalBar | Количество китов → Kit count | — | `kits` (empty) | single — draws blank |
| 20 | `chartUnique` | bar | Уникальных игроков → Unique players | — | `unique` (empty) | single — draws blank |

A `damage` series is also returned; where charted it maps to a damage canvas alongside the combat set.

Competitively interesting details:

- **Subtitle stat strip:** each time-series chart shows `Среднее: <avg>, Максимум: <max>, Всего: <total>` (Avg/Max/Total), computed client-side via `.average()`/`.max()`/`.sum()`/`.sum2d()` (stacking per-server into per-day totals). Totals use `Intl.NumberFormat("en-US")`. At-a-glance KPIs without a separate panel.
- **Business-hours windowing:** several titles hard-code **10:00–03:00** (the servers' active hours) so "average online" excludes dead night hours. Methodology choice to replicate.
- **Map chart excludes Skirmish & Seed** from "real match" counts (separating warmup/seeding from competitive rounds).
- **Consistent per-server coloring** via a fixed `colors[]` palette indexed by server id — same server, same color across all charts.
- **Coordinated redraw** inside one `Promise.all` — atomic refresh.
- **Debounced multi-server filter** (fires on dropdown close) minimizes RPC chatter.
- **`test` profiling block** ships per-sub-query timings to the client — internal instrumentation exposed in the response (info-leak worth noting; also a hint the backend runs ~8 separate aggregate queries).
- **Gaps vs. a competitor build:** no export/download; no drill-down from chart to underlying rows; `unique`/`kits` shipped but returning empty (dead metrics); playtime-hours not charted directly; numeric values inconsistently typed (int vs string, e.g. `maps`) forcing client coercion; single heavy ~1.5 s RPC returns the entire dashboard (no incremental/streamed load). Low-hanging features to differentiate on.

---

### Gaps / Unknowns

- **`getStatistic()` source** is inlined in the `statistics.html` fragment `<script>`, not in `custom.js` — exact per-chart option objects (axis config, colors) are inferred from canvas ids + response keys, not read line-by-line here.
- **`unique`/`kits` real schema** cannot be documented — both returned empty in this deployment; their populated shape is unobserved.
- **`damage` chart canvas id** is inferred from the combat-series grouping; the exact canvas element for the `damage` key was not isolated among the 20 (the combat block renders kills/death/revival/wound/damage together).
- **Backend query structure** behind each aggregate is inferred from the `test` profiling keys, not from `squad.php` source.
