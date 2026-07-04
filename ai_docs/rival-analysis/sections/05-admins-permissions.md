## 05. Administration: Admins, Groups & Permissions

Reference documentation of the SQSTAT "admins" page (breaking.sqstat.ru) — the staff roster and the group/role model that drives every permission in the panel. Source analyzed: `frags/admins.html` (the page fragment, which also embeds the shared player-detail modal and its JS), cross-checked against `action_catalog.txt`.

> Scope note: `frags/admins.html` contains two distinct things. (1) The page's **own** UI — a filter sidebar plus the `#adminPlayers` roster table (lines ~1–95). (2) The **shared player-detail modal** (`#playerModal`) and its `player.*` JavaScript object (lines ~98–2818), which is injected into every page fragment in the app. This document treats the roster + filter as the page's own surface, and the group-change modal as the permission-management surface, and explicitly flags shared-modal actions that are not unique to this page.

---

### 1. Purpose & Nav Location

- **Nav id / loader:** `pageLoad('admins')` → `GET /ajax/page.php?page=admins`, HTML fragment injected into `#content`.
- **Purpose:** Manage the **staff roster** — everyone who holds an admin/moderator/camera/trainee group. Shows activity metrics per admin over a selectable period (playtime, boost, punishments issued, Discord link). Clicking a row opens the shared player modal, whose **"Группа" (Group)** button is the single UI for assigning/changing/revoking a group — i.e. this is where permissions are granted.
- This page is a filtered view of the player base restricted to rows that have a `group_id`. There is no separate "create group" UI in this fragment — groups are a **fixed, hard-coded set** (see §2); the panel does not expose custom-group CRUD to the operator here.

---

### 2. The Group / Role Model (core answer)

Groups are defined inline in three `<select>` widgets. The **authoritative, complete list** comes from the group-change modal (`#player_group-groups`, lines 686–693), which includes the "none" and VIP entries that the roster filter omits.

| group_id | Russian label | English gloss | Icon (FontAwesome) | Color | Internal `name` (from JS) | In roster filter? |
|---|---|---|---|---|---|---|
| `0` | -Нет группы- | No group / remove | — | — | (clears group) | No |
| `1` | Администратор | Administrator | `fa-user-circle-o` | `#e50606` (red) | *(Admin)* | Yes |
| `2` | Модератор | Moderator | `fa-id-badge` | `#2df044` (green) | `Moderator` | Yes |
| `3` | VIP | VIP | `fa-star` | *(per-record)* | `QueuePriority` | **No** |
| `4` | Камера | Camera / Spectator | `fa-video-camera` | `#7d059e` (purple) | *(Camera)* | Yes |
| `5` | Стажёр | Trainee / Intern | `fa-graduation-cap` | `#b57c03` (orange) | *(Trainee)* | Yes |

Key structural findings about the model:

- **Fixed enum, not free-form roles.** There are exactly six values (0 + five groups). No API/UI for defining new groups or editing a group's capability set is present in this fragment. "Roles" in this panel = these fixed groups; permission granularity is coarse (one group per player).
- **VIP (id 3) is a group in the same table but is NOT an admin role.** Its internal `name` is `QueuePriority` (queue-priority perk), and it is deliberately excluded from the roster's group filter (which only lists 1, 2, 4, 5). The same "change group" modal is reused to grant VIP — assigning group 3 with an expiry date is how a VIP subscription is issued. This is why the group modal doubles as a VIP-management tool (note the hidden **"VIP +1 месяц" (VIP +1 month)** button at line 729).
- **Group carries cosmetic/identity payload, not just a permission tier.** Each assignment stores a free-text `description`, a `prefix` (in-game tag, ≤64 chars), a `prefix_rgb` color, and an `image` URL (≤256 chars). So a "group" record is `{group_id, expire, description, prefix, prefix_rgb, image}` scoped to a player.
- **Special-cased visuals by internal name:** the modal header swaps a background image when `group.name == 'QueuePriority'` → `/assets/img/vip.jpg`, or `== 'Moderator'` → `/assets/img/moderator.jpg` (lines 1149–1152). Only these two names are branch-checked in client code; the rest render generically from `group.color` + `group.icon`.
- **Scope appears GLOBAL, not per-server.** The `changeGroup` payload contains **no `server_id`** (contrast with squad/ban actions which always send `server_id`). Group membership is panel-wide across all servers. Per-server scoping is not modeled here.

---

### 3. Entities & Fields

#### 3.1 Admin roster row (entity: player-with-group)
Inferred from the `#adminPlayers` table columns and the `buildTable` `collum` array `["steam_id","name","group","date","time","boost","bans","discord"]`.

| Field | Column header | Meaning | Type |
|---|---|---|---|
| `steam_id` | SteamID | Steam64 ID; row key. Rendered inside `<hashtag>` in cell `td[data-contact="steam_id"]`. Click uses it to open modal. | string (17-digit) |
| `name` | Ник (Nick) | Player display name (search maps to DB col `t2.player`). | string |
| `group` | Группа (Group) | The assigned group (rendered as colored label + icon; DB search col `group_id`). | enum (see §2) |
| `date` | Заходил (Last seen / logged in) | Last-seen timestamp. | datetime |
| `time` | `fa-clock-o` (tooltip: "Наигранное время за период" / Playtime for the period) | Hours played within the selected period. | duration |
| `boost` | `fa-angle-double-up` (tooltip: "Буст за период" / Boost for the period) | Boost/activity metric for the period. | number |
| `bans` | `fa-gavel` (tooltip: "Выданные наказания за период" / Punishments issued for the period) | Count of punishments this admin **issued** in the period — an accountability/activity KPI. | number |
| `discord` | `fa-brands fa-discord` (tooltip "Discord") | Whether the admin has a linked Discord (and link). | bool / link |

Note: the roster deliberately surfaces **admin accountability metrics** (playtime, boost, punishments issued) over a date range — this is a staff-activity dashboard, not just a list.

#### 3.2 Group-assignment record (entity written by `changeGroup`)
From the `#player_group` form (lines 679–735) and the `player.group.set` payload (lines 2242–2249).

| Field | Input id | Meaning | Type / limit |
|---|---|---|---|
| `steam_id` | (from `player.info`) | Target player. | string |
| `group_id` | `#player_group-groups` | Group to assign; `0` clears it. | enum 0–5 |
| `date` | `#player_group-expire` (`.data('start')`) | Expiry of the group/VIP (a daterange). `expire=='0'` = infinity. | unix ts / 0 |
| `description` | `#player_group-description` | Free-text comment on the assignment. | textarea, ≤128 |
| `prefix` | `#player_group-prefix` | In-game name prefix/tag granted. | text, ≤64 |
| `prefix_rgb` | `#player_group-prefix_rgb` | RGB color of the prefix (`r,g,b`), paired with a `<input type="color">` swatch that syncs hex↔rgb. | text, ≤16 |
| `image` | `#player_group-image` | URL to an image/avatar tied to the group. | text (URL), ≤256 |

#### 3.3 Client-side permission flags (entity: `player.info.*`)
The server returns these booleans on `player.get`; the modal shows/hides controls accordingly (see §6). They ARE the effective permission model as the client sees it:

| Flag | Gates |
|---|---|
| `canChangeGroup` | Whether the **Группа (Group)** button is shown → whether this operator may assign groups at all. |
| `canBan` | Ban flow + name-ban + kits + (online) kill; also hides Group button when false. |
| `canUnban` | Whether the "unban" control appears on an existing ban. |
| `canSelfKick` | Whether "kick without reason" appears. |
| `is_you` | If the target is the operator themselves, the group multiselect and expiry are **disabled** — you cannot change your own group. |

---

### 4. Actions Available Here

Mutations go through the JS helper `Action({script, action, data})` → `POST /ajax/<script>.php` with `action=<action>&<data…>`.

#### 4.1 The permission action (unique/central to this page)

| UI label | action id | script → endpoint | data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Сменить группу (Change group) / VIP +1 месяц | `changeGroup` | `player` → `/ajax/player.php` | `steam_id, date, group_id, description, prefix, prefix_rgb, image` | Assigns / changes / (group_id=0) **revokes** a player's group. Also the mechanism to grant/extend VIP. Confirmation dialog "Сменить группу?" shows the selected group label before commit. On success re-opens the player modal. | **Y** — grants/revokes privileges |

There is **no separate `demote`/`promote`/`add-admin`/`remove-admin` action** — the entire lifecycle (add, promote, demote, expire, remove) is expressed as a single `changeGroup` call with a different `group_id` (and `0` = remove). Demotion = `changeGroup` to a lower group; removal = `changeGroup` with `group_id:0`.

#### 4.2 Read action that populates this page

| Purpose | action | script | data | Notes |
|---|---|---|---|---|
| Roster rows | (DataTables server-side) | `table` → `/ajax/table.php` | `table:'adminPlayers'`, `collum[]`, `order[]`, `numrows:50`, plus the search inputs | Server-side paginated table; 50 rows/page. |
| Open a player | `get` | `player` → `/ajax/player.php` | `steam_id` | Fires on row click; loads full player + permission flags. |

#### 4.3 Shared player-modal actions (present because the modal is embedded — NOT unique to admins page)
These ~22 actions appear on every page's embedded modal. Listed for completeness; do not attribute them to the admins page specifically. `script:'squad'` actions require the player to be online and always carry `server_id` (i.e. these ARE per-server). `script:'player'` actions are global.

| action | script | Per-server? (sends `server_id`) | Effect | Destructive? |
|---|---|---|---|---|
| `ban` | squad | Y | Ban player (`reason_id`, `description`, `days`) | Y |
| `unban` | squad | — | Lift ban | Y |
| `kick` | squad | Y | Kick from squad/server | Y |
| `removePlayer` | squad | Y | Remove from squad | Y |
| `changeTeam` | squad | Y | Switch team | Y |
| `kill` | squad | Y | Kill in-game | Y |
| `addBanName` / `removeBanName` | player | — | Ban/unban a nickname | Y |
| `kits` / `kitSave` | player | — | View/save kits | Y (save) |
| `mark` | player | — | Set/clear cheat-suspicion tag (8 mark types + clear) | Y |
| `message` | player | — | Send in-game message (canned templates provided) | Y |
| `addComment` / `getComments` | player | — | Admin notes on player | Y (add) |
| `twink` / `twinkOnline` / `findFriends` | player | — | Alt-account (twink) detection | N (read) |
| `checkBans` | player | — | Cross-check bans | N |
| `getPlayerOnlineData` | player | — | Online activity data | N |
| `downloadStat` | player | — | `post_to_url('/ajax/player.php', {action:'downloadStat'})` — export stats (form POST, not AJAX) | N |
| `vipPlayer` (via changeGroup id=3) | player | — | Grant VIP (implemented through `changeGroup`) | Y |

---

### 5. Forms, Filters & Modals

#### 5.1 Roster filter sidebar (page's own)
Fixed-position card (`position:fixed`) with:
- **Поиск (Search) button** `#adminPlayers-btn` — triggers `buildTable()`.
- **Ник или SteamID** text input `#adminPlayers-name` (`data-search="t2.player"`).
- **Group multiselect** `#adminPlayers-group` (`data-search="group_id"`, `type="multiselect" multiple`) — options 1/2/4/5 only (VIP excluded); placeholder "- Группа -", HTML-enabled labels with colored icons.
- **Period picker** `#adminPlayers-period` (`type="daterange"`, `data-search="custom.period"`) — presets: justMonth/justDay/justWeek/justYear/range/today/yesterday/currentWeek/lastWeek/currentMonth/lastMonth/**last30days (default)**. Changing it rebuilds the table. Also hidden start/end datetime pickers (`ru` locale).

#### 5.2 Roster table
`#adminPlayers`, `numrows:50`, sortable columns limited by `order` to: steam_id, name, group, date, bans. Row click → `player.open(steamId)`.

#### 5.3 Group-change modal (`#player_group`, initially `class="hide"`)
Reached via the **Группа** button in the player modal, which "flips" the panel to the group form. Fields per §3.2, plus:
- Expiry daterange presets: justDay / +1/+2/+3/+6 months / +1 year / **infinity** / reset. Default = infinity if already grouped with `expire=='0'`, else the current expiry.
- **Validation / guards:** if `is_you`, the group select and expiry are disabled (cannot self-edit). `prefix_rgb` input validates via `stringRgbToHex`/`hexToRgb`, clearing on parse failure, and stays two-way synced with the color swatch.
- Buttons: **Игрок (Player)** = flip back; **VIP +1 месяц** (hidden by default, `class="hide"`); **Сменить группу (Change group)**. Both action buttons call `player.group.set(this)`.
- Confirmation: `$.question` dialog titled "Сменить группу?" renders the chosen group's label as an `<h2>`; on confirm shows "Меняем" (Changing) progress text.

---

### 6. Permission / Visibility Logic

The panel is **client-gated by server-provided boolean flags** on `player.info` (server presumably enforces server-side too, but the UI logic is explicit):

- `#player_group` form is permanently `class="hide"` in markup and only revealed by the flip interaction.
- **Group button** (`#player_info-group_btn`, "Группа") is shown only if `player.info.canChangeGroup` (line 1130–1133); additionally hidden entirely when `!canBan` (line 1120).
- Ban/name-ban/kits controls gated on `canBan`; unban on `canUnban`; kill/kick-no-reason on `canBan`/`canSelfKick` and require the player to be `online`.
- Self-protection: `is_you` disables changing your own group/expiry.
- Group id `0` is the removal sentinel; the label "-Нет группы-" is the only non-icon option.

Implication for a competitor: permissions are **coarse and centralized** — a single `canChangeGroup` flag decides who can grant any group up to Administrator. There is no notion of "can grant group X but not Y", no per-server admin scoping, and no delegated/tiered promotion rules in the client. That is a weakness worth beating.

---

### 7. Notable UX & Competitively Interesting Details

- **Unified "group" abstraction covers both staff roles AND paid VIP** via one table/modal/`changeGroup` action. Simple to build, but conflates access-control with monetization — a competitor could separate "roles/permissions" from "subscriptions/perks" cleanly.
- **Staff-accountability KPIs baked into the roster** (playtime, boost, and *punishments issued* per admin over a date range). This turns the admin list into a moderation-activity dashboard — a strong feature worth copying/beating (e.g. add report-resolution time, ban-overturn rate).
- **Cosmetic identity per assignment** (prefix + RGB color + image + comment) tied to the group grant — nice touch; the color picker two-way-syncs hex and `r,g,b`.
- **Expiry on group membership** (including infinity) — groups can auto-expire, which elegantly handles temporary trainee/camera access and VIP subscriptions with the same mechanism.
- **Weaknesses to beat:** (1) fixed 6-value enum, no custom groups; (2) no fine-grained capability matrix — capabilities are implied by group id and hard-coded client checks (`QueuePriority`, `Moderator`); (3) group scope is global, no per-server admin assignment; (4) one group per player (no stacking); (5) promotion/demotion/removal all collapse into one opaque `changeGroup` call with no audit action of its own (though `description` gives a manual note).
