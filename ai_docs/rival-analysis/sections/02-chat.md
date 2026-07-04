## 02. In-game Chat & Broadcast

### 1. Purpose and nav location

- **Nav item / page id:** `chat` — loaded via `pageLoad('chat')` → `GET /ajax/page.php?page=chat`, fragment injected into `#content`.
- **Purpose:** A searchable, filterable archive of every in-game chat message (all chat scopes plus admin broadcasts) captured across all monitored servers. It is a **read/audit surface** for chat history, not a live composer. The panel's outbound messaging (broadcast, per-player message, per-squad message) is triggered elsewhere (the `main` dashboard and the shared player-detail modal), but is documented here because it is the counterpart to this feed and is in scope for this section.
- **Source file analyzed:** `frags/chat.html` (2890 lines; only the top ~180 lines are page-specific — the remainder is the shared player-detail modal). Cross-referenced against `custom.js` and `frags/main.html`.

The page layout is a fixed left filter sidebar (`col-md-3`, `position:fixed`) and a wide results table (`col-md-9`).

---

### 2. Entities & fields

#### 2.1 Chat message (`playerChat` — the page's own table)

Inferred from the table column config in the fragment's inline script:
```
buildTable({ table: 'playerChat',
  collum: ["steam_id","server","date","team","name","type","msg","play"], order: ["date"], numrows: 300 })
```
and from the `data-search` attributes on the filter inputs, which expose the underlying SQL alias/column names (the feed is a JOIN of a chat table `t1` and a player table `t2`).

| Field | Source / alias | Type | Meaning |
|---|---|---|---|
| `steam_id` | `t2` (player) | string (SteamID64) | Author's SteamID. Rendered in a `class="hide"` column; used as the row's click key to open the player modal. |
| `server` / `server_id` | `server_id` | int → label | Which game server the message came from (server icon column). Filterable multiselect. |
| `date` | `t1.date` | datetime | Timestamp of the message. Default sort column (descending). |
| `team` | — | flag | Player's team at time of message; rendered as a flag/faction icon (`fa-flag` header). |
| `name` / `player` | `t2.player` | string | Author's in-game nickname. |
| `type` | `type` | enum | Chat scope / channel (see enum below). Rendered as colored `<code>` via the `type` callback: `'<code style="color:'+data.color+'">'+data.name+'</code>`. |
| `msg` | `t1.msg` | string | Message body. `word-break:break-all`; profanity-flagged client-side (see §7). |
| `play` | — | derived | Not stored data — a UI-only text-to-speech ("speak") action cell (see §7). |

**`type` enum (chat scope)** — from the filter `<select id="chatPlayers-type">` options:

| Value | Label | Meaning |
|---|---|---|
| `ChatAll` | Всем (All) | Server-wide all-chat |
| `ChatTeam` | Команда (Team) | Team chat |
| `ChatSquad` | Сквад (Squad) | Squad chat |
| `ChatAdmin` | Админ чат (Admin chat) | Admin-only channel |
| `broadcast` | Broadcast | Admin broadcast messages (outbound, logged back into the same feed) |

Each type carries a server-provided display `color` (used by the render callback), so channels are color-coded in the table.

#### 2.2 Server (referenced entity)

From the server multiselect `<option>` list: each server has an `id` (values seen: 1, 6, 7, 9, 10, 11) and a `label` (e.g. `RAAS/AAS #1`, `INVASION #3`, `Custom для FW`). This is the same server roster used panel-wide.

#### 2.3 Outbound message payloads (broadcast / message / squadMessage)

These are not table entities but the request shapes of the three messaging actions (see §4).

- **Broadcast:** `{ server_id, msg }`.
- **Direct player message:** `{ steam_id, time, msg, log }` — `time` = repeat cadence in seconds, `log` = whether to also write the message into the player's card.
- **Squad message:** `{ server_id, team, squad, time, msg }` — targets a specific squad on a specific team.

---

### 3. The page's own table (`#chatPlayers`)

**Columns** (in render order):

| # | Header | Column key | Notes |
|---|---|---|---|
| 1 | `SteamID` (`class="hide"`) | `steam_id` | Hidden; also forced hidden via inline CSS `td:first-child{display:none}`. Row-click key. |
| 2 | server icon (`fa-server`) | `server` | 50px, centered. |
| 3 | `Дата` (Date) | `date` | 130px. Default sort (desc). |
| 4 | flag icon (`fa-flag`) | `team` | 50px, team/faction flag. |
| 5 | `Ник` (Nick) | `name` | 150px. |
| 6 | `Чат` (Chat) | `type` | 90px, colored channel badge. |
| 7 | `Сообщение` (Message) | `msg` | Flexible width, profanity-flagged. |
| 8 | (empty) | `play` | 30px, TTS button cell. |

**Data fetch:** `buildTable` issues `POST /ajax/table.php` with `action=playerChat` and body `table=playerChat&page=<n>&numrows=300&search=<encoded filters>&order_by=date&order_sort=<asc/desc>` (server-side DataTables-style paging). Page size is **300 rows**.

**Filters / search controls** (left sidebar; each maps to a `data-search` alias that becomes part of `search`):

| Control | id | `data-search` | Type | Behavior |
|---|---|---|---|---|
| Search button | `chatPlayers-btn` | — | button (`fa-search`, "Поиск") | Triggers table (re)build. |
| Nick / SteamID | `chatPlayers-name` | `t2.player` | text | Free-text on player name or SteamID. |
| Message | `chatPlayers-msg` | `t1.msg` | text, `maxlength="17"` | Substring search within message body. |
| Server | `chatPlayers-server` | `server_id` | multiselect (`- Сервер -`) | Filter by one or more servers. |
| Chat type | `chatPlayers-type` | `type` | multiselect (`- Чат -`) | Filter by channel(s). |
| Date range | `chatPlayers-date` | `t1.date` | daterange (default `allTime`) | Time window. |
| Только Мат (Profanity only) | `chatPlayers-obscene` | `obscene` | checkbox slider, value `obscene` | Restrict to messages flagged as profane; `change` rebuilds the table. |

**Sorting:** column-header driven (`order_by`/`order_sort`), default `date desc`. **Pagination:** page-based via `buildTable` `page`/`numrows`.

**Row interaction:** clicking a row reads the hidden `steam_id` cell and, if length > 15 (valid SteamID64), calls `player.open(steam_id)` to open the shared player-detail modal. Clicks on the `play` cell are intercepted (`stopPropagation`) so TTS does not also open the modal.

---

### 4. Actions / capabilities

Two categories: (a) the chat page's own read action, and (b) the messaging actions in scope. All state-changing calls go through the `Action({script, action, data})` helper → `POST /ajax/<script>.php` with body `action=<action>&<data>`. `Action` treats a `{...}` `data` object by appending `&key=value` pairs and adding `action`. Success is gated on JSON `{status:'ok'}`; `auth:true` forces a page reload.

| UI label | action id | script → endpoint | Data params | Effect | Destructive (state-changing)? |
|---|---|---|---|---|---|
| (table load) Поиск | `playerChat` | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` | Fetch/filter chat rows | N (read) |
| Broadcast (paper-plane on `main`) | `broadcast` | `squad` → `/ajax/squad.php` | `server_id, msg` | Sends `AdminBroadcast` — a system message to **all** players on the server; echoed back into this feed as `type=broadcast` | **Y** |
| Сообщение (Message, player modal) | `message` | `player` → `/ajax/player.php` | `steam_id, time, msg, log` | Sends an in-game direct/admin warning message to one player, repeated for `time` seconds; optionally logs it to the player card | **Y** |
| Squad message (envelope on `main`) | `squadMessage` | `squad` → `/ajax/squad.php` | `server_id, team, squad, time, msg` | Sends a message to every member of a specific squad, repeated for `time` seconds | **Y** |
| (speak) | — | none (client `SpeechSynthesis`) | — | Text-to-speech read-aloud of a message cell | N (client only) |

> Note: the chat fragment also embeds the full shared player-detail modal, whose ~22 actions (`ban`, `kick`, `kill`, `kits`, `mark`, `twink`, `addComment`, `getComments`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `removePlayer`, `unban`, `addBanName`/`removeBanName`, `downloadStat`, `transfer`, `vipPlayer`, …) appear here but belong to the modal, not to the chat page. They are documented in the player-detail section. Only `message` (direct player message) is chat-relevant among them.

---

### 5. Forms & modals

#### 5.1 Direct-message composer (`#player_message`, shared modal, `class="hide"`)

Opened via `player.message.open()` ("Сообщение" button) from the player card; posts through `player.message.send()`.

| Element | id | Type | Notes / validation |
|---|---|---|---|
| Canned-message list | — | `list-group` of `<a onclick="player.message.set(...)">` | ~18 preset moderation phrases (VIP grant, vehicle-claim rules, TK apology, unreadable-nick warning, etc.). Clicking one fills the textarea. Supports `{player}` token substitution (used by squad variant). |
| Add to player card | `player_message-log` | checkbox | "Добавить запись в карточку игрока" — sets `log=true` so the message is recorded on the player's profile. |
| Message body | `player_message-msg` | textarea, `rows=3`, `maxlength="512"` | The text sent. |
| Repeat cadence | `player_message-time` | select | Options: `1`=1 раз (once), `30`s, `40`s, `60`s (default, "1 минута"), `90`s, `120`s — how long the on-screen message repeats. |
| Send | `player_message-send` | button | `player.message.send()` → `message` action. |

**Client validation:** broadcast composer on `main` (`#server_chat-msg`) refuses to send when `msg.length < 2`; broadcast additionally requires a confirm dialog (`$.question`, "Отправить сообщение как Broadcast??"). The player-message send has no explicit min-length guard beyond the textarea `maxlength`.

#### 5.2 Squad-message composer (`#serverSquadMessage`, on `main`)

Opened by `messageSquad.open(this)` from a squad's envelope button. Fields: `#serverSquadMessage` (textarea, `{player}`-templated with the squad leader's name), `#serverSquadMessage-time` (same cadence select). Submits `squadMessage` with `team`, `squad`, `time`, `msg`.

#### 5.3 Broadcast composer (on `main`)

A single inline input `#server_chat-msg` (placeholder "Broadcast") with a paper-plane icon (`sendSeverBroadcast()`). Confirmation dialog required before send; input cleared on submit.

---

### 6. Permission / visibility logic

- The chat table's `SteamID` column is doubly hidden (`class="hide"` + inline CSS), used only as an internal key — not a permission gate.
- All modal action buttons embedded in the fragment default to `style="display:none;"` (e.g. "Сообщение", "Команда", "Наказать/Разбанить", kick/kill/ban-name/kits list items). They are unhidden by the client based on the player context and the operator's role/group returned when `player.open()` loads the card — i.e. capability visibility is **server-driven per operator**, not baked into the fragment. The chat page itself exposes no role gating beyond this.
- `Action` responses carrying `auth:true` trigger `location.reload()`, the standard session/permission-expiry path.
- There is no visible per-server permission split on the chat page; the server multiselect lists every server the operator can see.

---

### 7. Notable UX & competitively interesting details

- **Unified profanity detection.** A large client-side Russian-profanity regex (`isObscene()`) flags messages: any offending `msg` cell is prefixed with a red warning triangle `<code style="color:#CD5C5C"><i class="fa fa-exclamation-triangle"></i></code>`, and the "Только Мат" toggle filters the whole feed to flagged messages (server-side `obscene` search). Worth beating with a configurable, server-side, multi-language profanity model rather than a single hardcoded regex.
- **Text-to-speech read-aloud.** Each row's `play` cell uses the browser `SpeechSynthesisUtterance` API to speak a message aloud (`speak(td)`, picks `voices[1]`). Niche but a low-cost accessibility / passive-monitoring feature.
- **Color-coded channels.** Chat scope is rendered as a server-colored badge, making all/team/squad/admin/broadcast instantly distinguishable in a dense feed.
- **Repeating on-screen messages.** Both direct and squad messages support a repeat cadence (1×, 30–120s). Combined with `{player}` templating and ~18 canned moderation phrases, this makes routine enforcement (vehicle-claim rules, nick warnings, TK apologies) a two-click operation — a strong workflow to match.
- **Message-to-card logging.** A single checkbox turns an in-game warning into a permanent record on the player's profile, tying live moderation to the audit trail.
- **Cross-scope archive.** Broadcasts are logged back into the same searchable feed as player chat, so the operator sees their own outbound announcements interleaved with player messages — good for accountability.
- **Fixed sidebar + 300-row pages** keep filters permanently visible while scanning large volumes; the `msg` search input is oddly capped at `maxlength=17`, a limitation worth exceeding.

---

### 8. Gaps / unverified

- The exact SQL schema behind `t1` (chat) / `t2` (player) is inferred from `data-search` aliases, not seen directly.
- The `team` column's rendering (flag/faction mapping) and the `color` value per chat type come from server-side table data not present in the fragment.
- `broadcast` and `squadMessage` live on the `main` dashboard and the player modal (script `squad`/`player`); their handlers were read from `frags/main.html`, not from `chat.html`. The chat page is read-only for these.
