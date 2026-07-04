## 18. Clan Management

### 1. Purpose & Navigation

The Clan Management page is the detail/administration view for a single clan (internally also called a **squad** — see note below). It combines a clan "dashboard" (online chart, aggregate stats, top players, recent games) with a **roster manager** (add/remove members, assign roles, grant queue priority/VIP) and clan-level settings (tag protection, public visibility, expiry, tags).

- **Page id / nav:** `clan&id=N` — opened via `pageLoad('clan&id=<N>')` → `GET /ajax/page.php?page=clan&id=<N>`, returning the fragment analysed here (`clan_16.html`, `id=16`, clan `[MDC]`).
- **Entry points:** Clicking a clan anywhere in the app navigates to `clan&id=N`. A new clan is created from the global "Добавить" (Add) menu item (`home_auth.html`, `onclick="createClan.open()"`), which opens the shared **Create-clan modal** (documented in §5).
- **Terminology note — clan == squad:** The client object is `clan`, but the create/edit path posts to `script:'squad', action:'createSquad'`. "Clan" and "squad" are the same server-side entity; the roster-management actions use `script:'clan'` while creation/edit uses `script:'squad'`.

> The fragment also embeds the shared **player-detail modal** (`#player_info`, tabs Chat/Kills/Deaths/Kits/Games/Comments with ~22 actions such as `ban`, `kick`, `kill`, `kits`, `mark`, `message`, `twink`, `addComment`, `changeExpire`, `transfer`, `vipPlayer`, …). Those belong to the shared modal, **not** to the clan page, and are opened here only indirectly via `player.open(steam_id)` when an admin clicks a roster row. They are documented in the player-profile section and are deliberately excluded from the clan-action table below.

---

### 2. Entities & Fields

#### 2.1 Clan / Squad entity

Inferred from `clan.data` (bootstrapped inline into the fragment) and the create/edit modal payload.

| Field | Type | Meaning |
|---|---|---|
| `id` | int (string) | Clan primary key (`16` here). Used as `clan_id` in every clan action. |
| `name` | string, ≤32 chars | Clan display name (e.g. `[MDC]`). |
| `tags` | string[] | List of in-game name prefixes/clan tags (e.g. `["Mdc |", "MdcK |"]`). Drives tag-protection kicks and player search. |
| `discord_id` | string, ≤64 chars \| null | Discord **role** ID linked to the clan (label "Discord ID роль"). |
| `date` | unix ts (string) | Clan creation timestamp. |
| `expire` | unix ts (string) | Priority/VIP subscription expiry (`2620162800` ≈ 11.01.2053 here). `0` = infinity. |
| `max` | int (string) | Maximum priority (VIP/queue) slots (`999` here). Displayed as "Слотов: X из max". |
| `protected` | 0/1 | "Защита тега" (tag protection) — auto-kicks players wearing the clan's tags who are not on the roster; lists refresh every 10 min. |
| `public` | 0/1 | "Публичная страница" — makes this page viewable (read-only, without priority-queue info) without edit rights. |

Derived/related data returned by `action:'list'` (not stored on the clan row itself):

- `servers` — map of `server_id → [{team, name, playtime:{date,last_seen}}]`: which of the clan's members are currently online on each tracked server.
- `discord` — `[{name, channel}]`: linked Discord voice channels (rendered in the hidden `#discord-block`, shown only if non-empty).
- `access` — boolean: whether the current viewer may manage priority (controls whether the VIP column renders).

#### 2.2 Clan member (roster row)

Inferred from the `text.players[]` objects rendered by `clan.build()`.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (SteamID64) | Member identity; row `data-id`. Links to Steam profile & `/player/<id>` stats. |
| `name` | string | Current in-game nickname. |
| `kit` | string \| null | Last-used kit/role (e.g. `Recruit`, `Rifleman`); row `data-kit`; renders a kit icon. `null` → "неизвестно" (unknown). |
| `discord` | bool | Whether a Discord account is linked (green check / red cross). |
| `date` | unix ts | Last seen ("Заходил"). |
| `online` / `online_raw` | string / number | Naigrannoe (playtime) over the last 60 days; `online_raw` is the sort key. |
| `type` | 0/1/2 | Role: `1` = **Глава** (leader), `2` = **Зам** (deputy), `0`/`''` = ordinary member. |
| `vip_mode` | 0/1/2 | Priority state: `1` = priority ON, `0` = OFF (toggleable), `2` = priority granted from another source (shown as a ban-icon, not toggleable). |
| `access` | bool | Whether the current viewer may **remove** this specific member (renders the delete button). |

#### 2.3 Player search result (add-member modal)

From `action:'findPlayer'` → `text.players[]`:

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | Candidate SteamID64. |
| `name` | string | Nickname. |
| `clan_id` | int \| null | If already in a clan, shows a check and disables the add button. |

#### 2.4 Clan statistics payload

From `action:'stats'` → `text.stats` / `text.chart`:

- `chart.labels[]`, `chart.online[]` — bar-chart series ("Онлайн клана").
- `stats.online`, `stats.boost` (online boost), `stats.server` (primary server), `stats.primetime[]` (`{start,end}` peak windows), `stats.kill`, `stats.die`, `stats.revive` (K/D computed client-side).
- `stats.top[]` — `{steam_id, name, kill, die, revive}` top-10 members (top 5 rendered as a podium with kit art).
- `stats.games[]` — `{id, name, map, cnt, start, end}` recent games the clan participated in.

---

### 3. The Page's Own Table — "Состав клана" (Clan Roster)

Table `#clan-table`. Rows are built client-side from `action:'list'`; there is **no DataTables/`script:'table'` server-side pagination here** — the whole roster is loaded at once and sorted client-side.

| # | Header | Meaning / render |
|---|---|---|
| 1 | Ник (Nick) | Nickname (bold) + kit icon & kit name. Click → opens shared player modal `player.open(steam_id)`. |
| 2 | SteamID | SteamID64 as a `<hashtag>`; buttons: "открыть" (open Steam profile, new tab) and "статистика" (`/player/<id>`). |
| 3 | Discord (icon) | Linked-Discord flag: green check / red cross. |
| 4 | Заходил (Last seen) | Formatted last-seen date. |
| 5 | Clock icon | Playtime over last 60 days. |
| 6 | Роль (Role) | Глава (leader) / Зам (deputy) / blank. |
| 7 | Star icon | Priority-queue (VIP) checkbox — **only rendered when `text.access` is true**. Checkbox toggles `vipPlayer`; `vip_mode==2` renders a non-editable ban icon ("priority from another source"). |
| 8 | Wrench icon | Remove-member button (`clan.player.remove`) — **only rendered per-row when `v.access` is true**. |

**Controls above the table:** "Скачать" (download roster CSV) and "Добавить" (open add-member search modal).

**Sorting:** Every `<th data-sort="true">` is click-sortable client-side (numeric-aware comparer reading each cell's `data-sort`). **No search box or pagination** on the roster itself.

**Live counters:** `#clan-players_count` (total members) and `#clan-vip_count` (checked VIP boxes, recomputed on every toggle).

---

### 4. Actions / Admin Capabilities

All clan-scoped mutations post to `POST /ajax/clan.php` with `action=<id>&<data>` (via `Action({script:'clan', …})`), except **create/edit** which uses `script:'squad'` → `/ajax/squad.php`. Every payload carries `clan_id` (the current clan) unless noted.

| UI label | action id | Script → endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| (roster load) | `list` | clan → `/ajax/clan.php` | `clan_id` | Fetch roster, per-server online, linked Discord. | N (read) |
| (dashboard) | `stats` | clan | `clan_id`, `start`, `end` | Fetch online chart + aggregate stats for date range. | N (read) |
| Найти/Добавить search | `findPlayer` | clan | `clan_id`, `find` | Search players (≥3 chars; by nick, SteamID, or clan tag) to add. | N (read) |
| ➕ Add member | `addPlayer` | clan | `clan_id`, `steam_id`, `type` (0=member, 1=Глава, 2=Зам) | Add player to roster with a role. Role dropdown gated by `clan.canType`. | **Y** |
| 🗑 Remove member | `removePlayer` | clan | `clan_id`, `steam_id` | Remove player from roster (confirm dialog "Удалить игрока из списка клана?"). | **Y** |
| ⭐ Priority checkbox | `vipPlayer` | clan | `clan_id`, `steam_id`, `vip` (bool) | Grant/revoke queue priority (VIP) for a member. Reverts checkbox on error. | **Y** |
| 📅 Change expiry | `changeExpire` | clan | `clan_id`, `date` (unix) | Change clan priority-subscription expiry (daterange button + confirm "Сменить дату?"). Presets: +1/2/3/6 months, +1 year, infinity, reset. | **Y** |
| Public/Tag-protect toggles | `setting` | clan | `clan_id`, `key` (`public`\|`protected`), `value` (bool) | Toggle clan settings (public page / tag protection). | **Y** |
| 🗑 Delete clan | `delete` | clan | `clan_id` | **Disband the clan** (confirm "Удалить клан?", 3s cooldown). On success redirects to `/`. | **Y (irreversible)** |
| Редактировать (Edit) | `createSquad` | squad → `/ajax/squad.php` | `id`, `name`, `expire`, `max`, `discord_id`, `tags` (URL-encoded, comma-joined) | Edit clan (same modal/action as create; non-empty `id` = update). | **Y** |
| (create new clan) | `createSquad` | squad | same as above with empty `id` | Create a new clan; on success `pageLoad('clan&id='+text.id)`. | **Y** |
| Скачать (roster) | `downloadList` | clan (`post_to_url`) | `clan_id` | Download full roster (form-POST file download). | N (export) |
| Скачать статистику | `downloadOnline` | clan (`post_to_url`) | `clan_id`, `start`, `end` | Download online statistics for the chart range. | N (export) |
| (referenced) | `downloadStat` | clan | — | Stat export action id present in the action catalog for this page but not wired to a visible button in the fragment; likely a sibling export handler. | N (export) |

**Notable:** there is **no dedicated "rename" or "transfer ownership" action** — renaming is done through the shared edit modal (`createSquad` with `name`), and "ownership" is expressed via member `type` (Глава/Зам) rather than a distinct transfer call. `changeExpire`/`vipPlayer` action ids are shared with the player modal but here operate at clan scope with `clan_id`.

---

### 5. Forms & Modals

#### 5.1 Create/Edit clan modal (`#createClan_modal`, defined in `home_auth.html`)

Title "Создание клана" (Creation of clan). Reused for both create (`createClan.open()`) and edit (`createClan.edit(clan.data)`, invoked by the page's "Редактировать" button).

| Field | Input | Constraints | Maps to |
|---|---|---|---|
| Название клана (Clan name) | text `#createClan_name` | `maxlength=32` | `name` |
| Окончание приоритета (Priority end) | daterange `#createClan_expire` | presets: justDay, infinity | `expire` (unix `data-start`) |
| Приоритетов (Priority slots) | text `#createClan_max` | `maxlength=3`, placeholder `10` | `max` |
| Discord ID роль (Discord role ID) | text `#createClan_discord_id` | `maxlength=64` | `discord_id` |
| Теги (Tags) | tag-chip builder `#createClan_tags` | add via sub-modal, "очистить" (clear) all | `tags` (chips joined by comma, URL-encoded) |
| `#createClan_id` | hidden | empty = create, set = edit | `id` |

**Tag sub-modal** (`#createClanTags_modal`): single text input `#createClanTag_name` + "Добавить" (Add); each tag renders as a removable success-label chip. `createClan.tags.clear()` wipes all.

Submit ("Сохранить") → `createSquad`; success closes modal and navigates to the (new) clan page.

#### 5.2 Add-member search modal (`#findPlayer`, in the clan fragment)

- Search input `#clan-find_player` (placeholder "Ник или SteamID"), min 3 chars, 300 ms debounce, aborts in-flight request. Help text: can search by partial nick or clan-tag.
- Results table `#clan-find_table` (Ник / SteamID / wrench). Each row: green check if already in a clan; otherwise a ➕ button (`addPlayer` type 0) plus — **when `clan.canType` is true** — a dropdown to add directly as Глава (type 1) or Зам (type 2).

#### 5.3 Change-expiry control

The left sidebar `#clan-expire_date` daterange button opens presets (justDay, +1/+2/+3/+6 months, +1 year, infinity, reset); selecting a date shows a confirm ("Сменить дату?") then fires `changeExpire`.

---

### 6. Permission / Visibility Logic

- **`text.access` (clan-level priority rights):** gates rendering of the entire **VIP/priority column** (header + per-row checkbox). Without it the roster is view-only for priority.
- **`v.access` (per-member):** gates the **remove button** on each row — remove is authorised per member, not globally.
- **`clan.canType`:** gates the ability to assign leader/deputy roles when adding members (role dropdown in search results and the leader/deputy add-menu). When false, members can only be added as ordinary (type 0).
- **`vip_mode==2`:** priority coming "from another source" is shown as a locked ban icon — cannot be toggled off here.
- **`public` setting:** exposes a read-only version of this page to non-editors (explicitly *excluding* queue-priority info).
- **Hidden blocks:** the YooMoney "Продлить приоритет" (extend priority, 1000₽) donation form sits in a `.hide` row; `#discord-block` is hidden unless linked Discord channels exist. A `clan.pay()` stub exists but is empty.

---

### 7. Notable UX & Competitively Interesting Details

- **Clan = paid priority-queue product.** The whole clan concept is monetised: clans have an `expire` date, a `max` number of priority/VIP slots, and an inline **YooMoney payment form** to extend priority. Members get queue priority via per-row toggles counted against the slot limit ("X из 999"). This is the core reason clans exist in SQSTAT — worth understanding before designing our own model.
- **Tag protection (`protected`).** Auto-kicks players wearing the clan's registered tags who are not on the roster, refreshed every ~10 minutes. A strong anti-impersonation feature and a natural upsell.
- **Rich clan dashboard:** aggregate online chart (date-ranged, CSV-exportable), boost, primetime windows, primary server, kills/deaths/revives/KD, a **top-5 podium with kit artwork** (gold/silver/bronze outline styling), top-10 list, and recent games — all per clan. Far beyond a plain member list.
- **Per-server live presence:** the sidebar shows which members are currently online on each tracked server with session playtime — useful for admins spotting active clan stacks.
- **Discord integration:** clan ↔ Discord **role** ID linkage plus display of linked Discord voice channels.
- **Direct role assignment on add:** add-as-leader / add-as-deputy from the search dropdown avoids a second edit step.
- **Client-side roster sorting, no server pagination** — simple and fast for modest rosters but will not scale to very large clans; an area we could beat with proper server-side paging/search.
- **Export everywhere:** roster and online stats are one-click CSV/file exports.
- **Safety UX:** destructive actions (remove member, delete clan, change expiry) all use confirm dialogs; clan delete adds a 3-second cooldown before the confirm button arms.
- **Naming inconsistency to exploit:** the split between `script:'clan'` (roster ops) and `script:'squad'` (`createSquad` for create/edit) suggests an older "squad" model retrofitted as "clan" — a clean unified data model is an easy differentiator.
