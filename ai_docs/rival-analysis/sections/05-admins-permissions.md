## 05. Administration: Admins, Groups & Permissions

Implementation-spec documentation of the SQSTAT "admins" page (breaking.sqstat.ru) — the staff roster and the group/role model that drives every permission in the panel. **Ground truth for this chapter is a LIVE capture** of the page's own auto-load reads (read-only headless browser, mutations aborted by interceptor):

- `caps/admins/admins.network.json` — 3 live AJAX contracts (method, url, request body, status, response schema + redacted sample).
- `caps/admins/admins.content.html` — the live rendered `#content` (real headers, form ids, data-* attrs, embedded modal JS).
- `caps/admins/admins.modaltabs.json` — the per-player detail-log tables embedded in the shared modal (`admin`, `date`, `text`).
- `caps/admins/_blocked.json` — `[]` (zero mutations attempted/blocked during capture).

Cross-referenced against `custom.js` (the `player.*` object, `Action()` calls, DataTables config), `action_catalog.txt`, and chapter 16 (settings → permission-group tokens).

> Scope note: `admins.content.html` contains two distinct things. (1) The page's **own** UI — a fixed filter sidebar plus the `#adminPlayers` roster table. (2) The **shared player-detail modal** (`#playerModal`, ids `player_info*`, `player_ban*`, `player_group*`) and its `player.*` JavaScript object, injected into every page fragment in the app. This chapter treats the roster + filter as the page's own surface, and the group-change modal (`#player_group`) as the permission-management surface, and explicitly flags shared-modal actions that are not unique to this page.

---

### Live API Contracts

Everything below is transcribed from the captured `admins.network.json`. Timestamps are unix seconds. Note the panel's convention: **the server pre-renders display cells as HTML strings inside the JSON** (`group`, `time`, `boost`, `bans`, `discord`) while also returning the **raw** values (`group_id`, `color`, `icon`) the client needs for the filter/modal — so the same row carries both machine and presentation forms.

#### C1 — Page fragment loader

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=admins` |
| **Request params** | `page` — string — required — fragment id (`admins`) |
| **Status / ctype** | `200` · `text/html; charset=UTF-8` (114 456 B) |
| **Response** | HTML fragment injected into `#content`: the filter sidebar (`#adminPlayers-btn`, `-name`, `-group`, `-period`), the `#adminPlayers` table skeleton, and the full shared `#playerModal` markup (`#player_group` form included). |
| **Capture** | `caps/admins/admins.network.json` entry 0 |

#### C2 — Roster data (server-side DataTables read)

| | |
|---|---|
| **Method / path** | `POST /ajax/table.php` |
| **Status / ctype** | `200` · `application/json; charset=utf-8` |
| **Capture** | `caps/admins/admins.network.json` entry 1 |

Request body (form-urlencoded; captured, decoded):

```
action=adminPlayers&table=adminPlayers&page=1&numrows=50
&search={"text":{"custom.period.startdate":1780559720,"custom.period.enddate":1783151720},
         "check":{},"multiselect":{},"managers":{},"slider":{}}
&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id — always `adminPlayers`. |
| `table` | string | Y | Duplicate of `action` (`adminPlayers`); the panel sends both. |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size — **50**. |
| `search` | JSON string | Y | Filter envelope with fixed buckets `text`, `check`, `multiselect`, `managers`, `slider`. Roster injects the period as `text["custom.period.startdate"]` / `["custom.period.enddate"]` (unix s). `#adminPlayers-name` (DB alias `t2.player`) lands in `text`; `#adminPlayers-group` (alias `group_id`) lands in `multiselect` when set. |
| `order_by` | string \| `false` | Y | DB alias of the sort column, or literal `false` for default. |
| `order_sort` | string \| `false` | Y | `asc` / `desc`, or literal `false`. |

Response schema (`status: "ok"`, `exec_time: float` seconds):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | **0 on the data request** — the count is computed by the separate C3 call (see below). |
| `data.totalRows` | int | **0 on the data request** (same reason). |
| `data.currentPage` | string | Echoed page index, e.g. `"1"`. |
| `data.row` | array[≤`numrows`] | Roster rows; per-row schema in the table below. |
| `data.custom` | bool | `false`; server flag for custom-column mode. |
| `data.query_time` | float | Row-query seconds. |
| `data.count_time` | int | `0` on the data request. |
| `status` | string | `"ok"`. |
| `exec_time` | float | Total handler seconds. |

Per-row object (`data.row[]`) — **captured field → type → meaning**:

| Field | Captured type | Meaning / notes |
|---|---|---|
| `steam_id` | `str(len36)` | **Player UUID (36-char, dashed), NOT a Steam64 anymore.** Row key; passed to `player.open()`. See §8. |
| `group_id` | `str(len1)` | Raw group enum `"1".."5"` (see §2). Feeds the filter/modal preselect. |
| `expire` | `str` | Group/VIP expiry as unix s; `""` or `"0"` = no expiry (infinity). Captured `""`. |
| `description` | `str` | Free-text comment stored on the group assignment. |
| `prefix` | `str` | In-game tag granted by the group (may be empty). |
| `prefix_rgb` | `str` | Prefix color `"r,g,b"` (may be empty). |
| `image` | `str` | Group image URL (may be empty). |
| `name` | `str(len51)` | Player display nick (DB alias `t2.player`). |
| `date` | `str(len10)` | **Last-seen — unix s** (captured `"1783151718"`). Rendered client-side. |
| `color` | `str(len6)` | Group tag color, **hex without `#`** (captured `"e50606"`). |
| `icon` | `str(len13)` | FontAwesome suffix, **no `fa-` prefix** (captured `"user-circle-o"`). |
| `discord` | `str` | Pre-rendered HTML: linked Discord handle, or empty. |
| `bans` | `str` | Pre-rendered HTML KPI — punishments **issued** by this admin in the period (captured `"<kbd>17</kbd>"`). |
| `online` | object | Live-presence sub-block (see below); present even when the badge shows offline. |
| `online.online` | `str` | Live/session numeric (captured `"18030"`). |
| `online.boost` | `str` | Live boost numeric (captured `"10156"`). |
| `online.queue` | `str` | Queue position (captured `"6"`). |
| `online.server` | `str` | Server id the player is on (captured `"1"`). |
| `group` | `str(len123)` | **Pre-rendered** `<span class="label …" style="…color…">` group chip (icon + label). |
| `time` | `str(len49)` | **Pre-rendered** playtime-for-period badge (captured `"<span class=\"label label-success\">300ч 3…"`). |
| `boost` | `str(len49)` | **Pre-rendered** boost-for-period badge. |

Redacted sample row (from capture):

```json
{
  "steam_id": "<uuid:36>", "group_id": "1", "expire": "", "description": "<redacted:13>",
  "prefix": "", "prefix_rgb": "", "image": "", "name": "<redacted:51>",
  "date": "1783151718", "color": "e50606", "icon": "user-circle-o",
  "discord": "<redacted:73>", "bans": "<kbd>17</kbd>",
  "online": { "online": "18030", "boost": "10156", "queue": "6", "server": "1" },
  "group": "<span class=\"label label-primary\" style=…>…</span>",
  "time":  "<span class=\"label label-success\">300ч 3…</span>",
  "boost": "<span class=\"label label-success\">169ч 1…</span>"
}
```

#### C3 — Roster count (pagination companion call)

| | |
|---|---|
| **Method / path** | `POST /ajax/table.php` |
| **Status / ctype** | `200` · `application/json; charset=utf-8` |
| **Capture** | `caps/admins/admins.network.json` entry 2 |

Same body as C2 **plus `pagination=true`**. The panel fires C2 (rows) and C3 (count) as two requests against the same table id — the count is *not* returned inline on the data call.

Response schema (captured sample in parentheses):

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Page count (`2`). |
| `totalRows` | string | Total matching rows (`"53"`) — the true roster size. |
| `count_time` | int | Count-query time. |
| `status` | string | `"ok"`. |
| `exec_time` | float | Handler seconds. |

#### C4 — Open player (referenced, fires on row click)

`POST /ajax/player.php` with `action=get&steam_id=<uuid>` → returns the full `player.info` object incl. the permission flags in §3.3. Not auto-fired during capture (requires a row click, which we did not perform as it is a read but out of `--open-rows` scope for AJAX); documented from `custom.js` (`player.open`/`player.get`).

#### C5 — Change group (the permission mutation — NOT fired; interceptor would abort)

`POST /ajax/player.php` with `action=changeGroup` — full contract in §4.1. Documented from `custom.js`; **not executed** (mutation). `_blocked.json` = `[]` confirms no write was attempted.

---

### 1. Purpose & Nav Location

- **Loader:** `pageLoad('admins')` → `GET /ajax/page.php?page=admins` (C1), HTML fragment injected into `#content`.
- **Purpose:** Manage the **staff roster** — everyone holding an admin/moderator/camera/trainee group — with per-admin **activity KPIs** over a selectable period (playtime, boost, **punishments issued**, Discord link). Clicking a row opens the shared player modal, whose **"Группа" (Group)** button is the single UI for assigning/changing/revoking a group — i.e. this is where permissions are granted.
- This is a filtered view of the player base restricted to rows that have a `group_id`. There is **no create-group UI** in this fragment — groups are a **fixed, hard-coded 5-value set** (see §2). Custom-group CRUD lives on the **settings → groups** tab (chapter 16), not here; this page only *assigns* an existing group to a player.

---

### 2. The Group / Role Model (core answer)

The complete enum comes from the group-change select `#player_group-groups` (`admins.content.html:686–692`), which includes the "none" sentinel and the VIP entry that the roster filter omits. Internal `name` values are reconciled against chapter 16's `groups` settings tab (the five `[data-setting]` blocks: **Admin, Moderator, QueuePriority, Cameraman, Intern**).

| `group_id` | Russian label | English gloss | Icon (`icon` field) | Color (`color` field) | Internal `name` (ch.16) | In roster filter? |
|---|---|---|---|---|---|---|
| `0` | -Нет группы- | No group / **remove** | — | — | *(clears group)* | No |
| `1` | Администратор | Administrator | `user-circle-o` | `e50606` (red) | `Admin` | Yes |
| `2` | Модератор | Moderator | `id-badge` | `2df044` (green) | `Moderator` | Yes |
| `3` | VIP | VIP | `star` | *(per-record)* | `QueuePriority` | **No** |
| `4` | Камера | Camera / Spectator | `video-camera` | `7d059e` (purple) | `Cameraman` | Yes |
| `5` | Стажёр | Trainee / Intern | `graduation-cap` | `b57c03` (orange) | `Intern` | Yes |

> Reconciliation with chapter 16: each `group_id` here maps 1:1 to a settings-tab group whose **capability set is the 21 Squad permission tokens** (`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`). The admins page assigns the *membership*; chapter 16 defines what each membership *can do*. `changemap`/`kick`/`ban` performed in-game are flagged **"Не будет логироваться в панели"** (won't be audit-logged) in that tab.

Structural findings:

- **Fixed enum, not free-form roles.** Six values (0 + five groups); one group per player, no stacking. Granularity is coarse — the capability matrix lives in settings, not per-assignment.
- **VIP (id 3) is a group row but not an admin role.** Internal name `QueuePriority` (queue-priority perk); deliberately excluded from the roster filter (which lists 1/2/4/5). The *same* change-group modal grants VIP by assigning `group_id=3` with an expiry — hence the hidden **"VIP +1 месяц" (VIP +1 month)** button (`#player_group-btn.hide`, `admins.content.html:728`).
- **A group assignment carries cosmetic/identity payload**, not just a tier: `{group_id, expire, description, prefix, prefix_rgb, image}` scoped to a player (see the captured per-row fields and §3.2).
- **Special-cased modal visuals by internal name** (`custom.js` ~1149–1152): header background → `/assets/img/vip.jpg` when `group.name == 'QueuePriority'`, → `/assets/img/moderator.jpg` when `== 'Moderator'`; all others render generically from `color` + `icon`.
- **Scope is GLOBAL, not per-server.** The `changeGroup` payload (§4.1) contains **no `server_id`** (contrast squad actions, which always send it). Group membership is panel-wide.

---

### 3. Entities & Fields

#### 3.1 Admin roster row

Table headers are the live `#adminPlayers thead` (`admins.content.html`), each with its `data-sort` alias; field semantics from the C2 per-row schema.

| Column header (RU / gloss) | `data-sort` | Backing field(s) | Meaning | Type |
|---|---|---|---|---|
| SteamID | `steam_id` | `steam_id` | Player **UUID** (36-char); row key. | string(36) |
| Ник (Nick) | `name` | `name` (alias `t2.player`) | Display nick. | string |
| Группа (Group) | `group` | `group` (HTML), `group_id`+`color`+`icon` (raw) | Assigned group chip. | enum + rendered HTML |
| Заходил (Last seen) | `date` | `date` | Last-seen **unix s**. | int-as-string |
| `fa-clock-o` — "Наигранное время за период" (Playtime for period) | *(unsortable)* | `time` (HTML), `online.online` (raw) | Hours played in the selected period. | rendered badge |
| `fa-angle-double-up` — "Буст за период" (Boost for period) | *(unsortable)* | `boost` (HTML), `online.boost` (raw) | Boost/activity in the period. | rendered badge |
| `fa-gavel` — "Выданные наказания за период" (Punishments issued) | `bans` | `bans` (HTML `<kbd>N</kbd>`) | **Count of punishments this admin issued** in the period — accountability KPI. | rendered count |
| `fa-brands fa-discord` — "Discord" | *(unsortable)* | `discord` (HTML) | Linked Discord handle / link. | rendered link |

The roster deliberately surfaces **admin-accountability metrics** (playtime, boost, punishments issued) over a date range — a staff-activity dashboard, not just a list.

#### 3.2 Group-assignment record (written by `changeGroup`)

From `#player_group` (`admins.content.html:678–735`) and the `player.group.set` payload (`custom.js` ~2240–2249). Each field with its `#id`, input type, and limit:

| Payload key | `#id` | Input type | maxlength | Meaning / validation |
|---|---|---|---|---|
| `steam_id` | *(from `player.info.steam_id`)* | — | — | Target player UUID. |
| `group_id` | `#player_group-groups` | `<select>` (multiselect single) | — | Group `0..5`; `0` clears. Preselected to `player.info.group_id`. |
| `date` | `#player_group-expire` | `daterange` (`.data('start')`) | — | Expiry unix s; `0` = infinity. Presets in §5.3. |
| `description` | `#player_group-description` | `<textarea>` | **128** | Free-text comment. |
| `prefix` | `#player_group-prefix` | `text` | **64** | In-game tag granted. |
| `prefix_rgb` | `#player_group-prefix_rgb` | `text` | **16** | `"r,g,b"`; two-way-synced with `#player_group-prefix_rgb-color` (`<input type="color">`) via `stringRgbToHex`/`hexToRgb`; clears on parse failure. |
| `image` | `#player_group-image` | `text` (URL) | **256** | Group image URL. |

#### 3.3 Client-side permission flags (`player.info.*`, returned by C4)

Booleans on `player.get`; the modal shows/hides controls accordingly (§6). These are the effective permission model as the client sees it:

| Flag | Gates |
|---|---|
| `canChangeGroup` | Whether the **Группа (Group)** button renders → whether this operator may assign groups at all. |
| `canBan` | Ban flow + name-ban + kits + (online) kill; also **hides the Group button when false**. |
| `canUnban` | Whether an existing ban shows an "unban" control. |
| `canSelfKick` | Whether "kick without reason" appears. |
| `is_you` | If target == operator, the group select **and** expiry are `disable`d — you cannot change your own group. |

---

### 4. Actions Available Here

Mutations go through `Action({script, action, data})` → `POST /ajax/<script>.php` with `action=<action>&<data…>`.

#### 4.1 The permission action (unique/central to this page) — exact contract

Transcribed verbatim from `player.group.set` (`custom.js` ~2233–2250). **NOT executed during capture** (`_blocked.json` = `[]`).

```js
Action({
  script: 'player',
  action: 'changeGroup',
  data: {
    steam_id:   player.info.steam_id,                 // UUID string
    date:       $('#player_group-expire').data('start'), // unix s | 0 (=infinity)
    group_id:   $('#player_group-groups').val(),       // "0".."5"
    description:$('#player_group-description').val(),   // ≤128
    prefix:     $('#player_group-prefix').val(),        // ≤64
    prefix_rgb: $('#player_group-prefix_rgb').val(),    // "r,g,b", ≤16
    image:      $('#player_group-image').val()          // URL, ≤256
  }
})
```

| Endpoint | `POST /ajax/player.php` (body `action=changeGroup&…`) |
|---|---|
| **data keys** | `steam_id` (string, req), `date` (unix s \| `0`, req), `group_id` (`"0".."5"`, req), `description` (string), `prefix` (string), `prefix_rgb` (string), `image` (string) |
| **No `server_id`** | Confirms global scope. |
| **Effect** | Assigns / changes / (`group_id=0`) **revokes** a player's group; also grants/extends VIP (`group_id=3`). |
| **Confirm** | `$.question` "Сменить группу?" renders the chosen group `<option>` label as an `<h2>`; progress text "Меняем" (Changing). |
| **On success** | Re-opens the player modal via `player.open(player.info.steam_id)`. |
| **Destructive?** | **Y** — grants/revokes privileges. This single call *is* the RBAC lifecycle. |

There is **no separate `promote`/`demote`/`addAdmin`/`removeAdmin`** action. Add = assign a group; promote/demote = `changeGroup` to a different `group_id`; remove = `changeGroup` with `group_id:0`; VIP issue/extend = `group_id:3` + expiry.

#### 4.2 Reads that populate this page

| Purpose | Contract | Notes |
|---|---|---|
| Roster rows | **C2** `POST /ajax/table.php` `action=adminPlayers` | 50/page, server-side. |
| Roster count | **C3** same + `pagination=true` | Returns `totalRows`/`totalPage`. |
| Open a player | **C4** `POST /ajax/player.php` `action=get&steam_id=<uuid>` | Row click; loads `player.info` + flags. |

#### 4.3 Shared player-modal actions (embedded — NOT unique to admins page)

These ~22 actions ship on every page's embedded modal. `script:'squad'` actions require the player online and always carry `server_id` (per-server); `script:'player'` actions are global.

| action | script | Per-server (`server_id`)? | Effect | Destructive? |
|---|---|---|---|---|
| `ban` | squad | Y | Ban (`reason_id, description, days`) | Y |
| `unban` | squad | — | Lift ban | Y |
| `kick` | squad | Y | Kick | Y |
| `removePlayer` | squad | Y | Remove from squad | Y |
| `changeTeam` | squad | Y | Switch team | Y |
| `kill` | squad | Y | Kill in-game | Y |
| `addBanName` / `removeBanName` | player | — | Ban/unban a nickname | Y |
| `kits` / `kitSave` | player | — | View/save kits | Y (save) |
| `mark` | player | — | Set/clear cheat-suspicion tag | Y |
| `message` | player | — | In-game message (canned templates) | Y |
| `addComment` / `getComments` | player | — | Admin notes | Y (add) |
| `twink` / `twinkOnline` / `findFriends` | player | — | Alt-account detection | N |
| `checkBans` | player | — | Cross-check bans | N |
| `getPlayerOnlineData` | player | — | Online activity data | N |
| `downloadStat` | player | — | Export stats (form POST) | N |

---

### 5. Forms, Filters & Modals

#### 5.1 Roster filter sidebar (page's own) — live ids

Fixed card (`.block-box`, `position:fixed`), `admins.content.html:1–24`:

| Control | `#id` | Type / `data-search` | Options / default |
|---|---|---|---|
| Поиск (Search) | `#adminPlayers-btn` | button → `buildTable()` | — |
| Ник или SteamID | `#adminPlayers-name` | `text`, `data-search="t2.player"` | placeholder "Ник или SteamID" |
| Group multiselect | `#adminPlayers-group` | `multiselect multiple`, `data-search="group_id"` | options **1/2/4/5 only** (VIP excluded), HTML labels with colored `fa` icons; placeholder "- Группа -" |
| Period picker | `#adminPlayers-period` | `daterange`, `data-search="custom.period"` | button label **"30 дней"**; emits `custom.period.startdate/enddate` (unix s) into `search.text`. Default range = last 30 days. |

#### 5.2 Roster table

`#adminPlayers` (`class="table table-hover"`), `numrows:50`. **Sortable columns** (have `data-sort`): `steam_id`, `name`, `group`, `date`, `bans`. **Not sortable**: playtime, boost, discord. Row click → `player.open(steam_id)`.

#### 5.3 Group-change modal (`#player_group`, `class="hide"`)

Reached via the **Группа** button, which `player.modal.flip({direction:'lr', content:$('#player_group').html()})` (`custom.js` ~2155). On flip end:

- `#player_group-groups` multiselect built (`enableHTML:true`), preselected to `player.info.group_id`, rebuilt.
- `#player_group-expire` daterange presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. **Default:** `{type:'infinity'}` if `group_id && expire=='0'`, else `{type:'justDay', start: moment.unix(expire || now)}`.
- **Self-protection:** if `player.info.is_you`, `#player_group-groups` `multiselect('disable')` and `#player_group-expire` `prop('disabled', true)`.
- `#player_group-prefix_rgb` two-way-syncs with the color swatch; parse failure clears the text field.
- Buttons: **Игрок (Player)** = `player.unflip()` (flip back); **VIP +1 месяц** (`#player_group-btn.hide`); **Сменить группу (Change group)** (`#player_group-btn`). Both action buttons call `player.group.set(this)`.

---

### 6. Permission / Visibility Logic

Client-gated by the server-provided booleans on `player.info` (§3.3); server presumably re-enforces:

- `#player_group` is permanently `class="hide"` in markup, revealed only by the flip.
- **Group button** shown only if `canChangeGroup`; additionally hidden entirely when `!canBan`.
- Ban/name-ban/kits gated on `canBan`; unban on `canUnban`; kill/kick-no-reason on `canBan`/`canSelfKick` and require `online`.
- Self-protection: `is_you` disables changing your own group/expiry.
- `group_id=0` ("-Нет группы-") is the removal sentinel; it is the only non-icon option.

Implication for a competitor: permissions are **coarse and centralized** on this page — a single `canChangeGroup` flag decides who can grant *any* group up to Administrator. There is no "can grant X but not Y", no per-server admin scoping, and no delegated/tiered promotion rules in the client. (The per-token capability matrix exists — but in settings, §2/ch.16 — not per assignment.)

---

### 7. Notable UX & Competitively Interesting Details

- **Unified "group" abstraction covers staff roles AND paid VIP** via one enum/modal/`changeGroup` action — simple to build, but conflates access-control with monetization. A competitor could split "roles/permissions" from "subscriptions/perks" cleanly.
- **Staff-accountability KPIs in the roster** (playtime, boost, **punishments issued** per admin over a date range) turn the admin list into a moderation-activity dashboard — worth copying/beating (add report-resolution time, ban-overturn rate).
- **Cosmetic identity per assignment** (prefix + RGB + image + comment); the color picker two-way-syncs hex↔`r,g,b`.
- **Expiry on membership incl. infinity** — the same mechanism auto-expires trainee/camera access *and* VIP subscriptions.
- **Weaknesses to beat:** (1) fixed 5-value enum, no custom groups on this page; (2) capability granularity is one group per player + a global settings-level token matrix — no per-assignment scoping; (3) group scope is global, no per-server admin assignment; (4) no stacking; (5) promote/demote/remove collapse into one opaque `changeGroup` with no dedicated audit action (only the manual `description`).

---

### 8. Capture-Derived Findings (new vs. prior static analysis)

1. **Identity is now a UUID, not Steam64.** The live `steam_id` field is `str(len36)` (dashed UUID). Every `steam_id` on this page — row key, `changeGroup.steam_id`, `player.open()` arg — is a UUID string. Any reimplementation/interop must treat the identity column as an opaque UUID, mapping to Steam64 only where the game protocol requires it. (Mirrors this repo's own `steam_id64 → UUID` primary-key migration.)
2. **Two-request pagination.** The data call (C2) returns `totalPage:0 / totalRows:0`; the true count comes from a **separate** `pagination=true` call (C3, `totalRows:"53"`). A client that reads paging off C2 alone will see zero.
3. **Server-side HTML in JSON.** `group`, `time`, `boost`, `bans`, `discord` arrive **pre-rendered as HTML strings**, while `group_id`/`color`/`icon`/`date` arrive raw. The roster is not a clean data API — it mixes presentation and data, so a machine consumer must parse HTML out of some cells. Cleaner separation is an easy win.
4. **`live_contracts_captured = 3`, `blocked_mutations = 0`** — the page auto-loads only reads (fragment + rows + count); no mutation fires on load, and the interceptor blocked nothing.
5. **`color` has no `#`, `icon` has no `fa-` prefix** — the client adds both when rendering; matters for anyone re-styling the chips.
6. **Modal detail-log tables** (`admins.modaltabs.json`): `admin`, `date`, `text` — the per-player activity sub-tables inside the shared modal.
