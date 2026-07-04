## 14. Votes & Reports

Competitive analysis of the SQSTAT admin panel's **Votes log** (`votes`) and **player Report system** (`reports`), upgraded to implementation-spec quality from **live captured API contracts** against `https://breaking.sqstat.ru`. Both are read/monitor feeds built on the shared client-side `$.fn.buildTable` engine (server-side paginated), rendered as a scrollable **list-group of cards** (not a classic `<table>`), and both embed the shared player-detail modal that carries every mutating admin action.

Capture evidence (ground truth for this chapter):
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/votes.network.json` — 3 live AJAX contracts (page load + table + pagination).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/reports.network.json` — 2 live AJAX contracts (page load + table).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/votes.content.html`, `reports.content.html` — live rendered `#content` (real filters, template `data-table` fields, buildTable config).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/_blocked.json` — `[]` (zero mutations attempted/blocked; capture was pure observation).
- Client engine: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/custom.js` (`$.fn.buildTable`).

> Privacy: response samples below are redacted; a single redacted example per field is shown to convey type/shape only. No real SteamIDs/names/IPs are reproduced.

---

### 14.1 Purpose & Navigation

| Page | Nav id | Loaded via | Purpose |
|------|--------|-----------|---------|
| Votes | `votes` | `pageLoad('votes')` → `GET /ajax/page.php?page=votes` | Historical audit log of in-game votes (map skip / re-roll / map change). Captures initiator identity, server, outcome, threshold math (collected vs required), the full map triple (current → next → target), vote duration, and the **complete per-voter list**. |
| Reports | `reports` | `pageLoad('reports')` → `GET /ajax/page.php?page=reports` | Log of player-submitted in-game reports (Squad `!report`). Shows the reported (target) player, the report text, server tag, and timestamp, with a one-click jump into the target's full admin card. |

Both pages share a two-column layout: a `position:fixed` left sidebar (`width:240px`, `.col-md-4.mobile-left`) with filters, and a right content area holding the results list (`#votes_list` / `#reports_list`, a `<ul class="list-group">`). Live-verified server option set (shared by both filters): id `1` `RAAS/AAS #1`, `6` `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2), `7` `INVASION #3`, `9` `Custom для FW`, `10` `Custom для MDC`, `11` `Custom для BSS`.

---

### 14.2 Data-flow / rendering engine (buildTable)

Rows are **not** rendered with `<thead>/<th>`. A hidden `<div id="template" class="hide">` holds one `<li>` card whose descendants carry `data-table="<field>"` placeholders; `buildTable` clones it per row and fills each placeholder from the JSON response `data.row[]`.

Live buildTable config (from captured `#content`):

```js
// votes.content.html
$('#votes_list').buildTable({ table:'votes', collum:[], numrows:30, mode:'custom',
  searchInput:["votes-server"], template:$('#template > li'),
  end: d => d.selector.find('a[data-type="btn_open"]').click(...player.open(steam_id)) });

// reports.content.html
$('#reports_list').buildTable({ table:'reports', collum:[], numrows:30, mode:'custom',
  searchInput:["reports-server"], template:$('#template > li'),
  callback:{ date: (v,row) => formatDate(v,false,true) },   // client-formats the date column
  end: d => d.selector.find('a[data-type="btn_open"]').click(...player.open(steam_id)) });
```

Row fetches go through the RPC helper `Action({script:'table', action:'<votes|reports>', data:<query>})` → **`POST /ajax/table.php`**. Pagination re-issues the same call with `&pagination=true` (fired by `getPagination()` only when the current page fills or `currentPage != 1`). Text inputs submit on Enter (`keypress==13`) or the search button, setting `conf.page=1; conf.isSearch=true`; multiselect submits on change via `buildTable('rebuild')`. `collum:[]` + `mode:'custom'` means there is no column model — placeholders are matched by `data-table` name, so **there are no sortable columns** on these two feeds.

Search is assembled client-side into `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` keyed by each input's `data-search` attribute, then `encodeURIComponent(JSON.stringify(...))`. Text values get `+` escaped to `%2B` before submit.

> The `<th>` elements present later in both fragments belong exclusively to the **shared player-detail modal** (Chat/Kills/Deaths/Kits/Games/Damage tabs). They are NOT columns of the votes/reports lists.

---

### 14.3 Live API Contracts

All three endpoints are same-origin `https://breaking.sqstat.ru`. Envelope convention: top-level `status:"ok"`, `exec_time:float`; table payload nested under `data`.

#### 14.3.1 `GET /ajax/page.php?page={votes|reports}` — page shell

| Param | Type | Required | Meaning |
|-------|------|----------|---------|
| `page` | enum `votes` \| `reports` | Y | Which page fragment to render. |

Response: `text/html; charset=UTF-8` (≈113 KB) — the `#content` markup (sidebar filters + hidden `#template` + inline buildTable bootstrap). Not JSON. Cite: `votes.network.json[0]`, `reports.network.json[0]`.

#### 14.3.2 `POST /ajax/table.php` (action=votes) — vote log page

Request params (form-urlencoded), captured verbatim:

| Param | Type | Required | Meaning |
|-------|------|----------|---------|
| `action` | const `votes` | Y | Server table handler selector. |
| `table` | const `votes` | Y | Mirror of `action` (sent by buildTable). |
| `page` | int | Y | 1-based page number. |
| `numrows` | int | Y | Page size; fixed **30**. |
| `search` | urlencoded JSON | Y | `{"text":{},"check":{},"multiselect":{...},"managers":{},"slider":{}}`. Votes uses only `multiselect.server_id` (array of server ids). Empty object = no filter. |
| `order_by` | string \| `false` | Y | Sort column DB alias; literal `false` when unsorted (default). |
| `order_sort` | string \| `false` | Y | `asc`/`desc` or literal `false` (default). |
| `pagination` | `true` | N | When present, returns count-only payload (see 14.3.4). |

Captured request body (default first load):
```
action=votes&table=votes&page=1&numrows=30
&search=%7B%22text%22%3A%7B%7D%2C%22check%22%3A%7B%7D%2C%22multiselect%22%3A%7B%7D%2C%22managers%22%3A%7B%7D%2C%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

Response `application/json`, shape `data.row[]` = array of vote records (page size 30). Field contract (from `response_schema`, all scalar values are JSON strings):

| Field | Type | Meaning |
|-------|------|---------|
| `id` | str (numeric) | Vote row PK. Live max observed `3991` ⇒ auto-increment. |
| `server_id` | str (numeric) | FK to server (`1`,`6`,`7`,`9`,`10`,`11`). |
| `date` | str `"HH:MM [DD.MM.YYYY]"` | Vote timestamp, **pre-formatted server-side** (e.g. `"00:51 [04.07.2026]"`), not a unix epoch. |
| `steam_id` | str(17) | Initiator's SteamID64; fed to `player.open()` by the **открыть** button. Redacted in sample. |
| `name` | str | Initiator display name. Redacted in sample. |
| `short` | str(1) | Server short tag rendered in `<kbd>[…]</kbd>` (e.g. `"A"`). |
| `mode` | str (enum, Russian) | Vote type. Observed value `"Пропуск карты"` (map skip). Other expected members: map change / re-roll. |
| `map_current` | str | Current map at vote time (e.g. `"Harju RAAS v1"`). |
| `map_next` | str | Next map in rotation; may be empty `""`. |
| `map_vote` | str | Proposed target map; `"-"` when N/A (e.g. skip votes). |
| `players_sum` | str (numeric) | Yes-votes collected ("Набралось" / Collected). |
| `players_need` | str (numeric) | Threshold required to pass ("Необходимо" / Required). |
| `duration` | str (numeric, seconds) | Vote window length, e.g. `"190"`. Not surfaced in the card template. |
| `cancel` | str (HTML) | Outcome/status, delivered as a ready `<span class="label label-…">` badge (≈105 chars). Rendered raw into "Статуc" (Status). |
| `votes` | str (JSON) | **Full per-voter roster** — `{"yes":["7656119…","7656119…"], …}` (≈236 chars in sample). Present in the payload but **not bound to any `data-table` placeholder** (unused by the card). High-value analytics field. |
| `map_current_img` | str (HTML) | Ready `<img data-type="map" …>` thumbnail block for current map. |
| `map_next_img` | str (HTML) | Ready `<p>/<img>` block for next map. |

Envelope siblings under `data`: `totalPage:int`, `totalRows:int` (both `0` on the row call — real counts come from the pagination call), `currentPage:str`, `custom:bool`, `query_time:int`, `count_time:int`. Top level: `status:str("ok")`, `exec_time:float`. Cite: `votes.network.json[1]`.

Redacted example row:
```json
{ "id":"3991","server_id":"1","date":"00:51 [04.07.2026]","steam_id":"<redacted:17>",
  "map_current":"Harju RAAS v1","map_next":"","map_vote":"-","mode":"Пропуск карты",
  "players_sum":"<redacted:1>","players_need":"<redacted:2>","duration":"190",
  "cancel":"<span class=\"label label-primary\" …>","votes":"{\"yes\":[\"765611992…\"]}",
  "name":"<redacted:10>","short":"A","map_current_img":"<img data-type=\"map\" …>",
  "map_next_img":"<p class=\"text-center\">…</p>" }
```

#### 14.3.3 `POST /ajax/table.php` (action=reports) — report log page

Request params identical to 14.3.2 with `action=reports&table=reports`. Reports additionally drives two text filters via `search.text` (see 14.5.2). Captured body:
```
action=reports&table=reports&page=1&numrows=30
&search=%7B%22text%22%3A%7B%7D,%22check%22%3A%7B%7D,%22multiselect%22%3A%7B%7D,%22managers%22%3A%7B%7D,%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

Response `application/json`. In the live capture the account's report set was empty: `data.row = []` (`array[0]`), `totalRows=0`, `totalPage=0`. Envelope identical to votes (`currentPage`, `custom`, `query_time`, `count_time`, `status:"ok"`, `exec_time`). Cite: `reports.network.json[1]`.

Because rows were empty, the **row field contract is reconstructed from the live `#template` `data-table` placeholders** (authoritative for what the client renders) plus the search aliases (authoritative for the server JOIN):

| Field (`data-table`) | Type | Meaning |
|----------------------|------|---------|
| `short` | str | Server short tag, rendered in `<kbd>`. |
| `date` | str/int | Report timestamp; passed through client `formatDate(v,false,true)` (buildTable `callback.date`), implying a raw/less-formatted value than the votes `date`. |
| `player_name` | str | **Reported (target)** player display name (bold). |
| `steam_id` | str(17) | Target SteamID64; drives **открыть** → `player.open()`. |
| `text` | str | Free-text report body, rendered in `<p data-table="text">`. |

**JOIN aliases (from search `data-search`):** `t2.player` (joined players table → target nick/SteamID) and `t1.text` (reports table → message). The server query joins **reports `t1`** to **players `t2`**. The **reporter's identity is not exposed** in the template or the search surface — either unselected in this list or stored server-side only.

#### 14.3.4 `POST /ajax/table.php` … `&pagination=true` — count sidecar

Same body as the row call plus `pagination=true`. Returns a count-only JSON (no rows) used to render page links. Fired by `getPagination()`.

| Field | Type | Meaning |
|-------|------|---------|
| `totalPage` | int | Page count. Live votes: `134`. |
| `totalRows` | str (numeric) | Total matching rows. Live votes: `"3991"`. |
| `count_time` | int | Server count timer. |
| `status` | str `"ok"` | Envelope status. |
| `exec_time` | float | Server exec timer. |

Live sample (votes): `{ "totalPage":134, "totalRows":"3991", "count_time":0, "status":"ok", "exec_time":0.008 }`. Cite: `votes.network.json[2]`. (No pagination sidecar fired for reports since the set was empty.)

---

### 14.4 Votes page — entity, card & controls

#### 14.4.1 Card template (`#template > li`) → field binding

| Card region (Russian label → gloss) | Bound `data-table` |
|--------------------------------------|--------------------|
| `<kbd>[short]</kbd>` badge | `short` |
| Bold initiator name | `name` |
| `<hashtag>` SteamID | `steam_id` |
| Right-aligned timestamp | `date` |
| **Статуc** (Status) | `cancel` |
| **Режим** (Mode) | `mode` |
| **Набралось** (Collected) | `players_sum` |
| **Необходимо** (Required) | `players_need` |
| **Текущая** (Current map) | `map_current` |
| **Следующая** (Next map) | `map_next` |
| **На какую** (Target map) | `map_vote` |
| Current-map thumbnail | `map_current_img` |
| Next-map thumbnail | `map_next_img` |

Payload fields **`duration`, `votes`, `id`, `server_id` are delivered but not bound** to the card (dark data available to a reimplementation).

#### 14.4.2 Sidebar controls

| Control | `#id` / `name` | Input type | `data-search` | Default | Effect |
|---------|----------------|-----------|---------------|---------|--------|
| Server filter | `#votes-server` | `multiselect` (bootstrap-multiselect, `nonSelectedText:'- Сервер -'`, `enableHTML:true`) | `server_id` | none selected | `onChange` → `$('#votes_list').buildTable('rebuild')`. Options: `1`,`6`,`7`,`9`,`10`,`11`. |

Votes sidebar has **no text search and no explicit search button** — server-multiselect is the only filter. Pagination: 30/page, numeric + first/prev/next/last, with a "Всего: N" (Total) footer in `#votes_list-infoblock`.

#### 14.4.3 Votes page actions

| Label | Trigger | Endpoint | `Action({...})` data | Destructive |
|-------|---------|----------|----------------------|-------------|
| **открыть** (open) | `a[data-type="btn_open"]` click → `player.open(steam_id)` | `POST /ajax/player.php` `action=get` | `{ script:'player', action:'get', data:{ steam_id } }` | **N** (read) — opens shared modal for the initiator |

The votes page has **no destructive action of its own**; every mutation is one modal-flip away (§14.6).

---

### 14.5 Reports page — entity, card & controls

#### 14.5.1 Card template (`#template > li`) → field binding

| Card region | Bound `data-table` |
|-------------|--------------------|
| `<kbd>short</kbd>` badge | `short` |
| Right-aligned timestamp | `date` (via `callback.date → formatDate(v,false,true)`) |
| Bold target player name | `player_name` |
| `<hashtag>` SteamID | `steam_id` |
| `<p>` report body | `text` |

#### 14.5.2 Sidebar controls

| Control | `#id` / `name` | Input type | maxlength | `data-search` | Placeholder | Effect |
|---------|----------------|-----------|-----------|---------------|-------------|--------|
| **Поиск** (Search) button | `#reports_list-btn` | `<button>` (`fa-search`) | — | — | — | Submits current filters; re-fetches page 1 with `isSearch=true`. |
| Name / SteamID filter | `#reports-name` | `text` | (none set) | `t2.player` | `Ник или SteamID` (Nick or SteamID) | Free-text match on target nick/SteamID; submits on Enter or via search button (`search.text["t2.player"]`). |
| Text filter | `#reports-killed` | `text` | (none set) | `t1.text` | `Текст` (Text) | Full-text search over report body (`search.text["t1.text"]`). |
| Server filter | `#reports-server` | `multiselect` (`- Сервер -`, `enableHTML:true`) | — | `server_id` | — | `onChange` → `buildTable('rebuild')`. Options `1`,`6`,`7`,`9`,`10`,`11`. |

> `#reports-killed` is a copy-paste artifact from a kill-log page; its bound field is `t1.text` (report body), not a kill. Only `reports-server` is registered in `searchInput`, but the two text inputs still contribute via their `data-search` on submit. Pagination identical to votes (30/page, edges, totals footer; live set was empty so `Всего: 0`).

#### 14.5.3 Reports page actions

| Label | Trigger | Endpoint | `Action({...})` data | Destructive |
|-------|---------|----------|----------------------|-------------|
| **открыть** (open) | `a[data-type="btn_open"]` → `player.open(steam_id)` | `POST /ajax/player.php` `action=get` | `{ script:'player', action:'get', data:{ steam_id } }` | **N** (read) — opens target's admin card |

Reports has **no report-lifecycle mutation** (no resolve / claim / assign / mark-handled) — confirmed against both the template and the action catalog for `reports.html`, which lists only the shared player/squad actions (§14.6), no `report_*` verb.

---

### 14.6 Shared player-detail modal (the mutating surface)

Both pages embed `#playerModal`. **открыть** loads the player via `action=get` and renders a card that flips to sub-panels for punishment, group change, and messaging. These are the only state-changing capabilities reachable from votes & reports; per `action_catalog.txt`, `votes.html` and `reports.html` expose the identical action set (`script:'player'` + `script:'squad'`). Each row = a permission enforced server-side.

| Capability | Script endpoint | Action | Key data params | Destructive |
|-----------|-----------------|--------|-----------------|-------------|
| Load player card | `/ajax/player.php` | `get` | `steam_id` | N |
| Get comments | `/ajax/player.php` | `getComments` | `steam_id` | N |
| Check bans (cross-panel) | `/ajax/player.php` | `checkBans` | `steam_id` | N |
| Find twinks / friends | `/ajax/player.php` | `twink`, `twinkOnline`, `findFriends` | `steam_id` | N |
| Online telemetry | `/ajax/player.php` | `getPlayerOnlineData` | `steam_id` | N |
| Kits (list) | `/ajax/player.php` | `kits` | `steam_id` | N |
| Download stat | `/ajax/player.php` | `downloadStat` | `steam_id` | N |
| Kit save | `/ajax/player.php` | `kitSave` | `steam_id`, kit | **Y** |
| Add comment | `/ajax/player.php` | `addComment` | `steam_id`, comment | **Y** |
| Mark (flag) player | `/ajax/player.php` | `mark` | `steam_id`, `mark` | **Y** |
| Change group/role | `/ajax/player.php` | `changeGroup` | `steam_id`, `group_id`, `date`(expire), `description`, `prefix`, `prefix_rgb`, `image` | **Y** |
| Send in-game message | `/ajax/player.php` | `message` | `steam_id`, `msg`, `time`(repeat s), `log` | **Y** |
| Ban-name allow/deny | `/ajax/player.php` | `addBanName`, `removeBanName` | name payload | **Y** |
| Kick from server | `/ajax/squad.php` | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | **Y** |
| Ban (temp/perm) | `/ajax/squad.php` | `ban` | `server_id`(if online), `steam_id`, `reason_id`, `description`, `days` (`-1`=perm) | **Y** |
| Unban | `/ajax/squad.php` | `unban` | `steam_id`, `unban`(bool) | **Y** |
| Remove from squad | `/ajax/squad.php` | `removePlayer` | `server_id`, `steam_id` | **Y** |
| Switch team | `/ajax/squad.php` | `changeTeam` | `server_id`, `steam_id` | **Y** |
| Kill player | `/ajax/squad.php` | `kill` | `server_id`, `steam_id` | **Y** |

**Ban/kick (Наказание) form:** `<select id="player_ban-reason">` = a rule catalog in `<optgroup>`s (Особые / Общие / Для сквадных / Для техники / Милсим), each option value a rule id (e.g. `110` = "1.1 Оскорбления"; `2` = DPAC anti-cheat auto-ban), carrying `data-first/second/third/four` (escalation-tier default day counts). Reason-type radios `player_ban-reason_type`: Кикнуть (`-1`), Забанить N дней for 1/2/3/4/5/6/7/10/14/30, and Забанить навсегда (perm, `data-day=0`). Comment `<textarea maxlength=512>`. Special case: reason `-1` (Другое) routes straight to `banPlayer`.

**Group change (Смена группы):** groups `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера, `5` Стажёр; plus expiry daterange, comment (128), prefix text (64), prefix RGB (16), image URL (256); hidden "VIP +1 месяц" quick button.

**In-game message (Сообщение):** 18 canned templates including "Ваш репорт рассматривается модерацией" (your report is under review) — the de-facto report acknowledgement; "add record to card" checkbox `player_message-log`; free-text `<textarea maxlength=512>`; repeat select 1 раз / 30с / 40с / 60с (default) / 90с / 120с.

---

### 14.7 Permission / visibility logic

- Every sub-panel ships in the fragment wrapped `class="hide"` (`#player_ban`, `#player_group`, `#player_message`, `#player_info`, `#template`) and is revealed by JS flip/clone — visibility is client-driven, not role-gated in markup.
- No role/group conditional markup exists in these two fragments: the full ban catalog, all day tiers (incl. permanent), group assignment (incl. Администратор), kill, and messaging render regardless of viewer. Authorization is therefore **enforced server-side** on `/ajax/squad.php` and `/ajax/player.php` per action; the client renders the complete capability set. A competitor must not assume the client hides anything sensitive.
- `open` (`action=get`) is the only capability the votes/reports feeds expose directly; everything destructive is one modal-flip away behind a server permission check.
- Table reads (`/ajax/table.php`) accept arbitrary `page`/`numrows`/`search` from the client but respond only within the authenticated session's scope (empty report set observed for this account).

---

### 14.8 Notable UX & competitively interesting details

- **Vote record is analytics-grade and under-exposed:** the payload carries `players_sum` vs `players_need`, the full map triple with pre-baked thumbnails, `duration` (seconds), and — critically — a complete `votes` roster JSON (`{"yes":[…SteamIDs…]}`) that the UI **never renders**. A competitor exposing per-voter breakdowns, per-server pass rates, and repeat-skip-initiator detection would out-analyze SQSTAT using data it already collects but discards.
- **Server pre-renders presentation into data:** `cancel`, `map_current_img`, `map_next_img` arrive as HTML fragments, and `date` is pre-formatted for votes but raw for reports (client `formatDate`) — an inconsistency and an XSS-surface tell (raw HTML injected via `data-table`).
- **One-click pivot to enforcement:** both feeds deep-link the offender straight into the full ban/kick/message arsenal — tight report→action loop worth matching.
- **Rule-id driven bans with escalation defaults** (`data-first..four`) standardize moderation and feed analytics — strong feature to match.

**Gaps to beat:**
- **No report lifecycle:** confirmed via empty-schema + action catalog — reports have no status/assignee/resolution/"handled-by" field or verb. A moderator cannot claim, resolve, or dedupe reports. A proper queue (open/claimed/resolved, SLA timers, repeat-target dedupe) is a clear differentiator.
- **Reporter identity not surfaced** (`t2.player` is the *target*; no reporter alias in template or search) — no trusted-reporter weighting or false-report-spam detection.
- **Thin filters:** votes filters on `server_id` only (no date range, no `mode`, no initiator search); reports has no date-range filter. `order_by`/`order_sort` are wired in the protocol but `collum:[]` disables sorting on these feeds.
- **Fixed 30/page**, no adjustable page size, no column sort.
- **Code-quality tells:** reused/mis-purposed ids (`#reports-killed` bound to `t1.text`) signal template copy-paste — a cleaner data model is a low bar to clear.
