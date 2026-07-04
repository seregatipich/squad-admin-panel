## 06. VIP / Privileges (Привилегии)

### 1. Purpose & Navigation

- **Nav id / loader:** `vips` — the nav item calls `pageLoad('vips')` → `GET /ajax/page.php?page=vips`, and the returned HTML fragment is injected into `#content`.
- **Purpose:** A read-and-drill roster of all players who currently hold a **group/privilege** (VIP, Admin, Moderator, Camera, Trainee, …). It is effectively a filtered view of the player base joined against the "group assignment" table, showing who has a privilege, when it expires, when they last connected, and the admin's note.
- **Important architectural note:** The `vips` page itself is *read-only browsing + search*. It has **no add/edit/delete controls of its own**. All privilege mutation is performed through the **shared player-detail modal** ("Смена группы" / Change group sub-panel) that every fragment embeds. Clicking any row opens that modal for the selected player. So the "VIP management" capability physically lives in the shared modal, but is reached from this page.

---

### 2. Entities & Data Model

The page exposes two entities: the **VIP/privilege roster row** (the page's own table) and the **group assignment** record (edited via the shared modal). Fields are inferred from the `buildTable` `collum` array, the search `data-search` attributes, the `changeGroup` payload, and the group `<select>`/`dateRange` options.

#### Entity A — VIP roster row (`vipPlayers` table)

`buildTable({ table:'vipPlayers', collum:["steam_id","name","expire","date","time","vipdesc"] })`

| Field (collum key) | Column header | Meaning / Type | Notes |
|---|---|---|---|
| `steam_id` | SteamID | Player Steam64 id | Rendered inside a `<hashtag>` element; used as the drill key (`player.open(...)`). |
| `name` | Ник (Nick) | Current/last known player name | String. |
| `expire` | Срок (Term) | Privilege expiry timestamp | Unix seconds. `expire == '0'` ⇒ **permanent** ("infinity"). Drives the roster's core sort/meaning. |
| `date` | Заходил (Last seen) | Last-login timestamp | Unix seconds; the "Заходил c / до" filters range over this. |
| `time` | (clock icon `fa-clock-o`) | Time metric per row | A right-aligned narrow (80px) column keyed on a clock icon — represents accumulated online time / duration; not separately labelled in UI. |
| `vipdesc` | Описание (Description) | Admin note attached to the privilege | Free text; searchable via `t1.description`. |

The search `data-search` hints leak the server-side schema: `t1.description` (the privilege/assignment table, alias `t1`) and `t2.player` (the player table, alias `t2`), i.e. the roster is a JOIN of a **group-assignment table (t1)** and a **player table (t2)**.

#### Entity B — Group / privilege assignment (edited via `changeGroup`)

Payload of `player.group.set` → `Action({script:'player', action:'changeGroup', data:{...}})`:

| Field | Source control | Meaning / Type |
|---|---|---|
| `steam_id` | `player.info.steam_id` | Target player. |
| `group_id` | `#player_group-groups` (`<select>`) | The privilege/role granted (see group list below). `0` = remove group. |
| `date` | `#player_group-expire` dateRange (`.data('start')`) | Expiry start/term. `0` / infinity ⇒ permanent. |
| `description` | `#player_group-description` (`<textarea>`, maxlength 128) | Admin comment shown as `vipdesc` in the roster. |
| `prefix` | `#player_group-prefix` (maxlength 64) | In-game chat/name prefix/tag granted with the privilege. |
| `prefix_rgb` | `#player_group-prefix_rgb` (+ color picker, maxlength 16) | RGB color of the prefix, stored as `"r,g,b"`; a `<input type=color>` and hex↔rgb converters (`stringRgbToHex`,`hexToRgb`) keep the two synced. |
| `image` | `#player_group-image` (maxlength 256) | URL to an image/badge associated with the privilege. |

Group catalog (from the `<select id="player_group-groups">` options — this is the full privilege taxonomy):

| group_id | Label | Icon |
|---|---|---|
| `0` | -Нет группы- (No group) | — |
| `1` | Администратор (Administrator) | user-circle |
| `2` | Модератор (Moderator) | id-badge |
| `3` | **VIP** | star |
| `4` | Камера (Camera / spectator) | video-camera |
| `5` | Стажёр (Trainee) | graduation-cap |

So "VIP" is one value (`group_id=3`) inside a general **group/role system** — the same mechanism grants staff roles and VIP alike, differentiated only by `group_id`.

---

### 3. The Page's Own Table (`#vipPlayers`)

- **Columns:** SteamID · Ник · Срок (expiry) · Заходил (last seen) · clock-icon (time) · Описание. (See Entity A.)
- **Pagination / page size:** server-side via `POST /ajax/table.php` (script `table`, action = table name `vipPlayers`); `numrows: 50` rows/page. Page counts fetched with a separate `&pagination=true` call.
- **Search/filter controls** (left fixed sidebar, `#vipPlayers-*`, applied by the "Поиск" button `#vipPlayers-btn`):

| Control | id | `data-search` target | Meaning |
|---|---|---|---|
| Ник или SteamID (Nick or SteamID) | `vipPlayers-name` | `t2.player` | Text match on player name/id. |
| Заходил c (Last-seen from) | `vipPlayers-startdate` | `startdate` | Datetime picker (ru locale), range start on last-login. |
| Заходил до (Last-seen to) | `vipPlayers-enddate` | `enddate` | Datetime picker, range end; each has an inline clear (✕). |
| Описание (Description) | `vipPlayers-desc` | `t1.description` | Text match on the admin note. |

- **Row interaction:** `$('#vipPlayers tbody > tr').on('click', ...)` → `player.open(<steam_id from hashtag>)` opens the shared player-detail modal. There is **no sort UI, no per-row action buttons, no bulk-select** on this page — it is a browse/search surface only.

---

### 4. Actions / Permissions available from this page

The only *page-native* interaction is search + drill-in. Every state change is delegated to the shared player modal reached via row click. Actions relevant to VIP/privileges:

| UI label | action id | script → endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| (row click) | — | — | — | `player.open(steam_id)` — loads player card + `get` data. | N |
| Сменить группу (Change group) | `changeGroup` | `player` → `POST /ajax/player.php` | `steam_id, group_id, date, description, prefix, prefix_rgb, image` | Grants / changes / (with `group_id=0`) removes a privilege; sets expiry, note, prefix, color, image. This is the **VIP add + edit + remove** operation. | **Y** |
| VIP +1 месяц (VIP +1 month) | `changeGroup` | `player` → `POST /ajax/player.php` | same payload (quick-grant, expire preset to +1 month, group=VIP) | Convenience one-click VIP grant. Button carries class `hide` — rendered but hidden by default (shown only in certain contexts/roles). | **Y** |

Additional shared-modal actions embedded in this fragment (per the action catalog for `vips.html`) but **not part of the VIP workflow** — they belong to the universal player modal and are documented in the Players section: `ban`, `unban`, `kick`, `kill`, `kits`, `kitSave`, `mark`, `message`, `twink`, `twinkOnline`, `addComment`, `getComments`, `changeTeam`, `checkBans`, `findFriends`, `getPlayerOnlineData`, `removePlayer`, `addBanName`, `removeBanName`, `get`, `downloadStat` (scripts `player` and `squad`).

Note: On the **clan** page the same star-checkbox uses a *different* action — `Action({script:'clan', action:'vipPlayer', data:{clan_id, steam_id, vip:true|false}})` — which toggles a clan-scoped reserved/VIP flag per member. The `vips` roster page itself does **not** use `vipPlayer`; it uses `changeGroup`. This is a meaningful distinction: **global privilege = `changeGroup` (group_id=3)**, **clan reserved-slot = `vipPlayer` boolean**.

---

### 5. Forms & Modals

**"Смена группы" (Change group) panel** — `#player_group` (flip side of the player card; opened via `player.group.open()` from the card's "Группа" button `#player_info-group_btn`):

| Field | Control | Options / Validation |
|---|---|---|
| Group | `#player_group-groups` bootstrap-multiselect | The 5-role catalog + "No group"; pre-selected to the player's current `group_id`; `enableHTML` for icon labels. |
| Expire | `#player_group-expire` custom `dateRange` widget | Presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. Default = **infinity** if player already has a permanent group (`expire=='0'`), else a single-day range from current expiry/now. `infinity` ⇒ stored as `0` = permanent. |
| Комментарий (Comment) | `#player_group-description` textarea | maxlength **128**. |
| Префикс (Prefix) | `#player_group-prefix` text | maxlength **64**. |
| Цвет префикса RGB | `#player_group-prefix_rgb` + `type=color` swatch | maxlength 16; auto-synced hex↔`r,g,b`. |
| Ссылка на изображение (Image URL) | `#player_group-image` text | maxlength **256**. |
| Submit | "Сменить группу" / "VIP +1 месяц" | Both call `player.group.set(this)`; a confirm dialog (`$.question`, "Сменить группу?") shows the target group label before firing. |

**Self-protection:** if `player.info.is_you` (admin editing their own card), the group multiselect and the expire control are **disabled** — an admin cannot change their own group/expiry through the UI.

---

### 6. Permission / Visibility Logic

- **`class="hide"` gating:** `#player_group` and `#player_info` panels ship hidden and are cloned into the flip modal on demand. The **"VIP +1 месяц"** quick-grant button carries `hide` by default while **"Сменить группу"** is always visible — implying the one-click VIP button is surfaced only in specific contexts (e.g., a role/permission or a page where quick VIP granting is enabled).
- **Self-edit block:** `is_you` disables the group + expire controls (see above).
- **No client-side role fences beyond that** are visible in the fragment; server-side `player.php` presumably authorizes `changeGroup`. The page trusts the server to enforce who may grant Admin vs VIP (the client offers the full group list to anyone who can open the modal).
- The roster query itself is scoped server-side (aliases `t1`/`t2`); no per-server selector is present *on this page* — privilege scope (global vs per-server) is not exposed in the `vips` fragment, whereas the clan `vipPlayer` flag is explicitly clan-scoped (`clan_id`).

---

### 7. Notable UX & Competitively Interesting Details

- **Unified group system:** VIP, Admin, Moderator, Camera, Trainee are one `group_id` field, not separate subsystems. One modal + one `changeGroup` endpoint covers grant/edit/revoke for every role. Simple to clone; note the single-endpoint design.
- **Rich privilege metadata:** a privilege isn't just a boolean — it carries **expiry, admin note, chat prefix, prefix RGB color, and an image/badge URL**. The color picker with live hex↔rgb sync is a polished touch worth matching.
- **Expiry presets + "infinity":** the dateRange widget's fixed presets (day / 1-2-3-6 months / 1 year / permanent / reset) make term-setting one click. Permanent is encoded as `0`.
- **Quick "VIP +1 месяц":** a dedicated one-tap "extend/grant a month of VIP" button — a fast path for the most common operation (rewarding players). Copy this; it's the highest-frequency admin action for a VIP roster.
- **Search ergonomics:** last-seen date-range filtering lets staff find **expired-but-inactive** or **soon-to-lapse active** VIPs quickly; description search finds notes like "donation #123". Good for VIP retention workflows.
- **Self-protection guard:** blocking self-group-edit prevents an admin from accidentally (or maliciously without a second admin) altering their own privileges.
- **Two distinct "VIP" concepts to beat:** global privilege (`changeGroup`, group=VIP) vs clan reserved-slot toggle (`vipPlayer` boolean with `clan_id`). A competing panel should decide whether to unify these or keep them separate.

---

### Gaps / Unknowns

- The clock-icon column (`time`) has no text label; its exact semantic (total online time vs remaining term vs session length) is inferred, not confirmed by a label.
- Reserved-slot semantics for VIP (in-game slot priority) are implied by the role but not described in this fragment; the closest explicit reserved-slot mechanism is the clan `vipPlayer` boolean.
- Per-server scoping of a global VIP is not exposed on this page; whether `changeGroup` is global or server-scoped is server-side and not visible here.
- The condition that un-hides "VIP +1 месяц" is not determinable from the static fragment.
