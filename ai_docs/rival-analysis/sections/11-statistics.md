## 11. Statistics Dashboards

### 1. Purpose and Nav Location

- **Nav item:** `statistics` — invoked via `pageLoad('statistics')` → `GET /ajax/page.php?page=statistics`, injected into `#content`.
- **Source fragment:** `frags/statistics.html`.
- **Purpose:** A single-page, all-graphical analytics dashboard rendering ~20 Chart.js charts covering server population (online/queue), staff coverage (admins online), moderation volume (bans/punishments), match throughput, chat/teamkill volume, and per-server combat aggregates (kills/deaths/revives/wounds). It is a **read-only reporting screen** — there is no table, no row-level actions, and no export button on the page itself. All data is pulled by a single RPC (`action:'statistics'`, `script:'squad'`) driven by two controls: a date-range picker and a multi-server selector.

This page is unusual for SQSTAT: unlike the DataTables list pages (players, bans, chat, kills, etc.), it does **not** carry the `downloadStat` export action and, notably, its embedded fragment does **not** appear to include the shared player-detail modal wiring in the analyzed slice — it is a pure visualization surface.

---

### 2. Entities & Fields (inferred data model)

#### 2.1 Server (client-side `servers` map)

A `var servers = {...}` object is inlined in the fragment (`<script>` block, line 204) and drives dataset creation, coloring, and labels. One anonymized example entry:

```json
"1": { "id":"1","ip":"80.242.59.123","port":"0","pass":"","name":"RAAS/AAS #1",
       "short":"A","ext_short":"","mods":false,"types":false,
       "licensed":"1","sort":"1","chan_id":"","disabled":"0" }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | Server primary key; used as dataset `id`, color index (`colors[id]`), and response-map key. |
| `ip` | string | Server IP (all six configured servers share one host in this deployment). |
| `port` | string(int) | Query/RCON port (0 here → likely resolved elsewhere). |
| `pass` | string | RCON/query password (empty in the delivered fragment). |
| `name` | string | Full display name, e.g. "RAAS/AAS #1", "БЕЗ ГОЛОСОВАНИЯ #2" (No Voting #2), "INVASION #3". |
| `short` | string | Single-letter tag (A, B, C, E, F, G) used as the chart dataset `label`/legend and axis short code. |
| `ext_short` | string | Extended short label (unused/empty here). |
| `mods` | bool | Whether the server runs mods. |
| `types` | bool | Layer/type restriction flag. |
| `licensed` | string(int) | License/enabled flag (1 = licensed). |
| `sort` | string(int) | Display ordering. |
| `chan_id` | string | Associated Discord channel id (empty here). |
| `disabled` | string(int) | 0 = active. |

**Competitive note:** server ids are non-contiguous (1, 6, 7, 9, 10, 11 — id 8 and others missing), implying servers are soft-deleted / retired rather than renumbered.

#### 2.2 Statistics response payload (`text` from `action:'statistics'`)

The RPC returns one JSON object; keys are either flat time-series (`{label: value}`) or **nested per-server** (`{serverId: {label: value}}`). Axis label arrays are shared across charts.

| Response key | Shape | Feeds chart | Meaning |
|---|---|---|---|
| `days` | array | X labels (most time-series) | Date buckets for the selected range. |
| `hours` | array | X labels | Hour-of-day buckets (0–23) for the hourly chart. |
| `dayofweek` | array | X labels | Weekday buckets for the day-of-week chart. |
| `online` | `{serverId:{day:val}}` | `chartOnline` | Average online per server per day (stacked). |
| `max` | `{serverId:{day:val}}` | `chartOnlineMax` | Peak players incl. queue, per server per day (stacked). |
| `admins` | `{day:val}` | `chartAdmins` | Average admin count online (single series, line). |
| `maxAdmins` | `{day:val}` | `chartAdminsMax` | Peak admins online per day (single series, bar). |
| `bans` | `{day:val}` | `chartBans` | Punishments issued per day (single series; subtitle shows total). |
| `onlineHour` | `{serverId:{hour:val}}` | `chartOnlineHour` | Avg online by hour of day, per server (stacked). |
| `onlineDay` | `{serverId:{weekday:val}}` | `chartOnlineDay` | Avg online by weekday, per server (stacked). |
| `modes` | `{modeName:count}` | `chartModes` | Match count per game mode (doughnut). |
| `maps` | `{mapName:count}` | `chartMaps` | Match count per map, excluding Skirmish/Seed (bar). |
| `new` | `{day:val}` | `chartNew` | New/first-seen players per day. |
| `chat` | `{serverId:{day:val}}` | `chartChat` | Chat messages per server per day (stacked; subtitle: avg/max/total). |
| `teamkill` | `{serverId:{day:val}}` | `chartTeamkill` | Teamkills per server per day (stacked). |
| `queue` | `{serverId:{day:val}}` | `chartQueue` | Queue length per server per day (stacked). |
| `games` | `{serverId:{day:val}}` | `chartGames` | Matches played per server per day (stacked). |
| `kills` | `{serverId:{day:val}}` | `chartKills` | Kills per server per day (stacked). |
| `death` | `{serverId:{day:val}}` | `chartDeaths` | Deaths per server per day (stacked). |
| `revival` | `{serverId:{day:val}}` | `chartRevivals` | Revives per server per day (stacked). |
| `wound` | `{serverId:{day:val}}` | `chartWounds` | Wounds (downs) per server per day (stacked). |

Two additional charts, **`chartKits` (Количество китов / Kit count, horizontalBar)** and **`chartUnique` (Уникальных игроков / Unique players)**, are defined in JS but their surrounding HTML `<canvas>` blocks are **commented out** (lines 182–201) — dead/disabled features not currently rendered.

---

### 3. The Page's OWN Table

**None.** This page renders zero DataTables and zero HTML `<table>`. It is entirely `<canvas>`-based Chart.js output inside Bootstrap grid `block-box` cards. There is no per-row sort/search/pagination. The only "filter" controls are the global date range and server multiselect (Section 5).

---

### 4. Actions / Admin Capabilities

Only **one** action exists on this page, and it is a pure read (non state-changing).

| UI trigger | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Auto-run on load, on date-range change, and on server-select dropdown close (`getStatistic()`) | `statistics` | `POST /ajax/squad.php` (`script:'squad'`) | `start` (range start, from `#stat_date` `data-start`), `end` (range end, from `data-end`), `servers` (array of selected server ids from `#stat-server`) | Returns the aggregated statistics JSON (Section 2.2); client redraws all charts. | **N** (read-only) |

Notes:
- Payload is exactly `{ start, end, servers }` — see `getStatistic()` at `statistics.html:980`.
- There is **no** `downloadStat`, `stats`, CSV, or Excel export on this dashboard, in contrast to nearly every list page in the app (admins, bans, chat, kills, players, etc. all carry `downloadStat`). Server-side statistics are visualized only, not exportable from the UI here — a competitive gap worth beating.

---

### 5. Forms & Controls

No `<form>` element; two standalone controls at the top of `#stat_wrapper`:

**5.1 Date range — `#stat_date`** (`<button type="daterange">`)
- Initialized via `.dateRange({...})` plugin.
- Preset options offered: `justMonth`, `justDay`, `justWeek`, `justYear`, `range` (custom), `today`, `yesterday`, `currentWeek`, `lastWeek`, `currentMonth`, `lastMonth`, `last30days`.
- **Default:** `last30days`.
- Emits `crm_dateRange` event → calls `getStatistic()`. Exposes `data-start` / `data-end` consumed by the RPC.

**5.2 Server multiselect — `#stat-server`** (`<select multiple>` → Bootstrap `multiselect`)
- Options are the six configured servers (value = server id, label = full name), **all selected by default**.
- Placeholder when empty: `- Сервер -`.
- `enableHTML: true`.
- Change is **debounced to dropdown close**: an `onChange` flag is set, and `getStatistic()` only fires in `onDropdownHide` if something actually changed — avoids one RPC per checkbox toggle. Good UX pattern to copy.

**Loading state:** during a fetch, the date button is disabled, the multiselect is disabled (`.multiselect('disable')`), `#stat_wrapper` gets class `load`, and a spinner overlay (`.load_block` with `fa-spinner fa-pulse`) shows. Controls re-enable on completion. Charts are updated inside `Promise.all([...])` so all redraw together.

---

### 6. Permission / Visibility Logic

- No `class="hide"`, role checks, or group gating are present within the fragment itself. Access control is enforced upstream: whether the `statistics` nav item is rendered and whether `POST /ajax/squad.php action=statistics` is authorized is decided server-side (not visible in this fragment).
- The server list injected into `servers` is pre-filtered server-side to the servers this operator may view — the client trusts and iterates it directly.
- The commented-out `chartKits`/`chartUnique` cards are hidden by HTML comment, not by permission class.

---

### 7. Chart Inventory & Notable UX / Competitive Details

Full rendered chart list (title text is Russian in-source; English gloss added):

| Canvas id | Type | Title (RU → EN) | Grid width | Series model |
|---|---|---|---|---|
| `chartOnline` | bar (stacked) | Средний онлайн (10:00 - 03:00) → Average online (10:00–03:00) | col-6 | per-server |
| `chartOnlineMax` | bar (stacked) | Максимально игроков (с очередью) → Peak players (incl. queue) | col-6 | per-server |
| `chartAdmins` | line | Среднее кол-во админов (10:00 - 03:00) → Avg admins online | col-4 | single |
| `chartAdminsMax` | bar | Максимально админов → Peak admins | col-4 | single |
| `chartBans` | bar | Выдано наказаний → Punishments issued | col-4 | single |
| `chartOnlineHour` | bar (stacked) | Средний онлайн по часам дня → Avg online by hour of day | col-6 | per-server |
| `chartOnlineDay` | bar (stacked) | Средний онлайн по дням недели → Avg online by weekday | col-6 | per-server |
| `chartMaps` | bar | Количество карт (не Skirmish или Seed) → Map counts (excl. Skirmish/Seed) | col-8 | single |
| `chartModes` | doughnut | Game-mode distribution | col-4 | single |
| `chartNew` | bar | Новых игроков → New players | col-7 | single |
| `chartChat` | bar (stacked) | Сообщений чата → Chat messages | col-5 | per-server |
| `chartTeamkill` | bar (stacked) | Тимкиллы → Teamkills | col-6 | per-server |
| `chartQueue` | bar (stacked) | Очередь → Queue | col-6 | per-server |
| `chartGames` | bar (stacked) | Игр → Matches | col-6 | per-server |
| `chartKills` | bar (stacked) | Убийств → Kills | col-6 | per-server |
| `chartDeaths` | bar (stacked) | Смертей → Deaths | col-4 | per-server |
| `chartRevivals` | bar (stacked) | Поднятий → Revives | col-4 | per-server |
| `chartWounds` | bar (stacked) | Ранений → Wounds | col-4 | per-server |
| `chartKits` *(disabled)* | horizontalBar | Количество китов → Kit count | — | single |
| `chartUnique` *(disabled)* | bar | Уникальных игроков → Unique players | — | single |

Competitively interesting details:

- **Subtitle stat strip:** every time-series chart computes and displays a subtitle line reading `Среднее: <avg>, Максимум: <max>, Всего: <total>` (Average / Maximum / Total), computed client-side via helper array methods `.average()`, `.max()`, `.sum()`, and `.sum2d()` (for stacking per-server series into a per-day total). Totals are formatted with `Intl.NumberFormat("en-US")` (thousands separators). This gives at-a-glance KPIs without a separate stat panel.
- **Business-hours windowing:** several titles hard-code the analysis window **10:00–03:00**, i.e. the servers' active hours — averages deliberately exclude dead night hours to avoid diluting "average online". A subtle but meaningful methodology choice to replicate.
- **Map chart explicitly excludes Skirmish and Seed layers** from "real match" counts — separating warmup/seeding from competitive rounds.
- **Consistent per-server coloring:** a fixed `colors[]` palette indexed by server id keeps a server the same color across all charts, aiding cross-chart reading.
- **Coordinated redraw:** all charts update inside a single `Promise.all`, so the dashboard refreshes atomically rather than popping in piecemeal.
- **Debounced multi-server filter** (fires only on dropdown close) minimizes RPC chatter.
- **Gaps vs. a competitor build:** no export/download, no drill-down from chart to underlying rows, seeding volume not charted as its own metric (only inferred via queue/online), playtime hours not directly charted, and the Kits/Unique-players charts are shipped-but-disabled. These are low-hanging features to differentiate on.
