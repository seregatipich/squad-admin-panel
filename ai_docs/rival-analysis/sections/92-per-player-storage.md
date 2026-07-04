## Per-Player Data & Logs Storage (Synthesis)

> **Cross-cutting synthesis.** This chapter answers a single question exhaustively: *for one player, what does SQSTAT store, and how does an admin retrieve it?* It stitches together the per-section chapters — **03. Players Directory**, **04. Player Profile & Per-player Data Storage**, **08. Player Comments & Suspect Marking**, **09. Ban Management**, **13. Combat Logs**, **17. Admin Audit Journal**, **02. In-game Chat & Broadcast**, and **14. Votes & Reports** — into one model of *the per-player dossier*. It does not re-document each page; it maps every fact back to the chapter that owns it.
>
> **Two surfaces, one identity.** Everything below is keyed to a single player identity (historically **SteamID64**, now migrating to a **UUID** primary key — see repo commit `6a7b3b3`). That identity is read through two distinct surfaces:
> 1. **The shared player-detail modal** (`#player_info` / `#playerModal`), embedded on *every* page, opened by `player.open(steam_id)` → `Action({script:'player', action:'get'})` → `POST /ajax/player.php`. This is the **admin rap sheet** (see **03. Players Directory** §3–§4 for the full model). It returns the rich `player.info` object and lazily loads ~12 sub-tab tables via `script:'table'`.
> 2. **The self-service player profile** at `/player/<steamid>?season=<…>` — a hard-navigation stat dashboard for the account owner (see **04. Player Profile**), *not* the admin rap sheet. It denormalizes per-season aggregate stats but exposes **none** of the forensic data (bans, chat, comments, marks, IPs, twins).
>
> A competitor must not conflate the two: the modal is the moderation dossier; the profile page is the read-only scoreboard.

---

### 1. The Dossier at a Glance — What Is Stored per Player

Every category of per-player data, with the entity/table it lives in, where it surfaces in the UI, how it is fetched, and the owning chapter.

| # | Data category | Stored entity / table | Primary key | Retrieval surface | Fetch (script→action / endpoint) | Owning chapter |
|---|---|---|---|---|---|---|
| 1 | **Identity — SteamID64** | `player` | `steam_id` | Modal header, every table's hidden col | `player`→`get` / `player.php` | 03 §3 |
| 2 | **Identity — EOS id** | `player.eos_id` | — | Modal header + OWI report | `player`→`get` | 03 §3 |
| 3 | **Identity — UUID** (new) | `player` (migrated PK) | `uuid` | server-side | — | repo `6a7b3b3` |
| 4 | **Name history / aliases** | `player.names[]` `{name,date}` | `steam_id` | "Другие ники" dropdown; searchable via `with_other_names` | `player`→`get`; search on `t2.player` | 03 §2.2, §3 |
| 5 | **Discord id** | `player.discord` | — | "открыть" → discord.com/users/`<id>` | `player`→`get` | 03 §3 |
| 6 | **VAC / game-ban status** | `player.vac` / `player.steam_info.ban` `{vac,ban,days}` | — | Steam badge in header | `player`→`get` | 03 §3 |
| 7 | **Steam hours in Squad** | `player.steam_info.squad.time` | — | Header enrichment | `player`→`get` | 03 §3 |
| 8 | **"New account" (baby) flag** | `player.baby` (bool) | — | Red warning icon by online time | `player`→`get` | 03 §3 |
| 9 | **IP + Geo-IP history** | `player.location[]` `{iso,loc,timezone,lat,lng,ip,date}` | `steam_id` | "Другие локации" list + Leaflet map | `player`→`get`; `player.map.open(lat,lng)` | 03 §3 |
| 10 | **Primetime (active hours)** | `player.primetime[]` `{start,end}` | `steam_id` | `<hashtag>` HH:mm ranges | `player`→`get` | 03 §3 |
| 11 | **Aggregate + period playtime** | `player.playtime` `{online,boost,server}` | `steam_id` | Online/Boost/Queue tiles + chart | `player`→`get`; chart via `getPlayerOnlineData(start,end)` | 03 §3–§4 |
| 12 | **Online session time-series** | (server-side) | `steam_id` | Chart / Календарь / По серверам tabs | `player`→`getPlayerOnlineData` `{steam_id,start,end}` | 03 §4 |
| 13 | **Per-season stat aggregate** | `player_stat[steam_id,season]` | `steam_id`+season | Profile page "Скилл" block | rendered server-side (hard nav) | 04 §2.2 |
| 14 | **Per-map / recent matches** | `playerGames` / matches | `steam_id` | Modal "Игры" tab; profile "Матчи" | `table`→`playerGames` (+`&steam_id`) | 03 §4.1; 04 §2.7 |
| 15 | **Per-kit playtime** | `playerKits` / `player_kit_time` | `steam_id`(+season,kit) | Modal "Киты" tab; profile "Киты" | `table`→`playerKits` | 03 §4.1; 04 §2.3 |
| 16 | **Per-weapon kills+damage** | `player_weapon_stat[steam_id,season,weapon]` | composite | Profile "Оружие" cards | server-side | 04 §2.4 |
| 17 | **Vehicles driven / destroyed** | `playerVehicle`; profile veh tables | `steam_id` | Modal "Техника" tab; profile §2.5–§2.6 | `table`→`playerVehicle` | 03 §4.1; 04 §2.5–2.6 |
| 18 | **Kills log** | combat event `t1` + player joins | `steam_id` | Modal "Убийства"; `kills` page | `table`→`playerKills` | 03 §4.1; 13 |
| 19 | **Deaths log** | combat event `t1` | `steam_id` | Modal "Смерти"; `deaths` page | `table`→`playerDeath` | 03 §4.1; 13 |
| 20 | **K/D & winrate** | derived from stats | `steam_id` | Stat cards; profile donut/trend | `player`→`get` (`stats`) | 03 §3; 04 §2.2 |
| 21 | **Revives log** | combat event `t1` | `steam_id` | Modal "Поднятия"; `revives` page | `table`→`playerRevive` | 03 §4.1; 13 |
| 22 | **Damage-dealt log** | combat event `t1` (`damage` field) | `steam_id` | Modal "Урон"; `damages` page | `table`→`playerDamage` | 03 §4.1; 13 |
| 23 | **Teamkills log** | combat event `t1` (friendly-fire) | `steam_id` | Modal "Тимкиллы"; `teamkills` page | `table`→`playerTeamkill` | 03 §4.1; 13 |
| 24 | **Kit-denial state** | per-kit deny flags `{kit:bool}` | `steam_id` | Modal "Киты" deny modal | `player`→`kits`/`kitSave` | 03 §4.2, §5.5 |
| 25 | **Chat log** | `playerChat` (`t1` chat ⋈ `t2` player) | `steam_id` | Modal "Чат"; `chat` page | `table`→`playerChat` | 02; 03 §4.1 |
| 26 | **Votes initiated** | `votes` log (`steam_id`=initiator) | `steam_id` | `votes` page (card list) | `table`→`votes` | 14 §14.3 |
| 27 | **Reports against player** | `reports` (`t1` ⋈ `t2` player) | `steam_id`=target | `reports` page (card list) | `table`→`reports` | 14 §14.4 |
| 28 | **Squad membership history** | `playerSquad` | `steam_id` | Modal "Сквады" tab | `table`→`playerSquad` | 03 §4.1 |
| 29 | **Ban / punishment history** | `player.bans[]` (`t1` bans ⋈ `t3` admin) | `steam_id` | Modal "Наказания" accordion; `bans` page | `player`→`get`; `table`→`banPlayers` | 03 §3–§4; 09 |
| 30 | **Active ban** | `player.ban` `{expire,reason,admin_name,date,description}` | `steam_id` | Red ban banner + corner ribbon | `player`→`get` | 09 §2.2, §5.4 |
| 31 | **Warns** | `playerWarn` | `steam_id` | Modal "Варны" tab | `table`→`playerWarn` | 03 §4.1 |
| 32 | **Name-ban state** | `player.name_banned` + banned-names list | `name` | Ban/unban-nick menu | `player`→`addBanName`/`removeBanName` | 03 §4.2; 09 §4 |
| 33 | **Admin comments / notes** | `player_comment` (`t1` ⋈ `t2` admin ⋈ `t5` target) | `steam_id` | Comments drawer; `comments` page | `player`→`getComments`/`addComment` | 08 §2.1 |
| 34 | **Suspicion mark** | `player_mark` (single enum 0–8) | `steam_id` | Mark banner + row highlight; `mark` page | `player`→`mark` | 08 §2.2; 03 §4.4 |
| 35 | **Twins / alts (shared-IP)** | derived `text.list[]` `{steam_id,name,perm,min_date,ips[]}` | `steam_id` | Twink modal | `player`→`twink` | 03 §4.3 |
| 36 | **Steam-friends edge** | derived `in_friend` | pair | Twink candidate button | `player`→`findFriends` `{steam_id,compare_steam_id}` | 03 §4.2 |
| 37 | **Co-presence overlay** | derived session overlap | pair | Twink weekly calendar | `player`→`twinkOnline` `{…,start,end}` | 03 §4.2 |
| 38 | **Cross-project ban federation** | remote `{projects:[{name,discord,online,ban}]}` | `steam_id` | Check-bans grid modal | `player`→`checkBans` | 09 §5.3 |
| 39 | **Privilege group / role** | `player.group` `{name,color,icon,description}` + `group_id,expire,prefix,prefix_rgb,image` | `steam_id` | Group badge + group form | `player`→`get` / `changeGroup` | 03 §3, §5.2 |
| 40 | **VIP status / expiry** | group id 3 + `expire`; profile VIP-until | `steam_id` | Group form; profile header; `vips` page | `player`→`changeGroup`; `clan`→`vipPlayer` | 03 §5.2; 04 §2.1; 06 |
| 41 | **Clan membership** | `player.clans[]` `{clan_id,name}` | `steam_id` | Clan labels → `/clan.php?id=` | `player`→`get` | 03 §3; 18 |
| 42 | **Bonus / economy balance** | `player.bonus` | `steam_id` | Bonus tile; profile "Ваши бонусы" | `player`→`get` | 03 §3; 04 §2.1 |
| 43 | **Subscriptions** | (server-side) | `steam_id` | Profile "Подписки" | server-side | 04 §2.1 |
| 44 | **Admin actions ON the player** | `logs` (`t1` ⋈ `t2` admin) | via `<hashtag>` | Audit journal `logs` page | `table`→`logs` | 17 |

---

### 2. Identity Graph — Everything Keyed to One Player

SQSTAT resolves a single human across many identifiers. This is the richest part of the dossier and the strongest competitive feature (see **03. Players Directory** §7.5 "Rich identity graph").

| Identifier | Field | Notes |
|---|---|---|
| SteamID64 | `steam_id` | Legacy primary key; still the click-key of every table row (rendered in `<hashtag>`). |
| UUID | (new PK) | Panel migrated identity to a UUID primary key (repo commit `6a7b3b3`); SteamID becomes an attribute. |
| EOS id | `eos_id` | Epic Online Services id (Squad's newer identity); copied into the OWI cheat report. |
| Discord id | `discord` | Deep-links to `discord.com/users/<id>`. |
| Current nick | `name` | With clan-tag prefix on the profile H1. |
| Nick history | `names[]` `{name,date}` | Dropdown "Другие ники"; searchable via the `with_other_names` checkbox (**03** §2.2). |
| Alt accounts | `twink` → `list[]` | Shared-IP candidates, each with own SteamID, perm-ban flag, IP match list, time delta. |
| Steam-friend edge | `findFriends` → `in_friend` | Boolean per candidate pair. |
| VAC / game ban | `vac`, `steam_info.ban` | Enriched from Steam. |

**Alt-hunting workflow (03 §4.3)** is a fully built shared-IP + Steam-friends + co-presence engine: `twink` returns candidates keyed by matching IPs (`ips[]` with `loc`, both accounts' seen-times, humanized `min_date` delta), `findFriends` confirms the Steam social edge, and `twinkOnline` overlays both accounts' weekly sessions on a FullCalendar to prove co-presence. `perm:true` red-flags candidates carrying a permanent ban.

---

### 3. Location & Session Storage

| Datum | Field / source | Structure | Surface |
|---|---|---|---|
| Raw IP addresses | `location[].ip` | one per distinct location, newest first (`location[0]`) | "Другие локации" list (raw IP printed under each entry) |
| Country / city | `location[].iso`, `.loc` | ISO flag + city string | Header + list |
| Timezone | `location[].timezone` | string, appended in parentheses | Header + list |
| Coordinates | `location[].lat`, `.lng` | float pair → Leaflet OSM map (`player.map.open`) | `#player_map-modal` |
| Location seen-date | `location[].date` | timestamp | Each list entry |
| Primetime | `primetime[]` `{start,end}` | unix → `HH:mm–HH:mm` ranges | `#player_info-primetime` |
| Total online / boost | `playtime.online`, `.boost` | aggregate | Tiles |
| Favourite server | `playtime.server` | label | "Сервер" |
| Online time-series | `getPlayerOnlineData(steam_id,start,end)` | three series **Онлайн / Буст / Очередь** | Chart with Chart/Calendar/Per-server sub-tabs |

**Competitive note:** raw IPs, timezones, and a map per player is heavy PII retention — a differentiator but also a privacy/compliance surface a competitor should treat carefully.

---

### 4. Combat & Activity Logs (per-player, event-grained)

All combat logs are the *same* joined event table (`t1` event ⋈ player joins) re-projected per event class (**13. Combat Logs** §13.2). Each is reachable two ways: as a modal sub-tab scoped to one player (`&steam_id=<id>`), or as a global page filtered by name.

| Event class | Modal tab / table | Global page | Columns (player-relevant) | Weapon? | Magnitude stored? |
|---|---|---|---|---|---|
| Kills | Убийства / `playerKills` | `kills` | killer, victim (`victim_steam_id` clickable), weapon, date, server | Yes | — |
| Deaths | Смерти / `playerDeath` | `deaths` | deceased, weapon-that-killed, date, server | Yes | — |
| Revives | Поднятия / `playerRevive` | `revives` | medic, revived, date, server | No | — |
| Damage | Урон / `playerDamage` | `damages` | attacker, victim, weapon, **damage**, date | Yes | **Yes** in modal tab; *hidden* on global `damages` page (13 §13.3) |
| Teamkills | Тимкиллы / `playerTeamkill` | `teamkills` | offender, team-victim, date, server | No | — |
| Games | Игры / `playerGames` | (profile Матчи) | server, map, win, date | — | — |
| Squads | Сквады / `playerSquad` | — | server, team, date, squad_id, name | — | — |
| Vehicle | Техника / `playerVehicle` | — | server, vehicle, weapon, damage, date | Yes | Yes |
| Chat | Чат / `playerChat` | `chat` | server, date, team, type, msg (obscenity-flagged) | — | — |

**Damage magnitude asymmetry (13 §13.8):** the model stores per-event damage (`playerDamage` / `player.info` Урон tab exposes it), yet the global `damages` grid omits the numeric column — a documented easy win for a competitor (show and sort by damage).

**Teamkills is a passive log (13 §13.8):** no per-player TK tally, forgive, or auto-action on the page; enforcement is only via the shared modal's ban/kick.

---

### 5. Moderation & Forensic Records

The punitive/annotative half of the dossier — the part **absent** from the self-service profile (**04** §1, §8).

#### 5.1 Bans & punishment history (**09. Ban Management**)

| Field | Source | Meaning |
|---|---|---|
| `bans[]` `{admin_name,date,reason,description,impact,unban}` | `player`→`get` | Full punishment history (modal "Наказания" accordion). |
| `ban` `{expire,reason,admin_name,date,description}` | `player`→`get` | Current active ban (red banner + ribbon). |
| `impact` | ban row | Counts toward **progressive** escalation ("Влияет на наказание"). |
| `unban` (`"1"`) | ban row | Later revoked — kept greyed in history, or fully erased if "issued in error". |
| `reason_id` | rules catalog | Rule id (e.g. `110` insults, `160` cheating, `173` teamdamage) with `data-first/second/third/four` escalating day-tiers, cap `30` → permanent. |
| `admin_name` | `t3.player` | Issuing admin — **author-attributed** (auditable). |

Global `bans` page = `banPlayers` DataTable (`t1` ban ⋈ `t2` player ⋈ `t3` admin); mutation only through the modal (`ban`/`unban` on `script:'squad'`). `collabans` is the collaborative cross-community variant; `checkBans` federates ban status across projects (**09** §5.3).

#### 5.2 Comments & suspicion marks (**08. Player Comments & Suspect Marking**)

| Feature | Entity | Author-attributed? | Multiplicity | Write action |
|---|---|---|---|---|
| Admin notes | `player_comment` `{steam_id,date,admin,player,text≤256}` | **Yes** (`t2` admin) — append-only, no edit/delete | many per player (thread) | `player`→`addComment` |
| Suspicion mark | `player_mark` single enum `0–8` | **No** (no mark-author audit — a documented gap) | exactly **one** per player | `player`→`mark` |

Mark taxonomy (single scalar, replaced on set, `0` clears): `1` WallHack, `2` AimBot, `3` SpeedHack, `4` object-spawn, `5` reload-exploit, `6` grief, `7` config-exploit, `8` toxic. The `mark` page is a filterable watchlist with a **Бан** column (triage: flagged-but-not-yet-banned). See **08** §2.2, §7.

#### 5.3 Votes & reports tied to the player (**14. Votes & Reports**)

| Record | Player role | Fields | Gap |
|---|---|---|---|
| Vote | `steam_id` = **initiator** | `mode`, `cancel`(status), `players_sum`/`players_need`, `map_current/next/vote` | No per-voter storage; no initiator search filter. |
| Report | `steam_id` = **target** (reported) | `text` (report body), `player_name`, `date`, `server` | **Reporter identity not surfaced**; no report lifecycle/resolution state. |

---

### 6. Role / Economy / Membership State

| State | Field / action | Notes |
|---|---|---|
| Privilege group | `group` `{name,color,icon,description}`, `group_id` | Ids: `0` none, `1` Admin, `2` Moderator, `3` VIP, `4` Camera, `5` Trainee. |
| Group grant (branding) | `changeGroup` `{group_id,date(expire),description,prefix,prefix_rgb,image}` | Custom prefix text + RGB + image URL per player (monetizable cosmetics). |
| VIP expiry | `expire` on group 3; profile "VIP до DD.MM.YYYY" | Also `vips` page; clan-scoped VIP toggle `clan`→`vipPlayer` `{clan_id,steam_id,vip}` (see **18. Clans**). |
| Clan membership | `clans[]` `{clan_id,name}` | Links to clan page; clan priority expiry via `clan`→`changeExpire`. |
| Bonus balance | `bonus` | Loyalty/economy currency (profile "Ваши бонусы"). |
| Subscriptions | (server-side) | Profile "Подписки". |

---

### 7. Admin Actions Journaled *About* the Player (**17. Admin Audit Journal**)

The `logs` page is the accountability trail — "who did what, on which server, when." Row entity (`t1` logs ⋈ `t2` admin): `serverName`, `name` (acting admin), `date`, `log` (free-text action string).

| Property | Value | Competitive note |
|---|---|---|
| Structure | **Free-text `log` string**, substring-searchable (`t1.log`) | Not a normalized `{action_type,target,params}` schema — cannot reliably answer "all *bans* by admin X this week" (17 §8). |
| Player linkage | `<hashtag>` tokens inside `log` → `player.open()` | Drill-down into the modal from any journal line. |
| Sorting | Disabled (no `order` config) | Easy to beat. |
| Retention | No client-visible cap; unbounded pagination, `numrows=100` | Server-side policy not observable. |

**Which actions get journaled:** the audit captures panel-side admin operations (bans, kicks, group changes, etc.). Note the journal records the *action*, while the player-facing consequence is separately stored — e.g. a ban lands in `player.bans[]` *and* an entry appears in `logs`. Admin comments are separately author-stamped in `player_comment` (**08** §6), and message-to-card logging (`message` with `log=true`, **02** §5.1) writes an in-game warning permanently onto the player's card. So there are effectively **three overlapping audit trails**: the `logs` journal, the author-attributed `bans[]`/`comments`, and opt-in message-card records.

---

### 8. Retention & Time Horizon

| Dimension | Horizon | Source |
|---|---|---|
| Stat seasons | Back to **2016** (Сезон 0 pre-ICO 2016→2023; С1 UE4 2023→2025; С2 UE5 2025→present; "Все сезоны" rollup) | 04 §2.8 — effectively permanent, sliced by game-version boundaries |
| Combat logs | Date-range filters default to `allTime`; presets down to `last30days` | 13 §13.4 |
| Chat archive | `allTime` default range | 02 §3 |
| Bans | Full project-wide archive; permanent bans (`expire=0`) never expire | 09 |
| Audit journal | Unbounded (no visible cap) | 17 §8 |
| Comments | Append-only, immutable, unbounded | 08 §7 |

**Long-horizon per-player history (back to 2016) is a headline competitive feature** (04 §7). The season model is the retrieval index over that history.

---

### 9. Retrieval Mechanics Summary

Two transports serve the entire dossier:

| Transport | Call | Returns | Used for |
|---|---|---|---|
| **Player RPC** | `Action({script:'player', action:'get', data:{steam_id}})` → `POST /ajax/player.php` | the fat `player.info` object (identity, location, primetime, playtime, group, ban, bans[], stats, clans, discord, vac) | modal header + banners, one round-trip |
| **Table RPC** | `Action({script:'table', action:'<tableName>', data:'&table=…&page=&numrows=&search=<json>&order_by=&order_sort=&steam_id=<id>'})` → `POST /ajax/table.php` | paginated row sets | every sub-tab (`playerChat/Kills/Death/Revive/Damage/Teamkill/Vehicle/Games/Squad/Kits/Warn`) and every global page grid |

- The modal loads `player.info` once, then **lazily** fires a `table` call per sub-tab as it is opened, each with `&steam_id=<id>` appended and small `numrows` (10–20). Global pages fire the same `table` action without `steam_id`, with large `numrows` (100–500) and full filter sidebars.
- Twink/friends/checkBans/getPlayerOnlineData are extra `player`-script derivations, not table calls.
- Session expiry (`auth:true`) forces `location.reload()` on any call.

---

### 10. Coverage Matrix — Task Checklist vs. Storage Location

Every item the task asked to confirm, and where it lives.

| Requested datum | Stored? | Where retrieved | Chapter |
|---|---|---|---|
| SteamID / EOS / Discord / UUID | ✅ | modal header, `player.info` | 03; repo `6a7b3b3` |
| Name history / aliases | ✅ | `names[]`, `with_other_names` search | 03 |
| Twins / alts (shared-IP) | ✅ | `twink` modal | 03 §4.3 |
| Steam friends edge | ✅ | `findFriends` | 03 §4.2 |
| IP history | ✅ | `location[].ip` | 03 §3 |
| Sessions / total & period playtime | ✅ | `playtime`, `getPlayerOnlineData` | 03 §4 |
| Per-map stats / matches | ✅ | `playerGames`, profile Матчи | 03; 04 |
| Per-role / kit stats | ✅ | `playerKits`, profile Киты | 03; 04 |
| Kills / deaths / K-D | ✅ | combat logs + stat cards | 13; 04 |
| Revives | ✅ | `playerRevive` | 13 |
| Damage dealt | ✅ | `playerDamage` (magnitude in modal tab) | 13 |
| Teamkills | ✅ | `playerTeamkill` (passive log) | 13 |
| Kits used / kit-denial | ✅ | `playerKits` / `kits`+`kitSave` | 03; 04 |
| Chat log | ✅ | `playerChat` | 02 |
| Votes cast (initiated) | ✅ | `votes` (initiator) | 14 |
| Reports by/against | ⚠️ | `reports` (target only; **reporter not surfaced**) | 14 |
| Bans & mutes history + reasons/admins | ✅ | `bans[]`, `bans` page (`t3` admin) | 09 |
| Admin comments / notes | ✅ | `player_comment` (author-stamped) | 08 |
| Suspect marks | ⚠️ | `player_mark` (single enum, **no mark-author audit**) | 08 |
| Clan membership | ✅ | `clans[]` | 03; 18 |
| VIP status | ✅ | group 3 + `expire`, `vips` page | 03; 04; 06 |
| Admin actions journaled on player | ✅ | `logs` (free-text, unstructured) | 17 |

---

### 11. Competitive Takeaways (dossier-level)

1. **One universal card, everywhere.** The `player.info` dossier opens identically from chat, kills, bans, votes, reports, logs, clans — no context switch. Muscle memory + tight report→enforce loop.
2. **Deepest identity graph in class.** SteamID64 + EOS + Discord + VAC + Steam hours + IP/geo history + nick history + primetime + alts + Steam-friends + clan + economy on one screen.
3. **Alt-hunting suite** (shared-IP timeline + Steam-friends + co-presence calendar) is the standout forensic feature.
4. **Cross-project ban federation** (`checkBans`) is a network-effect moat.
5. **Progressive-ban policy-as-data** (`data-first/second/third/four` per rule) auto-recommends duration by prior `impact` bans.
6. **2016→present season retention** — very long per-player history, indexed by game-version seasons.
7. **Author accountability is uneven** — bans and comments are admin-attributed and the `logs` journal exists, but **marks have no author/history audit** and the journal is **free-text (unstructured)**. Normalizing the audit schema and adding mark-author/history are clear differentiators.
8. **Known gaps to beat:** damage magnitude hidden on the global grid; teamkills a passive log (no TK tally/forgive/auto-action); reports have no lifecycle and hide the reporter; one mark per player despite a multi-select *filter*; raw SQL aliases (`t1.player` etc.) leak into client `data-search`; PII (raw IPs) retained heavily.
