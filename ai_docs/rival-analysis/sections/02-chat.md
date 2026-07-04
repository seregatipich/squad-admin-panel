## 02. In-game Chat & Broadcast

### 1. Purpose and nav location

- **Nav item / page id:** `chat` — loaded via the SPA router `pageLoad('chat')` → `GET /ajax/page.php?page=chat`; the returned fragment is injected into `#content`.
- **Purpose:** A searchable, filterable **audit archive** of every in-game chat message (all chat scopes plus admin broadcasts) captured across all monitored servers. It is a read/audit surface, not a live composer. The panel's outbound messaging (broadcast, per-player message, per-squad message) is triggered on the `main` dashboard and the shared player-detail modal, but is documented here because it is the write-side counterpart of this feed.
- **Ground truth for this chapter:** `frags/chat.html` (page markup + inline `buildTable`/`speak` scripts), `custom.js` (the `buildTable` DataTables engine + the `Action()` transport, lines 284–340 and 605–1101), and `frags/main.html` (the three outbound-message senders: `sendSeverBroadcast()` @2135, `player.message.send()` @4356, `messageSquad.send()` @5654). Cross-referenced against `action_catalog.txt`.
- **Live-capture status:** the read-only headless capture (`capture.py --pages chat`) was run the maximum permitted **2×**; both runs died with a Chromium `TargetClosedError` during the post-load settle, so no `chat.network.json`/`content.html` was emitted and `_blocked.json` = `[]` (0 mutations blocked — the interceptor never had traffic to abort). The contracts below are therefore reconstructed from the client code that literally constructs the request bodies and parses the responses, which is authoritative for request shape and response envelope; only the server-side per-row field spelling for `action=playerChat` is inferred (see §8).

Page layout: a fixed left filter sidebar (`col-md-3`, `position:fixed`) and a wide results table (`col-md-9`).

---

### 2. Live API Contracts

All AJAX goes through the `Action({script, action, data})` helper in `custom.js:284`, which POSTs to `/ajax/<script>.php` with an `application/x-www-form-urlencoded` body. When `data` is an object it is serialized to `action=<action>&key=value&…`; when it is a string it is concatenated as `action=<action><string>`. Response contract (all endpoints): JSON with a top-level `status`; the success branch fires only on `status === 'ok'`, `auth === true` forces `location.reload()` (session/permission expiry), otherwise `msg` is surfaced as an error toast.

#### 2.1 `POST /ajax/table.php` — chat feed read (`action=playerChat`)

The one read the chat page issues. Built by `$.fn.buildTable` (`custom.js:605`); the request string is assembled in `preGetTable()` (`custom.js:1092`) and sent by `getTable()` (`custom.js:1069`).

**Request params** (form-urlencoded body):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `playerChat` | Y | Server table id (equals the `table:` config value). |
| `table` | const `playerChat` | Y | Redundant table id echoed in body. |
| `page` | int | Y | 1-based page index. Default `1`; set by pagination/search/sort handlers. |
| `numrows` | int | Y | Page size. Hardcoded **`300`** for this page. |
| `search` | string (URL-encoded JSON) | Y | Filter object, see §2.2. Empty string when no filters. |
| `order_by` | string \| `false` | Y | Sort column DB-alias. Initial load sends literal `false`; header-click sets it to the column's `data-sort` (e.g. `date`). |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction. Initial `false`; toggles `desc`→`asc` on repeat header-click. |
| `pagination` | const `true` | N | Present **only** on the secondary count request (§2.3); absent on the row request. |

**Response envelope** (`status==='ok'` branch, consumed in `getTable().success` and `build()`):

| Field | Type | Meaning |
|---|---|---|
| `status` | enum `ok` \| (error) | Gate. Non-`ok` → error toast. |
| `auth` | bool | If `true`, client calls `location.reload()`. |
| `msg` | string — nullable | Error message when `status != ok`. |
| `data` | object | Payload wrapper. |
| `data.row` | `array[N]` of row objects | The N≤300 chat records for this page (per-row schema §2.4). Empty array renders "Нет данных". |
| `data.query_time` | string | Server timing string, logged to console. |
| `data.currentPage` | int (as string) | Echoed page index, drives pagination active-state. |
| `data.custom` | object — nullable | Optional side-channel payload (`customData()`); unused by chat. |

Redacted example request/response:
```
POST /ajax/table.php
action=playerChat&table=playerChat&page=1&numrows=300
&search=%7B%22text%22%3A%7B%22t1.msg%22%3A%22help%22%7D%2C%22multiselect%22%3A%7B%22type%22%3A%5B%22ChatAdmin%22%5D%7D%7D
&order_by=false&order_sort=false

{ "status":"ok",
  "data":{ "currentPage":"1", "query_time":"0.0123s",
    "row":[ { "id":"<redacted>", "steam_id":"<redacted:17>", "server":"1",
              "date":"1720080000", "team":"1", "name":"<redacted:12>",
              "type":{"name":"Админ чат","color":"#3598DC"}, "msg":"<redacted:24>",
              "play":"" } ] } }
```

#### 2.2 `search` object schema

`buildTable` walks `searchInput[]`, reads each control's `data-search` alias, and buckets it by input `type` into `{text, check, multiselect, managers, slider}`, then `search = encodeURIComponent(JSON.stringify(obj))`. Chat populates only three buckets:

| Bucket | Key(s) written | From control (`data-search`) | Value shape |
|---|---|---|---|
| `text` | `t2.player` | `#chatPlayers-name` (text) | string (raw substring; `+`→`%2B`). |
| `text` | `t1.msg` | `#chatPlayers-msg` (text) | string, ≤17 chars. |
| `text` | `t1.date.startdate`, `t1.date.enddate` | `#chatPlayers-date` (daterange) | unix seconds; `0`/`0` for `allTime` default. |
| `check` | `obscene` | `#chatPlayers-obscene` (checkbox) | `"true"` \| `"false"`. |
| `multiselect` | `server_id` | `#chatPlayers-server` | array of server-id strings. |
| `multiselect` | `type` | `#chatPlayers-type` | array of scope enums (§2.4). |

Empty controls are omitted. `#chatPlayers-steam_id` is listed in `searchInput` but no such element exists in the fragment, so `buildTable` skips it (`typeof sData == "undefined" → continue`) — a dead config entry.

#### 2.3 `POST /ajax/table.php` — pagination count (`action=playerChat&…&pagination=true`)

Fired by `getPagination()` (`custom.js:987`) as a second call **only** when the first page filled (`rows == numrows`) or `currentPage != 1`. Same body as §2.1 plus `&pagination=true`.

| Response field | Type | Meaning |
|---|---|---|
| `status` | enum `ok` | Gate. |
| `totalPage` | int | Total page count; drives the numeric pager. |
| `totalRows` | int | Total matching rows; rendered as "Всего: N". |
| `count_time` | string | Server timing string, console-logged. |

#### 2.4 Chat message record schema

The per-row objects in `data.row` (keyed by the `collum` array `["steam_id","server","date","team","name","type","msg","play"]`) plus the richer **live-feed** record the `main` dashboard consumes (`data.chat[]`, `frags/main.html:978`) — the same underlying chat table, so it reveals the authoritative field set:

| Field | Type | Meaning |
|---|---|---|
| `id` | string/int | Row PK (`data-id` on the rendered `<tr>`/message div). |
| `steam_id` | string (SteamID64, len 17) | Author identity. Chat table renders it in a hidden first column used as the row-click key. |
| `server` / `server_id` | int → label | Origin game server. |
| `date` | **unix timestamp (seconds)** | Message time. Client renders via `formatDate(col,true,true)`. |
| `team` | int enum | Author's faction/team id; maps to icon `/assets/img/ico/teams/<team>.png`. |
| `name` | string | Author nickname. |
| `color` | string (hex, no `#`) — nullable | Author name color (clan/role tint); live feed only. |
| `type` | string enum (chat table) | Scope enum, see below. In the **row** object the render callback expects an object `{name,color}`. |
| `type_format` | object `{name,color,icon}` | Live-feed display metadata: `name` (RU label), `color` (hex), `icon` (FontAwesome class). |
| `msg` | string | Message body. `word-break:break-all`; client-flagged for profanity. |
| `play` | derived/empty | UI-only TTS action cell; carries no server data. |

**`type` enum (chat scope)** — from `<select id="chatPlayers-type">` options; each value carries a server-provided display `color`/`icon`:

| Value | Label (RU → EN) | Meaning |
|---|---|---|
| `ChatAll` | Всем → All | Server-wide all-chat. |
| `ChatTeam` | Команда → Team | Team chat. |
| `ChatSquad` | Сквад → Squad | Squad chat. |
| `ChatAdmin` | Админ чат → Admin chat | Admin-only channel. |
| `broadcast` | Broadcast | Admin broadcast; logged back into the same feed (rendered as a distinct `server_chat-broadcast` line, gold `#DAA520`). |

#### 2.5 Outbound message actions (write-side, in scope)

Exact `Action()` calls (all `Destructive = Y` — these equal send permissions):

| Action | Endpoint | `data` keys (type) | Effect |
|---|---|---|---|
| `broadcast` | `POST /ajax/squad.php` | `server_id` (int), `msg` (string) | System `AdminBroadcast` to **all** players on the server; echoes into this feed as `type=broadcast`. |
| `message` | `POST /ajax/player.php` | `steam_id` (SteamID64), `time` (int seconds), `msg` (string ≤512), `log` (bool) | In-game direct message to one player, repeated for `time`; `log=true` also writes it to the player card. |
| `squadMessage` | `POST /ajax/squad.php` | `server_id` (int), `team` (int), `squad` (int), `time` (int seconds), `msg` (string ≤512) | Message to every member of one squad on one team, repeated for `time`. |

All three consume the standard envelope (`status:'ok'` → success toast / modal close; `auth:true` → reload; else error toast). `broadcast` sends `data` as an object (`&server_id=&msg=`); `time` values come from the `1|30|40|60|90|120` cadence selects.

---

### 3. The page's own table (`#chatPlayers`)

**DataTables config** (`frags/chat.html`, inline `buildTable`):
```
$('#chatPlayers').buildTable({
  table: 'playerChat',
  collum: ["steam_id","server","date","team","name","type","msg","play"],
  order: ["date"], numrows: 300,
  searchInput: ["chatPlayers-name","chatPlayers-steam_id","chatPlayers-msg",
                "chatPlayers-server","chatPlayers-obscene","chatPlayers-type","chatPlayers-date"],
  callback: { type: (d,row) => '<code style="color:'+d.color+'">'+d.name+'</code>' }
});
```

- **Server table id:** `playerChat` (the `action=`/`table=` value).
- **Page size (`numrows`):** `300`.
- **Sortable columns (`order`):** only `date` gets a clickable sort header wired (`order:["date"]`). Header-click sets `order_by=date`, toggling `order_sort` desc↔asc. **Default sort:** none sent on first load (`order_by=false`) — the server returns its own default (newest-first) ordering.

**Columns** (render order; `data-contact` = the `collum` key on each `<td>`):

| # | Header | `collum` key / `data-search` | Width | Notes |
|---|---|---|---|---|
| 1 | `SteamID` (`class="hide"`) | `steam_id` | — | Hidden via `class="hide"` **and** CSS `#chatPlayers td:first-child{display:none}`. Row-click key. |
| 2 | `fa-server` icon | `server` | 50px, centered | Server icon. |
| 3 | `Дата` (Date) | `date` | 130px, centered | `formatDate(...)`. Only sortable column. |
| 4 | `fa-flag` icon | `team` | 50px, centered | Team/faction flag. |
| 5 | `Ник` (Nick) | `name` | 150px, centered | Author nickname. |
| 6 | `Чат` (Chat) | `type` | 90px, centered | Colored channel badge via `type` callback. |
| 7 | `Сообщение` (Message) | `msg` | flex | `word-break:break-all`; profanity-prefixed client-side (§7). |
| 8 | (empty) | `play` | 30px | TTS "speak" button cell. |

**Filters / search controls** (left sidebar):

| Control | `#id` | `data-search` alias | Input type | Attrs / options | Behavior |
|---|---|---|---|---|---|
| Search button | `chatPlayers-btn` | — | button (`fa-search`, "Поиск") | — | Rebuilds table. |
| Nick / SteamID | `chatPlayers-name` | `t2.player` | text | placeholder "Ник или SteamID" | Enter-key (`which==13`) also rebuilds with `page=1,isSearch=true`. |
| Message | `chatPlayers-msg` | `t1.msg` | text | **`maxlength="17"`** | Substring on body. |
| Server | `chatPlayers-server` | `server_id` | multiselect (`multiple`) | `nonSelectedText:'- Сервер -'`; options `1,6,7,9,10,11` | Multi-server filter. |
| Chat type | `chatPlayers-type` | `type` | multiselect (`multiple`) | `nonSelectedText:'- Чат -'`; 5 scope options | Multi-scope filter. |
| Date range | `chatPlayers-date` | `t1.date` | daterange | default `{type:'allTime',start:0,end:0}` | Emits `.startdate`/`.enddate`. |
| Только Мат (Profanity only) | `chatPlayers-obscene` | `obscene` | checkbox (slider) | value `obscene` | `.change()` → `buildTable()` rebuild. |

**Row interaction:** clicking a row reads the hidden `td[data-contact="steam_id"]` text; if `length > 15` (valid SteamID64) → `player.open(steam_id)` opens the shared player-detail modal. Clicks on the `play` cell `stopPropagation()` so TTS does not also open the modal.

---

### 4. Actions / capabilities

`Action({script,action,data})` → `POST /ajax/<script>.php`; object `data` becomes `&key=value` pairs, `action` prepended. Success gated on `status:'ok'`; `auth:true` → reload.

| UI label | action | script → endpoint | `data` keys | Effect | Destructive? |
|---|---|---|---|---|---|
| (table load) Поиск | `playerChat` | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort [, pagination]` | Fetch/filter chat rows | N (read) |
| Broadcast (paper-plane, `main`) | `broadcast` | `squad` → `/ajax/squad.php` | `server_id, msg` | `AdminBroadcast` to all players; echoed into feed | **Y** |
| Сообщение (Message, player modal) | `message` | `player` → `/ajax/player.php` | `steam_id, time, msg, log` | Direct in-game message to one player, repeated `time`s; optional card log | **Y** |
| Squad message (envelope, `main`) | `squadMessage` | `squad` → `/ajax/squad.php` | `server_id, team, squad, time, msg` | Message to a whole squad, repeated `time`s | **Y** |
| (speak) | — | none (client `SpeechSynthesis`) | — | TTS read-aloud of a message cell | N (client only) |

> The chat fragment also embeds the full shared player-detail modal, whose ~22 actions (`ban, kick, kill, kits, kitSave, mark, twink, twinkOnline, addComment, getComments, changeGroup, changeTeam, checkBans, findFriends, removePlayer, unban, addBanName, removeBanName, downloadStat, getPlayerOnlineData, get`) appear in `chat.html` (per `action_catalog.txt`) but belong to the modal, documented in the player-detail section. Only `message` is chat-relevant among them.

---

### 5. Forms & modals

#### 5.1 Direct-message composer (`#player_message`, shared modal, `class="hide"`)

Opened via `player.message.open()` (the "Сообщение" button, `style="display:none"` until unhidden per operator); flips the player card and clones `#player_message` into it. Sent by `player.message.send()` (`frags/main.html:4356`).

| Element | `#id` | Type | Attrs / validation |
|---|---|---|---|
| Canned-message list | — | `list-group` of `<a onclick="player.message.set(event,this)">` | **17** preset moderation phrases (VIP grant, vehicle-claim rules, TK apology, unreadable-nick warning, etc.). Click fills textarea; `set()` does `msg.replace('{player}', name)` for `{player}` token substitution. |
| Add to player card | `player_message-log` | checkbox | "Добавить запись в карточку игрока" → `log = is(':checked')`. |
| Message body | `player_message-msg` | textarea `rows=3` | **`maxlength="512"`**. |
| Repeat cadence | `player_message-time` | select | Options: `1`=1 раз (once), `30`s, `40`s, `60`s (**selected default**, "1 минута"), `90`s, `120`s. |
| Игрок (back) | — | button | `player.unflip()`. |
| Send | `player_message-send` | button | `player.message.send()` → `message` action. No explicit min-length guard beyond `maxlength`. |

#### 5.2 Squad-message composer (`#serverSquadMessage_modal`, on `main`)

Opened by `messageSquad.open(this)` from a squad-panel envelope button (`data-type="squadMessage"`). `open()` shows the modal, inits `#serverSquadMessage-time` and preselects `60`, populates author (`create_id`/`create_name`) + Steam link + "открыть" → `player.open()`.

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Author info | `serverSquadMessage-author_steamid` / `-author_open` / `-author_steamlink` | display | Squad creator SteamID, open-card, Steam profile. |
| Canned list | — | 18 `<a onclick="messageSquad.set(event,this)">` | `{player}` → squad leader name. |
| Message body | `serverSquadMessage` | textarea `rows=4` | **`maxlength="512"`**. |
| Repeat cadence | `serverSquadMessage-time` | select (multiselect) | Same `1/30/40/60/90/120` set; default `60`. |
| Send | `serverSquadMessage-send` | button | `messageSquad.send(this)` → `squadMessage` with `server_id, team=squad.team, squad=squad.id, time, msg`. |

#### 5.3 Broadcast composer (on `main`)

Single inline input `#server_chat-msg` (placeholder "Broadcast") with a `fa-paper-plane-o` icon → `sendSeverBroadcast()`.

- **Validation:** refuses send when `msg.val().length < 2`.
- **Confirm gate:** `$.question({title:'Broadcast', text:'Отправить сообщение как Broadcast??', da:…})` — must confirm before the `broadcast` `Action` fires.
- Input cleared (`msg.val('')`) after confirm.

---

### 6. Permission / visibility logic

- The chat table's `SteamID` column is doubly hidden (`class="hide"` + CSS `td:first-child{display:none}`) — an internal key, not a permission gate.
- Every modal action button embedded in the fragment defaults to `style="display:none;"` (e.g. "Сообщение", "Команда", "Наказать/Разбанить", kick/kill/ban-name/kits items). They are unhidden by the client from the player context + operator role/group returned when `player.open()` loads the card — capability visibility is **server-driven per operator**, not baked into the fragment.
- `Action` responses with `auth:true` → `location.reload()`, the standard session/permission-expiry path.
- No per-server permission split on the chat page itself; the `server` multiselect lists exactly the servers the operator can see.

---

### 7. Notable UX & competitively interesting details

- **Unified profanity detection.** A large single client-side Russian-profanity regex (`isObscene()`, `custom.js:1781`) flags messages: any offending `msg` cell is prefixed with a red warning triangle `<code style="color:#CD5C5C"><i class="fa fa-exclamation-triangle"></i></code>`, and the "Только Мат" toggle passes `obscene:true` to filter the whole feed server-side. Worth beating with a configurable, server-side, multi-language model rather than one hardcoded regex.
- **Text-to-speech read-aloud.** Each row's `play` cell calls `speak(td)` using `SpeechSynthesisUtterance` (`voices[1]`, cancels any in-progress utterance). Niche accessibility / passive-monitoring feature.
- **Color-coded channels.** Chat scope is a server-colored `<code>` badge (`type.color`/`type.name`); the live feed additionally attaches a FontAwesome `icon` per scope — all/team/squad/admin/broadcast instantly distinguishable in a dense feed.
- **Repeating on-screen messages.** Direct and squad messages both support a repeat cadence (`1×`, 30–120s). Combined with `{player}` templating and ~17–18 canned moderation phrases, routine enforcement (vehicle-claim rules, nick warnings, TK apologies) is a two-click operation — a strong workflow to match.
- **Message-to-card logging.** One checkbox (`log`) turns an in-game warning into a permanent record on the player profile, tying live moderation to the audit trail.
- **Cross-scope archive.** Broadcasts are logged back into the same searchable feed as player chat, so operators see their own announcements interleaved with player messages — good accountability.
- **Fixed sidebar + 300-row pages** keep filters permanently visible while scanning large volumes. The `msg` search input is oddly capped at `maxlength="17"` — a low-hanging limitation to exceed. Pagination is a **two-request** pattern (rows first, then a `pagination=true` count), so page counts appear a beat after rows.

---

### 8. Gaps / unverified

- **Live capture unavailable.** `capture.py` was run the permitted 2× and both attempts crashed the headless Chromium (`TargetClosedError`) before writing `network.json`/`content.html`; `_blocked.json` = `[]`. Every contract above is reconstructed from the client code that builds/parses it (`custom.js` `buildTable`/`Action`, `frags/*.html` senders) — authoritative for request bodies and the response envelope, but the exact server-side **field spelling** of each `data.row` object for `action=playerChat` (vs. the live-feed `data.chat` names used as proxy) is inferred, not captured.
- The SQL schema behind aliases `t1` (chat) / `t2` (player) is inferred from `data-search` (`t1.msg`, `t1.date`, `t2.player`, `server_id`, `type`, `obscene`), not seen directly.
- The `team` id→flag mapping and each scope's `color`/`icon` come from server-side table data not present in the fragment.
- `broadcast`/`squadMessage` live on `main` (script `squad`) and `message` on the player modal (script `player`); their handlers were read from `frags/main.html`, not exercised. The chat page is read-only for these.
