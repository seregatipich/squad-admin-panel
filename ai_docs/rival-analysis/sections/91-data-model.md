## Entity & Data Model

> **Cross-cutting, spec-grade synthesis.** This chapter is the unified database/ERD reference for the SQSTAT panel (`breaking.sqstat.ru`), rebuilt from the **LIVE captured API contracts** that now back the per-section chapters (01–20). Every field/type/enum below is transcribed from a captured `table.php` / `squad.php` / `clan.php` response, a captured `/api/*` docs example, or a captured `buildTable` config — not inferred from render code except where explicitly flagged **(inferred)**. Capture files are cited per entity. An engineer should be able to recreate the schema, the read/write endpoints, and the grids from this chapter alone.
>
> **Provenance root:** `caps/<area>/*.network.json` (contracts + redacted samples), `caps/<area>/*.content.html` (rendered `#content`, `buildTable` configs, form ids/maxlengths), `caps/<area>/_blocked.json` (mutation-interceptor log — `[]` everywhere: 0 mutations fired, all writes documented from client JS, never executed). Two areas are code-derived only: **chat** (`capture.py` crashed with `TargetClosedError` 2×, contracts from `custom.js`/`main.html`) and **player-profile** (fully server-side rendered, `network.json = []`).

---

### 0. Wire conventions (read this first — they apply to every entity)

These four conventions are the shape of the whole data layer; individual entity specs assume them.

#### 0.1 Two transports

| Transport | Endpoint | Body | Envelope | Auth |
|---|---|---|---|---|
| **Internal admin RPC** | `POST /ajax/<script>.php` (`script` ∈ `table`, `player`, `squad`, `clan`, `settings`, `public`) | `application/x-www-form-urlencoded`; `Action()` flattens `data` to `&k=v` pairs (**no URL-encoding of values** — callers pre-encode) + `action=<action>` | JSON `{status, exec_time, …}`; success gate `status=="ok"`; `auth===true` ⇒ `location.reload()` | session cookie |
| **Public REST API** | `GET\|POST /api/<group>/<method>.php` (`group` ∈ `server`, `player`, `clan`) | `x-www-form-urlencoded` | JSON, **envelope inconsistent per endpoint** (§7) | `key` param (query/body), or none for `stat`/`hasBan`/public `clan` |

#### 0.2 The universal `table.php` envelope (every DataTables grid)

Every list grid (`allPlayers`, `banPlayers`, `vipPlayers`, `adminPlayers`, `playerChat`, `playerComments`, `playerMark`, `playerKills`, `playerDeath`, `playerRevive`, `playerDamage`, `playerTeamkill`, `games`, `votes`, `reports`, `ban_names`, `collabans`, `topPlayers`, `logs`, `playersOnline`, plus the 11 modal sub-tabs) funnels through **`POST /ajax/table.php`** with an identical request/response envelope. Documented once here; per-entity sections give only the `action=` id, the `data.row[]` schema, and the grid config.

**Request** (`Action({script:'table', action:'<tableId>', data:'&table=<tableId>&…'})`):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id (routes the query). |
| `table` | string | Y | Duplicate of `action` (`buildTable` sends both). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size (per-grid; see each entity). |
| `search` | URL-encoded JSON | Y | 5 fixed buckets `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. Text inputs → `text` keyed by each control's `data-search` **raw SQL alias** (e.g. `t2.player`); checkboxes → `check` (value `"true"`/`"false"`); multiselect → `multiselect` (array); date-range → `text["<alias>.startdate"]`/`.enddate` (unix s, `0/0`=all-time). `+`→`%2B`. |
| `order_by` | string \| `false` | Y | Sort column DB-alias, or literal `false` = server default. |
| `order_sort` | `asc`\|`desc`\|`false` | Y | Sort direction, or `false`. |
| `pagination` | `true` | N | When present ⇒ **count-only** variant (second parallel call). |

**Data response** (rows call):

| Field | Type | Meaning |
|---|---|---|
| `data.row[]` | array[≤`numrows`] | Result rows (per-entity schema). |
| `data.totalPage` | int | **0 on the data call** (real value from the count call). |
| `data.totalRows` | int | **0 on the data call.** |
| `data.currentPage` | string | Echoed page index (`"1"`). |
| `data.custom` | bool | Custom/manager-scoped query flag. |
| `data.query_time` | float — s | Row-query time. |
| `data.count_time` | int/float — s | `0` on the data call. |
| `status` | string enum `"ok"` | Non-`ok`+`auth:true` ⇒ reload. |
| `exec_time` | float — s | Total handler time. |

**Count response** (`&pagination=true`, fired only when the page fills or `currentPage!=1`):

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Real page count. |
| `totalRows` | **string OR int — inconsistent per table** | Real row count. Captured as string on `ban_names`/`vipPlayers`/`adminPlayers`/`games`/`logs`/`votes` (`"371"`, `"395"`, `"53"`, `"28571"`, `"110488"`, `"3991"`) but **int** on `collabans` (`17510`). Coerce. |
| `count_time` | int/float — s | Isolated `COUNT(*)` cost. |
| `status` / `exec_time` | `"ok"` / float | — |

#### 0.3 Type conventions on the wire

- **Every scalar is a JSON string** unless noted (`"0"`, `"1783085160"`, `"e50606"`). Integers, enums, booleans-as-`"0"/"1"`, and unix timestamps all arrive as strings. Exceptions: `game.time` (int seconds), `clan.stats.kill/die/revive` (int), `primetime.cnt/.sum` (int), presence `playtime.date/.last_seen` (int).
- **Unix timestamps = string seconds** (10-digit) everywhere EXCEPT live-presence `playtime.{date,last_seen}` which are **integer JS milliseconds** (13-digit). §8 indexes every timestamp field.
- **Pre-rendered HTML in JSON:** the server ships presentation cells as ready HTML strings alongside raw values in the same row. Confirmed HTML-string fields: `adminPlayers.{group,time,boost,bans,discord}`, `vipPlayers.{group,time}`, `banPlayers.expire`, `playerComments.{admin,player}`, `playerMark.{mark,ban,player}`, `playerTeamkill.{player,killed,kit}`, every combat row's `server` badge, `clan.list players[].online`, `votes.{cancel,map_current_img,map_next_img}`. A machine consumer must parse HTML out of these.

#### 0.4 Live scale (row counts observed 2026-07-04)

| Entity | Rows | Entity | Rows | Entity | Rows |
|---|---|---|---|---|---|
| Player (`allPlayers`) | **385 350** | Damage event | **13 413 500** | Comment | 1 090 |
| VIP/privilege (`vipPlayers`) | 395 | Death event | 5 630 431 | Mark | 708 |
| Admin roster (`adminPlayers`) | 53 | Kill event | 4 402 799 | Vote | 3 991 |
| Ban (`banPlayers`) | (large) | Revive event | 1 217 973 | Audit log | 110 488 |
| Ban-name (`ban_names`) | ~371 | Teamkill event | 653 590 | Report | 0 (this acct) |
| Collab-ban (`collabans`) | 17 510 | Game/match | 28 571 | Issue | (page size 20) |

---

### 1. Identity model — the spine (LIVE-CONFIRMED, with a partial UUID migration)

Almost every entity foreign-keys to a **player identity**. The live captures reveal a **migration in progress** from SteamID64 to a 36-char UUID surrogate (mirrors this repo's own `steam_id64 → UUID` PK migration, commit `b2ddb12`): the rewritten global player-record tables now emit a UUID under the legacy column name `steam_id`, while the high-volume event/archive tables and the entire public API still key on SteamID64.

| Identity key | Type | Role | Authoritative |
|---|---|---|---|
| `steam_id` (as **UUID**) | string(36), dashed | **New player PK** on rewritten tables. | `adminPlayers`, `playerComments`, `playerMark`, `logs`, `changeGroup.steam_id`, `player.open()` arg |
| `steam_id` (as **SteamID64**) | string(17) | Legacy player PK, still live on event/archive tables + public API + all `<hashtag>` rendering. | `banPlayers`, `playersOnline`, `playerKills/Death/Revive/Damage/Teamkill`, `votes`, `reports`, `collabans`, `clan.list`, `topPlayers`, all `/api/*` |
| `admin_id` | string(17) SteamID64 | **Always SteamID64** — author key on bans (`t3`), comments (`t2`). Never migrated. | Ban, Comment |
| `eos_id` | string(32) hex | Epic Online Services id (`0…0`×32 when unset). | Player, Match roster, live dashboard, marks |
| `discord` | string(18) snowflake \| `null` | Discord user id (player) / Discord **role** id (clan). | Player, Clan |
| `server_id` | string(int), **sparse PK** | Primary server key. Live set: **1, 6, 7, 8, 9, 10, 11** (2–5 retired; `8` only in settings). Confirms soft-delete, not renumber. `"0"` = panel-global event (audit logins). | Server + every per-server event |

> **Capture matrix (which `steam_id` a table emits):** UUID(36) — `adminPlayers`, `playerComments`, `playerMark`, `logs`. Steam64(17) — `banPlayers`, `playersOnline`, combat tables, `votes`, `collabans`, `clan.list`, `topPlayers`, `/api/*`. Redacted-to-36 (unresolved) — `vipPlayers` JSON (`<hashtag>` renders Steam64; whether JSON carries raw Steam64 or UUID could not be confirmed under redaction). A reimplementation must treat `steam_id` as an **opaque identity column** and resolve to Steam64 only where the game protocol needs it.

**Structural bifurcation (the single most important shape):** `squad.*` actions are **per-server** (always carry `server_id`) — the live/RCON layer; `player.*` actions are **global** (no `server_id`) — the record layer. Global player record vs. per-server live/RCON event is the primary schema fault line.

---

### 2. Master entity catalog

| # | Entity | PK | `steam_id` form | Read endpoint (`action=`) | RPC script | Capture | Ch. |
|---|---|---|---|---|---|---|---|
| 1 | **Player** | `steam_id` | mixed | `allPlayers` / `player.get` / `/api/player/info` | `table`/`player` | players, api | 03,04,07 |
| 2 | Name history | (`steam_id`,`date`) | — | `player.get.names[]` / API `names[]` | `player` | api | 03,19 |
| 3 | Location / IP history | (`steam_id`,`date`,`ip`) | — | `player.get.location[]` | `player` | 03 (render) | 03,07 |
| 4 | Primetime bucket | (`steam_id`,`start`) | — | `player.get.primetime[]` / API `primetime[]` | `player` | api | 03,19 |
| 5 | Twin / alt link | (`steam_id`,`compare_steam_id`) | S64 | `twink`/`twinkOnline`/`findFriends` | `player` | players (JS) | 03,07 |
| 6 | Session / online series | (`steam_id`, ts) | S64 | `getPlayerOnlineData` | `player` | players (JS) | 03,07,20 |
| 7 | Playtime-by-kit aggregate | (`steam_id`, season) | S64 | `playersOnline` table | `table` | online | 07,04 |
| 8 | **Server** | `server_id` | — | `getServer` / stats `servers` / settings modal | `squad`/`settings` | dashboard, statistics, settings | 01,11,16 |
| 9 | Map layer / Unit | (layer) | — | `getServerMaps` | `squad` | dashboard (render) | 01,16 |
| 10 | Rotation | (`server_id`,`day`) | — | `getRotation` | `squad` | settings (JS) | 01,16 |
| 11 | Config file | (`server_id`,`dir`,`file`) | — | `getConfigFiles`/`getConfigFile` | `squad` | settings (JS) | 01,16 |
| 12 | Mod | `mod_id` | — | `getMods` | `squad` | settings (JS) | 01,16 |
| 13 | Monitor sample | (`server_id`, ts) | — | `server.monitor[]` / `serverMonitor` | `squad` | dashboard | 01 |
| 14 | Network connection | (`server_id`,`ip`) | — | `network` / root `ips` | `squad` | dashboard | 01 |
| 15 | Statistics aggregate | (`server_id`, bucket) | — | `statistics` | `squad` | statistics | 11 |
| 16 | Seeding priority | (`start` day,`server_id`) | — | `seedingGetPriority` | `squad` | profile (JS) | 04 |
| 17 | Permission group | `group_id` 0–5 / `name` | — | `groups` settings tab | `settings` | admins, settings | 05,16 |
| 18 | Group assignment | `steam_id` (1/player) | UUID/S64 | `changeGroup` / `adminPlayers` / `vipPlayers` | `player`/`table` | admins, vips | 05,06 |
| 19 | VIP / privilege | `steam_id` (grp=3) | S64 | `vipPlayers` / `/api/player/vip` | `player`/`table` | vips, api | 06,19 |
| 20 | **Clan (=squad)** | `id` | — | `clan.list` / `createSquad` / `/api/clan/get` | `clan`/`squad` | clans, api | 18,04 |
| 21 | Clan member | (`clan_id`,`steam_id`) | S64 | `clan.list.players[]` | `clan` | clans | 18 |
| 22 | Bonus economy | `steam_id` (scalar) | S64 | `player.get.bonus` / `/api/player/bonus` | `player`(API) | api,top | 04,19,20 |
| 23 | **Ban** | `id` | S64 | `banPlayers` / `player.get.bans[]` / `/api/.../hasBan` | `squad`(w)/`table`(r) | bans, api | 09,19 |
| 24 | Reason / rule | `value` (rule id) | — | `#player_ban-reason` `<option>` / `rules` tab | `squad` | bans, settings | 09,16 |
| 25 | Ban-name | `name` | — | `ban_names` | `player`/`table` | bans | 10 |
| 26 | Collab-ban (federated) | (`steam_id`, project) | S64 | `collabans` / `checkBans` / `/api/.../hasBanAll` | `player`/`table` | bans, api | 10,19 |
| 27 | Project (federation src) | project `name` | — | `checkBans.projects[]` / `collabans.projects[]` | `player` | bans | 10 |
| 28 | Comment | `id` | UUID | `playerComments` / `getComments` / `/api/.../comments` | `player`/`table` | notes, api | 08,19 |
| 29 | Mark | `steam_id` (scalar) | UUID | `playerMark` / `mark` | `player`/`table` | notes | 08 |
| 30 | Audit log entry | `id` | UUID | `logs` | `table` | logs | 17 |
| 31 | **Game / match** | `id` | — | `games` / `/game/<id>` / API `stats.games[]` | `table` | games, api | 12,04 |
| 32 | Match detail (per-player) | (`game_id`,`steam_id`) | — | `/game/<id>` (SSR, **not captured**) | — | — | 12 (gap) |
| 33 | Kill event | `id` | S64 | `playerKills` | `table` | combat | 13 |
| 34 | Death event | `id` | S64 | `playerDeath` | `table` | combat | 13 |
| 35 | Revive event | `id` | S64 | `playerRevive` | `table` | combat | 13 |
| 36 | Damage event | `id` | S64 | `playerDamage` | `table` | combat | 13 |
| 37 | Teamkill event | `id` | S64 | `playerTeamkill` | `table` | combat | 13 |
| 38 | Kit (usage / denial) | (`steam_id`,`kit`) | S64 | `playerKits` / `kits`+`kitSave` | `player` | players, profile | 03,04 |
| 39 | Weapon stat | (`steam_id`, season, weapon) | S64 | profile SSR / API `weapons.weapon{}` | (profile) | profile, api | 04,19 |
| 40 | Vehicle stat / destruction | (`steam_id`, season, vehicle) | S64 | profile SSR / API `weapons.vehicle{}` | (profile) | profile, api | 04 |
| 41 | Chat message | `id` | S64 | `playerChat` / `/api/server/chat` | `table` | (code) | 02,19 |
| 42 | Vote | `id` | S64 | `votes` | `table` | votes | 14 |
| 43 | Report | (row) | S64 | `reports` | `table` | reports | 14 |
| 44 | Issue (bug tracker) | `id` | — | `issues_get`/`issues_create` | `squad` | issues | 15 |
| 45 | Label (issue) | `id` (1/2) | — | `issues_get.labels[]` | `squad` | issues | 15 |
| 46 | Video / demo | (upload) | — | `uploadVideo` FormData | `public` | issues (JS) | 15 |
| 47 | Upload token | `token` | — | `uploadVideo_token` | `squad` | issues (JS) | 15 |
| 48 | Season (dimension) | `all`/`old`/`1`/`2` | — | profile `?season=` | — | profile | 04 |
| 49 | User settings | `steam_id` (self) | — | `saveUserSettings` JSON blob | `player` | profile | 04,16 |
| 50 | Discord config / webhooks | (panel-global) | — | `discordbot`/`discord` settings tabs | `settings` | settings | 16 |

---

### 3. Player & identity domain

#### 3.1 Player — directory row (`allPlayers`) vs. full card (`player.get`) vs. API (`/api/player/info`)

Three projections of the same entity. The directory list over-returns a denormalized identity+moderation payload per row.

**`allPlayers` row** — captured `data.row[i]` (`caps/players/players.network.json`). Grid: `numrows=100`, `collum=["steam_id","name","date"]`, but the wire carries 10 fields:

| Field | Wire type | Key | Meaning |
|---|---|---|---|
| `steam_id` | string(17) | **PK** | SteamID64, `<hashtag>` (copy). Row-click key. |
| `eos_id` | string(32) | | EOS id — returned though not a visible column. |
| `name` | string | | Current nickname. |
| `date` | string — **unix s** | | Last login ("Заходил"/Last seen). |
| `create_date` | string — **unix s** | | First seen ("Создан"/Created) — returned, not columned. |
| `mark` | string enum `"0".."8"` | FK→Mark | Suspicion tag (§8.6). |
| `bonus` | string(int) | | Bonus balance. |
| `discord` | string(id) \| `null` | FK | Discord user id, nullable. |
| `expire` | string — **unix s** \| `"0"` | | Group expiry; `"0"`=permanent. |
| `group_id` | string enum `"0".."5"` | FK→Group | Current group. |

**`player.get` full card** (`Action({script:'player',action:'get',data:{steam_id}})` → `POST /ajax/player.php`; `player.info = text.player`). The richest entity, read by the shared modal on every page. Fields (captured render + `/api/player/info` example `caps/api-top/_api_docs_.content.html`):

| Field | Type | Key/notes | Meaning |
|---|---|---|---|
| `steam_id` | string(17/UUID) | **PK** | Identity. |
| `eos_id` | string(32) | | EOS id. |
| `name` | string | | Current nick. |
| `names[]` | `{name, date(unix s)}` | 1:N | Name-history (§3.2). |
| `date` / `create_date` | **unix s** | | Last login / first seen. |
| `baby` | **bool** (JSON bool) | | New/young acct (<~30 h) risk flag. |
| `bonus` | string(int) | | Bonus balance (`"895"`). |
| `mark` | string `"0".."8"` | FK | Suspicion tag. |
| `playtime` | `{online, boost, queue, server}` | | Aggregate playtime / boost / queue / favourite server (all string). |
| `group_id, expire, group_description, prefix, prefix_rgb, image` | mixed, **nullable** | | Group-assignment payload (§7.2); all `null` when no group. |
| `group` | `{name, color, icon, description}` | | Rendered group badge (special art `QueuePriority`/`Moderator`). |
| `ban` | **singular object** `{id, admin_id, admin_name, date(unix), expire(unix\|"0"), reason, description, steam_id, unban}` \| falsy | | Active/last ban (§8.1). |
| `bans[]` | array `{…same + impact:bool}` | 1:N | Full punishment history (extra `impact` bool per item). |
| `canBan, canUnban, canPermanent, canChangeGroup, canSelfKick, is_you, name_banned, progressiveBan` | **bool** | | Server-provided capability flags = the effective client permission model. |
| `vac` / `steam_info` | `{ban:{vac,ban,days}, squad:{time}}` | | VAC/game-ban + Squad hours. |
| `discord` | string(18) \| `null`/`false` | FK | Discord user id. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` | 1:N | Geo-IP history, **raw IPs** (§3.3). [0]=current. |
| `primetime[]` | `{start, end}` | 1:N | Habitual hours (§3.4). |
| `clans[]` | `{clan_id, name}` | M:N→Clan | Memberships. |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` \| `false` | | Live presence — pivot for all RCON actions. |
| `stats` | object | | Aggregate combat (kill/die/revive/winrate/kit). |
| `comments_count` | int | | Cached comment badge count. |

**`player.php` action surface** (read + write, captured from modal JS; all Destructive writes never fired):

| action | script | `data:{…}` | Response | Destr. |
|---|---|---|---|---|
| `get` | player | `{steam_id}` | `{player}` full entity | N |
| `add` | player | `{steam_id}` | ack; opens new card | Y |
| `mark` | player | `{steam_id, mark(0–8)}` | `{status}` | Y |
| `getComments` | player | `{steam_id}` | `{comments:[{name,date(unix),text}]}` | N |
| `addComment` | player | `{steam_id, text(≤256)}` | ack | Y |
| `changeGroup` | player | `{steam_id, group_id, date, description, prefix, prefix_rgb, image}` | ack | Y |
| `message` | player | `{steam_id, time, msg(≤512), log(bool)}` | ack | Y |
| `addBanName`/`removeBanName` | player | `{name}` | ack | Y |
| `kits` / `kitSave` | player | `{steam_id}` / `{steam_id, kits(JSON {kit:bool})}` | `{kits:[…]}` / ack | N / Y |
| `twink` | player | `{steam_id}` | `{list:[{steam_id,name,perm,min_date,ips:[{loc,date,owner_date}]}]}` | N |
| `twinkOnline` | player | `{steam_id, compare_steam_id, start(unix), end(unix)}` | `{calendar:[…events]}` | N |
| `findFriends` | player | `{steam_id, compare_steam_id}` | `{in_friend:bool}` | N |
| `checkBans` | player | `{steam_id}` | `{projects:[…]}` (§8.4) | N |
| `getPlayerOnlineData` | player | `{steam_id, start, end}` | `{ts:{minute,boost,queue}}` series | N |
| `downloadStat` | player (`post_to_url` form) | `{action, steam_id}` | file | N |

**`squad.php` (RCON) player actions** — require player online, always carry `server_id`:

| action | `data:{…}` | Effect | Destr. |
|---|---|---|---|
| `kick` | `{steam_id, reason_id, description, noReason}` | Kick (`noReason:true`=no-rule) | Y |
| `ban` | `{server_id, steam_id, reason_id, description, days}` | Ban N days (`0`/`-1`=perma) | Y |
| `unban` | `{steam_id, unban(bool)}` | Lift; `unban:true` fully erases | Y |
| `removePlayer` | `{server_id, steam_id}` | Eject from squad | Y |
| `changeTeam` | `{server_id, steam_id}` | Force team swap | Y |
| `kill` | `{server_id, steam_id}` | Kill in-game | Y |

**Shared modal — visibility predicates** (buttons default `display:none`/`.hide`, revealed by `setInfo()`):

| Element | Shown iff |
|---|---|
| Наказать (ban flow) | `canBan` **and** no active ban |
| Убить/Кикнуть без причины | `canBan`/`canSelfKick` **and** `online` truthy |
| Разбанить | active ban **and** `canUnban` |
| Группа (changeGroup) | `canChangeGroup` (**hidden entirely when `!canBan`**) |
| Забанить ник ↔ Разбанить ник | toggled by `name_banned` |
| Сообщение / Команда / Кик из сквада | `online` / `online.team` / `online.squad` present |
| group select + expiry | **disabled** when `is_you` |

#### 3.2 Name history — `{name, date(unix s)}`; **PK** (`steam_id`,`date`). 1:N from Player. Feeds "Другие ники" (Other nicks) + `with_other_names` search. Source: `player.get.names[]`, API `names[]`.

#### 3.3 Location / IP history — `{iso, loc, timezone, lat, lng, ip, date(unix)}`; **PK** (`steam_id`,`date`,`ip`). [0]=current. Holds **raw IPs**; drives Leaflet map, same-IP alt-hunt, dashboard `ips` badge. Source: `player.get.location[]` (render). 1:N from Player, reflexive same-IP link to §3.5.

#### 3.4 Primetime bucket — client `{start, end}`; API `{start(unix), end(unix), cnt(int), sum(int), sort("HH:mm")}`. **PK** (`steam_id`,`start`). Hour-of-day histogram. Source: `player.get.primetime[]`, API `primetime[]` (`caps/api-top`).

#### 3.5 Twin / alt link — `twink` → `list[]` each `{steam_id, name, perm(bool), min_date(unix-delta), ips:[{loc, date(unix), owner_date(unix)}]}`. Two derived relations: `twinkOnline` (session-overlap calendar, keyed `compare_steam_id,start,end`) and `findFriends` (`{in_friend:bool}`). **Reflexive M:N on Player**, materialized on demand from shared-IP + Steam-friends + session overlap; no stored alt-group table.

#### 3.6 Session / online series — `getPlayerOnlineData(steam_id,start,end)` → time-series keyed by ts, each `{minute, boost, queue}`. Granular counterpart of the playtime aggregate; powers the modal activity chart. **PK** (`steam_id`, ts).

#### 3.7 Playtime-by-kit aggregate (`playersOnline` grid) — LIVE

Per-player playtime rollup over a **date-range window**, broken out by kit. Grid: `numrows=100`, `collum=["name","online","boost","SL","CMD","Rifleman","Medic","LAT","MachineGunner","Marksman","Engineer","Pilot","Crewman"]`, columns 2–13 sortable (`order`), default sort = server default (playtime desc). Row-click → `player.open(steam_id)`. Source: `caps/online/playersOnline.network.json`.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string(17) | PK / drill key. |
| `name` | string | Nick. |
| `online` / `boost` / `queue` | string **`"Xч Yм"`** (pre-formatted RU h/m) | Total / boosted / queue playtime in window. `queue` returned but **not columned**. |
| `SL,CMD,Rifleman,Medic,LAT,MachineGunner,Marksman,Engineer,Pilot,Crewman` | string `"Xч Yм"` | Per-kit playtime (11 kits) → implies stored `player_kit_time[steam_id, season, kit]=seconds`. |

Filter: `#playersOnline-user` (`data-search=player`, text), `#playersOnline-period` (daterange → `text["custom.period.startdate/.enddate"]` unix, default `today`), `#playersOnline-server` (multiselect → `multiselect["server_id"]`). **Durations are server-formatted strings** ⇒ sort must run server-side on underlying seconds.

---

### 4. Server & operations domain

#### 4.1 Server — LIVE (`getServer`, `statistics.servers`, settings modal)

**PK** `server_id` (sparse: 1,6,7,8,9,10,11). Read live via **`POST /ajax/squad.php` `action=getServer`** (`data:&server_id=<id>&last_chat_id=<int|false>`), polled every **5000 ms**. The one captured contract is `caps/dashboard/__server_id_1.network.json`.

**Persistent server fields** (from `statistics.servers` map + settings modal):

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | **PK.** |
| `name` | string(≤128) | Display name ("RAAS/AAS #1"). |
| `short` / `ext_short` | string(≤16) | Internal index (A,B,C,E,F,G) / public display index. |
| `ip` | string(15) | Bound IP. `new_ip` = pending after restart. |
| `port` | string(5) | **rnsquad JS-agent port** (default 3000 — per-server Node agent). |
| `pass` | string | RCON/query password (blanked in captures). |
| `licensed` / `license` / `license_valid` | `"0"/"1"` / key / bool | License validity. |
| `disabled` | `"0"/"1"` | Inactive flag. |
| `sort` | string(int) | Drag-order display index. |
| `chan_id` | string | Discord channel id (auto-renamed to live status `🟢c_100x7_👮2`). |
| `types` | list<enum> | Modes: `AAS, RAAS, Invasion, tc, Insurgency, Destruction`. |
| `mods` | list<enum> | Mod flags: `ge, sd, supermod, KOTH, squadZ`. |

**Live `getServer.server` runtime fields** (selected; full spec ch.01 §2.1.1): `map, nextMap, map_start(unix-str), players.active[], players.dis[], squads[], teams[0..1]{short,name,unit}, isConnect(bool), block_start(bool\|{msg,code}), need_restart, outdated, eos_problem, last_restart{…parts,unix}, start_params{ip,port,query}, beacon_port, region, pings{region:ms}, squad_version{version,build}, version, vote{isVote,votes:{yes[],no[]},map,mode:skip|next|current}, calculateOnline{}, stat.online{date[],players[],admins[],queue[]}, monitor[]`. Root envelope adds `you(S64\|false), servers{id:{players,admins,queue}}, ips{ip:count}, panelAdmins[], global_online(int), is_sale(int), isSeeding(bool)`.

**`players.active[]` row** (live roster): `{id, steam_id(17), eos_id(32), name, team("1"/"2"), squad(bool\|id), leader(bool), kit, ip, isAdmin(bool), color(bool\|hex), mark(int), warning(bool), vac(bool), baby(bool), playtime:{date,last_seen (unix MS)}, requests:{admins,report}, location:{iso,country,city}}`. **`squads[]` row:** `{id, name, team, size, locked(bool), cmd(bool), create_id(S64), create_name, eos_id(32), message(bool)}`.

**Server lifecycle actions** (`squad`, all Destructive, `$.question`-confirmed): `start, stop, restart, update{afterMapChange}, rconRestart, parserRestart, cacherRestart, botUpdate, setServerIP{ip}` — all `{server_id}` except `botUpdate` (global). Squad control: `disband, transfer, rename{team,squad}, demote{steam_id}, squadMessage{team,squad,time,msg}`. Messaging: `broadcast{server_id,msg}`. Map: `changeMap{next,map,vote,skip}, clearNext, setRotation{rotation,day}`. RCON: `rconRaw{command}`. Read: `getServerMaps, getRotation, serverMonitor, serverOnline, network, getConfigFiles, getConfigFile, getMods, mapCalendar`(`public`).

#### 4.2 Map layer / Unit (`getServerMaps`, inferred-from-render) — Map: `{map, type(RAAS/AAS/Invasion/…), weather, markers, teams.t_1|t_2:{tickets, default:{faction,unit,prefix,postfix}, factions[]:{name,default,units[]}}}`. Unit: `{roles[], vehicles[]:{name,count,respawn,delay}}`.

#### 4.3 Rotation (`getRotation`) — `{rotation:{lists:{default,"1".."7"}, current(1–7), isWin(bool)}, list:{layer:{teams[]}}, canEdit(bool)}`. **PK** (`server_id`,`day`), day∈{default, 1–7=Mon–Sun}. `lists[day]`=newline-delimited layers (`//` comments honored). Write `setRotation{server_id, rotation(encodeURIComponent), day}`, Destructive; `canEdit=false` ⇒ readonly; `isWin=true` ⇒ weekday tabs hidden.

#### 4.4 Config file (`getConfigFiles`/`getConfigFile`) — `getConfigFiles` → `{files:{<dir>:{files:[{name, date(unix-ms), symlin(bool)}]}}}`; `getConfigFile{server_id,file,dir}` → `{text, hasDefault(bool)}`. **PK** (`server_id`,`dir`,`file`). Write `saveConfigFile{server_id,text(encodeURIComponent),file,dir}` (Y), `reloadConfig{server_id}` (Y), `getDefaultConfig{file}` (N).

#### 4.5 Mod (`getMods`) — `{mods:[{publishedfileid,…}], mod_status:{mod_id,…}}`. **PK** Workshop `mod_id`. Write `installMod{server_id,mod_id,fix}` / `deleteMod{server_id,mod_id}` (Y); 5 s progress poll via `getMods{only_status:true}`.

#### 4.6 Monitor sample (`server.monitor[]`, 60) — each `{date(unix-s), data:{pid, mem, network:{send,receive,format,connections(int)}, cpu[int], disk:{read,write}, freq[str], temp[int], tps}}`. **PK** (`server_id`, ts). `network.connections>300` ⇒ "under attack" banner.

#### 4.7 Network connection (`network`) — `{network:{ips:{ip:{conn[],country,city}}, sockets[]}}`; `blockIP{ip}` firewall (Y). **PK** (`server_id`,`ip`). Live TCP monitor; **unrelated** to the ban network.

#### 4.8 Statistics aggregate (`statistics`) — LIVE

**`POST /ajax/squad.php`** body `&start=<unix>&end=<unix>&servers=<CSV ids>&action=statistics` (note: `servers` is **comma-joined**, not an array). Returns one JSON of pre-aggregated series; values often string-int. Source `caps/games-stats/statistics.network.json`. Not row entities — read-side rollups. Axis-label arrays: `days["DD.MM.YYYY"], hours["HH:00"], dayofweek[RU weekday]`.

| Key | Shape | Meaning |
|---|---|---|
| `online`/`max`/`queue` | `{sid:{day:val}}` | avg online / peak+queue / avg queue |
| `admins`/`maxAdmins` | `{day:val}` | avg / peak admins |
| `bans` | `{day:val}` | punishments issued |
| `new` | `{day:val}` | first-seen players |
| `chat`/`teamkill` | `{sid:{day:val}}` | chat volume / teamkills |
| `games`/`kills`/`death`/`revival`/`wound`/`damage` | `{sid:{day:val}}` | match & combat throughput |
| `onlineHour`/`onlineDay` | `{sid:{HH:00\|weekday:val}}` | online by hour / weekday |
| `modes` | `{AAS,Invasion,RAAS,Seed,Skirmish:count}` | match-count per mode |
| `maps` | `{mapName:count}` (**mixed int/str**) | match-count per map (excl. Skirmish/Seed) |
| `unique`/`kits` | `[]` | empty in this deployment |
| `test` | `{sub:float}` | server-side per-query profiling (info-leak) |

#### 4.9 Seeding priority (`seedingGetPriority(start_day)`) — `{server_list[]:{id,short,name,priority}, day:{min_players, use_unattached}}`. **PK** (`start` day,`server_id`). `priority<999` ⇒ attached. Write `seedingSetPriority{start, data(CSV), min_players, use_unattached}`.

---

### 5. Combat & match domain

#### 5.1 Game / match (`games`) — LIVE

Grid: `numrows=100`, `collum=["server","map","start","end","t1","t2","time","win"]`, **no `order`** (sorting disabled), default newest-first by `start`. Row-click = full nav `window.location='/game/<id>'`. Source `caps/games-stats/games.network.json`.

| Field | Type | Key/notes | Meaning |
|---|---|---|---|
| `id` | string(int) | **PK** | Match id → `/game/<id>`. |
| `server_id` | string(int) | FK→Server | Numeric server FK (filter `server_id`). |
| `server` | string(1) | | Short letter (`<code>[A]</code>`). |
| `start` / `end` | string — **unix s** | | Round start/end (`end` blank/`0` while ongoing). Filter `t1.start`. |
| `map` | string | | Layer name (`Harju RAAS v1`). Filter `t1.map`. |
| `t1` / `t2` | string | | Faction tags/names. |
| `t1_tickets` / `t2_tickets` | string(int) | | Remaining tickets. |
| `win` | enum `"t1"`\|`"t2"`\|`""` | | Winner (empty=draw/ongoing). |
| `is_seed` | `"0"/"1"` | | Seeding round — returned, **not columned/filterable**. |
| `time` | **int** (s) | | Round duration (only int-typed field). |

API `stats.games[]` adds `playtime` (per-player minutes) + `win` as a **status code** (`"0"`,`"3"`, not boolean). Clan `stats.games[]` adds `name, cnt` (clan participants).

#### 5.2 Match detail (per-player) — **GAP**. `/game/<id>` full-page SSR, not captured. Presumed per-player K/D/score, rosters, ticket timeline. Logical **PK** (`game_id`,`steam_id`).

#### 5.3 Combat events — LIVE, one physical event table (`t1`, holds `date`,`server_id`), five projections under swapped player aliases. **PK** event `id`. Source `caps/combat/*.network.json`. Grids: `numrows=500` (k/d/r/dmg), `100` (teamkills); no `order` (sort off); default newest-first; row-click → primary actor.

| Table | numrows | `collum` | Primary `steam_id` | Secondary | Weapon | Extra fields |
|---|---|---|---|---|---|---|
| `playerKills` | 500 | steam_id,server,date,player_name,name,weapon | killer(17) | `victim_steam_id`(17) | `weapon` | `kit, game_id, map` |
| `playerDeath` | 500 | steam_id,server,date,player_name,weapon | deceased(17) | (killer filterable, not shown) | `weapon`(killed-by) | `kit, game_id, map` (**no victim_steam_id/name**) |
| `playerRevive` | 500 | steam_id,server,date,player_name,name | medic(17) | `victim_steam_id`(17) | — | `kit, game_id, map` |
| `playerDamage` | 500 | steam_id,server,date,player_name,name,weapon | attacker(17) | `victim_steam_id`(17) | `weapon` | **`damage`(int) shipped but not columned**; `game_id, map` |
| `playerTeamkill` | 100 | steam_id,server,date,player,killed | offender(17) | — | — | `killed`(HTML), `player`(HTML), `kit`(HTML img), `killed_group`/`player_group`(null); no weapon/victim_steam_id |

Common: `id, steam_id, date(unix s), server(HTML badge), server_id`. Kills makes both parties openable (`#kill_template`); others only the primary. Every combat event = N:1 Player (×1–2) + N:1 Server + (round via `game_id`). **Page-specific `data-search` join aliases** (leaked): kills Кто=`t2.player`/Кого=`t4.player`; deaths/revives/teamkills Кто=`t5.player`/Кого=`t2.player`; damages Кто=`t2.player`/Кого=`t5.player`; all date=`t1.date`, server=`server_id`.

#### 5.4 Kit (usage / denial) — **Usage:** `playerKits` grid `{kit, cnt(minutes)}` → stored `player_kit_time[steam_id,season,kit]`. **Denial:** `kits`→`{kits:[…]}` deny map, `kitSave{steam_id, kits(JSON {kit:bool})}` (Y, license-risk warning). **PK** (`steam_id`,`kit`).

#### 5.5 Weapon stat (profile SSR / API `weapons.weapon{<name>:{cnt,damage,name,image}}`) — per-weapon kills+damage. **PK** (`steam_id`, season, weapon). Profile "Оружие" cards: `{name, kills(fa-crosshairs), damage(fa-explosion)}`.

#### 5.6 Vehicle stat & destruction (profile SSR / API `weapons.vehicle{<name>:{cnt,damage,name}}`) — **Driven** ("Техника"): `{vehicle(localized), kills, damage}`. **Destroyed** ("Уничтожение техники"): `{weapon, vehicle(raw asset id e.g. `T72B3`,`Tigr_RWS`), count}` — keyed by weapon, raw ids confirm parse from kill-log. **PK** (`steam_id`, season, vehicle).

#### 5.7 Skill/lifetime aggregate (profile "Скилл", per season) — `{kd(float), winrate(%), matches, wins, losses, kills, deaths, damage, revives, teamkills, online("Nч Nм")}`. Note wins+losses<matches (draws tracked). API `stats[]` = name/value pairs: `Online, Boost, Favorite kit, Matches, Winrate("W:12 L:18 (40%)"), K/D, Kills, Deaths, Revivals`.

#### 5.8 Season dimension — `all` / `old` (2016-01-01–2023-09-27, pre-ICO) / `1` (Squad 6.0 ICO UE4, →2025-09-03) / `2` (Squad 9.0 UE5, default). All §3.7/§5.4–5.7/§4.8 aggregates partition by season; retention → **2016**. Switch = hard nav `?season=`.

---

### 6. Access-control & monetization domain

#### 6.1 Permission group — fixed enum, **PK** `group_id` / internal `name` (LIVE from `#player_group-groups` + settings `groups` tab):

| group_id | Label (RU/EN) | Internal `name` | Icon (`icon`, no `fa-`) | Color (`color`, no `#`) |
|---|---|---|---|---|
| `0` | -Нет группы- / clears | *(clears)* | — | — |
| `1` | Администратор / Admin | `Admin` | `user-circle-o` | `e50606` |
| `2` | Модератор / Moderator | `Moderator` | `id-badge` | `2df044` |
| `3` | **VIP** | `QueuePriority` | `star` | `e2b032` (per-record) |
| `4` | Камера / Camera | `Cameraman` | `video-camera` | `7d059e` |
| `5` | Стажёр / Trainee | `Intern` | `graduation-cap` | `b57c03` |

Each group carries **21 Squad permission tokens** (`groups` settings tab, LIVE default matrix in ch.16 §16.3): `startvote, changemap⚠, pause, cheat, private, balance, chat, kick⚠, ban⚠, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat` (⚠ = "won't be audit-logged" when done in-game) + `{description(≤32), color(≤16)}`. This is the RBAC vocabulary (mirrors Squad `Admins.cfg`).

#### 6.2 Group assignment — **one per player** (scalar on Player, global, no `server_id`). Written by `changeGroup{steam_id, date(expire unix\|0=infinity), group_id, description(≤128), prefix(≤64), prefix_rgb(≤16 "r,g,b"), image(≤256 URL)}`. Same record grants staff roles AND VIP (grp 3). Read back on `adminPlayers`/`vipPlayers` rows.

#### 6.3 Admin roster (`adminPlayers`) — LIVE

`caps/admins/admins.network.json`. Grid: `numrows=50`, sortable `steam_id,name,group,date,bans` (playtime/boost/discord not). Filter `#adminPlayers-group` (multiselect **1/2/4/5 only**, VIP excluded), `#adminPlayers-period` (daterange → `text["custom.period.startdate/.enddate"]`, default 30 days), `#adminPlayers-name`(`t2.player`).

| Field | Wire type | Meaning |
|---|---|---|
| `steam_id` | **str(36) UUID** | Row key (migrated). |
| `group_id` | str enum `"1".."5"` | Raw group. |
| `expire` | str unix\|`""`/`"0"` | Group expiry. |
| `description, prefix, prefix_rgb, image` | str (may be empty) | Group-assignment cosmetics. |
| `name` | str | Nick (`t2.player`). |
| `date` | str — **unix s** | Last seen. |
| `color` | str(6) hex (no `#`) | Group color. |
| `icon` | str (no `fa-`) | Group icon. |
| `online` | `{online,boost,queue,server}` (all str) | Live presence. |
| `discord`, `bans`, `group`, `time`, `boost` | **pre-rendered HTML** | Discord link / punishments-issued `<kbd>N</kbd>` / group chip / playtime / boost badges. |

#### 6.4 VIP / privilege (`vipPlayers`) — LIVE

`caps/vips/vips.network.json`. Grid: `numrows=50`, `collum=["steam_id","name","expire","date","time","vipdesc"]`, no client sort. Join `t1`(assignment)×`t2`(player). Filter `#vipPlayers-name`(`t2.player`), `-desc`(`t1.description`), `-startdate`/`-enddate`.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | str (`<hashtag>` S64; JSON redacted-36) | Drill key. |
| `group_id` | str enum (sample `"3"`=VIP) | Privilege. |
| `expire` | str **unix s** \| `""` | `""`/`0`=permanent (blank cell). |
| `description` | str(≤128) | Raw note. |
| `vipdesc` | str | **Rendered/expanded** note (distinct from `description`). |
| `prefix`/`prefix_rgb`/`image` | str \| **null** | Cosmetics. |
| `name` | str | Nick. |
| `date` | str **unix s** | Last seen. |
| `color`/`icon` | str `e2b032`/`star` | Group badge. |
| `online` | `{online,boost,queue,server}` | Presence. |
| `group`/`time` | **pre-rendered HTML** | Chip / playtime badge. |

API `/player/vip` (`POST`): grant/extend, `expire` XOR `add` required; → `{msg, expire:{unix,human}, player:{name,steam_id}}`. **VIP = group_id 3**; distinct from clan-scoped reserved slot (§6.7).

#### 6.5 Bonus economy — integer currency `bonus` scalar on Player. Mutated only via API `/player/bonus` (`POST`, `method=add|remove|set`, `amount`) → `{old, new, amount}`. Surfaced on profile, `topPlayers` (`bonuses` col), player card, `playerMark.bonus`.

#### 6.6 Clan (=squad) (`clan.list`/`createSquad`/`/api/clan/get`) — LIVE

**PK** `id`. Bootstrap `clan.data` (captured id 16). Roster/settings ops = `script:'clan'`; create/edit = `script:'squad' action:'createSquad'`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | **PK** (= `clan_id`). |
| `name` | string(≤32) | Display name (`[MDC]`). |
| `tags[]` | string[] | In-game name prefixes; drive tag-protection + `findPlayer`. |
| `discord_id` | string(≤64) \| **null** | Discord **role** id. |
| `date` | string — **unix s** | Creation. |
| `expire` | string — **unix s** \| `"0"` | Priority-subscription expiry (0=infinity). |
| `max` | string(int) | Max priority slots. |
| `protected` | `"0"/"1"` | Tag-protection (auto-kick tag-wearers off roster, ~10 min). |
| `public` | `"0"/"1"` | Public read-only page. |

`clan.list` response envelope: `{access(0/1), players[], servers:{server_id:[Presence]}, discord:[{name,channel}], status, exec_time}`. `clan.stats{start,end}` → `{access, chart:{labels[60],online[60]}, stats:{online,boost,server,primetime[{start,end,cnt,sum,sort}], kill,die,revive(int), top[10]{steam_id,name,kill,die,revive}, games[10]}, status}`. Monetized: inline YooMoney "extend priority" form (receiver `41001649543147`, `sum=1000`).

**Clan actions** (`clan.php` unless noted; all carry `clan_id`):

| action | script | `data:{…}` | Effect | Destr. |
|---|---|---|---|---|
| `list` / `stats` | clan | `clan_id` / `+start,end` | roster+presence / dashboard | N |
| `findPlayer` | clan | `find(≥3)` | `{players:[{steam_id,name,clan_id}]}` | N |
| `addPlayer` | clan | `steam_id, type(0/1/2)` | add member (type>0 gated `clan.canType`) | Y |
| `removePlayer` | clan | `steam_id` | remove | Y |
| `vipPlayer` | clan | `steam_id, vip(bool)` | toggle clan reserved slot | Y |
| `changeExpire` | clan | `date(unix)` | change subscription expiry | Y |
| `setting` | clan | `key(public\|protected), value(bool)` | toggle setting | Y |
| `delete` | clan | `clan_id` | disband (→`/`) | Y (irrev) |
| `createSquad` | **squad** | `id, name, expire, max, discord_id, tags(URL-enc CSV)` | create(empty id)/edit/rename | Y |
| `downloadList`/`downloadOnline` | clan (`post_to_url`) | `clan_id[,start,end]` | file export | N |

#### 6.7 Clan member (`clan.list.players[]`) — LIVE. **PK** (`clan_id`,`steam_id`). M:N Clan↔Player.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string(17) | Member identity (row `data-id`). |
| `name` | string | Nick. |
| `vip` | `"0"/"1"` | Raw VIP flag (not rendered). |
| `type` | `"0"/"1"/"2"` | `1`=Глава/leader, `2`=Зам/deputy, `0`=member. |
| `date` | string — **unix s** | Last seen. |
| `discord` | **bool** | Discord linked (check/cross). |
| `vip_mode` | int `0/1/2` | `1`=priority ON (toggleable), `0`=OFF, `2`=from another source (locked). |
| `access` | **bool** | Per-row remove permission. |
| `online_raw` | int (seconds) | 60-day playtime (sort key). |
| `online` | **HTML string** | Pre-rendered playtime label. |
| `kit` | string | Last kit (`data-kit`). |

`Presence` (`servers[sid][]`): `{name, team, playtime:{date, last_seen}}` — **playtime in JS milliseconds** (13-digit; the roster `date` above is seconds — mixed units in one response). Gates: `access`(int, whole VIP column), `v.access`(per-row remove), `clan.canType`(leader/deputy add), `vip_mode==2`(locked).

---

### 7. Moderation domain

#### 7.1 Ban (`banPlayers`) — LIVE

`caps/bans/bans.network.json`. Grid: `numrows=100`, `collum`/`order=["steam_id","name","reason","date","expire"]` (all sortable). Join `t1`(bans)×`t2`(banned)×`t3`(admin). Filters: `-name`(`t2.player`), `-admin`(`t3.player`), `-reason`(`t1.reason`), `-description`(`t1.description`), `-permanent`(check `permanent`), date range.

| Field | Type | Key/notes | Meaning |
|---|---|---|---|
| `id` | string(numeric) | **PK** (`t1.id`) | `data-id`/`trID-<id>`. |
| `steam_id` | string(17) | FK→Player | Banned identity (`<hashtag>`, hidden col). Still Steam64 here. |
| `name` | string | | Nick at ban time. |
| `reason` | string | | Reason; **embeds expiry as `… до DD.MM.YYYY HH:MM`**. |
| `description` | string(≤512) \| `""` | | Admin comment. |
| `admin_id` | string(17) SteamID64 | FK→Admin | **Issuing admin (raw id, name resolved separately).** |
| `date` | string — **unix s** | | Issued ("Забанен"). |
| `expire` | **pre-rendered HTML** `<span class="badge">DD.MM.YYYY HH:MM</span>` | | NOT a raw ts; permanent renders distinct badge. |
| `unban` | `"0"/"1"` | | `"1"`=revoked (kept in history), `"0"`=active. |
| `impact` | bool (modal only) | | Counts toward progressive escalation. |
| `permanent` | filter-only bool-string | | `expire==0` filter. |

Write (`squad`): `ban{server_id(if online),steam_id,reason_id,description,days(0/-1=perma)}`, `unban{steam_id,unban(true=erase)}` (both Y). API `hasBan`/`hasBanAll` → `{ban(object), ban_count, mark, last_ban(unix)}` (`hasBanAll` per-ban omits `description`). `player.get.ban`=active, `.bans[]`=history (each +`impact`).

#### 7.2 Reason / rule (`#player_ban-reason` `<option>`) — **PK** `value` (rule id, e.g. `1`,`2`,`110`,`160`,`173`,`510`,`520`). Attrs `data-first/second/third/four` = escalating ban-days per 1st–4th offense (cap commonly 30→perma; general `0/0/0/30`, flood `1/1/1/30`). `<optgroup>`: Особые/Общие/Для сквадных/Для техники/Милсим (Special/General/Squad-leaders/Vehicles/Milsim). Editable (but **save serializer is a stub** — `collect()` returns `{}`, Add button disabled) in settings `rules` tab.

#### 7.3 Ban-name (`ban_names`) — LIVE

`caps/bans/bannames.network.json`. Grid: `numrows=100`, `collum=["name","date",["button",…]]`, filter `#ban_names-name`(`t1.name`). **PK** `name`.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Banned nickname (the rule identity key). |
| `date` | string — **unix s** | When added. |
| `button` | int `1` | Render flag → per-row delete button. |

Write `addBanName{name}`/`removeBanName{name}` (`player`, Y). **No severity/regex-flag/scope/expiry/author** exposed (gap). Live catalog ≈ 371.

#### 7.4 Collab-ban (federated) (`collabans`) — LIVE

`caps/bans/collabans.network.json`. Grid: `numrows=100`, `mode:list`, `collum=["steam_id","reason","date","expire"]` (reason/date/expire filled by `projects` callback cards, NOT top-level fields). Filter `-name`(`s.player`), `-reason`(`s.reason`), `-permanent`. **Row is flat** — only `name, steam_id, projects[]`.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string(17) | Player identity (hidden col, row-click). |
| `name` | string | Nick (`<b>` or `Нет ника`/No nick). |
| `projects[]` | array<Project> | Per-community ban breakdown. |

**Project** `{name, admin_name, reason, date(unix s), expire(unix\|"0"), cnt(int)}` — `expire=="0"` ⇒ red "Перманент"; else amber "Временный"/Temporary. **PK** (`steam_id`, project). Live pool ≈ 17 510.

**checkBans** (`player`, `{steam_id}`) → `{projects:[{name, discord?(url), online(seconds), ban:{total(int), current:null|{reason, date(unix), expire(unix|"0")}}}]}` — the trust/attribution model (per-source Discord + online-time). API `/player/hasBanAll` mirror. Federation sync is server/bot-side (`botUpdate` refreshes the enforcement agent); no client import.

#### 7.5 Comment (`playerComments`) — LIVE

`caps/notes/comments.network.json`. Grid: `numrows=100`, `collum=["steam_id","date","admin","player","text"]`. Join `t1`(comment)×`t2`(author admin)×`t5`(target). Filters `-name`(`t5.player`), `-admin`(`t2.player`), `-text`(`t1.text`). **PK** `id`. Live ≈ 1 090.

| Field | Type | Key | Meaning |
|---|---|---|---|
| `id` | str(int) | **PK** | Comment id. |
| `steam_id` | **str(36) UUID** | FK→Player | Target (migrated). |
| `admin_id` | str(17) SteamID64 | FK→Author | Authoring admin. |
| `date` | str — **unix s** | | Written. |
| `text` | str, HTML-double-escaped (`&quot;`) | | Note body (≤256 on create). |
| `admin`/`player` | **pre-rendered HTML** | | Author / target display blocks. |
| `admin_color` | str(6) hex | | Author color. |
| `admin_group` | str(1) | | Author group id. |
| `player_color`/`player_group` | str \| **null** | | Target color/group. |

Write `addComment{steam_id,text(≤256)}` (Y, author stamped server-side); read `getComments{steam_id}`→`{comments:[{name,date(unix),text}]}`. Append-only. API `/player/comments` → `[{id,steam_id,admin_id,date,text,admin_name}]`.

#### 7.6 Mark (`playerMark`) — LIVE

`caps/notes/mark.network.json`. **Single scalar enum on Player** (`mark` 0–8). Grid: `numrows=100`, `collum=["steam_id","player","date","mark","ban"]`. Filters `-name`(`t1.player`), `-mark`(multiselect `mark`, values 1–8, OR filter — no "unmarked"). **PK** `steam_id`. Live ≈ 708.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | **str(36) UUID** | Suspect identity (migrated, row key). |
| `eos_id` | str(32) | EOS id. |
| `name` | str (raw) | Nick. |
| `date` | str — **unix s** | Last seen ("Заходил"). |
| `create_date` | str — **unix s** | **When mark created** (persisted, not columned). |
| `mark` | **pre-rendered HTML** icon | Enum→icon (§9). |
| `bonus` | str(int) | Bonus balance. |
| `discord` | str(18) snowflake | Discord id. |
| `color` | str(6) hex | Nick color. |
| `player_group` | str(1) | Group id. |
| `ban`/`player` | **pre-rendered HTML** | Ban-status label / player block. |

Write `mark{steam_id, mark(0–8)}` (Y; `0`=clear; **no confirm dialog**). One mark at a time; `create_date` stored but **no author** field (gap).

#### 7.7 Audit log entry (`logs`) — LIVE

`caps/logs/logs.network.json`. Grid: `numrows=100`, `collum=["serverName","name","date","log"]`, **no `order`** (sort off). Filters `-user`(`t2.player`), `-name`(`t1.log`), `-startdate`/`-enddate`(`t1.startdate`/`t1.enddate`), `-server`(`server_id`). **PK** `id`. Live ≈ 110 488.

| Field | Type | Key | Meaning |
|---|---|---|---|
| `id` | str(numeric) | **PK** | Auto-inc (newest-first); `trID-<id>`. |
| `server_id` | str(int) | FK→Server | `"0"`=panel-global (login) ⇒ empty `serverName`. |
| `steam_id` | **str(36) UUID** | | Event subject — **returned but never rendered** (unmapped). |
| `date` | str — **unix s** | | Event time. |
| `log` | **free-text HTML** | | Rendered RU string; embeds `<b>`,`<i>`,`<hashtag>SteamID64</hashtag>` (drill-down keys off the S64 in prose, NOT the row `steam_id`). |
| `name` | str | | Acting admin nick. |
| `serverName` | str (may be empty) | | Denormalized server label. |

`log` is **free text, not normalized** — filter is substring on `t1.log`. Templates observed: `Авторизовался`(login, srv 0), `Зашёл в камеру`(admin-cam), `Забанил <b>{name}</b> <hashtag>{s64}</hashtag> на <b>{N}</b> дн …`, `Разбанил …`, `Отправил сообщение …`. In-game `changemap`/`kick`/`ban` bypass this log (§6.1 ⚠).

---

### 8. Community & communications domain

#### 8.1 Chat message (`playerChat`) — code-derived (live capture crashed)

Grid: `numrows=300`, `collum=["steam_id","server","date","team","name","type","msg","play"]`, `order=["date"]` (only date sortable). Filters `-name`(`t2.player`), `-msg`(`t1.msg`, **maxlength 17**), `-server`(`server_id`), `-type`(multiselect), `-obscene`(check), `-date`(`t1.date`). Join `t1`(chat)×`t2`(player). **PK** `id`. Field spelling proxied from live-feed `data.chat[]`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string/int | **PK**. |
| `steam_id` | string(17) | Author (hidden col, row-click). |
| `server`/`server_id` | int→label | Origin server. |
| `date` | **unix s** | Message time. |
| `team` | int enum | Faction → `/assets/img/ico/teams/<team>.png`. |
| `name` | string | Author nick. |
| `color` | hex(no `#`) \| null | Author color (live feed). |
| `type` | enum object `{name,color}` (grid) / `{name,color,icon}` (feed) | Scope badge. |
| `msg` | string | Body (client profanity-flagged). |
| `play` | empty | UI-only TTS cell. |

`type` enum: `ChatAll`(Всем), `ChatTeam`(Команда), `ChatSquad`(Сквад), `ChatAdmin`(Админ чат), `broadcast`(gold). Outbound (write): `broadcast{server_id,msg(≥2)}`(squad,Y), `message{steam_id,time,msg(≤512),log}`(player,Y), `squadMessage{server_id,team,squad,time,msg(≤512)}`(squad,Y). API `/server/chat` → top-level `chat[]` (last 100).

#### 8.2 Vote (`votes`) — LIVE

`caps/votes-reports/votes.network.json`. Grid: `numrows=30`, `mode:custom` (card list, `collum:[]`, no sort), template `#template>li`. Filter `#votes-server`(`server_id`) only. **PK** `id`. Live ≈ 3 991.

| Field | Type | Meaning |
|---|---|---|
| `id` | str(numeric) | **PK** (auto-inc). |
| `server_id` | str(int) | FK→Server. |
| `date` | str **`"HH:MM [DD.MM.YYYY]"`** | Pre-formatted (NOT unix). |
| `steam_id` | str(17) | Initiator (→`player.open`). |
| `name` | str | Initiator nick. |
| `short` | str(1) | Server tag (`<kbd>`). |
| `mode` | str enum RU (`"Пропуск карты"`=map skip; also change/re-roll) | Vote type. |
| `map_current`/`map_next`/`map_vote` | str | Current / next / target (`-`=N/A). |
| `players_sum`/`players_need` | str(int) | Collected / required (threshold). |
| `duration` | str(int s) | Vote window — **not rendered**. |
| `cancel` | **HTML** `<span class="label">` | Status badge. |
| `votes` | str **JSON** `{"yes":[…S64…]}` | **Full per-voter roster — not bound to any card** (dark data). |
| `map_current_img`/`map_next_img` | **HTML** | Map thumbnails. |

FK→initiator Player + Server. No destructive action of its own.

#### 8.3 Report (`reports`) — LIVE (0 rows this account; schema from `#template` + aliases)

`caps/votes-reports/reports.network.json`. Grid: `numrows=30`, `mode:custom`, `callback.date→formatDate`. Filters `-name`(`t2.player`), `-killed`(`t1.text` — mis-named copy-paste), `-server`. Join `t1`(reports)×`t2`(target player).

| Field (`data-table`) | Type | Meaning |
|---|---|---|
| `short` | str | Server tag (`<kbd>`). |
| `date` | str/int | Timestamp (client `formatDate`). |
| `player_name` | str | **Reported (target)** nick. |
| `steam_id` | str(17) | Target identity (→`player.open`). |
| `text` | str | Free-text report body. |

**Reporter identity NOT surfaced**; **no lifecycle/status/assignee/resolution** field or verb (gap).

#### 8.4 Issue (bug tracker) (`issues_get`/`issues_create`) — LIVE

`caps/issues-video/issues.network.json`. **`POST /ajax/squad.php`** `action=issues_get` (`state=open|closed&page`, page size 20) → `{issues:[…], status, exec_time, test:{getAdmin}}`. **PK** `id`.

| Field | Type | Rendered? | Meaning |
|---|---|---|---|
| `id` | int | Yes (`<hashtag>#id`) | Ticket number. |
| `user` | string | **No** | Reporter admin account (captured, hidden). |
| `title` | string | Yes | Server-derived (NOT a create input). |
| `body` | string(≤512) | Yes | Description. |
| `create` | **int unix** | Yes | Creation. |
| `update` | **int unix** | No | Last-modified (==`create`, unused). |
| `state` | enum `open`\|`closed` | Yes | Lifecycle. |
| `labels[]` | array<Label> | Yes | Category tags. |

**Label** `{id(1=Баг/Bug/`#e11d21`, 2=Предложение/Suggestion/`#207de5`), name, color(no `#`), url(empty)}`. Write `issues_create{body(≤512), labels(CSV int)}` (squad, Y). **No close/reopen/edit/comment/delete** UI (create+read only).

#### 8.5 Video / demo + upload token — LIVE (code)

`caps/issues-video/video.network.json`. **Video upload** `uploadVideo` (**`POST /ajax/public.php`**, multipart): `{name, description, file(MP4/AVI ≤2 GB), token(str\|null)}`. **No FK** to match/player/report — free-text only (gap). Fan-out Browser→SQSTAT→YouTube+Telegram. **Upload token** `uploadVideo_token` (`POST /ajax/squad.php`, `data:{}`) → `{token}` — single-use, 2-hour delegated credential. **PK** `token`. Two-endpoint auth split (squad mint / public consume).

#### 8.6 User settings (`saveUserSettings`) — JSON blob per self: `{lang: ru|en, theme: 0|dark, show_country: hide|show}`. **PK** owner `steam_id`. Reloads on save.

#### 8.7 Discord config / webhooks (settings `discordbot`/`discord` tabs) — LIVE, panel-global (not per-player). **Gamification engine:** `guild_id`, role-sync toggles+ids (`vip_sync`/`vip_id`, `moderator_sync`, `moderatorInactive_*`, `customRole_*`, leaderboard roles `top1Kill`/`top1Medic`/`topCMD`/`topSL`/`topVehicle`/`topMortar`/`clanKiller`/`pilot`/`knifeKiller`, `seeders_*` + `seeders_hours`, tiered `playtime{100,300,500,1000,2000,3000,5000}_id`). **Webhooks:** `{report, log, alert(+alert_everyone), cheater, grief, crash, endmatch(+endmatch_broadcast), weekend, monitoring(+monitoring_id), request, collab_ban, collab_warn}` each with `_enabled` flag. **SECURITY:** six webhook URLs (`log, weekend, monitoring, request, collab_ban, collab_warn`) render **live bot tokens** into page HTML `value=""` — do not replicate.

---

### 9. Enum & value-set appendix (LIVE)

| Enum | Field(s) | Values |
|---|---|---|
| Group | `group_id` | `0` none/clear, `1` Admin, `2` Moderator, `3` VIP(`QueuePriority`), `4` Camera(`Cameraman`), `5` Trainee(`Intern`) |
| Mark | `mark` | `1` WallHack, `2` AimBot, `3` SpeedHack, `4` object-spawn, `5` reload-exploit, `6` grief, `7` config, `8` toxic, `0` clear |
| Chat type | `type` | `ChatAll, ChatTeam, ChatSquad, ChatAdmin, broadcast` |
| Vote mode | `votes.mode` | RU strings — `Пропуск карты`(skip), + change/re-roll; live `getServer.vote.mode` ∈ `skip`\|`next`\|`current` |
| Game winner | `games.win` | `"t1"`, `"t2"`, `""`; API `stats.games[].win` = status codes (`"0"`,`"3"`) |
| Ban unban | `banPlayers.unban` | `"0"` active, `"1"` revoked-kept |
| Clan member role | `type` | `0` member, `1` Глава/leader, `2` Зам/deputy |
| Clan VIP mode | `vip_mode` | `0` off, `1` on, `2` external-locked |
| Issue state | `state` | `open`, `closed` |
| Issue label | `labels[].id` | `1` Баг(red), `2` Предложение(blue) |
| Server modes | `types` | `AAS, RAAS, Invasion, tc, Insurgency, Destruction` |
| Server mods | `mods` | `ge, sd, supermod, KOTH, squadZ` |
| Stat modes | `modes` | `AAS, Invasion, RAAS, Seed, Skirmish` |
| Season | `?season=` | `all`, `old`, `1`, `2`(default) |
| Message cadence | `time` | `1`(once), `30`, `40`, `60`(default), `90`, `120` s |
| Ban duration radio | `player_ban-reason_type` `data-day` | `-1`(kick), `1,2,3,4,5,6,7,10,14,30`, `0`(perma) |
| 21 permission tokens | group perms | `startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat` |
| Kits (playtime cols) | — | `SL, CMD, Rifleman, Medic, LAT, MachineGunner, Marksman, Engineer, Pilot, Crewman` |
| Server ids | `server_id` | `1, 6, 7, 8, 9, 10, 11` (+ `0` = panel-global audit) |

---

### 10. Unix-timestamp field index (unit trap)

**String unix SECONDS** (10-digit): `player.date/create_date`, `names[].date`, `location[].date`, `primetime[].start/end`, ban `date`/`expire`(raw, when not pre-rendered), comment `date`, mark `date`/`create_date`, log `date`, game `start`/`end`, combat `date`, chat `date`, ban_name `date`, collab-ban project `date`/`expire`, clan `date`/`expire`, clan member `date`, vote `duration`(seconds count), group `expire`, VIP `expire`, seeding day keys, statistics `start`/`end`, issue `create`/`update`, API `map_start`, `checkBans.ban.current.date/expire`.

**INT JS MILLISECONDS** (13-digit): `players.active[].playtime.{date,last_seen}`, `clan.list servers[].playtime.{date,last_seen}`, `getConfigFiles files[].date`, API `stat.players[].playtime.{date,last_seen}`, API `clan.players[].online.playtime.{date,last_seen}`.

**Pre-formatted strings (NOT parseable as unix):** `banPlayers.expire`(HTML badge), `votes.date`(`"HH:MM [DD.MM.YYYY]"`), all `playersOnline`/`adminPlayers`/`vipPlayers` duration cells (`"Xч Yм"`).

---

### 11. Relationship / ER overview

#### 11.1 Central hub

**Player (`steam_id`)** = hub; **Server (`server_id`)** = secondary hub.

```
                         ┌───────── Name-history (1:N)
                         ├───────── Location/IP (1:N)  ── same-IP ──┐
                         ├───────── Primetime (1:N)                 │
                         ├───────── Session-series (1:N)            │ (reflexive
                         ├───────── Playtime/Kit-time (1:N/season)  │  alt/twin
   Group ──(0..1)────────┤                                          │  M:N via
   (group_id enum,       │   ┌── Twin/alt link (M:N, reflexive) ◄───┘  shared IP
    global scalar)       │   │                                         + friends)
   Clan (clan_id) ──M:N──┤◄──┘
   (clan_member,         │
    type/vip_mode)       ●  PLAYER (steam_id ∈ {UUID | Steam64})──────┐
                        /│\                                            │
        author │        │ │ target        actor │ │ target            │
        ┌──────┘        │ │        ┌────────────┘ │                   │
     Comment(N:1×2)  Ban(N:1 +admin N:1)  Kill/Death/Revive/          │
     Mark(1:1 enum)  Ban-name(by name)    Damage/Teamkill (N:1×1–2,   │
     Audit-log(admin N:1) Collab-ban ──M:N── Project                  │
                         │  online.server.id / server_id              │
                         ▼                                            ▼
                      SERVER (server_id) ◄──── Chat, Vote, Report, Game,
                        │                       Combat-events, Statistics,
                        ├── Rotation (1:N /day)  Audit-log, Session, Monitor
                        ├── Config-file (1:N)
                        ├── Mod (1:N)
                        ├── Network-conn (1:N)
                        └── Seeding-priority (1:N /day)

   Game (id) ──1:N── Match-detail (per player)   [/game/<id>, GAP — not captured]
   Video ── (no FK) ── free-text only
   Bonus / VIP / User-settings / Mark ── scalar on Player
   Discord-config ── panel-global (not per-player)
```

#### 11.2 Foreign-key matrix (→ = "references")

| Entity | →Player | →Server | →Clan | →Game | →Group | →Project | →Admin(Player) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Name-history / Location / Primetime / Session / Kit-time | ✓ | | | | | | |
| Twin/alt link | ✓×2 (reflexive) | | | | | | |
| Group assignment | ✓ | | | ✓(grp) | | | |
| Admin roster / VIP | ✓ | (presence) | | | ✓ | | |
| Clan member | ✓ | (per srv) | ✓ | | | | |
| Ban | ✓ | ✓(if live) | | | | | ✓ |
| Ban-name | (by nick) | | | | | | |
| Collab-ban | ✓ | | | | | ✓ | ✓(per proj) |
| Comment | ✓ | | | | | | ✓ |
| Mark | ✓(1:1) | | | | | | |
| Audit-log | ✓(hashtag+uuid) | ✓ | | | | | ✓ |
| Chat / Vote(init) / Report(target) | ✓ | ✓ | | | | | |
| Game | | ✓ | | — | | | |
| Match-detail | ✓ | ✓ | | ✓ | | | |
| Kill/Death/Revive/Damage/Teamkill | ✓×1–2 | ✓ | | (game_id) | | | |
| Kit / Weapon / Vehicle stat | ✓ | | | | | | |
| Statistics | (aggregate) | ✓ | | (aggregate) | | | |
| Video | (prose only) | | | | | | |

#### 11.3 Cardinality highlights

- **Player 1:1 Mark** and **Player 1:1 Group** (scalars, not join tables) — one mark + one group at a time.
- **Player M:N Clan** via Clan-member (role `type`, clan-scoped `vip_mode`).
- **Player M:N Player** (reflexive) via Twin/alt — materialized on demand.
- **Player M:N Project** via Collab-ban (federated reputation, keyed Steam64).
- **Combat event N:1 Player twice + N:1 Server** — one physical event table (`t1`), five view projections.
- **Game 1:N Match-detail** — the only entity whose schema is a documented gap.

---

### 12. Gaps / not observable from the client

1. **Match-detail (`/game/<id>`)** — per-player round scoreboard SSR, not captured (ch.12). PK (`game_id`,`steam_id`).
2. **Column DDL/constraints** — types are wire-observed (all JSON strings); no schema dump.
3. **`steam_id` identity type on `vipPlayers` JSON** — redacted to 36 chars; raw Steam64 vs UUID unconfirmed (ch.06). The UUID migration is **partial** — event/archive tables + public API still Steam64.
4. **Ban-name matching semantics** (exact/substring/regex) + author/scope/severity/expiry — not exposed (ch.10).
5. **Mark authorship** — `create_date` stored, but no who-set/history (ch.08).
6. **Report reporter identity + lifecycle** — absent (ch.14).
7. **Video ↔ case linkage** — no FK to match/player/report (ch.15).
8. **Federation sync mechanism** — how Collab-bans propagate is server/bot-side (ch.10).
9. **Statistics** are pre-aggregated series, not queryable rows (ch.11); `unique`/`kits` shipped empty.
10. **Chat `data.row` field spelling** — proxied from live-feed `data.chat[]` (capture crashed, ch.02).
11. **Seeding/user-settings/Discord-config server schemas** — inferred from payloads (ch.04,16). Rules-tab save serializer is a **stub** (inert).

> For who-may-mutate governance see **chapter 90 (Permissions & Groups)**; for per-player forensic storage see **chapter 92**; for the full action/RPC/RCON surface see **chapter 93**.
