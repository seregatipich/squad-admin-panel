## Entity & Data Model (Synthesis)

> Cross-cutting synthesis chapter. This consolidates **every entity** observable across the SQSTAT panel (`breaking.sqstat.ru`) into one unified data-model reference: fields (with meaning/type), primary key, and relationships. It is reconstructed by triangulating the per-section chapters (01–20), the `buildTable` `collum` arrays and `data-search` SQL aliases leaked to the client, the `Action({script, action, data})` payloads catalogued in `action_catalog.txt`, and the publicly documented REST responses (chapter **19 — API**). The panel is PHP + a MySQL-family relational store; column types below are **inferred** from client usage, not from a schema dump (see §12 Gaps).

**How to read this chapter.** Nothing here is invented: each entity cites the chapter(s) and the concrete artifact (table name, action id, `data-search` alias, or API field block) it was reconstructed from. Where a page only *embeds* the shared player-detail modal, the modal's fields are attributed to the **Player** entity (chapter **03 — Players**), never to the host page (per the shared-modal separation rule used throughout 02, 08, 09, 10, 13, 14, 17, 20).

---

### 1. Identity model — the spine of the schema

Almost every entity foreign-keys to a **player identity**. SQSTAT carries a multi-key identity graph (chapters 03, 04, 07, 19):

| Identity key | Type | Role | Where authoritative |
|---|---|---|---|
| `steam_id` | string, SteamID64 (17-digit) | **Primary player key** across the entire panel and the public API. Rendered in a `<hashtag>` element everywhere; the click target for the shared modal. | Player, and FK on nearly every other entity |
| `eos_id` | string | Epic Online Services ID — Squad's newer engine identity; carried alongside `steam_id`. | Player, Match roster, live dashboard rows |
| `discord` | string (Discord user/role id) | Links a player to a Discord account (and clans to a Discord **role**). Drives the Discord gamification/role-sync engine (ch. 16). | Player, Clan |
| `admin_id` | SteamID64 of the acting staff member | Authorship key on bans, comments, audit log. Same value space as `steam_id` (admins are players with a group). | Ban, Comment, Log |
| `server_id` | int (non-contiguous PK: 1, 6, 7, 9, 10, 11) | **Primary server key**; sparse ids confirm servers are soft-deleted, not renumbered (ch. 11, 12, 13, 17). | Server, and FK on every per-server event |

Key structural fact (ch. 00, 05): **`squad.*` actions are per-server** (always send `server_id`), while **`player.*` actions are global** (no `server_id`). This bifurcation — a global player-record layer vs. a per-server live/RCON layer — is the single most important shape of the data model.

---

### 2. Master entity catalog

| # | Entity | Primary key | Reconstructed from (table / action / API) | RPC script | Chapter |
|---|---|---|---|---|---|
| 1 | **Player** | `steam_id` | `player.get` / `allPlayers` table / `/api/player/info` | `player` | 03, 04, 07 |
| 2 | **Name history** | (`steam_id`, `date`) | `player.info.names[]` / API `names[]` | `player` | 03, 19 |
| 3 | **Location / IP history** | (`steam_id`, `date`, `ip`) | `player.info.location[]` | `player` | 03, 07 |
| 4 | **Primetime bucket** | (`steam_id`, `start`) | `player.info.primetime[]` / API `primetime[]` | `player` | 03, 19 |
| 5 | **Twin / alt link** | (`steam_id`, `compare_steam_id`) | `twink` / `twinkOnline` / `findFriends` | `player` | 03, 07 |
| 6 | **Session / online series** | (`steam_id`, timestamp) | `getPlayerOnlineData` → `{minute,boost,queue}` | `player` | 03, 07, 20 |
| 7 | **Playtime aggregate** | `steam_id` (per season) | `player.info.playtime` / `playersOnline` table / API `stats` | `player`/`table` | 04, 07 |
| 8 | **Server** | `server_id` | `getServer` / settings `servers` list / stats `var servers` | `squad`/`settings` | 01, 11, 16 |
| 9 | **IP / network connection** | (`server_id`, `ip`) | `network` action → `network.ips{}` | `squad` | 01 |
| 10 | **Mod** | `mod_id` (Workshop id) | `getMods` / `installMod` / `deleteMod` | `squad` | 01, 16 |
| 11 | **Rotation** | (`server_id`, `day`) | `getRotation` / `setRotation` | `squad` | 01, 16 |
| 12 | **Config file** | (`server_id`, `dir`, `file`) | `getConfigFiles` / `saveConfigFile` | `squad` | 01, 16 |
| 13 | **Server monitor sample** | (`server_id`, timestamp) | `serverMonitor` time-series | `squad` | 01 |
| 14 | **Seeding priority (per day)** | (`start` day, `server_id`) | `seedingGetPriority` / `seedingSetPriority` | `squad` | 04 |
| 15 | **Permission group** | `group_id` (0–5) / group `name` | `changeGroup` select / settings `groups` tab | `player`/`settings` | 05, 06, 16 |
| 16 | **Group assignment** | `steam_id` (one per player) | `changeGroup` payload / `vipPlayers` table | `player` | 05, 06 |
| 17 | **Admin roster row** | `steam_id` (has `group_id`) | `adminPlayers` table | `table` | 05 |
| 18 | **VIP / privilege** | `steam_id` (group_id=3) | `vipPlayers` table / API `/player/vip` | `player` | 06, 19 |
| 19 | **Clan (== squad)** | `id` (`clan_id`) | `clan.list` / `createSquad` / `/api/clan/get` | `clan`/`squad` | 18, 04 |
| 20 | **Clan member** | (`clan_id`, `steam_id`) | `clan.list` → `players[]` | `clan` | 18 |
| 21 | **Bonus economy** | `steam_id` (balance) | `player.info.bonus` / `/api/player/bonus` | `player` (API) | 04, 19, 20 |
| 22 | **Ban** | `id` (ban row) | `banPlayers` table / `player.info.bans[]` / `/api/player/hasBan` | `squad`(write)/`table`(read) | 09, 19 |
| 23 | **Ban-name (nickname blacklist)** | `name` | `ban_names` table / `addBanName` | `player`/`table` | 10 |
| 24 | **Collab / Ru-Ban (federated ban)** | (`steam_id`, project) | `collabans` table / `checkBans` | `player`/`table` | 10, 19 |
| 25 | **Project (federation source)** | project `name` | `checkBans` → `projects[]` / `#project_template` | `player` | 10 |
| 26 | **Comment (admin note)** | `id` (comment row) | `playerComments` table / `getComments` / `/api/player/comments` | `player`/`table` | 08, 19 |
| 27 | **Mark (suspicion flag)** | `steam_id` (one enum) | `playerMark` table / `mark` action | `player`/`table` | 08 |
| 28 | **Audit log entry** | `id` (log row, alias `t1`) | `logs` table | `table` | 17 |
| 29 | **Game / match** | `id` (game id) | `games` table / `/game/<id>` / `/api/player/stats` games[] | `table` | 12, 04 |
| 30 | **Match detail (per-player)** | (`game_id`, `steam_id`) | `/game/<id>` (server-rendered, NOT captured) | — | 12 (gap) |
| 31 | **Kill event** | event `id` (alias `t1`) | `playerKills` table | `table` | 13 |
| 32 | **Death event** | event `id` | `playerDeath` table | `table` | 13 |
| 33 | **Revive event** | event `id` | `playerRevive` table | `table` | 13 |
| 34 | **Damage event** | event `id` | `playerDamage` table | `table` | 13 |
| 35 | **Teamkill event** | event `id` | `playerTeamkill` table | `table` | 13 |
| 36 | **Kit (usage / denial)** | (`steam_id`, `kit`) | `playerKits` table / `kits`+`kitSave` | `player` | 03, 04 |
| 37 | **Weapon stat** | (`steam_id`, season, `weapon`) | player profile weapon cards / API `weapons[]` | (profile) | 04, 19 |
| 38 | **Vehicle stat / destruction** | (`steam_id`, season, vehicle) | player profile vehicle tables | (profile) | 04 |
| 39 | **Chat message** | (`t1`) row | `playerChat` table / `/api/server/chat` | `table` | 02, 19 |
| 40 | **Vote** | vote row | `votes` table | `table` | 14 |
| 41 | **Report** | (`t1`) row | `reports` table | `table` | 14 |
| 42 | **Issue (bug tracker)** | `id` | `issues_get` / `issues_create` | `squad` | 15 |
| 43 | **Video / demo** | (upload) | `uploadVideo` FormData | `public` | 15 |
| 44 | **Upload token** | `token` | `uploadVideo_token` | `squad` | 15 |
| 45 | **Season (dimension)** | `all`/`old`/`1`/`2` | player profile `?season=` | — | 04 |
| 46 | **Statistics aggregate** | (server_id, day/hour/weekday) | `statistics` action payload | `squad` | 11 |
| 47 | **User settings** | `steam_id` (self) | `saveUserSettings` JSON blob | `player` | 04, 16 |
| 48 | **Discord config / webhooks** | (panel-global) | settings `discordbot`/`discord` tabs | `settings` | 16 |

---

### 3. Player & identity domain

#### 3.1 Player (`player.info`) — the richest entity (ch. 03, 04, 07, 19)

Loaded by `Action({script:'player', action:'get', data:{steam_id}})`. This is the app's central record; the shared modal reads it on every page.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string(17) | **PK** — SteamID64. |
| `eos_id` | string | Epic Online Services id. |
| `name` | string | Current nickname. |
| `names[]` | `{name, date}` | Historical nicknames → **Name-history** entity (§3.2). |
| `date` | ts | Last login ("Заходил"). |
| `create_date` | ts | First seen ("Создан"). |
| `baby` | bool | New/young account (<~30 h) risk flag. |
| `bonus` | number | Bonus-point balance → **Bonus economy** (§7.5). |
| `playtime` | `{online, boost, server}` | Aggregate playtime, boost/seeding time, favourite server. |
| `mark` | int 0–8 | Suspicion tag → **Mark** entity (§8.6). |
| `group` | `{name, color, icon, description}` | Rendered group badge (special art for `QueuePriority`/`Moderator`). |
| `group_id, expire, group_description, prefix, prefix_rgb, image` | mixed | Group-assignment payload (§7.2). |
| `ban` | `{expire, reason, admin_name, date, description}` | Active ban (or falsy). |
| `bans[]` | `{admin_name, date, reason, description, impact, unban}` | Full punishment history → **Ban** entity (§8.1). |
| `canBan, canUnban, canPermanent, canChangeGroup, canSelfKick, is_you, name_banned, progressiveBan` | bool | Server-provided **capability flags** — the effective client-visible permission model (ch. 05 §3.3). |
| `vac` / `steam_info` | `{ban:{vac,ban,days}, squad:{time}}` | Steam VAC/game-ban enrichment + Squad hours. |
| `discord` | string \| false | Discord user id. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history → **Location/IP** entity (§3.3). |
| `primetime[]` | `{start, end}` | Habitual active-hours → **Primetime** entity (§3.4). |
| `clans[]` | `{clan_id, name}` | Clan memberships (M:N to **Clan**). |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` \| false | Live presence — pivot for all live RCON actions. |
| `stats` | object | Aggregate combat stats (kill/die/revive/winrate/kit). |

Auxiliary counters delivered with the card: `comments_count` (badge on the comments drawer, ch. 08).

#### 3.2 Name history (ch. 03, 19)
`{name, date}`; **PK** (`steam_id`, `date`). One-to-many from Player. Feeds "Другие ники" dropdown and the `with_other_names` search extension.

#### 3.3 Location / IP history (ch. 03, 07)
`{iso, loc, timezone, lat, lng, ip, date}`; **PK** (`steam_id`, `date`, `ip`). First element = current. Holds **raw IP addresses**; drives the Leaflet map, the same-IP alt-hunt, and the dashboard `location.same` "N players share this IP" badge.

#### 3.4 Primetime bucket (ch. 03, 19)
`{start, end}` (client) / `{start, end, cnt, sum, sort}` (API). Hour-of-day activity histogram per player. **PK** (`steam_id`, `start`).

#### 3.5 Twin / alt link (ch. 03 §4.3, 07)
Result of `twink` → `text.list[]`, each `{steam_id, name, perm, min_date, ips[]}` where `ips[]` = `{loc, date, owner_date}` shared-IP hits. Two derived relations:
- `twinkOnline` — co-presence overlay of two accounts' sessions (`compare_steam_id, start, end`).
- `findFriends` — Steam-friends boolean (`in_friend`) between (`steam_id`, `compare_steam_id`).

This is a reflexive M:N **self-relationship on Player**, materialized on demand from shared-IP + Steam-friends + session overlap. No stored "alt group" table is exposed.

#### 3.6 Session / online series (ch. 03, 07, 20)
`getPlayerOnlineData(steam_id, start, end)` → time-series keyed by timestamp, each `{minute, boost, queue}`. Granular counterpart of the playtime aggregate; powers the modal activity chart and (unrealized) time-windowed leaderboards.

#### 3.7 Playtime aggregate & per-role playtime (ch. 04, 07)
Denormalized **per-player, per-season** rollup: `{online, boost, server}` plus per-kit playtime buckets. The `playersOnline` table projects this as 11 kit columns (`SL, CMD, Rifleman, Medic, LAT, MachineGunner, Marksman, Engineer, Pilot, Crewman`) — implying a stored `player_kit_time[steam_id, season, kit] = seconds`.

---

### 4. Server & operations domain

#### 4.1 Server (ch. 01, 11, 12, 16)
**PK** `server_id` (sparse ids). Union of the stats `var servers` object, the settings modal, and live `getServer`:

| Field | Type | Meaning |
|---|---|---|
| `id` | int | PK. |
| `name` | string | Full display name ("RAAS/AAS #1"). |
| `short` / `ext_short` | string | Internal 1-letter index (A,B,C,E,F,G) / public display index. |
| `ip` / `new_ip` | string | Bound IP / pending IP after restart. |
| `port` | int | **rnsquad JS-agent port** (default 3000 — confirms an out-of-process Node agent per server). |
| `start_params.port/.query/.beacon_port` | int | Game / Steam-query / RCON-beacon ports. |
| `pass` | string | RCON/query password (blanked in captures). |
| `license` / `licensed` / `license_valid` | key/bool | License key + validity. |
| `disabled` | bool | Inactive flag. |
| `sort` | int | Drag-order display index. |
| `chan_id` | string | Discord channel id (auto-renamed to a live status string). |
| `types` | set | Enabled modes: AAS, RAAS, Invasion, tc, Insurgency, Destruction. |
| `mods` | set | Enabled mod flags: ge, sd, supermod, KOTH, squadZ. |
| `version`/`build`/`region`/`cores`/`mem`/`EOS_ping`/`EOS_online` | mixed | Live health/telemetry (from `getServer`). |
| `teams[0..1]` | `{short, name, unit}` | Current factions. |
| `vote` | `{isVote, mode, map, votes:{yes[],no[]}}` | Live in-game map vote. |

Related read-only children: **Server-monitor sample** (`serverMonitor` → `{mem, network_send/receive, disk_read/write, tps, network_connections}` per timestamp) and the online timelines `serverOnline` / `serverOnlineAdmins` / `serverOnlineBooster`.

#### 4.2 IP / network connection (ch. 01)
`network` action → `network.ips{ip:{conn[], country, city}}` and `network.sockets[]`. Live TCP monitor with geolocation; a `blockIP(ip)` firewall action. **Unrelated to the ban network** (ch. 10 §10.3.5 caveat).

#### 4.3 Mod (ch. 01, 16)
`getMods` → `{mods[], mod_status}`. **PK** Workshop `mod_id`. Fields: title, description, `mod_id`, updated date. Install/remove with a 5 s progress poller.

#### 4.4 Rotation (ch. 01, 16)
`getRotation` → `{rotation:{lists:{default,1..7}, current, isWin}, list, canEdit}`. **PK** (`server_id`, `day`), day ∈ {default, 1–7 = Mon–Sun}. `lists[day]` is a newline-delimited layer list (`//` comments honored). Per-weekday scheduling; `isWin` = win-based mode.

#### 4.5 Config file (ch. 01, 16)
`getConfigFiles` → `{files:{<dir>:{files:[{name, date, symlin}]}}}`; `getConfigFile(server_id, file, dir)` → `{text, hasDefault}`. **PK** (`server_id`, `dir`, `file`). Edited via CodeMirror; `saveConfigFile` overwrites on disk, `reloadConfig` hot-reloads.

#### 4.6 Seeding priority (ch. 04)
`seedingGetPriority(start_day)` → `{server_list[]:{id, short, name, priority}, day:{min_players, use_unattached}}`. **PK** (`start` day, `server_id`). `priority < 999` ⇒ attached/priority; drives the seeding helper's per-day rotation.

---

### 5. Combat & match domain

#### 5.1 Game / match (ch. 12, 04, 19)
`games` table, **PK** `id`. Row click → `/game/<id>` (full-page, server-rendered).

| Field | Type | Meaning |
|---|---|---|
| `id` | int | PK. |
| `server` / `server_id` | int | FK → Server. |
| `map` | string | Layer name (`Gorodok_RAAS_v1`). |
| `start` / `end` | ts | Round start/end (`end` blank while ongoing). |
| `t1` / `t2` | string | Team/faction labels. |
| `t1_tickets` / `t2_tickets` | int | Remaining tickets per side. |
| `time` | int (s) | Round duration. |
| `win` | enum `t1`\|`t2`\|null | Winner (null = draw/ongoing). |

The API adds `playtime` (per-player minutes) on the `stats.games[]` projection, tying a player to a match.

#### 5.2 Match detail (per-player) — **gap** (ch. 12)
Reached by full navigation to `/game/<id>`; this HTML was **not captured**. Presumed schema: per-player kills/deaths/score, team rosters, ticket timeline. Documented as a gap. Logical **PK** (`game_id`, `steam_id`).

#### 5.3 Combat events (ch. 13) — one physical event table, five projections
`t1` = event row (`date`, `server_id`); player parties resolved by join under different aliases per page. **PK** event `id`.

| Entity | Table | Primary player (`steam_id`) | Secondary player | Weapon? | Extra |
|---|---|---|---|---|---|
| Kill | `playerKills` | killer | `victim_steam_id` (victim) | yes | — |
| Death | `playerDeath` | the deceased | (killer filterable, not shown) | yes (killed-by) | — |
| Revive | `playerRevive` | medic | revived player | no | — |
| Damage | `playerDamage` | attacker | victim | yes | **damage magnitude stored but not shown in grid** |
| Teamkill | `playerTeamkill` | offender (`player`) | victim (`killed`) | no | friendly-fire |

Common fields: `steam_id`, `victim_steam_id`, `server` (`server_id`), `date`, actor name (`player_name`/`player`), target name (`name`/`killed`), `weapon`. Every combat event is a many-to-one to **Player** (twice) and to **Server**.

#### 5.4 Kit (ch. 03, 04)
Two facets sharing the kit dimension:
- **Kit usage** — `playerKits` table / profile "Киты": `{kit, cnt}` where `cnt` = playtime minutes. Stored `player_kit_time[steam_id, season, kit]`.
- **Kit denial** — `kits`/`kitSave`: per-kit boolean deny map `{kit: bool}` (license-risk warning). **PK** (`steam_id`, `kit`).

#### 5.5 Weapon stat (ch. 04, 19)
`{name, kills/cnt, damage, image}`; **PK** (`steam_id`, season, `weapon`). Per-weapon kills + total damage.

#### 5.6 Vehicle stat & vehicle destruction (ch. 04)
Two tables:
- **Driven/crewed** ("Техника"): `{vehicle, kills, damage}` — localized vehicle names.
- **Destroyed** ("Уничтожение техники"): `{weapon, vehicle, count}` — keyed by weapon; uses **raw internal asset ids** (`T72A_IMF`, `MI8_AFU`), confirming it is pulled straight from parsed kill-log rows.

#### 5.7 Season dimension (ch. 04)
`all` / `old` (pre-ICO, 2016–2023-09-27) / `1` (Squad 6.0 ICO UE4) / `2` (Squad 9.0 UE5, default). All stat aggregates (§3.7, §5.4–5.6, §11) are partitioned by season; retention reaches back to **2016**.

---

### 6. Statistics aggregates (ch. 11)

The `statistics` action returns pre-aggregated series, not row entities. Keyed either flat `{day:val}` or nested per-server `{server_id:{day:val}}`, over `days`/`hours`/`dayofweek` axis buckets:

| Response key | Grain | Meaning |
|---|---|---|
| `online` / `max` / `queue` | per-server per-day | avg online / peak (incl. queue) / queue length |
| `admins` / `maxAdmins` | per-day | avg / peak admins online |
| `bans` | per-day | punishments issued |
| `new` | per-day | first-seen players |
| `chat` / `teamkill` | per-server per-day | chat volume / teamkills |
| `games` / `kills` / `death` / `revival` / `wound` | per-server per-day | match & combat throughput |
| `onlineHour` / `onlineDay` | per-server per hour / weekday | online distribution |
| `modes` / `maps` | per mode / per map | match-count distributions |

These are derived from the event/session tables above; they are the read-side rollups of Combat events, Games, Chat, Sessions, and Bans.

---

### 7. Access-control & monetization domain

#### 7.1 Permission group (ch. 05, 06, 16)
A **fixed enum**, not free-form roles. **PK** `group_id` / internal `name`:

| group_id | Label | Internal name | Icon | Color |
|---|---|---|---|---|
| 0 | -Нет группы- | (clears) | — | — |
| 1 | Администратор | Admin | user-circle | #e50606 |
| 2 | Модератор | Moderator | id-badge | #2df044 |
| 3 | **VIP** | QueuePriority | star | per-record |
| 4 | Камера | Cameraman | video-camera | #7d059e |
| 5 | Стажёр | Intern | graduation-cap | #b57c03 |

The settings `groups` tab defines each group's **21 Squad permission tokens** (`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`) plus `{description, color}`. This is the panel's RBAC vocabulary (mirrors Squad `Admins.cfg`).

#### 7.2 Group assignment (ch. 05, 06)
Written by `changeGroup`. **One per player** (a scalar on Player, not a join table): `{steam_id, group_id, date(expire), description, prefix, prefix_rgb, image}`. `expire==0` ⇒ permanent. Same record grants staff roles AND VIP (group 3). Scope is **global** (no `server_id`).

#### 7.3 Admin roster row (ch. 05)
`adminPlayers` table = Player ⟕ Group filtered to `group_id ∈ {1,2,4,5}`, with accountability KPIs: `{steam_id, name, group, date, time (playtime/period), boost, bans (punishments issued/period), discord}`.

#### 7.4 VIP / privilege (ch. 06, 19)
`vipPlayers` table = Player (`t2`) ⟕ group-assignment (`t1`): `{steam_id, name, expire, date, time, vipdesc}`. VIP is **group_id=3** granted via `changeGroup`; the API exposes `/player/vip` (`expire` XOR `add`). Distinct from the **clan-scoped** reserved-slot flag `vipPlayer` (§7.7).

#### 7.5 Bonus economy (ch. 04, 19, 20)
Integer loyalty currency `bonus` on Player. Mutated only via API `/player/bonus` (`method=add|remove|set`, `amount`) → `{old, new, amount}`. Surfaced on the profile, the `top` leaderboard (`bonuses` column), and player card.

#### 7.6 Clan (== squad) (ch. 18, 04, 19)
**PK** `id` (`clan_id`). Created/edited via `createSquad` (script `squad`); roster ops via script `clan`.

| Field | Type | Meaning |
|---|---|---|
| `id` | int | PK. |
| `name` | string ≤32 | Display name / tag ("[MDC]"). |
| `tags[]` | string[] | In-game name prefixes; drive tag-protection & search. |
| `discord_id` | string ≤64 | Discord **role** id. |
| `date` | ts | Creation. |
| `expire` | ts | Priority-subscription expiry (0 = infinity). |
| `max` | int | Max priority/VIP slots. |
| `protected` | 0/1 | Tag-protection (auto-kick tag-wearers not on roster). |
| `public` | 0/1 | Public read-only page. |

Monetized product: an inline YooMoney "extend priority" form; clans exist to sell queue priority.

#### 7.7 Clan member (ch. 18)
`clan.list` → `players[]`; **PK** (`clan_id`, `steam_id`). Fields: `{steam_id, name, kit, discord, date, online/online_raw (60-day playtime), type (0 member / 1 Глава-leader / 2 Зам-deputy), vip_mode (0 off / 1 on / 2 external), access}`. `vipPlayer(clan_id, steam_id, vip)` toggles the clan-scoped reserved slot (≠ global VIP). M:N between Clan and Player.

---

### 8. Moderation domain

#### 8.1 Ban (ch. 09, 19)
`banPlayers` table (alias `t1`), joined to banned player (`t2`) and issuing admin (`t3`). **PK** `id`.

| Field | Type | Meaning |
|---|---|---|
| `id` | int | PK (from API). |
| `steam_id` | string | FK → banned Player. |
| `reason` / `reason_id` (`rule`) | string / int | Resolved from the rules catalog (§8.2). |
| `date` | ts | Issued ("Забанен"). |
| `expire` | ts \| 0 | Expiry; 0 = permanent. |
| `description` | string ≤512 | Admin comment. |
| `admin_id` / `admin_name` | SteamID64 / string | Issuing admin (FK → Player). |
| `impact` | bool | Counts toward progressive escalation. |
| `unban` | bool/"1" | Later revoked (kept in history) vs error-erased. |
| `server_id` | int | Sent when target online (live enforcement); archive is project-wide. |

`bans[]` on Player is the history; `ban` is the active one. API `hasBan`/`hasBanAll` expose `{ban_count, last_ban, mark}` aggregates.

#### 8.2 Reason / rules catalog (ch. 09, 07, 16)
The ban `<select>` options: **PK** rule id (`value`), with `data-first/second/third/four` = escalating day-tiers for the 1st–4th offense (cap commonly 30 → permanent). `<optgroup>` categories: Особые/Общие/Для сквадных/Для техники/Милсим. Editable (partly stubbed) in settings `rules` tab as categories → rules, with a "Progressive system" toggle.

#### 8.3 Ban-name (ch. 10)
`ban_names` table, **PK** `name`: `{name, date}`. Nickname blacklist; `addBanName`/`removeBanName` reachable from every page. No exposed severity/regex/scope/author (gap).

#### 8.4 Collab / Ru-Ban federated ban (ch. 10, 19)
`collabans` table: `{steam_id, name, reason, date, expire, projects[]}`, **PK** (`steam_id`, project). A player aggregates ban records from many **Projects**.

**Project (federation source)** — `{name, admin_name, reason, date, expire, cnt}` per contributing community. `checkBans` extends each with `{name, discord, online, ban:{total, current:{reason,date,expire}}}` — the trust/attribution model. Populated server/bot-side; `botUpdate` refreshes the enforcement agent. API mirror: `/player/hasBanAll`.

#### 8.5 Comment (admin note) (ch. 08, 19)
`playerComments` table joining comment (`t1`), author admin (`t2`), target player (`t5`). **PK** `id`.

| Field | Type | Meaning |
|---|---|---|
| `id` | int | PK (API). |
| `steam_id` | string | FK → target Player. |
| `admin_id` / `admin_name` | SteamID64 / string | FK → author Player. |
| `date` | ts | Written. |
| `text` | string ≤256 | Note body. |

Append-only (no edit/delete in UI). `comments_count` cached on Player.

#### 8.6 Mark (suspicion flag) (ch. 08, 03)
A **single scalar enum on Player** (`mark` 0–8), not a join table. `playerMark` table view: `{steam_id, player, date (last-seen), mark, ban}`. Enum: 1 WallHack, 2 AimBot, 3 SpeedHack, 4 object-spawn, 5 reload-exploit, 6 grief, 7 config, 8 toxic, 0 clear. One mark at a time; no author/history exposed (gap).

#### 8.7 Audit log entry (ch. 17)
`logs` table (alias `t1`). **PK** `id`. Columns `{serverName (via server_id), name (via t2.player = admin), date, log}`. `log` is **free text** (not a normalized `{action_type, target, params}`), with embedded `<hashtag>` player drill-downs. Read-only. Note (ch. 16): in-game `changemap`/`kick`/`ban` bypass this log.

---

### 9. Community & communications domain

#### 9.1 Chat message (ch. 02, 19)
`playerChat` table (chat `t1` ⟕ player `t2`). **PK** message `id` (from API). Fields `{id, steam_id, server_id, date, team, name, type, msg}`; UI-only `play` (TTS). `type` enum: `ChatAll, ChatTeam, ChatSquad, ChatAdmin, broadcast` (each with a server-provided display `color`). Client-side profanity flag (`obscene`). Broadcasts are logged back into the same feed.

#### 9.2 Vote (ch. 14)
`votes` table (card list, no `<thead>`). **PK** vote row. Fields: `{short, name (initiator), steam_id, date, cancel (status), mode, players_sum, players_need, map_current, map_next, map_vote, map_current_img, map_next_img}`. FK → initiator Player + Server.

#### 9.3 Report (ch. 14)
`reports` table (report `t1` ⟕ player `t2`). **PK** report row. Fields: `{short, date, player_name (target), steam_id (target), text}`. Reporter identity **not surfaced** (gap). No lifecycle/status/assignee field.

#### 9.4 Issue (bug tracker) (ch. 15)
`issues_get` / `issues_create` (script `squad`). **PK** `id`. Fields `{id, title, body ≤512, state (open|closed), create (ts), labels[]}`. **Label** child: `{name, color}` (only two: 1 Баг red, 2 Предложение blue). Create/read only; no close/edit/comment in UI.

#### 9.5 Video / demo + upload token (ch. 15)
- **Video upload** (`uploadVideo`, script `public`): FormData `{name, description, file (MP4 ≤2 GB), token}`. **No FK** to match/player/report — association is free-text prose only (gap/weakness). Fan-out: Browser → SQSTAT → YouTube + Telegram.
- **Upload token** (`uploadVideo_token`, script `squad`): `{token}` — single-use, 2-hour credential enabling delegated (unauthenticated) uploads on the public endpoint.

#### 9.6 User settings (ch. 04, 16)
`saveUserSettings` (script `player`) — a JSON blob keyed by setting, per self: `{lang: ru|en, theme: 0|dark, show_country: hide|show}`. **PK** owner `steam_id`.

#### 9.7 Discord config / webhooks (ch. 16)
Panel-global settings (script `settings`, `discordbot`/`discord` tabs). Not a per-player entity but the config store behind the Discord gamification engine: `guild_id`, role-sync toggles + ids (`vip_sync`/`vip_id`, `moderator_sync`, tiered `playtime{100..5000}_id`, leaderboard roles `top1Kill`/`top1Medic`/`topCMD`/`topSL`/`topVehicle`/`topMortar`/`clanKiller`/`pilot`/`knifeKiller`, `seeders_*`), and webhook URLs (`report, log, alert, cheater, grief, crash, endmatch, weekend, monitoring, request, collab_ban, collab_warn`) each with an `_enabled` flag. **Security finding (ch. 16):** live webhook tokens are echoed into page HTML.

---

### 10. Relationship / ER overview

#### 10.1 Central hub

**Player (`steam_id`)** is the hub; **Server (`server_id`)** is the secondary hub. Almost everything else is a spoke off one or both.

```
                         ┌───────── Name-history (1:N)
                         ├───────── Location/IP (1:N)  ── same-IP ──┐
                         ├───────── Primetime (1:N)                 │
                         ├───────── Session-series (1:N)            │ (reflexive
                         ├───────── Playtime/Kit-time (1:N/season)  │  alt/twin
   Group ──(0..1)────────┤                                          │  M:N via
   (group_id enum)       │   ┌── Twin/alt link (M:N, reflexive) ◄───┘  shared IP
                         │   │                                         + friends)
   Clan (clan_id) ──M:N──┤◄──┘
   (clan_member)         │
                         ●  PLAYER (steam_id) ──────────────────────────┐
                        /│\                                             │
        author │        │ │ target        subject │ │ target           │
        ┌──────┘        │ │        ┌──────────────┘ │                  │
     Comment (N:1×2)  Ban (N:1 + admin N:1)   Kill/Death/Revive/       │
     Mark (1:1 enum)  Ban-name (by name)      Damage/Teamkill (N:1×2,  │
     Audit-log (admin N:1)   Collab-ban ──M:N── Project                │
                         │                                             │
                         │  online.server.id / server_id               │
                         ▼                                             ▼
                      SERVER (server_id) ◄──────── Chat, Vote, Report, Game,
                        │                          Combat-events, Statistics,
                        ├── Rotation (1:N per day)  Audit-log, Session
                        ├── Config-file (1:N)
                        ├── Mod (1:N)
                        ├── Monitor-sample (1:N)
                        ├── IP/connection (1:N)
                        └── Seeding-priority (1:N per day)

   Game (id) ──1:N── Match-detail (per player)   [/game/<id>, not captured]
   Video ── (no FK) ── free-text only
   Bonus / VIP / User-settings ── scalar on Player
```

#### 10.2 Foreign-key matrix (→ = "references")

| Entity | → Player | → Server | → Clan | → Game | → Group | → Project | → Admin(Player) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Name-history | ✓ | | | | | | |
| Location/IP | ✓ | | | | | | |
| Primetime | ✓ | | | | | | |
| Session-series | ✓ | (via presence) | | | | | |
| Playtime/Kit-time | ✓ | (favourite) | | | | | |
| Twin/alt link | ✓ (×2 reflexive) | | | | | | |
| Group assignment | ✓ | | | ✓ (group_id) | | |
| Admin roster | ✓ | | | | ✓ | | |
| VIP | ✓ | | | | ✓ (=3) | | |
| Clan member | ✓ | (online per srv) | ✓ | | | | |
| Ban | ✓ | ✓ (if live) | | | | | ✓ |
| Ban-name | (by nick text) | | | | | | |
| Collab-ban | ✓ | | | | | ✓ | ✓ (per project) |
| Comment | ✓ | | | | | | ✓ |
| Mark | ✓ (1:1) | | | | | | |
| Audit-log | ✓ (hashtags) | ✓ | | | | | ✓ |
| Chat | ✓ | ✓ | | | | | |
| Vote | ✓ (initiator) | ✓ | | | | | |
| Report | ✓ (target) | ✓ | | | | | |
| Game | | ✓ | | — | | | |
| Match-detail | ✓ | ✓ | | ✓ | | | |
| Kill/Death/Revive/Damage/Teamkill | ✓ (×1–2) | ✓ | | (round) | | | |
| Kit usage/deny | ✓ | | | | | | |
| Weapon/Vehicle stat | ✓ | | | | | | |
| Video | (prose only) | | | | | | |
| Statistics | (aggregate) | ✓ | | (aggregate) | | | |

#### 10.3 Cardinality highlights
- **Player 1:1 Mark** and **Player 1:1 Group** (scalars, not join tables) — a deliberate simplification; a player can hold exactly one mark and one group at a time (ch. 05, 08 note this as a beatable limitation).
- **Player M:N Clan** via Clan-member (with role `type` and clan-scoped `vip_mode`).
- **Player M:N Player** (reflexive) via Twin/alt — materialized on demand from shared IPs + Steam friends + session overlap, not stored as an explicit group.
- **Player M:N Project** via Collab-ban (federated reputation).
- **Combat event N:1 Player twice** (actor + target) + N:1 Server — one physical event table, five view projections.
- **Game 1:N Match-detail** (the per-player round scoreboard) — the only entity whose schema is a documented gap.

---

### 11. Cross-identity & derived structures worth flagging

- **Identity graph** (ch. 19 `/player/info`): `steam_id ↔ eos_id ↔ discord` with full `names[]` history — the backbone of alt detection and Discord role sync.
- **Progressive-ban policy-as-data**: escalation tiers live on the Reason catalog (`data-first..four`), not in admin discretion (ch. 07, 09).
- **Federated reputation**: Collab-ban + Project + `checkBans`/`hasBanAll` form a cross-community ban network keyed by `steam_id`, with per-source Discord + online-time attribution (ch. 10, 19).
- **Season partitioning** (ch. 04): all per-player stat aggregates carry an implicit season dimension (2016 → present, cut on engine boundaries).
- **Monetization scalars**: `bonus` (currency), VIP (`group_id=3` + `expire`), Subscriptions, and clan priority (`expire`+`max`+`vipPlayer`) are layered onto the same Player/Group/Clan tables rather than separate billing entities.

---

### 12. Gaps / not observable from the client

1. **Match-detail (`/game/<id>`)** — per-player round scoreboard schema (kills/deaths/score, rosters, ticket timeline) is server-rendered and was not captured (ch. 12).
2. **Column types & constraints** — all types above are inferred from client rendering, `maxlength`, and API field labels; no DDL was available.
3. **Ban-name matching semantics** — exact vs. substring vs. regex, plus any author/scope/severity/expiry columns, are not exposed (ch. 10).
4. **Mark authorship/history** — no who-set/when audit for the suspicion flag (ch. 08).
5. **Report reporter identity** and any lifecycle/status/assignee fields — absent from the client (ch. 14).
6. **Video ↔ case linkage** — no foreign key to match/player/report; association is free-text only (ch. 15).
7. **Federation sync mechanism** — how Collab-bans propagate between communities (push/poll/shared DB) is server/bot-side and not observable (ch. 10).
8. **Statistics** are pre-aggregated series, not queryable row entities; the underlying rollup tables are not directly exposed (ch. 11).
9. **Seeding, user-settings, and Discord-config** server schemas are inferred from payloads only (ch. 04, 16).

> For the permission/RBAC model that governs who may mutate these entities, see the **Permissions & Groups synthesis (chapter 90)**. For per-player forensic storage detail see **chapter 92**, and for the complete action/RPC/RCON surface that reads and writes these entities see **chapter 93**.
