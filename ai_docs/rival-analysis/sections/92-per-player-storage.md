## Per-Player Data & Logs Storage

> **Cross-cutting spec.** This chapter answers one question at implementation grade: *for a single player identity, what does SQSTAT store, and by exactly which endpoint + payload + column schema does an admin retrieve it?* It is keyed to **the table endpoints** — every per-player log table (the modal detail sub-tabs `playerKills / playerDeath / playerRevive / playerDamage / playerTeamkill / playerVehicle / playerChat / playerWarn / playerKits / playerSquad / playerGames`, plus the comment/mark/ban/audit tables) is given its `table.php` `action=` id and its captured column schema. An engineer must be able to reimplement "the player dossier" from this chapter alone.
>
> **Ground truth.** Every contract, field type, column set and payload below is transcribed from the LIVE captured per-section chapters (read-only headless capture against `https://breaking.sqstat.ru`, `_blocked.json == []` — zero mutations fired): **03. Players Directory** (`caps/players/*`), **04. Player Profile** (`caps/players/_player_*`), **08. Comments & Marks** (`caps/notes/*`), **09. Ban Management** (`caps/bans/*`), **13. Combat Logs** (`caps/combat/*`), **17. Audit Journal** (`caps/logs/*`), **02. Chat** (reconstructed from `custom.js`/`frags/*`), **14. Votes & Reports**. This chapter does not re-capture; it re-projects those captures into one player-keyed model and cites the owning chapter per fact.
>
> **Two surfaces, one identity.** The dossier is read through two disjoint surfaces:
> 1. **The shared player-detail modal** (`#player_info` → cloned into `#playerModal`), embedded on *every* page, opened by `player.open(steam_id)`. This is the **admin rap sheet**: one fat `player.info` RPC (§1.1) + up to 11 lazily-loaded `table.php` sub-tab grids (§3). Full moderation/forensic surface.
> 2. **The self-service profile** at `GET /player/<id>?season=<…>` (04) — a hard-navigation SSR scoreboard (0 XHR). It exposes per-season aggregate stats but **none** of the forensic data (bans, chat, comments, marks, IPs, twins). Do not conflate the two.
>
> **Identity migration (LIVE-confirmed split).** The click-key of every row is nominally `steam_id`, but its captured *type differs by table* — the panel is mid-migration from SteamID64 to a UUID surrogate (repo commit `6a7b3b3`):
>
> | Returns `steam_id` as… | Tables (captured) | Chapter |
> |---|---|---|
> | **SteamID64** — `str(17)` | `allPlayers`, `banPlayers`, `playerKills/Death/Revive/Damage/Teamkill`, `playerChat` | 03, 09, 13, 02 |
> | **UUID** — `str(36)` | `playerComments`, `playerMark`, `logs` | 08, 17 |
>
> `eos_id` (`str(32)`) and Discord snowflake are carried alongside as secondary identifiers. Treat `steam_id` as an opaque identity token whose wire type is table-dependent until the migration completes.

---

### 1. Retrieval Transports (how *anything* about a player is fetched)

All four endpoints share the `Action({script, action, data})` wrapper (`custom.js:284`): `POST /ajax/<script>.php`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, body = `action=<action>` then each `data` key appended as `&k=v` (object) or raw-concatenated (string, **no value URL-encoding in the wrapper**). Success branch fires only on `status === "ok"`; `auth === true` ⇒ `location.reload()` (session expiry); else `msg` → error toast. `retryAbort:true` aborts any in-flight request of the same logical name.

| Transport | `script` → endpoint | Returns | Used for |
|---|---|---|---|
| **Player RPC** | `player` → `POST /ajax/player.php` | the fat `player.info` object (§1.1) in one round-trip | modal header, badges, banners, `bans[]` accordion; forensic reads (twink/checkBans/comments/kits) |
| **Table RPC** | `table` → `POST /ajax/table.php` | paginated `data.row[]` sets | every log sub-tab (§3) and every global grid; `&steam_id=<id>` appended scopes it to one player |
| **Live-server RCON** | `squad` → `POST /ajax/squad.php` | ack `{status:"ok"}` | mutations requiring the player **online** (ban/kick/kill/changeTeam/removePlayer/broadcast/squadMessage) — §5 |
| **Clan/economy** | `clan` → `POST /ajax/clan.php` | ack | `changeExpire` (ban/priority expiry), `vipPlayer` (clan-scoped VIP) — §6 |

#### 1.1 `POST /ajax/player.php` `action=get` — the fat entity (single-call dossier core)

**Request:** `{ steam_id: string }`. **Response:** `{ status:"ok", player:{…} }` → `player.info`. Field-by-field (03 §3):

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `steam_id` | string(17) | N | SteamID64, primary identity, click-key. |
| `eos_id` | string(32) | N | Epic Online Services id (copied into OWI report). |
| `name` | string | N | Current nickname. |
| `names[]` | `{name:string, date:unix}` | N | Nick history ("Другие ники" / Other nicks) dropdown. |
| `date` | unix ts | N | Last login ("Заходил" / Last seen). |
| `create_date` | unix ts | N | First seen ("Создан" / Created). |
| `baby` | bool | N | New/young-account flag → red warning icon by online time. |
| `bonus` | int | N | Bonus/currency balance ("Бонусы"). |
| `playtime` | `{online, boost, server}` | N | Aggregate playtime, boost time, favourite server. |
| `mark` | int enum `0`–`8` | N | Suspicion tag (§6 taxonomy); `0` = none. |
| `group` | `{name, color, icon, description}` | N | Privilege badge (special art for VIP/Moderator). |
| `group_id` | enum `"0".."5"` | N | `0` none · `1` Admin · `2` Moderator · `3` VIP · `4` Camera · `5` Trainee. |
| `expire`, `group_description`, `prefix`, `prefix_rgb`, `image` | mixed | Y | Group-assignment fields consumed by the group form (§5). |
| `ban` | `{expire, reason, admin_name, date(unix), description}` \| falsy | Y | Current **active** ban → red banner + corner ribbon. |
| `bans[]` | `{admin_name, date(unix), reason, description, impact:bool, unban:"0"/"1"}` | N | Full punishment **history** → "Наказания" accordion. `impact`=counts toward escalation; `unban="1"`=revoked. |
| `canBan` | bool | N | Gates Наказать/kill/banname/kits. |
| `canUnban` | bool | N | Gates Разбанить. |
| `canPermanent` | bool | N | Gates permanent-ban tier injection. |
| `canChangeGroup` | bool | N | Gates Группа. |
| `canSelfKick` | bool | N | Gates "Кикнуть без причины". |
| `progressiveBan` | bool | N | Enables escalating day-tier relabel/lock on the ban form. |
| `is_you` | bool | N | Self → group select + expiry disabled. |
| `name_banned` | bool | N | Current nick on banned-names list → toggles banname/unbanname. |
| `vac` | `{ban, days}` | N | VAC ban status. |
| `steam_info` | `{ban:{vac, ban, days}, squad:{time}}` | N | Steam enrichment: VAC/game-ban badge + Squad hours. |
| `discord` | string(id) \| false | Y | Discord user id → `discord.com/users/<id>`. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date(unix)}` | N | Geo-IP history (flag, city, tz, coords, **raw IP**, seen date). `[0]` = current. |
| `primetime[]` | `{start:unix, end:unix}` | N | Typical active hours → `HH:mm`. |
| `clans[]` | `{clan_id, name}` | N | Clan memberships → `/clan.php?id=`. |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` \| false | Y | Live session — enables message/kill/changeTeam/removePlayer; `squad.id` prepends as a name badge. |
| `stats` | object | N | Aggregate combat stats (kill, die, revive, winrate, kd, kit, kit_name) for the six stat cards. |
| `comments_count` | int | N | Seeds the comments-drawer count badge. |

> **Over-return note (03 §7.9):** the directory list `allPlayers` returns a denormalized identity+moderation payload *per row* (`eos_id, create_date, mark, bonus, discord, expire, group_id`) even though only `steam_id/name/date` render — a scraper with an admin session harvests the identity graph for all 385 K players from the list endpoint alone.

---

### 2. `table.php` — the universal per-player log transport

Every log sub-tab and every global grid is **one** endpoint. Modal sub-tabs are the same request with the tab's `action=` and an appended `&steam_id=<id>` scoping filter.

**Request (form-urlencoded body):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id (e.g. `playerKills`). |
| `table` | string | Y | Duplicate of `action` (`buildTable` sends both). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size (per-tab values in §3.1). |
| `search` | URL-encoded JSON | Y | 5-bucket filter `{text,check,multiselect,managers,slider}`; empty `{}` = unfiltered. `text` keyed by each control's `data-search` DB alias; `check` values are the strings `"true"`/`"false"`; date range writes `t1.date.startdate`/`t1.date.enddate` (unix, `0/0`=allTime). |
| `order_by` | string \| `false` | Y | DB column alias to sort by, or literal `false` = server default. |
| `order_sort` | `asc`\|`desc`\|`false` | Y | Sort direction, or `false`. |
| `steam_id` | string | N | **Appended for modal sub-tabs** — scopes the grid to one player. Absent on global pages. |
| `pagination` | `true` | N | Count-only variant (§2.1). |

**Response — data call** (`200 application/json`):

| Field | Type | Meaning |
|---|---|---|
| `status` | string | `"ok"` on success. |
| `exec_time` | float — s | Total server exec time. |
| `data.totalPage` | int | **`0`** on the data call (real value from the count call). |
| `data.totalRows` | int | **`0`** on the data call. |
| `data.currentPage` | string | Echoed page index (e.g. `"1"`). |
| `data.custom` | bool | Custom/manager-scoped result flag (`false` typical). |
| `data.query_time` | float — s | Row-query wall time (perf telemetry). |
| `data.count_time` | int — s | `0` on the data call (counting deferred). |
| `data.row[]` | array(≤`numrows`) | Result rows; per-table schema in §3.2. |

#### 2.1 `&pagination=true` — deferred count variant

Same body + `&pagination=true`, fired as a second call (only when the first page filled or `currentPage != 1`). Splits the expensive `COUNT(*)` off the hot path:

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | ceil(totalRows / numrows). |
| `totalRows` | **string** (int) | Total matching rows. *Type inconsistent across tables* — some return int; treat as numeric. |
| `count_time` | float — s | COUNT query time (console-logged). |
| `status` | string | `"ok"`. |
| `exec_time` | float — s | Total exec. |

---

### 3. The Per-Player Log Tables — keyed by `table.php action=` (the heart of the dossier)

Every modal detail tab (03 §4.1) lazy-loads on `show.bs.tab`, POSTing `action=<table>&…&steam_id=<id>`. The modal `collum` (rendered columns) is a **scoped projection** of the same underlying row object the global grid returns; e.g. modal `playerKills` shows `[server,name,weapon,date]` because the opened player is *always* the killer, whereas the global `kills` page also renders killer/victim names. Row schemas (the full wire object) are the LIVE-captured ones from 13/02/08.

#### 3.1 Sub-tab endpoint contract (server table id · scoped collum · page size)

| Tab (RU / EN) | `action=` | modal `collum` (rendered, scoped) | `numrows` | `showPages` | Panel `#id` | Row schema |
|---|---|---|---|---|---|---|
| Наказания / Bans | *(none — `player.info.bans[]`, accordion `#player_info_accordion-bans`, no table call)* | admin, date, reason, description, impact, unban | — | — | — | §1.1 `bans[]`; §7 |
| Варны / Warns | `playerWarn` | `admin, text, date` (list via `#player_info_warn-template`) | 10 | 3 | `#player_info_warn-table` | admin, text, date(unix) |
| Чат / Chat | `playerChat` | `server, date, team, type, msg` | **20** | 3 | `#player_info_chat-table` | §3.2 `playerChat` |
| Тимкиллы / Teamkills | `playerTeamkill` | `server, date, killed, kit` | 10 | 3 | `#player_info_teamkill-table` | §3.2 `playerTeamkill` |
| Киты / Kits | `playerKits` | `kit, cnt` | 10 | 3 | `#player_info_kits-table` | kit:string, cnt:int |
| Сквады / Squads | `playerSquad` | `server, team, date, squad_id, name` | 10 | 3 | `#player_info_squad-table` | server(HTML), team, date(unix), squad_id, name |
| Убийства / Kills | `playerKills` | `server, name, weapon, date` | 10 | 3 | `#player_info_kills-table` | §3.2 `playerKills` |
| Смерти / Deaths | `playerDeath` | `server, weapon, date` | 10 | 3 | `#player_info_death-table` | §3.2 `playerDeath` |
| Игры / Games | `playerGames` | `server, map, win, date` | 10 | 3 | `#player_info_games-table` | server(HTML), map, win(label), date(unix) |
| Поднятия / Revives | `playerRevive` | `server, name, date` | 10 | 3 | `#player_info_revive-table` | §3.2 `playerRevive` |
| Урон / Damage | `playerDamage` | `server, weapon, name, **damage**, date` | 10 | 3 | `#player_info_damage-table` | §3.2 `playerDamage` |
| Техника / Vehicle | `playerVehicle` | `server, vehicle, weapon, damage, date` | 10 | 3 | `#player_info_vehicle-table` | server(HTML), vehicle, weapon, damage:int, date(unix) |

- **Chat tab:** each `msg` cell is post-processed by `isObscene(text)` → red warning-triangle prefix. `type` renders `<code style="color:type.color">type.name</code>` (channel object `{name,color}`). Scoped `numrows` is 20 in the modal vs **300** on the global `chat` page (02 §3).
- **Damage asymmetry (LIVE, 13 §13.8):** the modal `playerDamage` tab **renders** `damage` (collum includes it), but the *global* `damages` page returns `damage` in the row yet **omits it from `collum`** — never shown or sortable there. A documented easy win for a competitor (surface + sort by damage).
- **Teamkills passive log:** no per-player TK tally / forgive / auto-action; enforcement only via the modal's ban/kick.

#### 3.2 Captured row schemas (full wire object per event class — LIVE, 13)

All scalars are JSON strings unless noted. `date` = **unix epoch seconds** (string) everywhere. `server` = pre-rendered HTML badge `<code>[X]</code>`. `steam_id`/`victim_steam_id` = `str(17)` SteamID64.

**`playerKills`** (global `collum:["steam_id","server","date","player_name","name","weapon"]`)

| Field | Type | Meaning | Rendered? |
|---|---|---|---|
| `id` | str(num) | Event PK | no |
| `steam_id` | str(17) | Killer — row-click key | hidden col 1 |
| `victim_steam_id` | str(17) | Victim — makes target openable (kills only, via `#kill_template`) | no |
| `game_id` | str(num) | Match id → `/game/<id>` | no |
| `date` | str(unix) | Event time | Дата |
| `weapon` | str | Weapon/entity id | Оружие |
| `kit` | str | Killer kit id | no |
| `player_name` | str | Killer name | Кто / Who |
| `name` | str | Victim name | Кого / Whom |
| `server_id` | str(num) | Server id (1/6/7/9/10/11) | no |
| `map` | str | Map + layer | no |
| `server` | HTML | Server badge | col 2 |

**`playerDeath`** (`collum:["steam_id","server","date","player_name","weapon"]`) — no second-party column: `id, steam_id`(deceased)`, game_id, date, weapon`(actor that killed)`, kit, player_name, server_id, map, server`. Killer still **filterable** via the Кого input.

**`playerRevive`** (`collum:["steam_id","server","date","player_name","name"]`) — `id, steam_id`(medic)`, victim_steam_id`(revived)`, game_id, date, kit, player_name`(medic)`, name`(revived)`, server_id, map, server`. No `weapon`.

**`playerDamage`** (`collum:["steam_id","server","date","player_name","name","weapon"]`) — `id, steam_id`(attacker)`, victim_steam_id, game_id, date, `**`damage`**`:str(num), weapon, player_name`(attacker)`, name`(victim)`, server_id, map, server`. **`damage` present in every row but excluded from global `collum`.**

**`playerTeamkill`** (`collum:["steam_id","server","date","player","killed"]`, `numrows:100`) — server-renders HTML: `id, server_id, steam_id`(offender)`, killed`(HTML, team victim, incl. clan tag)`, date, killed_group`(null when none)`, player`(HTML, offender name)`, player_group`(null)`, kit`(HTML `<img>`)`, server`. No `weapon`, no `victim_steam_id`.

**`playerChat`** (`collum:["steam_id","server","date","team","name","type","msg","play"]`, global `numrows:300`, 02 §2.4) — `id, steam_id`(str17 author)`, server`/`server_id, date`(unix)`, team`(int enum → team icon)`, name, color`(hex, nullable)`, type`(object `{name,color}` in row; enum below)`, msg, play`(UI-only TTS cell, no server data).

`type` scope enum: `ChatAll` (Всем/All), `ChatTeam` (Команда/Team), `ChatSquad` (Сквад/Squad), `ChatAdmin` (Админ чат/Admin), `broadcast` (Broadcast, gold `#DAA520`).

#### 3.3 Global grid equivalents (same `action`, no `&steam_id`, big `numrows`)

The same tables serve dedicated pages with the full filter sidebar and large page sizes. LIVE scale (13 §13.2):

| Page | `action=` | `numrows` | Live totalRows | count_time | Кто→ / Кого→ aliases (leaked SQL) |
|---|---|---|---|---|---|
| `kills` | `playerKills` | 500 | 4,402,799 | 1.37 s | `t2.player` / `t4.player` |
| `deaths` | `playerDeath` | 500 | 5,630,431 | 1.36 s | `t5.player` / `t2.player` |
| `revives` | `playerRevive` | 500 | 1,217,973 | 0.27 s | `t5.player` / `t2.player` |
| `damages` | `playerDamage` | 500 | 13,413,500 | 2.76 s | `t2.player` / `t5.player` |
| `teamkills` | `playerTeamkill` | 100 | 653,590 | 0.10 s | `t5.player` / `t2.player` |
| `chat` | `playerChat` | 300 | — | — | `t2.player` (name), `t1.msg` (body) |

Shared server multiselect (`data-search="server_id"`, this tenant's own servers; note id gaps 2–5, 8): `1` RAAS/AAS #1 · `6` БЕЗ ГОЛОСОВАНИЯ #2 · `7` INVASION #3 · `9` Custom для FW · `10` Custom для MDC · `11` Custom для BSS. Combat/audit date range uses the shared `dateRange` widget (21 presets, `allTime` default `0/0`).

---

### 4. Forensic Reads — `player.php` derivations (not table calls)

Extra `script:'player'` reads that enrich the dossier beyond `get` (03 §2.4). All non-destructive.

| `action` | `data:{…}` | Response shape (captured/render) | Purpose |
|---|---|---|---|
| `getComments` | `{steam_id}` (UUID) | `{status:"ok", comments:[{name:str, date:unix-str, text:str}]}` | Comment thread → drawer (§6). |
| `kits` | `{steam_id}` | `{kits:[{kit, deny:bool, date?:unix}]}` | Per-kit deny state (§5 kit modal). |
| `twink` | `{steam_id}` | `{list:[{steam_id, name, perm:bool, min_date:unix-delta, ips:[{loc, date:unix, owner_date:unix}]}]}` | Shared-IP alt candidates. `perm`=candidate carries permanent ban; `min_date` humanized via `moment.duration(min_date*1000)`; each `ips[]` shows both accounts' seen-times side by side. |
| `twinkOnline` | `{steam_id, compare_steam_id, start:unix, end:unix}` | `{calendar:[<fullcalendar events>]}` | Overlay two accounts' weekly sessions to prove co-presence. |
| `findFriends` | `{steam_id, compare_steam_id}` | `{in_friend:bool}` | Steam-friends edge between two accounts. |
| `checkBans` | `{steam_id}` | `{projects:[{name, discord?:url, online:int-sec, ban:{total:int, current:null\|{reason, date:unix, expire:unix\|"0"}}}]}` | Cross-project ban federation. `expire=="0"` ⇒ "Перманент"; else From/To. |
| `getPlayerOnlineData` | `{steam_id, start:unix, end:unix}` | online/boost/queue time series | Chart with **График / Календарь / По серверам** (Chart/Calendar/Per-server) sub-tabs; three series **Онлайн / Буст / Очередь**. |
| `downloadStat` | form POST (`post_to_url`) `{action, steam_id}` | file download | Stat export. |

**Alt-hunting workflow (03 §4.3):** `twink` (shared-IP candidates) → `findFriends` (confirm Steam social edge) → `twinkOnline` (co-presence calendar). A complete anti-ban-evasion engine — the standout forensic feature.

---

### 5. Write Actions = Permissions (exact `Action({script,action,data:{…}})`)

Every state-changing capability on the player, verbatim from captured modal JS (03 §2.4/§2.5, 09 §4, 02 §2.5). These equal the operator's permission surface; buttons default `display:none`/`.hide` and are revealed by `setInfo()` per server capability flags (§8).

| UI label (RU / EN) | `action` | script → endpoint | `data:{…}` keys (type) | Effect | Destr. |
|---|---|---|---|---|---|
| open card | `get` | player → player.php | `steam_id` | Load `player.info`. | N |
| Добавить / Add player | `add` | player | `steam_id` | Create record from SteamID64, open it. | Y |
| Наказать→Кикнуть / Kick w/ reason | `kick` | squad | `steam_id, reason_id, description, noReason:false` | Kick with rulebook reason. Online only. | Y |
| Кикнуть без причины / Kick no reason | `kick` | squad | `steam_id, reason_id, description, noReason:true` | Kick without rule (confirm). Gated `canSelfKick`. | Y |
| Наказать→Забанить / Ban | `ban` | squad | `server_id`(if online)`, steam_id, reason_id, description, days` | Ban N days; `days=0`/`-1` = permanent. | Y |
| Разбанить / Unban | `unban` | squad | `steam_id, unban:bool` | Lift ban; `unban:true` **fully erases** record, `false` keeps history (`unban="1"`). Gated `canUnban`. | Y |
| Сообщение / Message | `message` | player | `steam_id, time:int-sec, msg:≤512, log:bool` | In-game DM repeated for `time`s; `log=true` mirrors onto card. | Y |
| Команда / Switch team | `changeTeam` | squad | `server_id, steam_id` | Force team swap (confirm). Online only. | Y |
| Убить / Kill | `kill` | squad | `server_id, steam_id` | Kill in-game, dissolves squad. Gated `canBan`+online. | Y |
| Кик из сквада / Remove from squad | `removePlayer` | squad | `server_id, steam_id` | Eject from fireteam/squad. Online + in squad. | Y |
| tag menu / Подозрение…·Снять метку | `mark` | player | `steam_id, mark:int 0–8` | Set/clear suspicion tag (`0` clears). | Y |
| Группа→Сменить группу / Change group | `changeGroup` | player | `steam_id, group_id, date`(expire unix)`, description, prefix, prefix_rgb, image` | Assign group + expiry + custom prefix/RGB/image (**VIP grant** path). Gated `canChangeGroup`; disabled for self. | Y |
| Забанить ник / Ban nickname | `addBanName` | player | `name` | Add current nick to banned-names blacklist. | Y |
| Разбанить ник / Unban nickname | `removeBanName` | player | `name` | Remove nick from blacklist. | Y |
| Киты→Сохранить / Kit deny save | `kitSave` | player | `steam_id, kits`(JSON `{kit:bool}`) | Toggle per-kit denial. Modal warns it "may violate server license terms." | Y |
| comments drawer send | `addComment` | player | `steam_id, text:≤256` | Internal admin comment (author = session). | Y |
| Проверить баны / Check bans | `checkBans` | player | `steam_id` | Cross-project ban lookup (§4). | N |
| Поиск твинков / Find alts | `twink` | player | `steam_id` | Alt detection (§4). | N |
| VIP (clan-scoped) | `vipPlayer` | clan | `clan_id, steam_id, vip:bool` | Grant/revoke clan-priority VIP. | Y |
| ban/priority expiry edit | `changeExpire` | clan | ban-expiry payload | Adjust an existing ban/priority `expire`. | Y |
| Копировать телепорт / Copy teleport | *(client)* | — | — | Copies `AdminTeleportToPlayer <steam_id>`. | N |
| Заявка в OWI / OWI report | *(client)* | — | — | Copies cheat-report template (name/EOS/Steam URL). | N |
| card link | *(client)* | — | — | Copies `https://<host>/?steam_id=<id>`. | N |

> Only `players.html`/`playersOnline.html` expose the FULL write set (`ban/kick/kill/kits/changeGroup/changeTeam/add`). Other pages (`bans/chat/kills/…`) embed the same modal but a **reduced** action set (per `action_catalog.txt`: reads like `twink/checkBans/getPlayerOnlineData` present, write actions restricted). Actual gating is server-driven (§8).

---

### 6. Annotations — Comments & Suspicion Marks (LIVE schemas, UUID identity — 08)

Two dedicated tables plus the modal write verbs. **Note the `steam_id` type flips to `str(36)` UUID here** (identity migration).

#### 6.1 `POST /ajax/table.php action=playerComments` — global comment feed

`buildTable({table:'playerComments', numrows:100})`, `collum:["steam_id","date","admin","player","text"]`, `searchInput:["playerComments-name"(→`t5.player`),"playerComments-admin"(→`t2.player`),"playerComments-text"(→`t1.text`)]`. Aliases confirm join `t1`=comments, `t2`=author admin, `t5`=target player. Row click → `player.open(td[data-contact="steam_id"])`.

**Captured `data.row[]` schema:**

| Field | Type | Meaning |
|---|---|---|
| `id` | str(int) | Comment PK. |
| `steam_id` | **str(36) UUID** | Target player identity (row-click key). |
| `admin_id` | str(17) Steam64 | Authoring admin. |
| `date` | str(10) **unix** | When written. |
| `text` | str (HTML-escaped, `&quot;` double-escaped) | Note body; unescaped client-side via `.replace(/&amp;quot;/g,'"')`. |
| `admin` | str (pre-rendered HTML) | Author display block `<code style="color:#<hex>">`. |
| `admin_color` | str(6) hex | Author name color. |
| `admin_group` | str(1) | Author group id. |
| `player` | str (pre-rendered HTML) | Target display block. |
| `player_color` | str \| null | Target color. |
| `player_group` | str \| null | Target group. |

#### 6.2 `POST /ajax/table.php action=playerMark` — suspect watchlist

`buildTable({table:'playerMark', numrows:100})`, `collum:["steam_id","player","date","mark","ban"]`, `searchInput:["playerMark-name"(→`t1.player`, text),"playerMark-mark"(→`mark`, multiselect, `value=1..8`)]`. Marked rows carry CSS `player_mark`. The multiselect is an **OR filter over the log** (values `1`–`8`; **no "unmarked"/`0` option**).

**Captured `data.row[]` schema:**

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | **str(36) UUID** | Suspect identity (row-click key). |
| `eos_id` | str(32) | EOS id. |
| `name` | str (raw) | Nickname. |
| `date` | str(10) **unix** | Last seen ("Заходил"). |
| `create_date` | str(10) **unix** | **When the mark was created** (persisted, not shown as a column). |
| `mark` | str (pre-rendered HTML `<i class="fa …">`) | Reason icon (enum → icon). |
| `bonus` | str(int) | Bonus balance. |
| `discord` | str(18) snowflake | Discord id. |
| `color` | str(6) hex | Nickname color. |
| `player_group` | str(1) | Player group id. |
| `ban` | str (pre-rendered HTML `<span class="label …">`) | Ban-status label (Нет/None = not banned). |
| `player` | str (pre-rendered HTML) | Colored nickname block. |

#### 6.3 Write verbs & mark taxonomy

| Verb | `action` | `data:{…}` | Response | Effect | Destr. |
|---|---|---|---|---|---|
| Read thread | `getComments` | `{steam_id}` | `{status:"ok", comments:[{name, date:unix, text}]}` | Populate drawer. | N |
| Add note | `addComment` | `{steam_id, text}` (trimmed non-empty, ≤256) | `{status:"ok"}` | Persist note authored by session admin; re-runs `getComments`. | Y |
| Set/clear mark | `mark` | `{steam_id, mark:int 0–8}` | `{status:"ok"}` | Write single mark enum (`0` clears); flip animation + banner + row highlight. | Y |

**Mark enum (single scalar, replaced on set — a player carries exactly ONE):**

| val | RU label / EN gloss | icon |
|---|---|---|
| 1 | Подозрение на WallHack / Suspected WallHack | `fa-eye` |
| 2 | Подозрение на AimBot / AimBot | `fa-crosshairs` |
| 3 | Подозрение на SpeedHack / SpeedHack | `fa-tachometer` |
| 4 | Подозрение на спавн объектов / object spawning | `fa-bomb` |
| 5 | Подозрение на перезарядку / reload exploit | `fa-refresh` |
| 6 | Подозрение на гриф / griefing | `fa-free-code-camp` |
| 7 | Подозрение на конфиг / illegal config | `fa-file-excel` |
| 8 | Токсичный игрок / toxic | `fa-biohazard` |
| 0 | Снять метку / clear (dropdown-only, not a filter option) | `fa-times` |

**Drawer state predicates (08 §5.1):** container `#playerModal .player_comments`; `open()` toggles `open` class and **fetches only when it becomes open** (`if(container.toggleClass('open').hasClass('open')) get()`); composer `<input maxlength="256">`; submit on Enter or button; validation `text.trim()!=""` only; append-only (no edit/delete). **Mark predicates (08 §5.2):** each `<a onclick="player.mark.set(n)">` fires directly (**no confirm**); `render(mark)` shows `#player_info_mark` pulsing banner when `mark!="0"`, adds `.disabled` to the active option, toggles `player_mark` on `tr[data-id="<steam_id>"]`.

> **Gaps (08 §6–7):** comments are **author-attributed** (accountability trail) but **immutable/append-only**; marks are **NOT author-attributed** (`create_date` = *when*, but no *who* — no mark history/audit). Only one mark per player despite the multi-select *filter*.

---

### 7. Bans & Punishment History (09)

#### 7.1 `POST /ajax/table.php action=banPlayers` — global ban archive

`buildTable`: `collum/order:["steam_id","name","reason","date","expire"]` (all sortable), `numrows:100`. `searchInput:["banPlayers-name"(→`t2.player`),"banPlayers-admin"(→`t3.player`),"banPlayers-reason"(→`t1.reason`),"banPlayers-description"(→`t1.description`),"banPlayers-permanent"(check `permanent`),"banPlayers-startdate","banPlayers-enddate"]`. Join: `t1`=bans, `t2`=banned player, `t3`=issuing admin. Row click → `player.open(<hashtag>)`.

**Captured `data.row[]` schema:**

| Field | Type | Meaning |
|---|---|---|
| `id` | str(num) | Ban PK (`t1.id`) → `data-id`/`trID-<id>`. |
| `steam_id` | str(17) Steam64 | Banned player (hidden col, drives row-click). |
| `name` | str | Nick at ban time. |
| `reason` | str | Reason text; **embeds expiry as trailing `… до DD.MM.YYYY HH:MM`**. |
| `description` | str (may be `""`, ≤512) | Free-text admin comment. |
| `admin_id` | str(17) Steam64 | Issuing admin (raw id; name resolved separately). |
| `date` | str **unix** | When issued ("Забанен"). |
| `expire` | str **pre-rendered HTML** | Server returns a ready `<span class="badge …">DD.MM.YYYY HH:MM</span>` (permanent → distinct badge), injected verbatim. |
| `unban` | str `"0"`/`"1"` | `"1"` = revoked (kept in history), `"0"` = active. |

Filter-only: `permanent` (check bucket, bool-as-string, = `expire==0`). Modal-only: `impact` (bool, counts toward progressive escalation).

#### 7.2 Rules catalog (ban `<select>` = progressive policy-as-data)

Each `<option value=<reason_id>>` (e.g. `1`=Другое, `2`=DPAC anti-cheat, `110`=Оскорбления/Insults, `160`=Cheating, `173`=Teamdamage) carries escalation attrs `data-first / data-second / data-third / data-four` = ban-days for the 1st/2nd/3rd/4th offense (`data-four="30"` common cap → permanent). `<optgroup>`: Особые/Общие/Для сквадных/Для техники/Милсим. When `progressiveBan`, only tiers up to `(#prior impact bans + 1)` are enabled; last enabled tier auto-checked as "Рекомендуемое" (Recommended). Permanent tier injected only when `canPermanent && progressiveBan`.

#### 7.3 Cross-project ban federation

`checkBans` (§4) → per-project cards `{name, discord?, online, ban:{total, current:{reason, date, expire}}}`. `expire=="0"` ⇒ "Перманент". `collabans` is the collaborative cross-community variant of `banPlayers`. Ban mutation only via the modal (`ban`/`unban` on `script:'squad'`, §5).

---

### 8. Admin Actions Journaled *About* the Player (17)

#### 8.1 `POST /ajax/table.php action=logs` — audit trail

`buildTable({table:'logs', collum:["serverName","name","date","log"], numrows:100, order:[]})` (no column sort wired). `searchInput:["logTable-user"(→`t2.player`),"logTable-name"(→`t1.log`),"logTable-startdate"(→`t1.startdate`),"logTable-enddate"(→`t1.enddate`),"logTable-server"(→`server_id`)]`. Two-phase load (rows fast, count deferred). Live scale: 110,488 rows / 1,105 pages.

**Captured `data.row[]` schema:**

| Field | Type | Meaning |
|---|---|---|
| `id` | str(num) | Audit PK (auto-increment, effectively newest-first) → `trID-<id>`. |
| `server_id` | str(int) | FK to server; `"0"` = panel-global (login) → empty `serverName`. |
| `steam_id` | **str(36) UUID** | Event subject. **Returned but NOT rendered** — no `collum` maps it. |
| `date` | str(10) **unix** | Event time → relative badge. |
| `log` | str (free text / HTML) | Human-readable action (Russian); embeds `<b>/<i>/<hashtag>SteamID64</hashtag>` tokens. |
| `name` | str | Acting admin display name. |
| `serverName` | str (may be `""`) | Denormalized server label. |

**Two identifiers, neither clean (17 §3):** the row carries a `str(36)` UUID `steam_id` it never renders, while drill-down keys off a `str(17)` SteamID64 parsed out of the `log` prose (`<hashtag>` → `player.open($(this).text())`). Structure is **free-text `log`**, substring-searchable on `t1.log` — cannot reliably answer "all *bans* by admin X this week." Read-only page (no mutation of its own).

**Observed `log` templates:** `Авторизовался` (login, `server_id=0`), `Зашёл в камеру` (admin-cam, dominant), `Забанил <b>{name}</b> <hashtag>{id}</hashtag> на <b>{N}</b> дн <i>"{reason до …}"</i>`, `Разбанил <b>{name}</b> <hashtag>{id}</hashtag>`, `Отправил сообщение <b>{tag}</b> <hashtag>{id}</hashtag> - "{msg}"`.

#### 8.2 Three overlapping audit trails

A single admin action lands in **three** places: (1) the `logs` free-text journal; (2) author-attributed structured records — `player.bans[]` (`admin_name`) and `player_comment` (`admin_id`); (3) opt-in message-to-card records (`message` with `log=true`, 02 §5.1) — a permanent in-game-warning line on the player's card.

---

### 9. Permission / Visibility Logic (show/hide predicates)

Buttons default hidden (inline `display:none` / `.hide`), revealed by `setInfo()` per **server-provided** capability flags on `player.info` — the server is the source of truth, the client only reflects it (03 §6, 09 §6):

| Element | Predicate |
|---|---|
| Наказать (issue ban) | `canBan && !player.info.ban` (no active ban). |
| Разбанить + corner ribbon | `player.info.ban && canUnban`. |
| Убить / kill, kit/banname items | `canBan && player.info.online`. |
| Кикнуть без причины | `canSelfKick`. |
| Забанить ник ⟷ Разбанить ник | `canBan`; which one shows toggles on `name_banned`. |
| Группа (`#player_info-group_btn`) | `canChangeGroup`; group select+expiry disabled when `is_you`. |
| Message / Команда / Kill / removePlayer | require `player.info.online` (+ `online.squad.id` for removePlayer). |
| Mark / twink / checkBans / comments / copy-teleport / OWI / downloadStat | ungated — visible to any admin who can open the card. |

Session expiry: any `Action` response with `auth:true` → `location.reload()`.

---

### 10. Everything Queryable About One Player — master index

Keyed by the retrieval call. `[modal]` = scoped by `&steam_id`; `[global]` = dedicated page.

| Datum | Stored in | Endpoint / call | Type flags | Chapter |
|---|---|---|---|---|
| Full identity + moderation entity | `player.info` | `player`→`get {steam_id}` | fat object §1.1 | 03 |
| Kills log | `playerKills` | `table`→`playerKills` [modal/global] | date=unix; weapon | 13 |
| Deaths log | `playerDeath` | `table`→`playerDeath` | no 2nd party | 13 |
| Revives log | `playerRevive` | `table`→`playerRevive` | no weapon | 13 |
| Damage log (+magnitude) | `playerDamage` | `table`→`playerDamage` | `damage` hidden on global grid | 13 |
| Teamkills log | `playerTeamkill` | `table`→`playerTeamkill` | HTML-rendered, `numrows:100`, passive | 13 |
| Vehicle log | `playerVehicle` | `table`→`playerVehicle` | modal-only | 03 |
| Chat log | `playerChat` | `table`→`playerChat` | modal `numrows:20` / global `300`; obscenity-flagged | 02 |
| Warns | `playerWarn` | `table`→`playerWarn` | list mode | 03 |
| Kits used (count) | `playerKits` | `table`→`playerKits` | `{kit,cnt}` | 03 |
| Squad history | `playerSquad` | `table`→`playerSquad` | modal-only | 03 |
| Games / matches | `playerGames` | `table`→`playerGames` | + profile "Матчи" → `/game/<id>` | 03/04 |
| Kit-denial state | per-kit `{kit:bool}` | `player`→`kits` / `kitSave` | write | 03 |
| Admin comments | `playerComments` | `table`→`playerComments` + `player`→`getComments`/`addComment` | **UUID** id; author-stamped, append-only | 08 |
| Suspicion mark | `playerMark` | `table`→`playerMark` + `player`→`mark` | **UUID** id; single enum, `create_date` but no author | 08 |
| Bans / punishment history | `banPlayers` / `player.info.bans[]` | `table`→`banPlayers` [global] + `player`→`get` | Steam64 id; `admin_id`, `impact`, `unban` | 09 |
| Active ban | `player.info.ban` | `player`→`get` | red banner | 09 |
| Cross-project bans | remote federation | `player`→`checkBans` | `expire=="0"`=perm | 09 |
| Twins / alts (shared-IP) | derived | `player`→`twink` | `perm`, `min_date`, `ips[]` | 03 |
| Steam-friend edge | derived | `player`→`findFriends {steam_id,compare_steam_id}` | `in_friend:bool` | 03 |
| Co-presence overlay | derived | `player`→`twinkOnline {…,start,end}` | calendar | 03 |
| IP + geo history | `location[]` | `player`→`get` | raw IP, tz, lat/lng | 03 |
| Primetime / sessions / playtime | `primetime[]`, `playtime`, `getPlayerOnlineData` | `player`→`get` / `getPlayerOnlineData {steam_id,start,end}` | 3-series chart | 03 |
| Per-season aggregate stats | `player_stat[steam_id,season]` | SSR `GET /player/<id>?season=` | 0 XHR; back to 2016 | 04 |
| Per-weapon / per-kit / vehicle stats | server-side | SSR profile | inline Chart.js arrays | 04 |
| Privilege group / VIP / prefix | `player.group`, `group_id`, `expire` | `player`→`get` / `changeGroup`; `clan`→`vipPlayer` | Steam64 id | 03/06 |
| Clan membership | `clans[]` | `player`→`get` | → `/clan.php?id=` | 03/18 |
| Bonus / subscriptions | `bonus` / server-side | `player`→`get` / SSR profile | economy | 03/04 |
| Votes initiated | `votes` | `table`→`votes` | initiator only; no per-voter store | 14 |
| Reports against player | `reports` | `table`→`reports` | target only; **reporter not surfaced** | 14 |
| Admin actions journaled | `logs` | `table`→`logs` | **UUID** id unrendered; free-text `log` | 17 |

---

### 11. Retention, Gaps & Competitive Takeaways

**Retention horizon:** stat seasons reach back to **2016** (С0 pre-ICO 2016→2023 · С1 UE4 2023→2025 · С2 UE5 2025→present · "Все сезоны" rollup, 04 §2.8); combat/chat default to `allTime`; bans/comments/audit unbounded (no client-visible cap). Long per-player history is the headline feature; the season model is its retrieval index.

**Identity-migration gap (LIVE):** `steam_id` is a `str(17)` SteamID64 on combat/chat/ban tables but a `str(36)` UUID on comment/mark/audit tables — a competitor must model identity as an opaque token with a per-table wire type until the `6a7b3b3` migration completes, and note the audit log even carries a UUID it never renders while drilling down via a SteamID64 baked into prose.

**Known gaps to beat:**
1. **Damage magnitude hidden** on the global `damages` grid (`damage` in row, out of `collum`) — surface + sort.
2. **Teamkills passive** — no per-player TK tally / forgive / auto-action.
3. **Marks not author-attributed** — `create_date` (when) but no who / no history; only one mark per player despite a multi-select *filter*; no "unmarked" filter.
4. **Comments immutable & 256-char single-line**; body double-escaped (`&amp;quot;`) round-trip.
5. **Audit `log` is free-text** — not `{actor, action_enum, target+id, before/after, server_id, ts}`; can't reliably answer "all bans by admin X this week"; no column sorting (`order:[]`).
6. **Reports hide the reporter** and have no lifecycle/resolution state (14).
7. **Raw SQL aliases leak** to the client (`data-search="t1.date"`, `t2.player`, `t5.player`) — maintenance smell + mild info-leak.
8. **Heavy PII retention** (raw IPs, timezones, map per player) — differentiator and compliance surface.

**Strengths to match/beat:** one universal card opened identically from every page; the deepest identity graph in class (SteamID64+EOS+Discord+VAC+Steam hours+IP/geo+nick history+primetime+alts+friends+clan+economy on one screen); the shared-IP+friends+co-presence alt-hunting suite; cross-project ban federation (network-effect moat); progressive-ban policy-as-data (`data-first/second/third/four`); split count/data queries with per-response telemetry for multi-million-row tables.
