## 08. Player Comments & Suspect Marking

Documentation of SQSTAT's per-player admin note system (**Комментарии / Comments**) and its suspect-tagging system (**Метки / Marks**). These are two distinct but related moderation-storage features that attach free-form notes and structured "cheat suspicion" flags to a player identity (keyed by SteamID). Both surface as dedicated nav pages **and** as controls inside the shared `player-detail` modal that is embedded on every page.

---

### 1. Purpose & Nav Location

| Feature | Nav item | Page id | AJAX fragment | Own table id |
|---|---|---|---|---|
| Player comments log | `comments` | `comments` | `GET /ajax/page.php?page=comments` | `#playerComments` |
| Suspect marks log | `mark` | `mark` | `GET /ajax/page.php?page=mark` | `#playerMark` |

- **Comments page** = a global, cross-player audit feed of every admin note ever written, with search by target player, authoring admin, and note text.
- **Mark page** = a global roster of every player who currently carries a suspicion/toxicity flag, filterable by mark type; effectively a "watchlist" of suspected cheaters and toxic players.
- Both are read/browse surfaces. The *write* side (adding a comment, setting/clearing a mark) happens inside the shared player modal, which both pages also embed. Clicking any row opens that player's modal via `player.open(steam_id)`.

The underlying capabilities (`addComment`, `getComments`, `mark`) are available from **every** page in the panel (admins, bans, chat, kills, players, reports, etc. — confirmed in the action catalog), because they are part of the shared modal. The two pages documented here are just the dedicated *browse/report* views over the same stored data.

---

### 2. Entities & Fields

#### 2.1 Entity: `player_comment` (admin note)

Inferred from the `#playerComments` table columns (`buildTable` `collum: ["steam_id","date","admin","player","text"]`), the search inputs (`t1.text`, `t2.player`, `t5.player`), and the `addComment` / `getComments` payloads.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Target player the note is attached to. |
| `date` | datetime | When the note was written (rendered via `formatDate(date,false)`). |
| `admin` | string | Display name of the authoring admin (join alias `t2.player`). |
| `player` | string | Current nickname of the target player (join alias `t5.player`). |
| `text` | string, `maxlength=256` | The note body. Free text, one line, up to 256 chars. |
| `name` | string | In the `getComments` response, the author's display name (`comment.name`) rendered above each message. |

Notes on structure:
- The search aliases `t1`, `t2`, `t5` reveal a multi-table join server-side: `t1` = comments table (has `.text`), `t2` = admin/author table (has `.player`), `t5` = target player table (has `.player`). This confirms comments are stored in their own table and joined to both the author admin and the target player records.
- Comments are **append-only** from the UI — there is no edit or delete control anywhere in the fragment. Notes accumulate as an immutable thread per player.
- A per-player **comment count** (`comments_count`) is delivered with the player modal payload and shown as a badge on the comment button.

#### 2.2 Entity: `player_mark` (suspicion / toxicity flag)

Inferred from the `#playerMark` table (`collum: ["steam_id","player","date","mark","ban"]`), the `<select id="playerMark-mark">` options, the modal `player.mark` object, and the `mark` action payload.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Player carrying the mark. |
| `player` | string | Player nickname. |
| `date` | datetime | Last-seen timestamp — column header is **Заходил (Last logged in)**, not mark date. |
| `mark` | enum int `0`–`8` | The suspicion category (see enum below). `0` = no mark / cleared. |
| `ban` | (flag/status) | **Бан (Ban)** column — indicates whether this suspected player is currently banned, letting admins triage suspects who have not yet been actioned. |

**`mark` enum (suspicion categories):** This is the competitively interesting core of the feature — a fixed taxonomy of cheat/behaviour suspicions, each with its own FontAwesome icon.

| Value | Russian label | English gloss | Icon |
|---|---|---|---|
| `1` | Подозрение на WallHack | Suspected WallHack | `fa-eye` |
| `2` | Подозрение на AimBot | Suspected AimBot | `fa-crosshairs` |
| `3` | Подозрение на SpeedHack | Suspected SpeedHack | `fa-tachometer` |
| `4` | Подозрение на спавн объектов | Suspected object spawning | `fa-bomb` |
| `5` | Подозрение на перезарядку | Suspected reload exploit | `fa-refresh` |
| `6` | Подозрение на гриф | Suspected griefing | `fa-free-code-camp` |
| `7` | Подозрение на конфиг | Suspected illegal config | `fa-file-excel` |
| `8` | Токсичный игрок | Toxic player | `fa-biohazard` |
| `0` | Снять метку | Remove mark (clear) | `fa-times` |

- A player carries **exactly one** mark at a time (setting a new value replaces the old; `mark.set(0)` clears). It is a single scalar enum column, not a multi-tag set — even though the *mark page filter* is a multiselect (that multiselect is an OR filter over the log, not a per-player multi-value store).
- The mark enum table is hardcoded client-side in `player.mark.get()` as a JSON map (id → `{name, icon}`), duplicated between the page's filter `<select>` and the modal dropdown. A competing panel could make this taxonomy server-configurable.

---

### 3. The Pages' Own Tables

#### 3.1 `#playerComments` (comments page)

Server-side DataTables-style table via jQuery `buildTable` (`table:'playerComments'`, `numrows:100`). Row click → `player.open(steam_id)`.

| # | Header | Data key | Meaning |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Target player id (also the row's click key). |
| 2 | Дата (Date) | `date` | Note timestamp, centered. |
| 3 | Админ (Admin) | `admin` | Authoring admin. |
| 4 | Ник (Nick) | `player` | Target player nickname. |
| 5 | Комментарий (Comment) | `text` | Note body. |

**Search/filter controls** (left fixed sidebar, submitted by the **Поиск (Search)** button `#playerComments-btn`):

| Input | Placeholder | Server field | Filters on |
|---|---|---|---|
| `#playerComments-name` | Игрок (Player) | `t5.player` | Target player nickname |
| `#playerComments-admin` | Админ (Admin) | `t2.player` | Authoring admin |
| `#playerComments-text` | Текст (Text) | `t1.text` | Note body substring |

No column-sort UI or pagination widgets are present in the fragment beyond the `numrows:100` page size; loading is server-side.

#### 3.2 `#playerMark` (mark page)

Same `buildTable` engine (`numrows:100`). Row click → `player.open(steam_id)`. Rows carrying a mark get CSS class `player_mark` (highlight styling).

| # | Header | Data key | Meaning |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Suspect player id. |
| 2 | Ник (Nick) | `player` | Nickname. |
| 3 | Заходил (Last seen) | `date` | Last login time. |
| 4 | Причина (Reason) | `mark` | Suspicion category (enum → icon+label). |
| 5 | Бан (Ban) | `ban` | Whether the suspect is currently banned. |

**Search/filter controls** (left sidebar):

| Control | Type | Server field | Filters on |
|---|---|---|---|
| `#playerMark-name` | text, placeholder Игрок (Player) | `t1.player` | Nickname |
| `#playerMark-mark` | `<select multiple>` (bootstrap-multiselect, `nonSelectedText:'- Метка -'`, `enableHTML:true`) | `mark` | One or more mark categories (OR) |

The multiselect renders each option with its inline icon via `enableHTML`. This is the "watchlist filter": e.g. show me all players flagged AimBot **or** WallHack.

---

### 4. Actions / Admin Capabilities

All three actions post to the same script endpoint. `Action({script, action, data})` → `POST /ajax/<script>.php` with body `action=<action>&<data...>`.

| UI label / trigger | action id | Endpoint | Data params | Effect | Destructive (state-change)? |
|---|---|---|---|---|---|
| Comment thread open (auto-load) | `getComments` | `/ajax/player.php` | `steam_id` | Returns `{comments:[{name,date,text},…]}` for the player; populates the slide-out thread. | N (read) |
| Send note (Enter or ▶ submit) | `addComment` | `/ajax/player.php` | `steam_id`, `text` (trimmed, non-empty, ≤256) | Persists a new note authored by the current admin; on complete re-runs `getComments`. | **Y** |
| Set/clear suspicion mark (dropdown `player.mark.set(n)`) | `mark` | `/ajax/player.php` | `steam_id`, `mark` (0–8) | Sets the player's mark enum; `0` clears it. Updates modal warning banner + row highlight. | **Y** |

Supporting client behaviour:
- `addComment` clears the input on success and always refetches the thread on `complete`, so the new note appears immediately.
- `mark` on success plays a flip animation (`animateCss('flip_panel_full')`), destroys/rebuilds the comment panel, re-renders the mark banner, and toggles the `player_mark` row class across any visible table (`tr[data-id="<steam_id>"]`).
- Errors from either write action surface via `addAlert(text, "exclamation-triangle")`.

> Note: the action catalogs for `comments.html` and `mark.html` also list the full shared-modal action set (`ban`, `kick`, `kill`, `kits`, `kitSave`, `message`, `twink`, `unban`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `addBanName`, `removeBanName`, `removePlayer`, `getPlayerOnlineData`, `downloadStat`, `get`) plus `script:'squad'`. Those belong to the embedded player modal, **not** to the comments/mark pages themselves, and are documented in the shared-modal section.

---

### 5. Forms & Modals

#### 5.1 Comment slide-out panel (`.player_comments`, inside the player modal)

- **Trigger:** comment button with unread/count badge (`.player_comments_button` desktop, `.player_comments_button-mobile` mobile) → `player.comment.open()` toggles the `open` class; opening triggers `get()`.
- **Composer:** single `<input class="form-control" maxlength="256">` + submit button `.player_comments_sumbit`. Submits on Enter (keyCode 13) or click.
- **Validation:** client trims input and drops empty strings (`if(text=='') return;`). Only a 256-char max and non-empty check; no server-echoed validation shown.
- **Thread rendering:** each message shows author name + formatted date header and the note text (with `&amp;quot;` unescaped back to `"`).
- **States:** loading spinner (`.player_comments_load`), empty state **Нет комментариев (No comments)** (`.player_comments_nomessage`), and a live count badge via `player.comment.count()`.

#### 5.2 Mark dropdown (inside the player modal header)

- A **tags** dropdown button (`fa-tags`) next to the **Группа (Group)** button opens `#player_info-mark`, listing the 8 suspicion options + a divider + **Снять метку (Remove mark)**.
- Each `<li><a onclick="player.mark.set(n)">` fires the mark action directly — no confirmation dialog.
- The currently-active mark's menu item gets `class="disabled"` via `mark.render()`, so admins see which flag is set.
- When a mark is set, a pulsing warning banner (`#player_info_mark`, `alert-warning`, `animated pulse infinite`) shows the icon + label at the top of the player panel; cleared marks hide it.

---

### 6. Permission / Visibility Logic

- The whole player template block lives inside `<div id="player_info" class="hide">` — it is a hidden client-side template cloned into `#playerModal` when a player is opened; the `hide` class here is a rendering mechanism, not a permission gate.
- **No explicit role/group gating** is present on the comment composer or the mark dropdown in these fragments — unlike sibling controls (e.g. **Убить (Kill)**, **Кикнуть без причины (Kick w/o reason)**, ban-name actions) which ship with `style="display:none;"` and are revealed by role logic elsewhere. This suggests comments and marks are available to any admin who can open the modal (a relatively low privilege bar), whereas punitive actions are gated tighter.
- Authorship is server-attributed: `addComment` sends only `steam_id`+`text`; the admin identity is taken from the session, and every note is stamped with the author name shown in the comments feed and thread. This makes the comments page an **accountability/audit trail** of which admin said what about whom.
- Marks are **not** author-attributed in the visible schema (the mark page shows last-seen date, not who flagged) — a possible weakness to beat: no audit of who set/cleared a suspicion.

---

### 7. Notable UX & Competitive Takeaways

- **Structured cheat taxonomy.** The 8-value suspicion enum (WallHack, AimBot, SpeedHack, object-spawn, reload-exploit, grief, illegal-config, toxic) with per-type icons is a clean, low-friction watchlist primitive. Setting a flag is one click, no dialog. Worth copying — but make the taxonomy **server-configurable** rather than hardcoded in JS in two places.
- **Ban-aware watchlist.** The mark page's **Бан** column lets moderators immediately see which flagged suspects are still unbanned — a ready-made triage queue for "suspected but not yet actioned" cheaters.
- **Cross-player audit feed.** The comments page is a global, searchable log of every admin note (searchable by author admin), doubling as staff accountability. Notes are immutable/append-only.
- **Ubiquitous access.** Because comments+marks ride the shared modal, an admin can annotate/flag a player from *any* page (chat, kills, reports…) without navigating away — very low friction. The count badge keeps prior notes discoverable.
- **Gaps to beat:**
  - No edit/delete/soft-delete of comments; no threading or attachments; 256-char single-line cap.
  - Only one mark per player (single enum) — cannot flag both "AimBot" and "toxic" simultaneously despite the multiselect *filter* implying otherwise.
  - No visible mark-author audit or mark history/timeline.
  - Mark taxonomy and enum→label map are hardcoded client-side and duplicated between filter and modal.
  - No pagination beyond a fixed 100-row server page; no explicit sort controls.
