## 18. Clan Management

### 1. Purpose & Navigation

The Clan Management page is the detail/administration view for a single clan (internally also called a **squad** — see terminology note). It combines a clan **dashboard** (60-day online bar chart, aggregate combat stats, top-10 podium, recent games), a **roster manager** (add/remove members, assign leader/deputy roles, grant queue priority/VIP), a per-server **live presence** panel, and clan-level **settings** (tag protection, public visibility, expiry, tags, Discord role).

- **Page id / nav:** `clan&id=N`, opened via `pageLoad('clan&id=<N>')` → `GET /ajax/page.php?page=clan&id=<N>`. Returns the HTML fragment analysed here. Live capture: `clan&id=16`, clan `[MDC]`.
- **Entry points:** clicking a clan anywhere in the app navigates to `clan&id=N`. A new clan is created from the global "Добавить" (Add) menu (`onclick="createClan.open()"`), opening the shared **Create-clan modal** (§6). The page's "Редактировать" button calls `clan.edit()` → `createClan.edit(clan.data)`, reusing that same modal.
- **Terminology — clan == squad:** the client object is `clan`, but create/edit posts to `script:'squad', action:'createSquad'` (`/ajax/squad.php`). "Clan" and "squad" are the same server-side entity; roster/settings ops use `script:'clan'` (`/ajax/clan.php`) while creation/edit uses `script:'squad'`.
- **Bootstrap:** the fragment inlines the full clan record as `clan.data` and sets `clan.id`. Captured verbatim (id 16):

  ```json
  {"id":"16","name":"[MDC]","tags":["Mdc |","MdcK |"],"discord_id":null,
   "date":"1746523474","expire":"2620162800","max":"999","protected":"1","public":"1"}
  ```

> The fragment also embeds the shared **player-detail modal** (`#player_info`) with ~22 `script:'player'`/`script:'squad'` actions (`get`, `ban`, `kick`, `kill`, `kits`, `mark`, `message`, `twink`, `addComment`, `changeExpire`, `changeGroup`, `changeTeam`, `getComments`, `getPlayerOnlineData`, `downloadStat`, …). Those belong to the **player profile / in-game squad** subsystems and are opened here only indirectly via `player.open(steam_id)` when an admin clicks a roster row. They are documented in their own sections and are excluded from the clan-action tables below. In particular, the `disband` / `rename` / `transfer` actions seen in `action_catalog.txt` live on the **in-game squad panel** (`main.html`), **not** on `clan.php`; the clan-page equivalents are `delete` (disband a clan), `createSquad` with a non-empty `id` (rename), and member `type` (ownership).

---

### 2. Live API Contracts

Ground truth from headless capture (`caps/clans/clan_id_16.network.json`, 3 contracts, 0 blocked mutations). All AJAX calls are dispatched through `Action({script,action,data})`, which POSTs a URL-encoded body to `/ajax/<script>.php` and expects `application/json`. Reads fire automatically on page load; mutations require a user gesture and were not exercised by the capture.

#### 2.1 `GET /ajax/page.php` — fragment loader

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | string | Y | Literal `clan`. |
| `id` | int | Y | Clan primary key. |

Response: `text/html; charset=UTF-8` (~144 KB), the `#content` fragment (inline `<style>`, markup, `var clan = {…}` bootstrap, and the clan/createClan scripts).

#### 2.2 `POST /ajax/clan.php` — `action=list` (roster + presence + Discord)

Request body (URL-encoded): `clan_id=<int>&action=list`.

Response `application/json`:

| Field | Type | Meaning |
|---|---|---|
| `access` | int (`0`/`1`) | Clan-level priority-management right for the current viewer. `1` → render VIP column + slot counter. |
| `players` | array<Member> | Full roster (captured length 45). No server-side paging. |
| `servers` | object<server_id → array<Presence>> | Per-tracked-server list of members currently online. Keys are server ids (`"1"`,`"6"`,`"7"`,`"9"`,`"10"`,`"11"`); value `[]` when nobody from the clan is on that server. |
| `discord` | array<{name,channel}> | Linked Discord voice channels; `[]` when none. Drives `#discord-block` (shown only if non-empty). |
| `status` | string | `"ok"` on success. |
| `exec_time` | float | Server timing (seconds). |

`Member` object (roster row) — captured schema:

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string, 17 digits (SteamID64) | Member identity; becomes row `data-id`. |
| `name` | string | Current in-game nickname. |
| `vip` | string (`"0"`/`"1"`) | Raw VIP flag for the member (distinct from `vip_mode`; not directly rendered). |
| `type` | string (`"0"`/`"1"`/`"2"`) | Role: `"1"`=Глава (leader), `"2"`=Зам (deputy), `"0"`=ordinary member. |
| `date` | string, unix ts (10-digit, **seconds**) | Last seen ("Заходил"). |
| `discord` | bool | Whether a Discord account is linked (green check / red cross). |
| `vip_mode` | int (`0`/`1`/`2`) | Priority render state: `1`=priority ON (checked, toggleable), `0`=OFF (unchecked, toggleable), `2`=priority from another source → non-editable ban icon. |
| `access` | bool | Per-row: may the viewer **remove** this member (renders the delete button). |
| `online_raw` | int | Playtime over last 60 days in seconds; the numeric sort key for the clock column. |
| `online` | string (HTML) | Pre-rendered playtime label, e.g. `<span class="label label-success">398ч 1…</span>`. |
| `kit` | string | Last-used kit code (e.g. `"SL"`, `"Recruit"`); becomes row `data-kit`, drives the kit icon. Empty/`"undefined"` → "неизвестно". |

`Presence` object (values inside `servers[server_id]`):

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Member's in-game nickname on that server. |
| `team` | string | Team/faction code (e.g. `"WPMC"`), maps to `/assets/img/ico/teams/<team>.png`. |
| `playtime.date` | int, **milliseconds** (13-digit) | Session start (`Date.getTime()`). |
| `playtime.last_seen` | int, **milliseconds** (13-digit) | Session last-seen. Session length rendered as `secToTime((last_seen - date)/1000)`. |

> Timestamp gotcha to replicate/avoid: roster `date` is **unix seconds**, but `servers[].playtime.*` are **JS milliseconds**. Two different units in the same response.

Redacted example:

```json
{"access":1,
 "servers":{"1":[{"name":"<redacted>","team":"WPMC",
   "playtime":{"date":1783131847742,"last_seen":1783152242849}}],
  "6":[],"7":[],"9":[],"10":[],"11":[]},
 "discord":[],
 "players":[{"steam_id":"<redacted:17>","name":"<redacted>","vip":"<0|1>",
   "type":"0","date":"1783152243","discord":true,"vip_mode":1,
   "access":true,"online_raw":23893,
   "online":"<span class=\"label label-success\">398ч 1…","kit":"SL"}],
 "status":"ok","exec_time":0.092}
```

#### 2.3 `POST /ajax/clan.php` — `action=stats` (dashboard)

Request body: `clan_id=<int>&start=<unix|undefined>&end=<unix|undefined>&action=stats`.

> Captured initial-load body was `clan_id=16&start=undefined&end=undefined&action=stats` — on first render `stats(start,end)` is invoked with no arguments, so `start`/`end` serialise to the literal string `"undefined"`; the server treats missing/`undefined` as the default **last-60-days** window. Subsequent calls come from the `#clan-chartOnline_date` daterange with real unix bounds.

Response `application/json`:

| Field | Type | Meaning |
|---|---|---|
| `access` | int (`0`/`1`) | Priority-management right (same semantics as §2.2). |
| `chart.labels` | array<string> (len 60) | X-axis day labels, format `DD.MM.YYYY`. |
| `chart.online` | array<string> (len 60) | Daily online value per label (parallel to `labels`). |
| `stats.online` | string | Total clan online, humanised (e.g. `"2726ч 0м"`). |
| `stats.boost` | string | Online "boost" hours, humanised (e.g. `"446ч 51м"`). |
| `stats.server` | string | Primary server display name (e.g. `"RAAS/AAS #1"`). |
| `stats.primetime` | array<Primetime> | Peak-activity windows. |
| `stats.kill` | int | Aggregate clan kills. |
| `stats.die` | int | Aggregate clan deaths. |
| `stats.revive` | int | Aggregate clan revives. K/D computed client-side as `kill/die` (→ `"1"` if either is 0). |
| `stats.top` | array<Top> (len 10) | Top members by combat; first 5 rendered as podium. |
| `stats.games` | array<Game> (len 10) | Recent games the clan participated in. |
| `status` | string | `"ok"`. |
| `exec_time` | float | Server timing. |

`Primetime`: `{ start: string(unix), end: string(unix), cnt: int, sum: int, sort: string("HH:mm") }` — rendered as `HH:mm-HH:mm` chips.

`Top`: `{ steam_id: string(17), name: string, kill: string(int), die: string(int), revive: string(int) }`.

`Game`: `{ id: string(int), server_id: string(int), start: string(unix), end: string(unix), map: string, t1: string, t1_tickets: string(int), t2: string, t2_tickets: string(int), win: string(enum "t1"|"t2"|"draw"), is_seed: string("0"|"1"), name: string, cnt: string(int) }`. Links to `/game/<id>`; `cnt` = clan members that played it.

Redacted example (trimmed to one element per array):

```json
{"access":1,
 "chart":{"labels":["06.05.2026"],"online":["20"]},
 "stats":{"online":"2726ч 0м","boost":"446ч 51м","server":"RAAS/AAS #1",
   "primetime":[{"start":"1778424060","end":"1778528820","cnt":306,"sum":108852,"sort":"17:41"}],
   "kill":9875,"die":5918,"revive":2698,
   "top":[{"steam_id":"<redacted:17>","name":"<redacted>","kill":"1847","die":"347","revive":"206"}],
   "games":[{"id":"33295","server_id":"1","start":"1783114006","end":"1783115978",
     "map":"Harju RAAS v1","t1":"AFU","t1_tickets":"0","t2":"PLANMC","t2_tickets":"366",
     "win":"t2","is_seed":"0","name":"<redacted>","cnt":"4"}]},
 "status":"ok","exec_time":0.745}
```

#### 2.4 Mutating & search contracts (not fired during capture; shapes from inline JS)

All `POST /ajax/clan.php` with the listed body; response is the standard `{status, …}` envelope surfaced through `Action`'s `success`/`error`.

| action | Request body | Response used by client | Blocked in capture? |
|---|---|---|---|
| `findPlayer` | `clan_id`, `find`, `action=findPlayer` | `text.players[] = {steam_id, name, clan_id}` | read — not fired (needs ≥3-char input) |
| `addPlayer` | `clan_id`, `steam_id`, `type`, `action=addPlayer` | success → `clan.build()` | mutation — interceptor would abort |
| `removePlayer` | `clan_id`, `steam_id`, `action=removePlayer` | success → row removed | mutation — aborted |
| `vipPlayer` | `clan_id`, `steam_id`, `vip`(bool), `action=vipPlayer` | success → recount checkboxes | mutation — aborted |
| `changeExpire` | `clan_id`, `date`(unix), `action=changeExpire` | success → close confirm | mutation — aborted |
| `setting` | `clan_id`, `key`(`public`\|`protected`), `value`(bool), `action=setting` | success (silent) | mutation — aborted |
| `delete` | `clan_id`, `action=delete` | success → `location.href='/'` | mutation — aborted |
| `createSquad` (squad) | `id`, `name`, `expire`, `max`, `discord_id`, `tags` → `POST /ajax/squad.php` | success → `pageLoad('clan&id='+text.id)` | mutation — aborted |
| `downloadList` | `clan_id`, `action=downloadList` — **form-POST** via `post_to_url` | file download | export — not an `Action` |
| `downloadOnline` | `clan_id`, `start`, `end`, `action=downloadOnline` — **form-POST** | file download | export — not an `Action` |

`_blocked.json` for this capture is `[]` — the read-only harness only auto-fired the three reads (`page`, `list`, `stats`); no mutation was attempted, so nothing needed aborting.

---

### 3. Entities & Fields

#### 3.1 Clan / Squad entity (`clan.data`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | Primary key; used as `clan_id` in every clan action. |
| `name` | string, ≤32 | Display name (`[MDC]`). |
| `tags` | string[] | In-game name prefixes / clan tags (`["Mdc |","MdcK |"]`). Drive tag-protection kicks and `findPlayer` matching. |
| `discord_id` | string ≤64 \| null | Linked Discord **role** ID ("Discord ID роль"). `null` when unset. |
| `date` | string, unix ts (seconds) | Clan creation time (`1746523474`). |
| `expire` | string, unix ts (seconds) | Priority/VIP subscription expiry (`2620162800` ≈ 11.01.2053). `"0"` = infinity. Header renders "Истекает: … (через N дней)". |
| `max` | string(int) | Maximum priority (queue/VIP) slots (`"999"`). Header: "Слотов: <clan-vip_count> из max". |
| `protected` | string(`"0"`/`"1"`) | "Защита тега" (tag protection): auto-kicks players wearing the clan's tags who are not on the roster; lists refresh every ~10 min. |
| `public` | string(`"0"`/`"1"`) | "Публичная страница": exposes a read-only view (excluding queue-priority info) to non-editors. |

Header also shows a static **Приоритет** (priority) badge — "Да" (green) when the subscription is active. This is derived from `expire` server-side, not a stored column.

#### 3.2 Runtime flags (not on the clan row)

| Flag | Source | Type | Effect |
|---|---|---|---|
| `text.access` | `list`/`stats` response | int 0/1 | Gates the entire VIP/priority column + slot counter. |
| `v.access` | per `Member` in `list` | bool | Gates the remove button on that specific row. |
| `clan.canType` | server-injected in `init()` (`clan.canType=true;`); bootstrap default `false` | bool | Gates the add-as-leader / add-as-deputy dropdown in search results. |
| `vip_mode==2` | per `Member` | — | Locks priority as "from another source" (ban icon, not toggleable). |

#### 3.3 Player search result (`findPlayer`)

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string(17) | Candidate SteamID64; row `data-id`. |
| `name` | string | Nickname. |
| `clan_id` | int \| null/0 | If already in a clan → render a green check and **suppress** the add controls; otherwise render add buttons. |

---

### 4. The Page's Own Table — "Состав клана" (Clan Roster)

Table `#clan-table`. Rows built client-side by `clan.build()` from `action:'list'`. **No DataTables / `script:'table'` server-side pagination** — the whole roster loads at once and sorts client-side.

| # | Header | `data-sort` source | Render |
|---|---|---|---|
| 1 | Ник (Nick) | `v.name` | Bold nickname + kit icon (`/assets/img/ico/kits/<kit|Recruit>.svg`) + kit name. Click → `player.open(steam_id)`. |
| 2 | SteamID | `v.steam_id` | `<hashtag>` id + "открыть" (Steam profile, new tab) + "статистика" (`/player/<id>`). |
| 3 | Discord (icon) | `v.discord` | Green check / red cross. |
| 4 | Заходил (Last seen) | `v.date` | `formatDate(v.date,…)`. |
| 5 | Clock icon | `v.online_raw` | Pre-rendered `v.online` label (60-day playtime). |
| 6 | Роль (Role) | `v.type` | `"1"`→Глава, `"2"`→Зам, else blank. |
| 7 | Star icon (Приоритет) | `v.vip_mode` | **Only when `text.access`.** `vip_mode!=2` → checkbox `#vip_<steam_id>` (`onchange=clan.player.vip`), checked when `vip_mode==1`; `vip_mode==2` → non-editable ban icon (tooltip "У данного игрока есть приоритет от иного источника"). |
| 8 | Wrench icon | — | **Only when `v.access`.** Remove button → `clan.player.remove(steam_id,this)`. |

- **Controls above table:** "Скачать" (`clan.download.list()` → `downloadList`) and "Добавить" (`clan.find.open()` → search modal).
- **Sorting:** every `<th data-sort="true">` is click-sortable client-side. Comparer: numeric when both cell `data-sort` values are numeric, else `localeCompare`; toggles asc/desc via `this.asc`. **No search box, no pagination** on the roster.
- **Live counters:** `#clan-players_count` = `text.players.length`; `#clan-vip_count` = count of checked VIP checkboxes, recomputed on every toggle and on load.
- Widths (px): Ник 350, SteamID 160, Discord 30, Заходил 120, clock 80, Роль 150, star 35, wrench 40.

---

### 5. Actions / Admin Capabilities

Clan-scoped mutations `POST /ajax/clan.php` via `Action({script:'clan',…})`; create/edit uses `script:'squad'` → `/ajax/squad.php`. Every payload carries `clan_id = clan.id` unless noted. These equal the permission surface.

| UI label | action | Script → endpoint | Data keys (type) | Effect | Destructive |
|---|---|---|---|---|---|
| (roster load) | `list` | clan | `clan_id` (int) | Fetch roster + per-server presence + Discord channels. | N (read) |
| (dashboard) | `stats` | clan | `clan_id` (int), `start` (unix\|undefined), `end` (unix\|undefined) | Fetch online chart + aggregate combat stats. | N (read) |
| Найти (search) | `findPlayer` | clan | `clan_id` (int), `find` (string, ≥3) | Search addable players (nick / SteamID / clan tag). | N (read) |
| ➕ Add member | `addPlayer` | clan | `clan_id` (int), `steam_id` (string), `type` (0=member \| 1=Глава \| 2=Зам) | Add player with role; success → `clan.build()`. Role >0 gated by `clan.canType`. | **Y** |
| 🗑 Remove member | `removePlayer` | clan | `clan_id` (int), `steam_id` (string) | Remove from roster. Confirm "Удалить игрока из списка клана?". | **Y** |
| ⭐ Priority checkbox | `vipPlayer` | clan | `clan_id` (int), `steam_id` (string), `vip` (bool) | Grant/revoke queue priority. Checkbox disabled 3 s after toggle; reverts on error. | **Y** |
| 📅 Change expiry | `changeExpire` | clan | `clan_id` (int), `date` (unix) | Change clan priority-subscription expiry. Daterange presets: justDay, +1/+2/+3/+6 months, +1 year, infinity, reset. Confirm "Сменить дату?". | **Y** |
| Public / Tag-protect toggles | `setting` | clan | `clan_id` (int), `key` (`public`\|`protected`), `value` (bool) | Toggle clan settings. | **Y** |
| 🗑 Disband clan | `delete` | clan | `clan_id` (int) | Delete the clan. Confirm "Удалить клан?" with **3 s cooldown**; on success `location.href='/'`. | **Y (irreversible)** |
| Редактировать / Rename | `createSquad` | squad | `id` (int), `name`, `expire` (unix), `max` (int), `discord_id`, `tags` (URL-encoded, comma-joined) | Edit clan (non-empty `id`). Also serves rename. Success → `pageLoad('clan&id='+text.id)`. | **Y** |
| (create new clan) | `createSquad` | squad | same, `id` empty | Create clan. | **Y** |
| Скачать (roster) | `downloadList` | clan (`post_to_url`) | `clan_id` | Form-POST file download. | N (export) |
| Скачать статистику | `downloadOnline` | clan (`post_to_url`) | `clan_id`, `start`, `end` (daterange bounds) | Form-POST file download. | N (export) |

**No dedicated `rename`/`transfer`/`disband` actions on this page.** Renaming = `createSquad` with `name`; ownership/"transfer" = member `type` (Глава/Зам); disband = `delete`. The `rename`/`transfer`/`disband` action ids in the catalog belong to the in-game squad panel (`main.html`), and `downloadStat` belongs to the player modal (`script:'player'`, keyed by `steam_id`) — none are wired to clan-page controls.

---

### 6. Forms & Modals

#### 6.1 Create/Edit clan modal (`#createClan_modal`, defined in `home_auth.html`)

Title "Создание клана". Reused for create (`createClan.open()`) and edit (`createClan.edit(clan.data)`). Submit "Сохранить" → `createClan.send()` → `createSquad`.

| Field | `#id` | Input | Constraints | Maps to |
|---|---|---|---|---|
| Название клана (Clan name) | `#createClan_name` | text | `maxlength=32` | `name` |
| Окончание приоритета (Priority end) | `#createClan_expire` | daterange button | presets: `justDay`, `infinity`; `limitDate:false`; default create = today, edit = `moment.unix(clan.expire)` | `expire` (reads `data-start`, unix) |
| Приоритетов (Priority slots) | `#createClan_max` | text | `maxlength=3`, placeholder `10` | `max` |
| Discord ID роль (Discord role ID) | `#createClan_discord_id` | text | `maxlength=64` | `discord_id` |
| Теги (Tags) | `#createClan_tags` | chip builder | added via sub-modal; "очистить" clears all | `tags` = chip innerHTML joined by `,`, then `encodeURIComponent` |
| (hidden id) | `#createClan_id` | hidden | empty → create, set → edit | `id` |

**Tag sub-modal** (`#createClanTags_modal`): single input `#createClanTag_name` (placeholder "тег") + "Добавить". `createClan.tags.add(name)` appends a `label label-success` chip and hides the sub-modal; `createClan.tags.clear()` empties `#createClan_tags`. On edit, existing `clan.tags` are re-added chip-by-chip.

`send()` payload (verbatim):

```js
Action({script:'squad', action:'createSquad', data:{
  id: $('#createClan_id').val(),
  name: $('#createClan_name').val(),
  expire: $('#createClan_expire').data('start'),
  max: $('#createClan_max').val(),
  discord_id: $('#createClan_discord_id').val(),
  tags: encodeURIComponent($('#createClan_tags > span').map((i,v)=>v.innerHTML).get().join())
}})
```

#### 6.2 Add-member search modal (`#findPlayer`, in the clan fragment)

- Input `#clan-find_player` (placeholder "Ник или SteamID"), min **3 chars**, **300 ms** debounce, aborts the in-flight request on each keystroke. Help: "Не менее 3 символов. Можно искать по части ника или по клан-тегу" / "Если не находит, скорее всего игрок не заходил к нам".
- Results table `#clan-find_table` (Ник / SteamID / wrench). Per row: `v.clan_id` truthy → green check (no add); else ➕ button `clan.player.add(steam_id,this,0)` plus — **when `clan.canType`** — a dropdown ("Добавить главу" → type 1, "Добавить зама" → type 2).

#### 6.3 Change-expiry control

Sidebar button `#clan-expire_date` (`type="daterange"`) with presets justDay / plus1Month / plus2Month / plus3Month / plus6Month / plus1Year / infinity / reset; `limitDate:false`; default seeded from `clan.data.expire`. Selecting fires the "Сменить дату?" confirm (button text "Меняем") → `changeExpire` with `date = data.start`.

#### 6.4 Online-chart daterange

`#clan-chartOnline_date` daterange presets: justMonth / justDay / justWeek / justYear / range / today / yesterday / currentWeek / lastWeek / currentMonth / lastMonth / last30days / last60days / last90days; default `last60days`. Selecting → `clan.stats(start,end)`; also feeds `downloadOnline`.

---

### 7. Permission / Visibility Logic

- **`text.access` (int 0/1):** gates the whole VIP/priority column (header + per-row checkbox) and the slot counter. Without it the roster is priority-read-only.
- **`v.access` (per-member bool):** gates the remove button on that row — remove is authorised per member, not globally.
- **`clan.canType`:** gates leader/deputy assignment when adding members. Server-injected as `clan.canType=true;` in `init()` (bootstrap default `false`); false → members can only be added as type 0.
- **`vip_mode==2`:** priority "from another source" renders as a locked ban icon — not toggleable here.
- **`public` setting:** exposes a read-only page to non-editors, explicitly excluding queue-priority info.
- **Hidden blocks:** the YooMoney "Продлить приоритет (1000руб)" donation form sits in a `.hide` row (receiver `41001649543147`, `label`/`targets`=clan id, `sum=1000`, `successURL=…/clans.php?id=16`); `#discord-block` stays hidden unless `text.discord` is non-empty. `clan.pay()` is an empty stub.

---

### 8. Notable UX & Competitively Interesting Details

- **Clan = paid priority-queue product.** Clans have an `expire` date, a `max` slot cap, and an inline **YooMoney** payment form to extend priority; members get queue priority via per-row toggles counted against the cap ("35 из 999"). This monetisation is the core reason clans exist in SQSTAT.
- **Tag protection (`protected`).** Auto-kicks players wearing the clan's registered tags who are not on the roster (~10-min refresh) — strong anti-impersonation feature and a natural upsell.
- **Rich per-clan dashboard.** 60-day online bar chart (date-ranged, file-exportable), total online + boost hours, primetime windows (`start/end/cnt/sum/sort`), primary server, aggregate kills/deaths/revives + client-side K/D, a **top-5 podium with per-member kit artwork** (gold/silver/bronze outline), a top-10 list, and recent games (with map, teams, tickets, winner, seed flag, participant count) — far beyond a plain member list.
- **Per-server live presence** with session length (ms-precision timestamps) — spot active clan stacks per server.
- **Discord integration:** clan ↔ Discord **role** ID linkage plus display of linked voice channels.
- **Direct role assignment on add:** add-as-leader / add-as-deputy from the search dropdown avoids a second edit step.
- **Client-side roster sorting, no server paging** — fast for modest rosters but won't scale; an area to beat with proper server-side paging/search.
- **Safety UX:** remove-member, change-expiry, and disband all use confirm dialogs; disband adds a **3-second cooldown** before the confirm arms; VIP toggle self-disables for 3 s and reverts on error.
- **Observable bugs/quirks to exploit:** (1) `stats` initial call sends `start=undefined&end=undefined` literally — sloppy client contract. (2) Mixed timestamp units in `list` (roster seconds vs presence milliseconds). (3) `script:'clan'` (roster/settings) vs `script:'squad'` (`createSquad`) split hints at an older "squad" model retrofitted as "clan" — a clean unified data model is an easy differentiator.
