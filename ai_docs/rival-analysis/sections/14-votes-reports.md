## 14. Votes & Reports

Competitive analysis of the SQSTAT admin panel's **Votes log** (`votes`) and **player Report system** (`reports`). Both are read/monitor pages built on the same client-side `buildTable` engine (server-side paginated data), rendered as a scrollable **list-group of cards** (not a classic `<table>`), and both embed the shared player-detail modal that carries all the mutating admin actions.

Source fragments analyzed:
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/votes.html`
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/reports.html`
- Client engine: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/custom.js` (`$.fn.buildTable`, lines ~605–1090)

---

### 14.1 Purpose & Navigation

| Page | Nav id | Loaded via | Purpose |
|------|--------|-----------|---------|
| Votes | `votes` | `pageLoad('votes')` → `GET /ajax/page.php?page=votes` | Historical log of in-game votes (map change / re-roll / skip votes). Shows who triggered the vote, on what server, whether it passed or was cancelled, current/next/target map, and the yes-count vs. threshold. |
| Reports | `reports` | `pageLoad('reports')` → `GET /ajax/page.php?page=reports` | Log of player-submitted in-game reports (the Squad `!report` / admin-request flow). Shows the reported player, the report text, server, and timestamp, with a one-click jump into the reported player's full admin card. |

Both pages share a **two-column layout**: a `position:fixed` left sidebar (240px) with filters, and a right `col-md-8` content area holding the results list (`#votes_list` / `#reports_list`, a `<ul class="list-group">`).

---

### 14.2 Data flow / rendering engine

Neither page renders rows with `<thead>/<th>`. Instead:

- A hidden `<div id="template" class="hide">` holds a single `<li>` card whose child elements carry `data-table="<field>"` attributes. `buildTable` clones this template per row and fills each `data-table` placeholder from the server response.
- Config is passed inline: `$('#votes_list').buildTable({ table: 'votes', mode: 'custom', numrows: 30, template: $('#template > li'), searchInput: [...] })` (reports uses `table: 'reports'`).
- Row data is fetched with the standard RPC helper: `Action({ script: 'table', action: '<votes|reports>', data: <query> })` → **POST `/ajax/table.php`** with `action=votes` (or `reports`). Pagination issues the same call with `&pagination=true` to get `totalPage` / `totalRows`.
- Page size is fixed at **30 rows**; server-side pagination renders numeric page links plus first/prev/next/last.
- The `<th>` elements present in both fragments belong exclusively to the **shared player-detail modal** (Chat/Kills/Deaths/Kits/Games/Damage tabs: Дата, Чат, Сообщение, Убил, Кит, ID, Название, Карта, Победа, Игрок, Оружие, Поднял, Урон, Техника). They are NOT columns of the votes/reports lists and must not be attributed to these pages.

Search is assembled client-side into a JSON object grouped by input type — `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` — keyed by each input's `data-search` attribute, then `encodeURIComponent(JSON.stringify(...))` and sent in the table query. Text inputs submit on Enter (keypress 13) or the search button; multiselect submits on change.

---

### 14.3 Votes page

#### 14.3.1 Entity: Vote log record

Fields inferred from the `#template` card's `data-table` placeholders:

| Field (`data-table`) | UI label | Meaning / type |
|----------------------|----------|----------------|
| `short` | shown in `<kbd>[…]</kbd>` | Server short tag / vote-type short code (e.g. server prefix badge). |
| `name` | bold player name | Display name of the vote **initiator**. |
| `steam_id` | `<hashtag>` | Initiator's SteamID64; also fed to `player.open()` when the **открыть (open)** button is clicked. |
| `date` | right-aligned | Timestamp of the vote. |
| `cancel` | **Статус (Status)** | Vote outcome/status (e.g. passed vs. cancelled/aborted). Rendered as-is from server. |
| `mode` | **Режим (Mode)** | Vote type/mode (map change, skip, re-roll, etc.). |
| `players_sum` | **Набралось (Collected)** | Number of yes-votes actually gathered. |
| `players_need` | **Необходимо (Required)** | Threshold of votes required to pass. |
| `map_current` | **Текущая (Current)** | Current map at time of vote. |
| `map_next` | **Следующая (Next)** | Next map in rotation. |
| `map_vote` | **На какую (Target)** | Map the vote is proposing to switch to. |
| `map_current_img` | (image) | Thumbnail for current map. |
| `map_next_img` | (image) | Thumbnail for next map. |

This is a rich, purpose-built vote-audit record: initiator identity + result + threshold math + map context (current → next → proposed) with map thumbnails.

#### 14.3.2 Votes list controls (page's own controls)

| Control | id / attr | Type | `data-search` | Effect |
|---------|-----------|------|---------------|--------|
| Server filter | `#votes-server` | `multiselect` (bootstrap-multiselect, placeholder `- Сервер -`) | `server_id` | Filters votes to selected server(s); rebuilds the list on change. |

Server options (shared across both pages) are the project's live servers, e.g. `RAAS/AAS #1` (id 1), `БЕЗ ГОЛОСОВАНИЯ #2` (id 6), `INVASION #3` (id 7), `Custom для FW` (9), `Custom для MDC` (10), `Custom для BSS` (11).

- **No text search and no explicit search button** on the votes sidebar — filtering is server-multiselect only.
- Pagination: 30/page, numeric + first/prev/next/last, with a "Страница X из Y · Всего: N" info footer.

#### 14.3.3 Votes page actions

| Label | Trigger | Endpoint | Data | State-changing? |
|-------|---------|----------|------|-----------------|
| **открыть (open)** | `a[data-type="btn_open"]` click → `player.open(steam_id)` | POST `/ajax/player.php` `action=get` | `steam_id` | N (read) — opens the shared player modal for the initiator |

The votes page itself has **no destructive actions**; all mutations come from the shared modal (§14.5).

---

### 14.4 Reports page

#### 14.4.1 Entity: Report record

Fields inferred from the `#template` card:

| Field (`data-table`) | UI label | Meaning / type |
|----------------------|----------|----------------|
| `short` | `<kbd>` badge | Server short tag / report code. |
| `date` | right-aligned | Report timestamp. Formatted client-side via `callback.date → formatDate(data, false, true)`. |
| `player_name` | bold | Display name of the **reported (target) player**. |
| `steam_id` | `<hashtag>` | Target player's SteamID64; drives the **открыть (open)** button → `player.open()`. |
| `text` | `<p>` block | Free-text body of the report (the reason/description submitted in-game). |

**Data-model note (JOIN aliases):** the reports search inputs use qualified aliases — `t1.text` (report row: the message text) and `t2.player` (joined player row: name/SteamID). This reveals the server query joins a **reports table (t1)** to a **players table (t2)**. The rendered card surfaces the target player and the report text; the reporter's identity is not exposed in the card template (either not shown in this list or stored server-side only).

#### 14.4.2 Reports list controls (page's own controls)

| Control | id / attr | Type | `data-search` | Effect |
|---------|-----------|------|---------------|--------|
| **Поиск (Search)** button | `#reports_list-btn` | button (`fa-search`) | — | Submits the current filter set; re-fetches page 1 with `isSearch=true`. |
| Name/SteamID filter | `#reports-name` (placeholder "Ник или SteamID") | text | `t2.player` | Filter by reported player's nick or SteamID (submits on Enter or via search button). |
| Text filter | `#reports-killed` (placeholder "Текст") | text | `t1.text` | Full-text search over report body. |
| Server filter | `#reports-server` | `multiselect` (`- Сервер -`) | `server_id` | Filter by server(s); rebuilds on change. |

Note the `#reports-killed` element id is a copy-paste artifact from a kill-log page; its actual bound field is `t1.text` (report text), not a kill.

Pagination identical to votes: 30/page, numeric + edges, totals footer.

#### 14.4.3 Reports page actions

| Label | Trigger | Endpoint | Data | State-changing? |
|-------|---------|----------|------|-----------------|
| **открыть (open)** | `a[data-type="btn_open"]` → `player.open(steam_id)` | POST `/ajax/player.php` `action=get` | `steam_id` | N (read) — opens the target player's admin card |

Reports has **no report-lifecycle mutation of its own** in this fragment — no "resolve / close / assign / mark-handled" action on the report entity. Handling a report is done by opening the reported player and applying a modal action (kick/ban/message), plus optionally logging a canned "Ваш репорт рассматривается модерацией" message. This is a notable gap to beat (see §14.7).

---

### 14.5 Shared player-detail modal (mutating admin capabilities)

Both pages embed the standard `#playerModal`. Clicking **открыть** loads the player via `action=get` and renders the card, which flips to sub-panels for punishment, group change, and messaging. These are the actual admin **permissions/capabilities** reachable from votes & reports. All identical across the panel; documented here because they are the only state-changing surface on these two pages.

| Capability | UI | Script endpoint | Action | Key data params | Destructive? |
|-----------|----|-----------------|--------|-----------------|--------------|
| Load player card | открыть | `/ajax/player.php` | `get` | `steam_id` | N |
| Kick from server | Наказание panel, radio `data-action=kick` (value -1) | `/ajax/squad.php` | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | Y |
| Ban (temp/perm) | Наказание radios `data-action=ban` `data-day` 1/2/3/4/5/6/7/10/14/30/0 | `/ajax/squad.php` | `ban` | `server_id` (if online), `steam_id`, `reason_id`, `description`, `days` (`-1`/`value` = permanent) | Y |
| Unban | Разбанить dialog | `/ajax/squad.php` | `unban` | `steam_id`, `unban` (bool — true = fully erase ban) | Y |
| Remove from squad | Выкинуть из сквада | `/ajax/squad.php` | `removePlayer` | `server_id`, `steam_id` | Y |
| Switch team | Сменить команду | `/ajax/squad.php` | `changeTeam` | `server_id`, `steam_id` | Y |
| Kill player | Убить игрока | `/ajax/squad.php` | `kill` | `server_id`, `steam_id` | Y |
| Change group/role | Смена группы panel | `/ajax/player.php` | `changeGroup` | `steam_id`, `group_id`, `date` (expire), `description`, `prefix`, `prefix_rgb`, `image` | Y |
| Send in-game message | Сообщение panel | `/ajax/player.php` | `message` | `steam_id`, `msg`, `time` (repeat seconds), `log` (record in card) | Y |
| Mark (flag) player | mark toggle | `/ajax/player.php` | `mark` | `steam_id`, `mark` | Y |
| Add comment to card | comments | `/ajax/player.php` | `addComment` | comment payload | Y |
| Get comments | comments tab | `/ajax/player.php` | `getComments` | `steam_id` | N |
| Find twinks/friends | твинки | `/ajax/player.php` | `twink`, `twinkOnline`, `findFriends` | `steam_id` | N |
| Check bans | checkBans | `/ajax/player.php` | `checkBans` | `steam_id` | N |
| Kits / kit save | kits tab | `/ajax/player.php` | `kits`, `kitSave` | `steam_id` (+ kit) | N / Y |
| Ban-name allow/deny list | — | `/ajax/player.php` | `addBanName`, `removeBanName` | name payload | Y |
| Online telemetry | — | `/ajax/player.php` | `getPlayerOnlineData` | `steam_id` | N |
| Download stat / copy cheat report | downloadStat / clipboard | `/ajax/player.php` | `downloadStat` | `steam_id` | N |

#### Ban/kick form (Наказание) details
- **Причина (Reason)** `<select id="player_ban-reason">` — a full rule catalog grouped in `<optgroup>`s: **Особые (Special)**, **Общие (General)**, **Для сквадных (For SLs)**, **Для техники (For vehicles)**, **Милсим (Milsim)**. Each option value is a rule id (e.g. `110` = "1.1. Оскорбления, разжигание ненависти", `510` = "5.1. flood/soundpad in main during prep", `2` = DPAC anti-cheat auto-ban). Options carry `data-first/second/third/four` attributes (escalation-tier default ban lengths in days).
- **Reason type radios** (`player_ban-reason_type`): Кикнуть (kick, value -1), then Забанить N дней for 1/2/3/4/5/6/7/10/14/30, and **Забанить навсегда (permanent)** (value -1, `data-day=0`, red).
- **Дополнительный комментарий (Additional comment)**: `<textarea maxlength=512>`.
- Special case: if reason == `-1` (Другое), it routes straight to `banPlayer` bypassing the type radios.

#### Group change (Смена группы) details
Groups: `0` -Нет группы- (none), `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator/camera), `5` Стажёр (trainee). Plus expiry daterange, comment (128), **prefix** text (64), **prefix RGB color** picker (16), and an **image URL** (256). A dedicated "VIP +1 месяц" quick button exists (hidden by default).

#### In-game message (Сообщение) details
- 18 canned message templates (VIP grant, vehicle-solo warning, squad-lock rules, TK apology, "Ваш репорт рассматривается модерацией" = "your report is under review", etc.).
- **Add record to player card** checkbox (`player_message-log`).
- Free-text `<textarea maxlength=512>`.
- Repeat **time** select: 1 раз / 30с / 40с / 60с (default) / 90с / 120с.

---

### 14.6 Permission / visibility logic

- Every sub-panel and the modal itself ship in the fragment wrapped in `class="hide"` (`#player_ban`, `#player_group`, `#player_message`, `#player_info`, `#template`) and are revealed by JS flip/clone — visibility is client-driven, not evidence of role gating in the fragment itself.
- No explicit role/group conditional markup is present in these two fragments: the ban reason catalog, all ban-day tiers (incl. permanent), group assignment (incl. Администратор), kill, and messaging are all present in the DOM regardless of viewer. Authorization is therefore expected to be **enforced server-side** on `/ajax/squad.php` and `/ajax/player.php` per action; the client renders the full capability set. A competing panel should not assume the client hides anything sensitive.
- The `open` (`action=get`) call is the only capability the votes/reports pages expose directly; everything destructive is one modal-flip away but requires a server-side permission check.

---

### 14.7 Notable UX & competitively interesting details

- **Card-list over grid:** votes/reports use a readable card layout (map thumbnails, status/threshold blocks) rather than a dense table — better for at-a-glance triage on mobile (`mobile-left`, `col-xs` grid). Worth copying for a moderation feed.
- **Vote record is analytics-grade:** it captures `players_sum` vs `players_need` and the full map triple (current/next/target) with images — enables detecting vote-abuse patterns (e.g. repeated map-skip initiators). A competitor can go further by also logging each individual voter and per-server pass rates.
- **One-click pivot to enforcement:** both feeds put an "открыть" button that deep-links the offender straight into the full admin card with the entire ban/kick/message arsenal — tight report→action loop.
- **Rule-id driven bans with escalation defaults:** the reason `<select>` encodes a structured rule taxonomy with per-tier default durations (`data-first..four`). This standardizes moderation and feeds analytics; strong feature to match.
- **Gaps to beat:**
  - **No report lifecycle:** reports have no status/assignee/resolution/"handled-by" field or action — a moderator cannot mark a report resolved, claim it, or see who handled it. Building a proper report queue (open/claimed/resolved, SLA timers, dedupe of repeat reports on the same target) is a clear differentiator.
  - **Reporter identity not surfaced** in the card — no way to weight trusted reporters or detect false-report spam. Adding reporter reputation is an opportunity.
  - **No filters on the votes page** beyond server (no date range, no mode filter, no initiator search) and **no date-range filter on reports** — easy wins to exceed.
  - Fixed 30/page with no adjustable page size or column sort on these feeds.
  - Minor code-quality tell: reused ids (`#reports-killed`, duplicate `id="player_group-btn"`) indicate template copy-paste — a cleaner data model is a low bar to clear.
