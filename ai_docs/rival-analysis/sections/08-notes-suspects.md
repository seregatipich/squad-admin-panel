## 08. Player Comments & Suspect Marking

Implementation-spec reconstruction of SQSTAT's per-player admin note system (**Комментарии / Comments**) and its suspect-tagging system (**Метки / Marks**), built from **live captured API contracts** (`breaking.sqstat.ru`, session-authenticated headless capture) plus the rendered `#content` fragments and the shared player-modal JS. These are two distinct-but-related moderation-storage features that attach free-form notes and a single structured "cheat suspicion" flag to a player identity. Both surface as dedicated nav pages **and** as controls inside the shared `player_info` modal that is embedded on every page.

Ground-truth capture files (cited inline below):
- `caps/notes/comments.network.json`, `caps/notes/mark.network.json` — live `table.php` request/response schemas.
- `caps/notes/comments.content.html`, `caps/notes/mark.content.html` — rendered `#content`: real headers, search inputs, `buildTable` config.
- `home_auth.html` — the shared `player` JS object (`player.comment.*`, `player.mark.*`) and `Action()` bodies.
- `custom.js` — the `Action()` transport wrapper (`POST /ajax/<script>.php`, JSON envelope).

Capture summary: **6 live AJAX contracts** captured (3 per page), **0 blocked mutations** (`caps/notes/_blocked.json == []`) — everything below is observation-only.

---

### 1. Purpose & Nav Location

| Feature | Nav id | Fragment loader | Own table id (`table.php action=`) | Row array size |
|---|---|---|---|---|
| Player comments log | `comments` | `GET /ajax/page.php?page=comments` | `playerComments` | 1090 rows / 11 pages |
| Suspect marks log | `mark` | `GET /ajax/page.php?page=mark` | `playerMark` | 708 rows / 8 pages |

- **Comments page** = a global, cross-player audit feed of every admin note ever written, searchable by target player, authoring admin, and note text.
- **Mark page** = a global roster of every player who currently carries a suspicion/toxicity flag, filterable by mark type; effectively a watchlist of suspected cheaters and toxic players.
- Both are read/browse surfaces. The *write* side (`addComment`, `mark`) happens inside the shared player modal, which both pages also embed. Any row click opens that player's modal via `player.open(steam_id)` (see §5).

The capabilities (`addComment`, `getComments`, `mark`) are attached to the shared modal and are therefore reachable from **every** page in the panel — `action_catalog.txt` confirms `addComment`/`getComments`/`mark` on `admins`, `bans`, `chat`, `kills`, `players`, `reports`, `damages`, `deaths`, `teamkills`, `top`, `vips`, `votes`, etc. The two pages here are just the dedicated browse/report views over the same stored data.

> **Identity key finding:** the live schemas show `steam_id` as a **36-character** string (`str(len36)` in both `comments.network.json` and `mark.network.json`) — i.e. a **UUID**, not a Steam64. Steam64 survives only as the author key `admin_id: str(len17)`. SQSTAT has moved its player primary key to a UUID surrogate; the column retains the legacy name `steam_id`.

---

### 2. Live API Contracts

All three action verbs and both list tables share one transport: `Action({script, action, data})` from `custom.js:284`.

**Transport (`Action` wrapper, `custom.js`):**
- Request: `POST /ajax/<script>.php`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.
- Body: object `data` is serialized to `action=<action>` + `&<key>=<value>` for each data key (no URL-encoding of values in the wrapper — raw concatenation).
- Response envelope (JSON): success branch requires `status == "ok"` → `success(text)`. Otherwise: if `text.auth === true` → `location.reload()` (session expired); else `error(text.msg)`.
- `retryAbort:true` aborts any in-flight request sharing the same logical `name` before firing (server throttles the shared session).

#### 2.1 `POST /ajax/table.php` — list tables (`playerComments`, `playerMark`)

Both browse tables are driven by the same `buildTable` DataTables engine and hit `table.php` twice on load: (a) the **data** request and (b) a **pagination/count** request with `&pagination=true`.

**Request params** (source: `comments.network.json`, `mark.network.json`):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | enum `playerComments` \| `playerMark` | yes | Server table selector. |
| `table` | string | yes | Same value as `action` (echoed). |
| `page` | int | yes | 1-based page index. |
| `numrows` | int | yes | Page size — captured value **`100`**. |
| `search` | URL-encoded JSON | yes | Filter envelope: `{"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}`. Text inputs populate `text` keyed by the input's `data-search` DB alias; the mark multiselect populates `multiselect` keyed by `mark` (see §4). Empty objects = no filter. |
| `order_by` | string \| `false` | yes | Sort column DB alias; `false` = default sort. |
| `order_sort` | string \| `false` | yes | `asc` / `desc`; `false` = default. |
| `pagination` | `true` | count-only | Present only on the second (count) request. |

**Response — data request (`status:"ok"`, `application/json`):**

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Total pages (0 on the data call; real value comes from the count call). |
| `data.totalRows` | int | Total matched rows (0 on the data call). |
| `data.currentPage` | str | Echoed page, e.g. `"1"`. |
| `data.row` | array (≤ `numrows`) | Row objects (schemas in §2.1.1 / §2.1.2). |
| `data.custom` | bool | Custom-query flag (`false` observed). |
| `data.query_time` | int/float — seconds | Row-query duration. |
| `data.count_time` | int — seconds | Count duration (0 on data call). |
| `status` | str — `"ok"` | Envelope status. |
| `exec_time` | float — seconds | Server exec time. |

**Response — count request (`&pagination=true`):**

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Page count (comments **11**, mark **8**). |
| `totalRows` | str — integer | Total rows (comments **`"1090"`**, mark **`"708"`**). |
| `count_time` | int/float — seconds | Count duration. |
| `status` | str — `"ok"` | Status. |
| `exec_time` | float — seconds | Exec time. |

##### 2.1.1 `playerComments` row schema (LIVE — `comments.network.json`)

| Field | Type | Meaning |
|---|---|---|
| `id` | str — integer | Comment PK (e.g. `"1091"`). |
| `steam_id` | str(36) — **UUID** | Target player identity (also the row click key). |
| `admin_id` | str(17) — Steam64 | Authoring admin's Steam64. |
| `date` | str(10) — **unix timestamp** | When the note was written. |
| `text` | str — HTML-escaped | Note body; double-quotes arrive as `&quot;` (double-escaped on the wire; see §5.1 unescape). |
| `admin` | str — **pre-rendered HTML** | Author display block: `<p class="mb-0"><code style="color:#<hex>">…</code></p>`. |
| `admin_color` | str(6) — hex | Author name color (e.g. `e50606`). |
| `admin_group` | str(1) | Author group id. |
| `player` | str — **pre-rendered HTML** | Target player display block. |
| `player_color` | str \| null | Target color (null observed). |
| `player_group` | str \| null | Target group (null observed). |

Redacted example row:
```json
{"id":"1091","steam_id":"<uuid:36>","admin_id":"7656119XXXXXXXXXX","date":"1783097436",
 "text":"&quot;Попал в пачку к читерам…","admin":"<p class=\"mb-0\"><code style=\"color:#e50606\">…",
 "admin_color":"e50606","admin_group":"1","player":"<redacted>","player_color":null,"player_group":null}
```

##### 2.1.2 `playerMark` row schema (LIVE — `mark.network.json`)

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | str(36) — **UUID** | Suspect player identity (row click key). |
| `eos_id` | str(32) — EOS id | Epic Online Services id. |
| `name` | str — raw | Player nickname (raw, unrendered). |
| `date` | str(10) — **unix timestamp** | **Заходил / last seen** login time. |
| `create_date` | str(10) — **unix timestamp** | **When the mark was created** (persisted, though not shown as a column). |
| `mark` | str — **pre-rendered HTML** | Reason icon: `<i class="fa fa-fw fa-fa-fw fa-solid fa-…"></i>` (enum → icon, §3). |
| `bonus` | str — integer | Player bonus-points balance (e.g. `"59103"`). |
| `discord` | str(18) — snowflake | Linked Discord id. |
| `color` | str(6) — hex | Nickname color. |
| `player_group` | str(1) | Player group id. |
| `ban` | str — **pre-rendered HTML** | Ban status label: `<span class="label label-danger">Нет</span>` (Нет = not banned) / positive label when banned. |
| `player` | str — **pre-rendered HTML** | Player display block (colored nickname). |

Redacted example row:
```json
{"steam_id":"<uuid:36>","eos_id":"<eos:32>","name":"<redacted>","date":"1783151948",
 "create_date":"1769521352","mark":"<i class=\"fa fa-fw fa-fa-fw fa-solid fa-…","bonus":"59103",
 "discord":"<snowflake:18>","color":"e2b032","player_group":"<redacted:1>",
 "ban":"<span class=\"label label-danger\">Нет</span>","player":"<redacted>"}
```

> **Correction vs prior draft:** `playerMark` **does** persist a mark-creation timestamp (`create_date`). It is stored but not surfaced as a table column (the visible date column is `date` = last-seen). There is still **no mark-author** field in the schema — who set/cleared a mark is not exposed.

#### 2.2 `POST /ajax/player.php` — the three write/read verbs

Source: `home_auth.html` (`player.comment.*`, `player.mark.*`).

| Verb | `action` | Data keys (type) | Response | Effect | Destructive |
|---|---|---|---|---|---|
| Read comment thread | `getComments` | `steam_id` (UUID str) | `{status:"ok", comments:[{name:str, date:unix-str, text:str}, …]}` | Populates slide-out thread; empties → empty-state. | **N** |
| Add note | `addComment` | `steam_id` (UUID str), `text` (str, trimmed non-empty, ≤256) | `{status:"ok"}` | Persists a note authored by the session admin; `complete` re-runs `getComments`. | **Y** |
| Set/clear mark | `mark` | `steam_id` (UUID str), `mark` (int `0`–`8`) | `{status:"ok"}` | Writes the player's single mark enum; `0` clears. Triggers flip animation + banner re-render + row highlight. | **Y** |

`getComments` response (redacted):
```json
{"status":"ok","comments":[{"name":"AdminNick","date":"1783097436","text":"note body"}]}
```

---

### 3. The `mark` Enum (suspicion taxonomy)

Hardcoded client-side twice: as the page filter `<option>` set (`mark.content.html`) **and** as the JS map returned by `player.mark.get()` (`home_auth.html`). Values `1`–`8` are real categories; `0` is the clear sentinel (dropdown-only, not a filter option).

| Value | Russian label | English gloss | Icon (`get()` map) |
|---|---|---|---|
| `1` | Подозрение на WallHack | Suspected WallHack | `fa-fw fa fa-eye` |
| `2` | Подозрение на AimBot | Suspected AimBot | `fa-fw fa fa-crosshairs` |
| `3` | Подозрение на SpeedHack | Suspected SpeedHack | `fa-fw fa fa-tachometer` |
| `4` | Подозрение на спавн объектов | Suspected object spawning | `fa-fw fa fa-bomb` |
| `5` | Подозрение на перезарядку | Suspected reload exploit | `fa-fw fa fa-refresh` |
| `6` | Подозрение на гриф | Suspected griefing | `fa-fw fa fa-free-code-camp` |
| `7` | Подозрение на конфиг | Suspected illegal config | `fa-fw fa-solid fa-file-excel` |
| `8` | Токсичный игрок | Toxic player | `fa-fw fa-solid fa-biohazard` |
| `0` | Снять метку | Remove mark (clear) | `fa fa-times` |

- A player carries **exactly one** mark at a time (single scalar enum column; `mark.set(n)` replaces, `mark.set(0)` clears). The mark-page multiselect is an **OR filter over the log**, not a per-player multi-value store.
- The enum→`{name,icon}` map is duplicated between filter and modal and is **not server-configurable** — a competitor could make the taxonomy dynamic.

---

### 4. The Pages' Own Tables (`buildTable`)

Both use the same jQuery `buildTable` engine, `numrows:100`, server-side loading, row click → `player.open(<steam_id cell text>)`. No column-sort or pagination widgets are rendered beyond the fixed page size (`order_by/order_sort` default to `false`).

#### 4.1 `#playerComments` — `buildTable({table:'playerComments', numrows:100})`

`collum: ["steam_id","date","admin","player","text"]` · `searchInput: ["playerComments-name","playerComments-admin","playerComments-text"]` · click handler reads `td[data-contact="steam_id"]`.

| # | Header (rendered) | `collum` key | Notes |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Row click key; `width:151px`. |
| 2 | Дата (Date) | `date` | unix→`formatDate`; `text-center`. |
| 3 | `<i fa-id-badge>` Админ (Admin) | `admin` | Pre-rendered colored author. |
| 4 | `<i fa-user>` Ник (Nick) | `player` | Target nickname. |
| 5 | `<i fa-comment>` Комментарий (Comment) | `text` | Note body. |

**Search inputs** (left fixed sidebar; submit `#playerComments-btn` = **Поиск / Search**):

| `#id` | placeholder | `data-search` (DB alias → `search.text` key) | input |
|---|---|---|---|
| `#playerComments-name` | Игрок (Player) | `t5.player` | text |
| `#playerComments-admin` | Админ (Admin) | `t2.player` | text |
| `#playerComments-text` | Текст (Text) | `t1.text` | text |

Aliases confirm a server-side join: `t1` = comments (`.text`), `t2` = author admin (`.player`), `t5` = target player (`.player`).

#### 4.2 `#playerMark` — `buildTable({table:'playerMark', numrows:100})`

`collum: ["steam_id","player","date","mark","ban"]` · `searchInput: ["playerMark-name","playerMark-mark"]`. Marked rows carry CSS class `player_mark` (highlight).

| # | Header (rendered) | `collum` key | Notes |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Row click key; `width:151px`. |
| 2 | `<i fa-user>` Ник (Nick) | `player` | Colored nickname. |
| 3 | `<i fa-clock-o>` Заходил (Last seen) | `date` | Maps to `date` field (last-seen unix). |
| 4 | `<i fa-triangle-exclamation>` Причина (Reason) | `mark` | Pre-rendered enum icon. |
| 5 | `<i fa-gavel>` Бан (Ban) | `ban` | Pre-rendered ban-status label. |

**Search controls** (left sidebar; submit `#playerMark-btn`):

| Control | Type | `data-search` (→ `search` key) | Filters on |
|---|---|---|---|
| `#playerMark-name` | text, placeholder Игрок (Player) | `t1.player` (→ `search.text`) | Nickname |
| `#playerMark-mark` | `<select multiple type="multiselect">`, 8 options `value=1..8` with `label="<i …>…"` | `mark` (→ `search.multiselect`) | One or more mark categories (OR) |

The multiselect renders each option's inline icon (bootstrap-multiselect, `enableHTML`). This is the watchlist filter (e.g. show all AimBot **or** WallHack flags). Note `0`/clear is **not** an option here — you cannot filter for "unmarked".

---

### 5. Modal Forms, State & Predicates

The `player_info` template lives in `<div id="player_info" class="hide">` and is cloned into `#playerModal` on `player.open()`. The `hide` class is a template mechanism, not a permission gate.

#### 5.1 Comment slide-out (`player.comment`, `home_auth.html`)

| Aspect | Spec |
|---|---|
| Container | `#playerModal .player_comments`; toggled open via `open` class. |
| Trigger | `.player_comments_button` (desktop) / `.player_comments_button-mobile` (mobile) → `player.comment.open()`. |
| Open predicate | `open()` toggles `open` class; **fetches only when it becomes open** (`if(container.toggleClass('open').hasClass('open')) get()`). |
| Composer | single `<input class="form-control" maxlength="256">` + `.player_comments_sumbit` button. |
| Submit | Enter (`keyCode==13`) **or** submit-button click → `send()`. |
| Validation | `text = input.val().trim(); if(text=='') return;` — non-empty + `maxlength=256` only; no server-echoed validation surfaced. |
| Send | `addComment{steam_id,text}`; `success` clears input; `complete` always re-runs `get()` (new note appears immediately). |
| Thread render (`add`) | per message: `<p class="player_comments_message_user">{name} <small …>{formatDate(date,false)}</small></p>` + `<p class="player_comments_message_text">`; body via `.html(text.replace(/&amp;quot;/g,'"'))` (unescapes double-escaped quotes). |
| Count badge | `count(cnt)` writes into `.player_comments_button span` (and mobile); seeded from modal payload `player.info.comments_count`. |
| States | loading `.player_comments_load`; empty **Нет комментариев / No comments** `.player_comments_nomessage` (shown when `comments.length==0` **or** on request error). |
| Immutability | append-only — no edit/delete control in the fragment. |

#### 5.2 Mark dropdown (`player.mark`, `home_auth.html`)

| Aspect | Spec |
|---|---|
| Trigger | header `<button><i class="fa-solid fa-tags"></i></button>` dropdown → `#player_info-mark` list. |
| Options | 8 `<li><a onclick="player.mark.set(1..8)">` + `divider` + `<a onclick="player.mark.set(0)">` **Снять метку / Remove mark**. |
| Confirmation | **none** — each `<a>` fires `mark.set(n)` directly. |
| Set (`set(n)`) | `mark{steam_id,mark:n}`; `success` → `animateCss('flip_panel_full')` then `comment.destroy()` + `mark.render(n)`; toggles `player_mark` on `tr[data-id="<steam_id>"]` (add when `n!=0`, remove when `n==0`). |
| Banner render (`render(mark)`) | if `mark!="0"`: `#player_info_mark` `.show()` with `<i class="{icon}"></i> {name}` (pulsing `alert-warning animated pulse infinite`); else `.hide()`. |
| Active-state predicate | `render` clears `.disabled` on all `#player_info-mark li`, then adds `.disabled` to `a[onclick="player.mark.set({mark})"]` — the current flag is visibly disabled in the menu. |
| Errors | `mark`/`addComment` failures → `addAlert(text,"exclamation-triangle")`. |

---

### 6. Permission / Visibility Logic

- **No explicit role/group gating** on the comment composer or the mark dropdown in these fragments — unlike sibling controls (**Убить / Kill**, **Кикнуть / Kick**, **Забанить ник / Ban name**, **Разбанить ник**, **Киты / Kits**) which ship `style="display:none;"` and are revealed by role logic elsewhere. Comments and marks are available to any admin who can open the modal — a lower privilege bar than punitive actions.
- **Comment authorship is server-attributed:** `addComment` sends only `{steam_id,text}`; the author (`admin_id`/`admin`) is stamped from the session. The comments page is therefore an accountability/audit trail of which admin said what about whom.
- **Marks are not author-attributed:** the schema carries `create_date` (when) but no "who". No audit of who set/cleared a suspicion — an exploitable weakness for a competitor to beat.
- **Session-expiry handling:** any verb returning `{auth:true}` forces `location.reload()` (`custom.js`), so an expired admin session bounces to login rather than silently failing a write.

---

### 7. Competitive Takeaways & Gaps to Beat

- **Structured cheat taxonomy.** The 8-value suspicion enum (WallHack, AimBot, SpeedHack, object-spawn, reload-exploit, grief, illegal-config, toxic) with per-type icons is a clean, one-click watchlist primitive (no confirm dialog). Worth copying — but make it **server-configurable**, not hardcoded in JS in two places.
- **Ban-aware watchlist.** The mark page's **Бан** column is a ready-made triage queue for "suspected but not yet actioned" cheaters; the row also carries `bonus`, `discord`, `eos_id` for cross-referencing.
- **Cross-player audit feed.** The comments page is a global, searchable log of every admin note (searchable by author admin), doubling as staff accountability. Notes are immutable/append-only, timestamped, and colored per author group.
- **Ubiquitous, low-friction access.** Because comments+marks ride the shared modal, an admin can annotate/flag from *any* page (chat, kills, reports…) without navigating away; the count badge keeps prior notes discoverable.
- **Gaps:**
  - No edit/delete/soft-delete of comments; no threading or attachments; 256-char single-line cap; body is double-escaped and unescaped client-side (`&amp;quot;`), a brittle round-trip.
  - Only one mark per player (single enum) — cannot flag "AimBot" **and** "toxic" simultaneously, despite the multiselect *filter* implying otherwise. No "unmarked" filter option.
  - `create_date` is stored but never surfaced; **no mark-author audit** and no mark history/timeline.
  - Mark taxonomy + enum→label map hardcoded and duplicated client-side.
  - No pagination controls beyond a fixed `numrows:100` page and no exposed sort UI (`order_by/order_sort` hardwired to `false` on load).
