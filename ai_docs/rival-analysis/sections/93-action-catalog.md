## Complete Action / RPC / RCON Catalog

> Cross-cutting API reference for every server-side capability SQSTAT (`breaking.sqstat.ru`) exposes to a logged-in admin. This chapter is the **union** of the per-section chapters — it consolidates the ~90 distinct `action` ids scattered across 28 page fragments into one authoritative, buildable contract table. It is the panel's full **permission surface**: every row is a POST an authenticated session can issue.
>
> **Provenance & method.** Every contract below is tagged **[LIVE]** (observed in a read-only headless-browser capture — the app's own auto-load AJAX, recorded verbatim: request body + response schema) or **[SOURCE]** (read from the page fragment / `custom.js`; fires only on a user gesture, so the read-only capturer never triggered it). The capturer runs a network interceptor that **aborts every mutating Action** — across all 16 capture groups `_blocked.json == []`, i.e. **zero mutations were fired** and none needed aborting (the auto-load surface is pure reads). All request bodies and JSON schemas cite files under `caps/<group>/<page>.network.json`.

---

### 1. How the RPC layer works (from `custom.js`)

Every mutation and most reads go through one JS helper (`custom.js` lines 284–396):

```js
Action({ script:'<script>', action:'<action>', data:{…} })
  → POST /ajax/<script>.php
     body: &<k1>=<v1>&<k2>=<v2>… + "action=<action>"
```

| Mechanic | Detail (line ref) |
|---|---|
| **Endpoint = `script`** | Exactly **six** PHP endpoints exist: `public`, `player`, `squad`, `clan`, `settings`, and the DataTables-only `table`. `url:'/ajax/'+script+'.php'`, `type:'POST'` (line 327–329). The `action` id selects behaviour inside the endpoint; the endpoint is a coarse router. |
| **Response envelope** | JSON `{status, msg, auth, exec_time, …}`. Success gate: `text.status == 'ok'` → `success(text)`; `text.auth === true` → `location.reload()` (session expiry); else `error(text.msg)` → `addAlert(msg,'exclamation-triangle')` (lines 333–341). |
| **Three data encodings** | `FormData` → appends `action`, `contentType:false` (multipart uploads). Plain object → `$.map(data,(v,i)=>'&'+i+'='+v).join('')` then `+=action` — **NO URL-encoding**; callers must `encodeURIComponent` any value containing `&`/`=`/space (map layer, rotation body, RCON command, broadcast) (lines 313–324). String → `"action="+action+data`. |
| **Bulk/file exports bypass `Action()`** | `post_to_url('/ajax/<script>.php', {action:'download…', …})` builds a hidden `<form target=_blank>` and submits it — a full-page POST that streams a file (lines 1798–1817). Used by `downloadStat`, `downloadList`, `downloadOnline`. |
| **Abort/retry flags** | `retryAbort:true` aborts any in-flight request of the same `name` before firing (line 309); `pageAbort:true` cancels on navigation; `connectCheck:true` shows "Проверьте подключение к интернету!" when offline (line 344). |
| **`script:'table'`** | The DataTables server-side processing endpoint — a distinct read contract (§6), driven by `$.fn.buildTable` (lines 605–1105), not the mutation `Action()` path. |

Because the shared **player-detail modal** (Chat/Kills/Deaths/Kits/Games/Comments tabs) is embedded into *every* page fragment, its ~22 actions appear in `action_catalog.txt` under all 20+ pages. They are listed **once** here under **player-mod** (§7), not duplicated per page.

---

### 2. Endpoint → category map

| Endpoint (`/ajax/*.php`) | Primary role | Categories served |
|---|---|---|
| `public.php` | Unauthenticated / session bootstrap + public reads | auth, map calendar, video upload |
| `player.php` | Player database & annotations (non-RCON) | player-mod (DB side), user settings |
| `squad.php` | Live-server RCON + process control + config + seeding + statistics + issues + video token | RCON, player-mod (RCON side), server-config, stats, seeding, issues, video |
| `clan.php` | Clan/community roster & config | clan, VIP |
| `settings.php` | Per-server settings form (bulk save) | server-config |
| `table.php` | DataTables row feeds (per page) | reads only — see §6 |

> **The single most sensitive observation:** `squad.php` alone fronts raw RCON, process control (start/stop/restart/update), config-file writes, seeding, statistics, and issues. One permission bit gating `squad.php` would be catastrophically coarse — authorization **must** be per-`action`, server-side.

---

### 3. Category totals

| Category | # actions | Endpoint(s) | Destructive present? |
|---|---:|---|---|
| player-mod | 23 | `player`, `squad` | Yes (ban/kick/kill/unban/removePlayer/changeGroup/addBanName) |
| RCON / process | 22 | `squad` | Yes (start/stop/restart/update/blockIP/disband/rconRaw) |
| server-config | 15 | `squad`, `settings` | Yes (saveConfigFile/setRotation/installMod/deleteMod/setServerSettings/reloadConfig) |
| clan | 10 | `clan`, `squad`, `player` | Yes (delete/setting/addPlayer/changeExpire/createSquad) |
| VIP | 1 | `clan` | Yes (vipPlayer) |
| stats | 6 | `squad`, `public` | No (read-only analytics) |
| seeding | 5 | `squad` | Yes (seedingSetPriority/seedingSetServer) |
| video | 2 | `squad`, `public` | Yes (uploadVideo) |
| issues | 2 | `squad` | Yes (issues_create) |
| auth | 1 | `public` | Yes (session) |
| user-settings | 1 | `player` | No |
| **DataTables feeds** | 19 tables | `table` | No (reads) |

Grand total: **~90 distinct action/table ids** across 6 endpoints.

---

### 4. LIVE-captured RPC contracts (auto-loaded reads)

Seven non-`table` RPC contracts fired automatically during capture and are recorded verbatim. Everything else in §7–§16 is **[SOURCE]** (interaction-triggered).

#### 4.1 `auth` — session bootstrap **[SOURCE — custom.js 253–266]**

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/public.php` |
| Request | `tz` — string — Y — browser IANA timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`); `action=auth` |
| Response | `{status, url?:string}` — `url` present ⇒ `window.location.href = url` (Steam OAuth redirect) |
| Destructive | **Y** (starts a session) |

Clears the `PHPSESSID` cookie before firing (lines 240–246).

#### 4.2 `getServer` — live server-state poll **[LIVE]**

Cite: `caps/dashboard/__server_id_1.network.json`. The only auto-load read on the dashboard; polled every **5000 ms** for the active tab. Full field spec in [01. Dashboard §2.1](01-dashboard.md).

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/squad.php` |
| Captured body | `&server_id=1&last_chat_id=false&action=getServer` |
| `server_id` | int — Y — active server tab id |
| `last_chat_id` | int \| `false` — Y — chat delta cursor; `false` = full tail, else highest `chat[].id` seen |

Response root: `{status:"ok", exec_time:float, test:{getAdmin,queue,stat,post,chat:float}, server:{…}, you:str(17)\|false, servers:map<id,{players:int,admins:int,queue:int}>, ips:map<ip,str-count>, panelAdmins:[{name,steam_id,online}], global_online:int, is_sale:int(0/1), isSeeding:bool, discord:[]}`. The `server` object (live) carries `map`, `nextMap`, `players.active[]` (14 rows), `players.dis[]`, `squads[]` (7 rows), `teams[]`, `monitor[]` (60 hw samples), `chat[]`, `calculateOnline`, `stat.online` — see [01. Dashboard §2.1.1–2.1.5](01-dashboard.md) for the full nested spec.

**Live `players.active[]` row:** `id, eos_id:str(32), steam_id:str(17), name, team:"1"|"2", squad:bool|id, leader:bool, kit:str(raw token), ip, playtime:{date,last_seen:int(ms)}, requests:{admins,report:bool}, isAdmin:bool, color:bool|hex, warning:bool, mark:int, baby:bool, vac:bool, location:{iso,country,city}`.

#### 4.3 `clan.list` — roster + presence + Discord **[LIVE]**

Cite: `caps/clans/clan_id_16.network.json`. Full spec in [18. Clans §2.2](18-clans.md).

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/clan.php` |
| Captured body | `&clan_id=16&action=list` |
| `clan_id` | int — Y — clan PK |

Response: `{access:int(0/1), servers:map<server_id, [Presence]>, discord:[{name,channel}], players:[Member](45 rows), status, exec_time}`.
- **Member:** `steam_id:str(17), name, vip:"0"|"1", type:"0"|"1"|"2" (0=member/1=Глава leader/2=Зам deputy), date:str(unix-sec), discord:bool, vip_mode:int(0/1/2; 2=priority from another source, locked), access:bool (row-level remove right), online_raw:int(sec, sort key), online:str(HTML label), kit:str`.
- **Presence** (in `servers[id]`): `name, team:str(faction code), playtime:{date,last_seen:int(**ms**)}`. Unit gotcha: roster `date` is **seconds**, presence `playtime.*` are **milliseconds**.

#### 4.4 `clan.stats` — clan dashboard **[LIVE]**

Cite: `caps/clans/clan_id_16.network.json`. Full spec in [18. Clans §2.3](18-clans.md).

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/clan.php` |
| Captured body | `&clan_id=16&start=undefined&end=undefined&action=stats` |
| `clan_id` | int — Y | `start`/`end` | unix \| literal `"undefined"` — on first render they serialise to the string `"undefined"` (client bug); server defaults to last-60-days |

Response: `{access:int, chart:{labels:[str(DD.MM.YYYY)]×60, online:[str]×60}, stats:{online:str, boost:str, server:str, primetime:[{start,end:str(unix), cnt,sum:int, sort:str(HH:mm)}], kill:int, die:int, revive:int, top:[{steam_id(17),name,kill,die,revive:str}]×10, games:[Game]×10}, status, exec_time}`. **Game:** `{id,server_id,start,end:str, map, t1,t2:str(faction), t1_tickets,t2_tickets:str, win:enum("t1"|"t2"|"draw"), is_seed:"0"|"1", name, cnt:str}`.

#### 4.5 `statistics` — aggregate analytics dashboard **[LIVE]**

Cite: `caps/games-stats/statistics.network.json`. Cross-ref [11. Statistics](11-statistics.md).

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/squad.php` |
| Captured body | `&start=1780560007&end=1783152007&servers=1,6,7,9,10,11&action=statistics` |
| `start` / `end` | unix-sec — Y — window (captured = 30-day span) |
| `servers` | CSV of server ids — Y — e.g. `1,6,7,9,10,11` |

Response (captured top-level keys): `{test:{…8 timings}, days:[str(DD.MM.YYYY)]×31, online:map<server_id, map<date,str>>, max:map<server_id,map<date,str>>, admins:map<date,int>, maxAdmins:map<date,int>, chat:map<server_id,map<date,str>>, teamkill:map<server_id,map<date,str>>, queue:map<server_id,map<date,str>>, unique:[], kits:[], onlineHour:map<server_id,map<"HH:00",str>>, onlineDay:map<server_id,map<RU-weekday,str>>, games:map<server_id,map<date,str>>, kills/death/revival/wound/damage:map<server_id,map<date,str>>, modes:{AAS,Invasion,RAAS,Seed,Skirmish:int}, maps:map<mapName,int>, new:map<date,int>, bans:map<date,str>, hours:[str]×24, dayofweek:[str(RU-weekday)]×7, status, exec_time}`. A per-server × per-day matrix across ~15 metrics — the heaviest read in the product.

#### 4.6 `issues_get` — issue tracker list **[LIVE]**

Cite: `caps/issues-video/issues.network.json`. Cross-ref [15. Issues & Video](15-issues-video.md).

| Attribute | Value |
|---|---|
| HTTP | `POST /ajax/squad.php` |
| Captured body | `&state=open&page=1&action=issues_get` |
| `state` | enum `open`\|`closed` — Y | `page` | int — Y — pagination |

Response: `{test:{getAdmin:float}, issues:[{id:int, user:str, title:str, body:str, labels:[{id:int, name:str, color:str(hex), url:str}], create:int(unix), update:int(unix), state:str}]×20, status, exec_time}`. Redacted example: `{"id":56,"user":"Enj0y","title":"Human","body":"При выдаче бана…","labels":[{"id":1,"name":"…","color":"e11d21","url":""}],"create":1763650640,"update":1763650640,"state":"open"}` (backed by an external tracker, likely GitHub Issues — `labels`/`state`/`page`/hex colors).

#### 4.7 `topPlayers` — LIVE server-error finding **[LIVE]**

Cite: `caps/api-top/top.network.json`. The Top page's DataTables feed (`action=topPlayers`, §6) returned **`{status:"error", sql_error:[[…]], sql:"SELECT t1.steam_id, t2.type, t2.name…"}`** on capture — the endpoint **leaks the raw failing SQL query** into the JSON response (a real information-disclosure bug; a competitor must never echo SQL to the client). See [20. Top](20-top.md).

---

### 5. Reads fired only on user interaction (not auto-captured) **[SOURCE]**

These fire when a modal/panel opens; the read-only capturer performs no clicks, so shapes are read from `main.html` render code — **inferred**, not observed. Response shapes detailed in [16. Settings §16.4](16-settings.md) and [01. Dashboard §2.2](01-dashboard.md).

| Action | Script | Params | Returns (inferred) |
|---|---|---|---|
| `getRotation` | squad | `server_id:int` | `{rotation:{lists:{default,"1".."7"}, current:int, isWin:bool}, list:map<layer,{teams}>, canEdit:bool}` |
| `getServerMaps` | squad | `server_id:int` | `{maps[], units[]}` map/faction/unit picker catalog |
| `serverMonitor` | squad | `start,end:unix, server_id:int` | mem / network_send·receive / disk_read·write / tps / network_connections series |
| `serverOnline` | squad | `start,end:unix, server_id:int` | `{players[],admins[],queue[],days[],maps{}}` |
| `serverOnlineAdmins` | squad | `day, server_id:int` | `{events,resources}` per-admin presence timeline |
| `serverOnlineBooster` | squad | `day, server_id:int` | `{events,resources}` booster timeline |
| `network` | squad | `server_id:int` | `{network:{ips:map<ip,{conn[],country,city}>, sockets[]}}` |
| `mapCalendar` | **public** | `server_id:int, start,end:unix` | `{maps:[…events]}` played-layer calendar |
| `getConfigFiles` | squad | `server_id:int` | `{files:map<dir,{files:[{name,date:unix-ms,symlin:bool}]}>}` |
| `getConfigFile` | squad | `server_id:int, file, dir:str` | `{text:str, hasDefault:bool}` |
| `getDefaultConfig` | squad | `file:str` *(no server_id)* | `{text:str}` |
| `getMods` | squad | `server_id:int, only_status:bool` | `{mods:[{publishedfileid,…}], mod_status:{…}}` |
| `getServerSettings` | settings | `server_id:int` | `{server:{…data-input fields…}}` |
| `getComments` | player | `steam_id` | player's internal notes |
| `checkBans` / `findFriends` / `twink` / `twinkOnline` / `kits` / `get` / `getPlayerOnlineData` | player | see §7 | player-modal reads |
| `seedingGetCalendar` / `seedingGetPriority` | squad | see §13 | seeding reads |

---

### 6. DataTables feeds — `script:'table'` (all **[LIVE]**)

Every grid POSTs to `/ajax/table.php`. Common request shape (from `$.fn.buildTable`, `custom.js` 1092–1099):

```
POST /ajax/table.php
action=<table>&table=<table>&page=<n>&numrows=<size>
  &search=<URI-encoded JSON>&order_by=<false|db-alias>&order_sort=<false|asc|desc>
  [&pagination=true]        ← second call: returns only {totalPage,totalRows,count_time}
```

`search` JSON envelope: `{"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}` — each search input contributes to a bucket keyed by its `data-search` DB-alias (text/hidden→`text`, checkbox→`check`, multiselect→`multiselect`, managers→`managers`, range→`slider`, daterange→`text.<alias>.startdate`/`.enddate`). Data response: `{data:{totalPage:int, totalRows:int, currentPage:str, row:[…], custom:bool, query_time, count_time}, status:"ok", exec_time}`.

| Table id (`action=`/`table=`) | Page | `numrows` | Auto-applied search filter (captured) | Row schema (captured `data.row[]` fields) |
|---|---|---:|---|---|
| `allPlayers` | players | 100 | `check.with_other_names=false`, `check.full_match=false` | `steam_id:str(36 UUID)`, `eos_id:str(32)`, `name`, `date:unix`, `create_date:unix`, `mark:str`, `bonus:str`, `discord:null`, `expire:str`, `group_id:str` |
| `adminPlayers` | admins | 50 | `text.custom.period.startdate/enddate` (unix) | `steam_id:str(36)`, `group_id`, `expire`, `description`, `prefix`, `prefix_rgb`, `image`, `name`, `date:unix`, `color:hex`, `icon`, `discord`, `bans`, `online:{online,boost,queue,server}`, `group:str(HTML)`, `time`, `boost` |
| `vipPlayers` | vips | 50 | — | `steam_id:str(36)`, `group_id`, `expire`, `description`, `prefix:null`, `prefix_rgb:null`, `image:null`, `name`, `date:unix`, `color:hex`, `icon`, `vipdesc`, `online:{…}`, `group`, `time` |
| `banPlayers` | bans | 100 | `check.permanent=false` | `id`, `steam_id:str(36)`, `date:unix`, `reason`, `description`, `admin_id:str(17)`, `expire:str(HTML badge)`, `unban:"0"|"1"`, `name` |
| `ban_names` | bannames | 100 | — | `name`, `date:unix`, `button:int` |
| `collabans` | collabans | 100 | — | `name`, `steam_id:str(17)`, `projects:[{name,date:unix,reason,admin_name,expire,cnt}]` |
| `playersOnline` | playersOnline | 100 | `text.custom.period.startdate/enddate` (unix, today) | `steam_id:str(17)`, `name`, `online`, `boost`, `queue`, then per-kit seconds: `SL,CMD,Rifleman,Medic,LAT,MachineGunner,Marksman,Engineer,Pilot,Crewman` |
| `playerKills` | kills | 500 | `text.t1.date.startdate/enddate` (0=all) | `id`, `steam_id:str(17)`, `victim_steam_id:str(17)`, `game_id`, `date:unix`, `weapon`, `kit`, `player_name`, `server_id`, `map`, `name`, `server` |
| `playerDeath` | deaths | 500 | `text.t1.date.*` | `id`, `steam_id`, `game_id`, `date:unix`, `weapon`, `kit`, `player_name`, `server_id`, `map`, `server` |
| `playerRevive` | revives | 500 | `text.t1.date.*` | `id`, `steam_id`, `victim_steam_id`, `game_id`, `date:unix`, `kit`, `player_name`, `server_id`, `map`, `name`, `server` |
| `playerDamage` | damages | 500 | `text.t1.date.*` | `id`, `steam_id`, `victim_steam_id`, `game_id`, `date:unix`, `damage`, `weapon`, `player_name`, `server_id`, `map`, `name`, `server` |
| `playerTeamkill` | teamkills | 100 | `text.t1.date.*` | `id`, `server_id`, `steam_id`, `killed:str(HTML)`, `date:unix`, `killed_group:null`, `player:str(HTML)`, `player_group:null`, `kit`, `server` |
| `games` | games | 100 | `text.t1.start.startdate/enddate` | `id`, `server_id`, `start:unix`, `end:unix`, `map`, `t1`, `t1_tickets`, `t2`, `t2_tickets`, `win:enum(t1/t2/draw)`, `is_seed:"0"|"1"`, `server`, `time:int` |
| `logs` | logs | 100 | — | `id`, `server_id`, `steam_id:str(36)`, `date:unix`, `log:str(enum action code)`, `name:str(HTML)`, `serverName` |
| `playerComments` | comments | 100 | — | `id`, `steam_id:str(36)`, `admin_id:str(17)`, `date:unix`, `text`, `admin:str(HTML)`, `admin_color:hex`, `admin_group`, `player:str(HTML)`, `player_color:null`, `player_group:null` |
| `playerMark` | mark | 100 | — | `steam_id:str(36)`, `eos_id`, `name`, `date:unix`, `create_date:unix`, `mark:str(HTML)`, `bonus`, `discord`, `color:hex`, `player_group`, `ban:str(HTML)`, `player:str(HTML)` |
| `votes` | votes | 30 | — | `id`, `server_id`, `date:unix`, `steam_id`, `map_current`, `map_next`, `map_vote:"0"|"1"`, `mode:enum`, `players_sum`, `players_need`, `duration`, `cancel:str(HTML)`, `votes:str(HTML)`, `name`, `short`, `map_current_img`, `map_next_img` |
| `reports` | reports | 30 | — | *(empty in capture — 0 rows)*; same envelope |
| `topPlayers` | top | 30 | `multiselect.sort=online` | **`{status:"error", sql_error, sql}`** in capture — see §4.7 |

**Default sort:** every captured request sends `order_by=false&order_sort=false` (server default sort); clicking a `<th>` sets `order_by=<data-sort alias>&order_sort=asc|desc` and resets `page=1`. **Pagination** is a second POST with `&pagination=true` returning `{totalPage:int, totalRows:str, count_time, status, exec_time}` only. **Identity note:** DataTables player feeds carry `steam_id` as a **36-char (UUID-form) id**, while live game / clan / combat feeds use the **17-digit SteamID64** — a dual-identity scheme worth matching carefully.

---

### 7. player-mod — player moderation & annotation (23 actions) **[SOURCE]**

Invoked from the shared player-detail modal + its ban/kick/message sub-modals, embedded in *every* page. Split: **DB/annotation → `player.php`**; **live-game → `squad.php`** (RCON-backed). Live-game data keys are captured-verbatim in [01. Dashboard §4.2](01-dashboard.md). Cross-ref [03. Players](03-players.md), [08. Notes](08-notes-suspects.md), [09. Bans](09-bans.md).

| Action id | Endpoint | Data keys (type) | Effect | Destructive |
|---|---|---|---|:--:|
| `ban` | squad | `server_id:int`, `steam_id:str`, `reason_id:int`, `description:str`, `days:int` | Ban (`days=0` → permanent); RCON-kicks if online | **Y** |
| `kick` | squad | `steam_id:str`, `reason_id:int`, `description:str`, `noReason:bool` | RCON-kick; `noReason:true` skips reason string | **Y** |
| `kill` | squad | `server_id:int`, `steam_id:str` | RCON-kill current pawn (soft punish) | **Y** |
| `unban` | squad | `steam_id:str`, `unban:bool` | Lift ban; `unban:true` wipes the record | **Y** |
| `changeTeam` | squad | `server_id:int`, `steam_id:str` | Force team-swap via RCON | **Y** |
| `removePlayer` | squad | `server_id:int`, `steam_id:str` | Remove from squad without kicking | **Y** |
| `message` | player | `steam_id:str`, `time:int`, `msg:str`, `log:bool` | In-game warn/message; `time`=repeat cadence; optional card log | No |
| `changeGroup` | player | `steam_id:str`, `date:unix`, `group_id:int(0–5)`, `description:str`, `prefix:str`, `prefix_rgb:str`, `image:str` | Assign admin/VIP group + cosmetic prefix/color/icon, with expiry | **Y** |
| `mark` | player | `steam_id:str`, `mark:int` | Flag/annotate (suspect marker) | No |
| `addComment` | player | `steam_id:str`, `text:str` | Attach internal note | No |
| `getComments` | player | `steam_id:str` | Read internal notes | No |
| `checkBans` | player | `steam_id:str` | Cross-check vs ban DBs (self + linked) | No |
| `findFriends` | player | `steam_id:str`, `compare_steam_id:str` | Compare Steam friend graphs (alt detection) | No |
| `twink` | player | `steam_id:str` | List shared-IP / linked accounts | No |
| `twinkOnline` | player | `steam_id:str`, `compare_steam_id:str`, `start`, `end:unix` | Overlay two accounts' sessions to prove co-play | No |
| `addBanName` | player | `name:str` | Add nick to banned-names blocklist | **Y** |
| `removeBanName` | player | `name:str` | Remove nick from blocklist | No |
| `kits` | player | `steam_id:str` | Read kit history | No |
| `kitSave` | player | `steam_id:str`, `kits` | Persist edited kit assignment | No |
| `get` | player | `steam_id:str` | Load full profile into modal | No |
| `add` | player | `steam_id:str` | Register/import a player record | No |
| `getPlayerOnlineData` | player | `steam_id:str`, `start`, `end:unix` | Online-time series for profile chart | No |
| `downloadStat` | player | `steam_id:str` (via `post_to_url`) | Export player stat sheet (file) | No |

`changeGroup.group_id` enum (from the shared select): `0` Нет группы (none), `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator), `5` Стажёр (trainee).

---

### 8. RCON — live server & process control (22 actions) **[SOURCE]**

All `squad.php`, from the dashboard `main.html`. Data keys captured-verbatim in [01. Dashboard §4](01-dashboard.md) / [16. Settings §16.4.5](16-settings.md).

| Action id | Data keys (type) | Effect | Destructive |
|---|---|---|:--:|
| `rconRaw` | `server_id:int`, `command:str(URI-enc)` | **Arbitrary raw RCON command** (free-text console; JSON pretty-printed in CodeMirror) | **Y** |
| `start` | `server_id:int` | Start the game server process | **Y** |
| `stop` | `server_id:int` | Stop the server | **Y** |
| `restart` | `server_id:int` | Restart the server | **Y** |
| `update` | `server_id:int`, `afterMapChange:bool` | Update; `afterMapChange` defers to next map break | **Y** |
| `rconRestart` | `server_id:int` | Restart the RCON bridge | **Y** |
| `parserRestart` | `server_id:int` | Restart the log-journal parser | **Y** |
| `cacherRestart` | `server_id:int` | Restart the Steam-query/A2S cacher | **Y** |
| `botUpdate` | *(none — global)* | Update the sqstat bot agent | **Y** |
| `broadcast` | `server_id:int`, `msg:str` | Server-wide broadcast (min 2 chars) | No |
| `squadMessage` | `server_id:int`, `team:str`, `squad:str`, `time:int`, `msg:str` | Repeating message to a specific squad | No |
| `changeMap` | `server_id:int`, `next:bool\|'skip'`, `map:str(URI-enc)`, `vote:bool`, `skip?:bool` | Set current / next map, or skip round | **Y** |
| `clearNext` | `server_id:int` | Clear the queued next map | No |
| `disband` | `server_id:int`, `team:str`, `squad:str` | Disband a squad | **Y** |
| `rename` | `server_id:int`, `team:str`, `squad:str` | Clear a squad's name | No |
| `demote` | `server_id:int`, `steam_id:str(leader)` | Strip Commander | **Y** |
| `transfer` | `server_id:int`, `team:str`, `squad:str` | Move a squad to the other team | **Y** |
| `blockIP` | `ip:str` | Firewall-block an IP (network modal; `.hide`-gated) | **Y** |
| `network` | `server_id:int` | Read live IP/connection map | No |
| `getServer` | `server_id:int`, `last_chat_id` | Live poll (see §4.2) | No |
| `getServerMaps` | `server_id:int` | Map/faction/unit picker catalog | No |
| `setServerIP` | `server_id:int`, `ip:str` (raw query string) | Rebind server IP (effective after restart) | **Y** |

RCON console ships a built-in Squad admin command dictionary + typeahead (`AdminKick(ById)`, `AdminBan(ById)`, `AdminBroadcast`, `AdminChangeMap`, `AdminSetNextMap`, `AdminEndMatch`, `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`, `AdminForceTeamChange(ById)`, `AdminDisbandSquad`, `AdminDemoteCommander(ById)`, `ListPlayers`, `ListSquads`, `ShowServerInfo`, …) — see [01. Dashboard §4.7](01-dashboard.md).

---

### 9. server-config — config, rotation, mods, settings (15 actions) **[SOURCE]**

`squad.php` (config editor / mod manager / rotation on `main.html`) + `settings.php` (bulk settings save). Response shapes captured-verbatim in [16. Settings §16.4](16-settings.md).

| Action id | Endpoint | Data keys (type) | Response | Destructive |
|---|---|---|---|:--:|
| `getConfigFiles` | squad | `server_id:int` | `{files:map<dir,{files:[{name,date:unix-ms,symlin:bool}]}>}` | No |
| `getConfigFile` | squad | `server_id:int`, `file:str`, `dir:str` | `{text:str, hasDefault:bool}` | No |
| `saveConfigFile` | squad | `server_id:int`, `text:str(URI-enc)`, `file:str`, `dir:str` | `{}` | **Y** |
| `getDefaultConfig` | squad | `file:str` | `{text:str}` | No |
| `reloadConfig` | squad | `server_id:int` | `{}` — hot-reload | **Y** |
| `getRotation` | squad | `server_id:int` | `{rotation:{lists,current,isWin}, list, canEdit:bool}` | No |
| `setRotation` | squad | `server_id:int`, `rotation:str(URI-enc)`, `day:int` | `{}` → re-runs `getRotation(day)` | **Y** |
| `getMods` | squad | `server_id:int`, `only_status:bool` | `{mods:[…], mod_status:{…}}` | No |
| `installMod` | squad | `server_id:int`, `mod_id:str`, `fix:true` | `{}` | **Y** |
| `deleteMod` | squad | `server_id:int`, `mod_id:str` | `{}` | **Y** |
| `getServerSettings` | settings | `server_id:int` | `{server:{…fields…}}` (form set read-only after load) | No |
| `setServerSettings` | settings | all `data-input` fields | `{new:bool}` — `new` truthy → full `pageLoad('settings')` | **Y** |
| bulk save | settings | `type:enum(servers\|groups\|rules\|squad_messages\|discordbot\|discord)`, `settings:str(JSON)` | `{}` — overwrites that tab's config blob | **Y** |
| `serverMonitor` | squad | `start`, `end:unix`, `server_id:int` | health time series | No |
| `mapCalendar` | public | `server_id:int`, `start`, `end:unix` | `{maps:[…]}` | No |

> **Latent bug ([16. Settings §16.4.1](16-settings.md)):** `saveConfigFile`/`reloadConfig` send the ambient global `server_id`, not the editor's own — cross-server write hazard if the editor is opened for a non-active server. The `rules` bulk-save serializer is a **stub** (`collect()` returns `{}`, Add button `disabled`) — rules editing is inert.

---

### 10. clan — community/clan roster & config (10 actions)

`clan.php` (roster/settings) + `squad.php` (`createSquad`) + `player.php` export. `list`/`stats` are **[LIVE]** (§4.3–4.4); the rest **[SOURCE]** (`caps/clans/_blocked.json == []`, mutations not fired). Full detail in [18. Clans §5](18-clans.md).

| Action id | Endpoint | Data keys (type) | Effect | Destructive |
|---|---|---|---|:--:|
| `list` | clan | `clan_id:int` | Roster + presence + Discord (**[LIVE]**) | No |
| `stats` | clan | `clan_id:int`, `start`, `end:unix\|undefined` | Dashboard chart + combat stats (**[LIVE]**) | No |
| `findPlayer` | clan | `clan_id:int`, `find:str(≥3)` | Search addable players → `[{steam_id,name,clan_id}]` | No |
| `addPlayer` | clan | `clan_id:int`, `steam_id:str`, `type:0\|1\|2` | Add member with role (>0 gated by `clan.canType`) | **Y** |
| `removePlayer` | clan | `clan_id:int`, `steam_id:str` | Remove from roster | **Y** |
| `vipPlayer` | clan | `clan_id:int`, `steam_id:str`, `vip:bool` | Grant/revoke queue priority | **Y** |
| `changeExpire` | clan | `clan_id:int`, `date:unix` | Change priority-subscription expiry | **Y** |
| `setting` | clan | `clan_id:int`, `key:enum(public\|protected)`, `value:bool` | Toggle clan setting | **Y** |
| `delete` | clan | `clan_id:int` | **Delete the clan** (3 s cooldown; success → `location.href='/'`) | **Y (irreversible)** |
| `createSquad` | squad | `id:int`, `name`, `expire:unix`, `max:int`, `discord_id`, `tags:str(URI-enc CSV)` | Create (empty `id`) / edit / rename a clan | **Y** |
| `downloadList` | clan (`post_to_url`) | `clan_id` | Export roster file | No |
| `downloadOnline` | clan (`post_to_url`) | `clan_id`, `start`, `end` | Export clan online-history file | No |

---

### 11. VIP (1 action) **[SOURCE]**

`vips.html` hosts only the shared player modal + search UI; the real grant toggle lives in the clan roster. Cross-ref [06. VIPs](06-vips.md), [18. Clans](18-clans.md).

| Action id | Endpoint | Data keys (type) | Effect | Destructive |
|---|---|---|---|:--:|
| `vipPlayer` | clan | `clan_id:int`, `steam_id:str`, `vip:bool` | Toggle VIP/priority slot for a clan member | **Y** |

---

### 12. stats — read-only analytics (6 actions)

`statistics` is **[LIVE]** (§4.5); `mapCalendar` **[SOURCE]**; the four `server*` reads **[SOURCE]** (interaction-triggered). Cross-ref [11. Statistics](11-statistics.md), [12. Games](12-games.md), [20. Top](20-top.md).

| Action id | Endpoint | Data keys (type) | Effect |
|---|---|---|---|
| `statistics` | squad | `start`, `end:unix`, `servers:CSV` | Aggregate statistics dashboard (**[LIVE]**, §4.5) |
| `mapCalendar` | public | `server_id:int`, `start`, `end:unix` | Map-history calendar |
| `serverMonitor` | squad | `start`, `end:unix`, `server_id:int` | Hardware health time series |
| `serverOnline` | squad | `start`, `end:unix`, `server_id:int` | Online-count history |
| `serverOnlineAdmins` | squad | `day`, `server_id:int` | Admin-presence timeline |
| `serverOnlineBooster` | squad | `day`, `server_id:int` | Booster-presence timeline |

---

### 13. seeding — seeding scheduler & priority (5 actions) **[SOURCE]**

All `squad.php`, from `player_profile.html` seed-helper (data keys read verbatim from `frags/player_profile.html`). Cross-ref [04. Player Profile](04-player-profile.md).

| Action id | Data keys (type) | Effect | Destructive |
|---|---|---|:--:|
| `seeding` | `start:bool`, `isMobile:bool`, `tab_id:str` | Start/join the live seeding session view | No |
| `seedingGetCalendar` | `start:unix`, `end:unix` | Read seeding calendar → `{seed:[…events], canServerAction:bool}` | No |
| `seedingGetPriority` | `start` | Read the seeding priority list for a day | No |
| `seedingSetPriority` | `start` (day), `data`, `min_players:int`, `use_unattached:bool` | **Write** seeding priority order/rules | **Y** |
| `seedingSetServer` | `server_id` | Set the admin's seeding target server | **Y** |

---

### 14. video (2 actions) **[SOURCE]**

`video.html` (page GET is **[LIVE]**; the two actions **[SOURCE]** — no auto-fire). Data keys read verbatim from `frags/video.html`. Cross-ref [15. Issues & Video](15-issues-video.md).

| Action id | Endpoint | Data keys (type) | Effect | Destructive |
|---|---|---|---|:--:|
| `uploadVideo_token` | squad | *(none)* | Mint an upload token (session/CSRF gate) | No |
| `uploadVideo` | public | `FormData`: `name:str`, `description:str`, `file:File`, `token:str` (from `?token=`), 300 s timeout | **Upload a video** (evidence/clip) | **Y** |

---

### 15. issues (2 actions)

`squad.php`, `issues.html`. `issues_get` is **[LIVE]** (§4.6); `issues_create` **[SOURCE]**. Backed by an external tracker (GitHub-style labels/state/paging). Cross-ref [15. Issues & Video](15-issues-video.md).

| Action id | Data keys (type) | Effect | Destructive |
|---|---|---|:--:|
| `issues_get` | `state:enum(open\|closed)`, `page:int` | List issues (paginated) — see §4.6 | No |
| `issues_create` | `body:str`, `labels` | Create an issue with labels | **Y** |

---

### 16. auth & user-settings (2 actions) **[SOURCE]**

Cross-ref [00. Overview](00-overview.md), [05. Admins & Permissions](05-admins-permissions.md), [16. Settings §16.3](16-settings.md).

| Action id | Endpoint | Category | Data keys (type) | Effect | Destructive |
|---|---|---|---|---|:--:|
| `auth` | public | auth | `tz:str` | Session bootstrap; may return `url` to redirect (see §4.1) | **Y** |
| `saveUserSettings` | player | user-settings | `lang:enum(ru\|en)`, `theme:enum(0\|dark)`, `show_country:enum(hide\|show)` | Persist the admin's own UI settings | No |

---

### 17. Destructive-surface matrix (blast radius)

The competitively important slice: which actions change third-party state and how far the blast reaches. A permission model must gate these individually.

| Blast radius | Representative actions | Endpoint | Risk |
|---|---|---|---|
| **Whole game server** | `start`, `stop`, `restart`, `update`, `changeMap`, `setRotation`, `saveConfigFile`, `reloadConfig`, `installMod`, `deleteMod`, `setServerSettings`, `setServerIP` | squad / settings | Server downtime / misconfig |
| **Arbitrary console** | `rconRaw` | squad | Superset of every other server action |
| **Individual player (live)** | `ban`, `kick`, `kill`, `unban`, `changeTeam`, `removePlayer`, `blockIP`, `demote`, `disband`, `transfer` | squad | In-game punishment |
| **Player record (DB)** | `changeGroup`, `addBanName`, `kitSave`, `mark`, `addComment` | player | Persistent DB annotation / privileges |
| **Community** | `createSquad`, `delete`, `setting`, `addPlayer`, `vipPlayer`, `changeExpire` | clan / squad | Clan roster / VIP economy |
| **Scheduling** | `seedingSetPriority`, `seedingSetServer` | squad | Seeding fairness |
| **Content/tracker** | `uploadVideo`, `issues_create` | public / squad | External artifacts |

---

### 18. Capture provenance (what's LIVE vs SOURCE)

| Contract | Status | Cite |
|---|---|---|
| `getServer` | **LIVE** | `caps/dashboard/__server_id_1.network.json` |
| `clan.list`, `clan.stats` | **LIVE** | `caps/clans/clan_id_16.network.json` |
| `statistics` | **LIVE** | `caps/games-stats/statistics.network.json` |
| `issues_get` | **LIVE** | `caps/issues-video/issues.network.json` |
| 18 DataTables feeds + `page.php` GETs | **LIVE** | `caps/*/*.network.json` (§6) |
| `topPlayers` (SQL-error leak) | **LIVE** | `caps/api-top/top.network.json` |
| player-mod, RCON, config, seeding, video, clan mutations, `auth`, `saveUserSettings` | **SOURCE** | `custom.js` + page fragments; `_blocked.json == []` (never fired) |

The read-only capturer performed **zero mutations** (all 16 `_blocked.json` are `[]`). The player-profile detail capture (`caps/players/_player_*.network.json`) is `[]` — the profile page auto-loads nothing, so all player-modal actions remain SOURCE-derived.

---

### 19. Competitive takeaways

1. **Single raw-RCON escape hatch.** `rconRaw` (§8) is a free-text console; any admin who reaches it effectively holds every other server-side capability. Treat it as its own top-tier permission and audit-log every command.
2. **Endpoint ≠ permission.** Six PHP files front ~90 actions; `squad.php` alone fronts RCON, process control, config writes, seeding, statistics, and issues. Authorization must be per-`action`, never per-endpoint.
3. **Server-render-everything settings.** The Settings console fires **one** request (the fragment) — all config (incl. live Discord webhook tokens) is pre-hydrated into the DOM. This leaks six real webhook secrets into page source ([16. Settings §16.3](16-settings.md)); keep secrets server-side.
4. **Two information-disclosure bugs in the live capture:** `topPlayers` echoes the raw failing **SQL** into the JSON response (§4.7); the settings page leaks webhook tokens. Both are "beat, don't copy."
5. **Uniform envelope, no URL-encoding.** The `{status,msg,auth}` contract + `Action()` helper is trivial to reimplement — but the helper does **not** URL-encode object-form `data`, so any value with a raw `&`/`=` corrupts the body. The moat is the **breadth** of the action set, not the transport.
6. **DataTables uniformity.** 18 grids share one `table.php` contract (envelope + `search` bucket JSON + two-phase pagination); page sizes 30/50/100/500. A dual-identity scheme (36-char UUID in DB feeds vs 17-digit SteamID64 in live feeds) is the subtle detail to get right.
7. **Shared modal = 23 actions everywhere.** The player-detail modal ships on every page; building that one component well yields maximal leverage.
8. **Export via full-page POST.** `download*` actions deliberately sidestep the AJAX helper (`post_to_url`) to stream files — an easy-to-miss but load-bearing pattern.
