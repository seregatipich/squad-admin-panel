## 06. VIP / Privileges (Привилегии)

> Spec-grade rewrite backed by LIVE captured contracts (headless, read-only).
> Capture set: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/vips/`
> — `vips.network.json` (3 AJAX contracts), `vips.content.html` (rendered `#content`, 138 KB), `vips.modaltabs.json`, `vips.png`.
> Mutating requests blocked by the interceptor: **0** (`_blocked.json` == `[]`). Everything below is observation-only.

### 1. Purpose & Navigation

- **Nav id / loader:** `vips` — nav item calls `pageLoad('vips')` → `GET /ajax/page.php?page=vips`; the returned HTML fragment (`response_len` 113 754 B, `ctype: text/html`) is injected into `#content`. Confirmed in `vips.network.json` contract #1.
- **Purpose:** a read-and-drill roster of every player who currently holds a **group/privilege** (VIP, Admin, Moderator, Camera, Trainee). It is a JOIN of the group-assignment table (`t1`) and the player table (`t2`), showing SteamID, nick, term/expiry, last-seen, accumulated online time, and the admin note.
- **Architectural invariant:** the `vips` page is **read + search only**. It ships **no add/edit/delete controls of its own**. Every privilege mutation goes through the **shared player-detail modal** ("Смена группы" / Change group), which the fragment embeds as a hidden `#player_group` panel. A row click opens the player modal (`player.open(steam_id)`); flipping to the group panel (`player.group.open()`) exposes the single mutation `changeGroup`. So the "VIP management" capability physically lives in the shared modal, reached from this page.
- **Live scale:** the captured instance holds **395 privilege rows** across **8 pages** at 50 rows/page (`pagination=true` response: `totalRows:"395"`, `totalPage:8`).

---

### 2. Live API Contracts

Three contracts fire on load. Ground truth: `vips.network.json`.

#### 2.1 `GET /ajax/page.php?page=vips` — fragment loader

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | string enum | Y | Page id; here `vips`. |

Response: `text/html` fragment (the sidebar filter form + the `#vipPlayers` table skeleton + all hidden player-modal panel templates). Injected into `#content`.

#### 2.2 `POST /ajax/table.php` — roster data (`action=vipPlayers`)

**Request body** (`application/x-www-form-urlencoded`, verbatim from capture):

```
action=vipPlayers&table=vipPlayers&page=1&numrows=50
&search={"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}
&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id; **`vipPlayers`**. |
| `table` | string | Y | Duplicate of `action` (buildTable sends both). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size; **50** for this table. |
| `search` | JSON string | Y | Filter bag: `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. Text filters land under `text` keyed by each input's `data-search` alias (see §5). Empty object = no filter. |
| `order_by` | string / `false` | Y | Column DB-alias to sort by; `false` = server default. |
| `order_sort` | `asc`/`desc`/`false` | Y | Sort direction; `false` = server default. |
| `pagination` | bool (optional) | N | When `true`, returns only the count envelope (§2.3) instead of rows. |

**Response** `application/json`, `status:"ok"`, `exec_time: float` (seconds, e.g. `0.644`). Shape (`data.*`):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 on the rows call; real value comes from the `pagination=true` call). |
| `data.totalRows` | int | Row count (0 on rows call). |
| `data.currentPage` | string | Echo of requested page, e.g. `"1"`. |
| `data.row[]` | array (len == `numrows`) | Roster rows; per-row schema below. |
| `data.custom` | bool | Whether a custom/user filter preset is active. |
| `data.query_time` | int | ms for the row query. |
| `data.count_time` | int | ms for the count query. |
| `status` | string enum | `"ok"` on success. |
| `exec_time` | float | Total server time (s). |

**Per-row object** (`data.row[i]`) — the VIP roster entity:

| Field | Type | Meaning / notes |
|---|---|---|
| `steam_id` | string | Player identifier / drill key. Rendered in HTML as `<hashtag>7656119XXXXXXXXXX</hashtag>` (Steam64). Capture redaction reported a 36-char token — see Gaps re: raw vs UUID. |
| `group_id` | string enum | Privilege id as a string: `"0"`..`"5"` (see §3 catalog). Captured sample `"3"` = VIP. |
| `expire` | string | Privilege expiry, **unix seconds as string**. Empty string `""` in the captured VIP sample ⇒ **permanent / no expiry** (the UI treats `expire=='0'` as infinity; empty renders as a blank `Срок` cell). |
| `description` | string | Raw admin note (short; sample len 3). |
| `prefix` | string \| null | In-game chat/name prefix; `null` when unset. |
| `prefix_rgb` | string \| null | Prefix color as `"r,g,b"`; `null` when unset. |
| `image` | string \| null | Badge/image URL; `null` when unset. |
| `name` | string | Current/last known player nick. |
| `date` | string | Last-seen timestamp, **unix seconds as string** (sample `"1783107913"`). Rendered as a `badge bg-success` with `data-unix`. |
| `color` | string | Group badge hex color, **no `#`** (sample `"e2b032"` = VIP gold). |
| `icon` | string | Group FontAwesome icon name (sample `"star"` = VIP). |
| `vipdesc` | string | Rendered/expanded note shown in the `Описание` column (sample includes newlines/ASCII art, len 94). Distinct from `description`. |
| `online` | object | Live presence sub-object (below). |
| `online.online` | string | Total online minutes/points (sample `"3221"`). |
| `online.boost` | string | Boost time/points (sample `"141"`). |
| `online.queue` | string | Queue priority / reserved-slot indicator (sample `"5"`). |
| `online.server` | string | Server id the metric is scoped to (sample `"1"`). |
| `group` | string (HTML) | Pre-rendered group label, e.g. `<span class="label label-primary" …>`. |
| `time` | string (HTML) | Pre-rendered accumulated-time badge, e.g. `<span class="label label-success">53ч 41м</span>` (danger variant `0ч 0м` when zero). |

Redacted example row (privacy-safe):

```json
{
  "steam_id": "<redacted Steam64>",
  "group_id": "3", "expire": "",
  "description": "<3ch>", "vipdesc": "випку зайке (\\__/) …",
  "prefix": null, "prefix_rgb": null, "image": null,
  "name": "<redacted nick>",
  "date": "1783107913",
  "color": "e2b032", "icon": "star",
  "online": { "online": "3221", "boost": "141", "queue": "5", "server": "1" },
  "group": "<span class=\"label label-primary\" …>",
  "time": "<span class=\"label label-success\">53ч 41м…"
}
```

#### 2.3 `POST /ajax/table.php` … `&pagination=true` — count envelope

Same body as §2.2 plus `&pagination=true`. Returns a slim envelope (no rows):

| Field | Type | Sample | Meaning |
|---|---|---|---|
| `totalPage` | int | `8` | Page count = ceil(totalRows / numrows). |
| `totalRows` | string | `"395"` | Total matching privilege rows (string!). |
| `count_time` | int | `0` | ms for the count query. |
| `status` | string | `"ok"` | — |
| `exec_time` | float | `0.01` | Total server time (s). |

buildTable fires this once after the rows call to paint the pager, so the roster page issues **two** `table.php` POSTs per view.

---

### 3. Entities & Data Model

Two entities: the **VIP/privilege roster row** (§2.2 schema) and the **group-assignment record** (edited via `changeGroup`).

#### Entity A — VIP roster row (`vipPlayers` server table)

buildTable init (from `vips.content.html` inline script):

```js
$('#vipPlayers').buildTable({
  table: 'vipPlayers',
  collum: ["steam_id","name","expire","date","time","vipdesc"],
  numrows: 50,
  searchInput: ["vipPlayers-name","vipPlayers-startdate","vipPlayers-enddate","vipPlayers-desc"],
  end: () => { $('#vipPlayers tbody > tr').on('click', function(){
      player.open($(this).find('td[data-contact="steam_id"] > hashtag').text());
  }); }
});
```

| `collum` key | Column header (rendered) | Cell `data-contact` | Source field | Type / meaning |
|---|---|---|---|---|
| `steam_id` | `SteamID` (width 151px) | `steam_id` | `row.steam_id` | Steam64 in `<hashtag>`; the drill key. |
| `name` | `Ник` (Nick, centered) | `name` | `row.name` | Bold-centered nick. |
| `expire` | `Срок` (Term, width 130px) | `expire` | `row.expire` | Unix-sec string; empty/`0` ⇒ permanent (blank cell). |
| `date` | `Заходил` (Last seen, width 130px) | `date` | `row.date` | `badge bg-success[data-unix]`, humanized ("Вчера 21:45:13"). |
| `time` | clock icon `fa-clock-o` (width 80px) | `time` | `row.time` | Accumulated online time badge (`53ч 41м`); success/danger color. |
| `vipdesc` | `Описание` (Description, centered) | `vipdesc` | `row.vipdesc` | Admin note (expanded). |

Search aliases leak the server schema: `t1.description` (assignment table) and `t2.player` (player table) — the roster is a JOIN of **group-assignment `t1`** × **player `t2`**.

#### Entity B — Group / privilege assignment (edited via `changeGroup`)

`Action({script:'player', action:'changeGroup', data:{…}})` — exact keys from `vips.content.html`:

| Key | Source control | Type | Meaning |
|---|---|---|---|
| `steam_id` | `player.info.steam_id` | string | Target player (Steam64). |
| `date` | `$('#player_group-expire').data('start')` | unix-sec / `0` | Expiry term; `0` (infinity preset) ⇒ permanent. |
| `group_id` | `$('#player_group-groups').val()` | enum `0..5` | Privilege granted; `0` = remove group. |
| `description` | `#player_group-description` textarea | string ≤128 | Admin comment → `vipdesc`. |
| `prefix` | `#player_group-prefix` | string ≤64 | In-game chat/name prefix. |
| `prefix_rgb` | `#player_group-prefix_rgb` | string ≤16 | Prefix color `"r,g,b"`. |
| `image` | `#player_group-image` | string ≤256 | Badge/image URL. |

On success it re-opens the card: `success: () => player.open(player.info.steam_id)`; on error `addAlert(text)`; `complete` closes the confirm dialog.

Group catalog — verbatim `<option>`s of `#player_group-groups`:

| group_id | Label (RU / EN) | FA icon |
|---|---|---|
| `0` | -Нет группы- (No group) | — |
| `1` | Администратор (Administrator) | `fa-user-circle-o` |
| `2` | Модератор (Moderator) | `fa-id-badge` |
| `3` | **VIP** | `fa-star` |
| `4` | Камера (Camera / spectator) | `fa-video-camera` |
| `5` | Стажёр (Trainee) | `fa-graduation-cap` |

VIP is one value (`group_id=3`) inside a general **group/role system**; the same `changeGroup` endpoint grants staff roles and VIP alike, differentiated only by `group_id`. VIP's badge is gold (`color:"e2b032"`, `icon:"star"`).

---

### 4. The Page's Own Table (`#vipPlayers`)

- **Columns:** SteamID · Ник · Срок · Заходил · clock-icon (time) · Описание (§3, Entity A).
- **Server table id:** `vipPlayers` (both `action=` and `table=`).
- **Page size (`numrows`):** **50**. Two POSTs per view: rows, then `pagination=true` count.
- **Default sort:** `order_by=false&order_sort=false` — server default (no client sort UI, no `order` config, no sortable headers).
- **Row interaction:** `#vipPlayers tbody > tr` click → `player.open(<hashtag text>)`. No per-row buttons, no bulk-select, no inline edit.

---

### 5. Forms & Filters

Left fixed sidebar, applied by the **Поиск** (Search) button `#vipPlayers-btn`. Each input's `data-search` becomes a key in the `search.text` bag.

| Control (RU / EN) | `#id` | input type | `data-search` alias | Notes |
|---|---|---|---|---|
| Ник или SteamID (Nick or SteamID) | `#vipPlayers-name` | text | `t2.player` | Free text on player name/id. |
| Заходил c (Last-seen from) | `#vipPlayers-startdate` | text `readonly` | `startdate` | `datetimepicker({language:'ru', pickTime:true, sideBySide:true})`; inline ✕ clears (`$('#vipPlayers-startdate').val('')`). |
| Заходил до (Last-seen to) | `#vipPlayers-enddate` | text `readonly` | `enddate` | Same picker; inline ✕ clears. |
| Описание (Description) | `#vipPlayers-desc` | text | `t1.description` | Free text on admin note. |

No `maxlength`/regex on the filter inputs; validation is server-side.

---

### 6. Actions / Permissions from this page

The only page-native interaction is search + drill-in; every mutation is delegated to the shared modal. VIP-relevant actions:

| UI label | action | script → endpoint | Data keys | Effect | Destructive |
|---|---|---|---|---|---|
| (row click) | `get` | `player` → `POST /ajax/player.php` | `{steam_id}` | Loads player card + `player.info`. | N |
| Сменить группу (Change group) | `changeGroup` | `player` → `POST /ajax/player.php` | `steam_id, date, group_id, description, prefix, prefix_rgb, image` | Grants / changes / (with `group_id=0`) removes a privilege; sets term, note, prefix, color, image. **The VIP add + edit + remove operation.** | **Y** |
| VIP +1 месяц (VIP +1 month) | `changeGroup` | `player` → `POST /ajax/player.php` | same payload | Quick-grant button (`#player_group-btn`, class `hide`). Rendered but hidden by default. | **Y** |

Both submit buttons call `player.group.set(this)`; there is **no separate `changeExpire` action on this page** — `changeExpire` exists only on the clan page (`clan_16.html`, per `action_catalog.txt`) and is out of scope here. The clan-scoped `Action({script:'clan', action:'vipPlayer', data:{clan_id, steam_id, vip}})` reserved-slot toggle is **not present** in the `vips` fragment (the "vipPlayer" substrings in the HTML are all the `vipPlayers` table id).

Other shared-modal actions embedded in this fragment but belonging to the universal player modal (documented in the Players section): `ban`, `unban`, `kick`, `kill`, `kits`, `kitSave`, `mark`, `message`, `twink`, `twinkOnline`, `addComment`, `getComments`, `changeTeam`, `checkBans`, `findFriends`, `getPlayerOnlineData`, `removePlayer`, `addBanName`, `removeBanName`, `downloadStat` (scripts `player`, `squad`).

**Distinction to beat:** global privilege = `changeGroup` (`group_id=3`); clan reserved-slot = clan-scoped `vipPlayer` boolean. Two separate "VIP" concepts.

---

### 7. The "Смена группы" Modal (`#player_group`)

Hidden template (`class="hide"`), cloned into the flip modal via `player.group.open()` (`player.modal.flip({direction:'lr', content:$('#player_group').html()})`).

| Field (RU / EN) | Control | Type / options | Validation |
|---|---|---|---|
| Group | `#player_group-groups` | bootstrap `multiselect({buttonClass, maxHeight:400, enableHTML:true})` | 6 options (`0..5`); pre-selected via `.multiselect('select', player.info.group_id)` then `'rebuild'`. |
| Expire (Срок) | `#player_group-expire` | custom `dateRange` widget | Presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. `limitDate:false`. **Default:** `infinity` when `group_id && expire=='0'`; else `{type:'justDay', start: expire || now}`. `data('start')` feeds the `date` payload key; `infinity` ⇒ `0`. |
| Комментарий (Comment) | `#player_group-description` | `<textarea rows=2>` | `maxlength=128`; init `.html(player.info.group_description)`. |
| Префикс (Prefix) | `#player_group-prefix` | text | `maxlength=64`; init `.val(player.info.prefix)`. |
| Цвет префикса RGB | `#player_group-prefix_rgb` + `#player_group-prefix_rgb-color` (`type=color`) | text + swatch | `maxlength=16`. On `change`: `stringRgbToHex()` → `hexToRgb()` → writes back `"r,g,b"` and syncs the swatch; parse failure clears the field. |
| Ссылка на изображение (Image URL) | `#player_group-image` | text | `maxlength=256`; init `.val(player.info.image)`. |
| Submit — Сменить группу | `#player_group-btn` (always visible) | `onclick="player.group.set(this)"` | Confirm `$.question({title:'Сменить группу?', text:<selected group label>, daPrevent:'Меняем'})` before firing. |
| Submit — VIP +1 месяц | `#player_group-btn` (`class="hide"`) | `onclick="player.group.set(this)"` | Same handler; hidden by default. |
| Back — Игрок | — | `onclick="player.unflip()"` | Flip back to the player card. |

`player.info` fields the modal consumes (from `player.get`): `steam_id`, `eos_id`, `group_id`, `expire`, `group_description`, `prefix`, `prefix_rgb`, `image`, `is_you`, `canChangeGroup`.

---

### 8. Permission / Visibility Logic (explicit predicates)

| Predicate | Effect |
|---|---|
| `player.info.canChangeGroup === true` | show `#player_info-group_btn` (the "Группа" button that opens the modal); else hide it. **Server-provided per-player permission flag** — the primary gate on who may edit a group. |
| `player.info.is_you === true` | `#player_group-groups` → `multiselect('disable')` **and** `#player_group-expire` → `prop('disabled', true)`. Self-edit of group/term blocked in UI. |
| `#player_group-btn.hide` (VIP +1 месяц) | button carries `hide` by default; surfaced only in specific contexts/roles. |
| `player.info.group_id && player.info.expire=='0'` | dateRange default = `infinity` (permanent); otherwise a single-day range from current expiry/now. |

The client offers the full 6-group list to anyone who passes `canChangeGroup`; server-side `player.php` authorizes which target group (Admin vs VIP) a given admin may actually set.

---

### 9. Notable UX & Competitively Interesting Details

- **`canChangeGroup` server flag** (new vs prior notes): group editing is gated by an explicit per-player boolean from `player.get`, not just `is_you`. Clone this — it lets the server centralize "who can grant what."
- **Unified group system:** VIP/Admin/Moderator/Camera/Trainee are one `group_id`; one modal + one `changeGroup` endpoint covers grant/edit/revoke for every role.
- **Rich privilege metadata:** a privilege carries **term, admin note, chat prefix, prefix RGB, and image/badge URL** — plus live `online/boost/queue/server` presence in the roster row. The color picker with live hex↔rgb sync is polished.
- **Dual note fields:** `description` (raw, ≤128) vs `vipdesc` (rendered) — server formats notes for display.
- **Expiry presets + infinity:** day / 1·2·3·6 months / 1 year / permanent / reset; permanent encoded as `0` (blank `Срок` cell).
- **Quick "VIP +1 месяц":** dedicated one-tap grant/extend (hidden by default) — the highest-frequency VIP action; worth copying.
- **Search ergonomics:** last-seen range + description search find expired-but-inactive or soon-to-lapse VIPs and donation notes ("випку зайке…"). Good retention tooling.
- **Two-POST pattern:** rows + `pagination=true` count; `totalRows` returns as a **string**, mixed with int `totalPage` — a quirk to normalize in a clone.
- **Scale:** 395 active privilege rows / 8 pages on the live instance.

---

### Gaps / Unknowns

- **`steam_id` identity type:** rendered HTML uses Steam64 (`<hashtag>`) and `player.get`/`changeGroup` payloads use Steam64; the `table.php` JSON `steam_id` was redacted to a 36-char token, so whether the JSON carries the raw Steam64 or an internal 36-char UUID could not be confirmed from the redacted capture.
- **`expire` blank vs `0`:** the live VIP sample returned `expire:""` (empty) for a permanent grant while the UI logic keys on `expire=='0'`; the server appears to accept both — the exact normalization is server-side.
- **`online.queue`/`online.server` semantics:** the `queue` field (sample `"5"`) is the closest thing to a **reserved-slot priority** indicator, but no label confirms it maps to in-game slot reservation for VIPs; inferred, not proven.
- **Per-server scoping:** `changeGroup` carries no `server_id`; whether a granted group is global or per-server is not exposed on this page (unlike the clan `vipPlayer` flag, which is explicitly `clan_id`-scoped).
- **Condition that un-hides "VIP +1 месяц"** is not determinable from the static fragment.
- **`clock-icon` (`time`) column** is pre-rendered HTML (`53ч 41м`); the underlying raw metric is not exposed as a separate numeric field in the JSON.
