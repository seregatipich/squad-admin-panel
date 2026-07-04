## 07. Players Online (live)

Reference documentation for the SQSTAT (breaking.sqstat.ru) **Players Online** page, reconstructed from the local page fragment `frags/playersOnline.html`, the shared client library `custom.js`, and `action_catalog.txt`. Original Russian UI labels are preserved with an English gloss in parentheses.

---

### 1. Purpose and nav location

| Property | Value |
|---|---|
| Nav id / loader | `playersOnline` → `pageLoad('playersOnline')` → `GET /ajax/page.php?page=playersOnline` |
| Injected into | `#content` |
| Purpose | A cross-server leaderboard of players who were **online during a selected time window**, ranked by playtime and by time spent in each in-game role (kit). It doubles as the launchpad for the shared **player-detail modal**, from which admins perform live RCON actions (kick / ban / kill / move team / message) against players **currently** on a server. |
| Primary data source | DataTables-style server-side table `playersOnline` via `Action({script:'table', action:'playersOnline', ...})` → `POST /ajax/table.php` |

> **Important scope note.** Despite the section brief listing `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster` and `downloadOnline`, **none of those actions exist on this page.** `action_catalog.txt` places them exclusively on `main.html` (the per-server dashboard). This page's "online" concept is a **historical playtime aggregation over a date range**, not a real-time server roster snapshot. The truly live element here is the RCON action set that becomes available when a listed player happens to be online right now (`player.info.online` is populated). See §8 (Gaps).

---

### 2. Entities & fields

#### 2.1 `PlayerOnlineRow` — the page's own table row

Inferred from the `#playersOnline` `<thead>` and the `buildTable({collum:[...]})` config. Each row is a player aggregated over the selected period. Columns after `boost` are **per-kit playtime** buckets.

| Field (buildTable key) | Column label / tooltip | Meaning | Type |
|---|---|---|---|
| `name` | Игрок (Player) | Player display name; rendered as a clickable `<hashtag>` carrying the SteamID | string |
| `online` | tooltip: Наигранное время за период (Playtime in period) | Total playtime in the window | duration (minutes) |
| `boost` | tooltip: Буст за период (Boost in period) | Accumulated "boost" (server-perk / bonus metric) in the window | number |
| `SL` | Сквадной (Squad Leader) | Time played as Squad Leader | duration |
| `CMD` | CMD (Commander) | Time as Commander | duration |
| `Rifleman` | Стрелок (Rifleman) | Time as Rifleman | duration |
| `Medic` | Медик (Medic) | Time as Medic | duration |
| `LAT` | Гранатомётчик (Grenadier / LAT) | Time as Light Anti-Tank | duration |
| `MachineGunner` | Пулемётчик (Machine Gunner) | Time as MG | duration |
| `Marksman` | Снайпер (Marksman) | Time as Marksman | duration |
| `Engineer` | Инженер (Engineer) | Time as Engineer | duration |
| `Pilot` | Пилот (Pilot) | Time as Pilot | duration |
| `Crewman` | Водитель (Crewman) | Time as vehicle Crewman | duration |

Kit columns are rendered as SVG icons from `/assets/img/ico/kits/<Kit>.svg`.

#### 2.2 `PlayerInfo` — the shared player-detail entity (`player.info`)

Loaded by `action:'get'` (script `player`) when a row is clicked. This entity is shared across the whole panel; only the fields that this page reads/renders are listed.

| Field | Meaning | Type |
|---|---|---|
| `steam_id` | Steam64 ID — the identity key for every downstream action | string |
| `name` | Current nickname | string |
| `eos_id` | Epic Online Services ID | string |
| `discord` | Discord user id (links to `discord.com/users/<id>`) | string |
| `vac` | VAC status | mixed |
| `steam_info.ban` | `{vac, ban, days}` — VAC / game-ban flags from Steam | object |
| `steam_info.squad.time` | Steam hours played in Squad | number |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` — geo-IP history (first = current) | array |
| `primetime[]` | `{start, end}` unix ranges — the player's habitual online hours | array |
| `playtime.server` | "home" server label | string |
| `group_id`, `expire`, `prefix`, `prefix_rgb` | admin group membership (see §2.4) | mixed |
| `ban` | `{expire, reason, admin, date, description}` — active punishment | object |
| **`online`** | **Presence object — non-null only if the player is on a server right now** | object / null |
| `online.server` | `{id, name}` — the server the player is currently on | object |
| `online.team` | `{short}` — current team (drives the "change team" button) | object |
| `online.squad` | `{id}` — current squad number (drives "kick from squad") | object |

The `online` object is the pivot for every live/RCON capability on this page. When it is null the destructive live buttons stay hidden (§6).

#### 2.3 `PlayerOnlineData` — live activity chart (`getPlayerOnlineData`)

Returned by `action:'getPlayerOnlineData'` (script `player`). Keyed by timestamp; each entry:

| Field | Meaning |
|---|---|
| `minute` | Minutes online in that bucket |
| `boost` | Boost value in that bucket |
| `queue` | Queue position / queue time in that bucket |

Rendered as a 3-dataset line chart in the modal.

#### 2.4 Reference/enum entities

- **Ban reason** (`player_ban-reason` select): a large rule catalog. Each `<option>` carries `data-first/second/third/four` = recommended ban lengths (in days) for the 1st–4th offence. Categories seen: `0.x` system/other, `1.x` conduct/nick/cheating, `2.x` command/SL, `3.x` vehicle rules, `4.x` CMD discipline, `5.x` misc. Value `-1` = permanent.
- **Ban duration radios** (`player_ban-reason_type`): `data-action` = `kick`|`ban`, `data-day` = `0,1,2,3,4,5,6,7,10,14,30` (0 = permanent). One is auto-selected as "Рекомендуемое" (Recommended) based on the reason's offence data.
- **Admin groups** (`player_group-groups`): `0` -Нет группы- (None), `1` Администратор (Admin), `2` Модератор (Moderator), `3` VIP, `4` Камера (Camera/spectator), `5` Стажёр (Trainee).
- **Suspicion marks** (`player.mark.set`): `1` WallHack, `2` AimBot, `3` SpeedHack, `4` object-spawn, `5` reload exploit, `6` griefing, `7` config, `8` toxic player, `0` = clear mark.
- **Message durations** (`player_message-time`): `1` (once), `30`, `40`, `60`(default), `90`, `120` seconds.

---

### 3. The page's own table & controls

**Table:** `#playersOnline` (`buildTable` config at fragment lines 72–107). `numrows: 100`, sortable on every metric column (`order` lists all of them), default sort by playtime. Data is server-side paginated via `/ajax/table.php` (`action=playersOnline`, `&pagination=true` for the count query).

**Filter/search bar** (`searchInput: ["playersOnline-user","playersOnline-period","playersOnline-server"]`):

| Control | id | `data-search` key sent | Type | Notes |
|---|---|---|---|---|
| Игрок (Player) | `playersOnline-user` | `player` | text | Free-text name/ID filter; Enter triggers rebuild |
| Period picker | `playersOnline-period` | `custom.period` | daterange | Presets: today (default), yesterday, current/last week, current/last month, last 30 days, month/day/week/year, custom range |
| Сервер (Server) | `playersOnline-server` | `server_id` | multiselect | Multi-select of servers (values 1,6,7,9,10,11 in this capture); placeholder "- Сервер -" |
| Поиск (Search) | `playersOnline-btn` | — | button | Rebuilds table with current filters |

Clicking a player `<hashtag>` in the body calls `player.open(<steam_id>)`, opening the shared modal.

---

### 4. Actions / admin capabilities

Every state-changing action here originates in the **shared player-detail modal**, not in the page's own table. Two script endpoints are used:

- **`/ajax/squad.php`** — the **live RCON layer**. These require `player.info.online.server.id` and act on the running game server. All destructive.
- **`/ajax/player.php`** — the **database/record layer** (marks, comments, groups, name-bans, twink analysis, exports).

| # | UI label | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|---|
| 1 | (open card) | `get` | player → `/ajax/player.php` | `steam_id` | Load full player card | N |
| 2 | График (online chart) | `getPlayerOnlineData` | player | `steam_id, start, end` | Fetch minute/boost/queue series | N |
| 3 | Наказать → Кикнуть (Kick, no ban) | `kick` | **squad** | `server_id, steam_id, reason_id` | RCON kick from server | **Y** |
| 4 | Кикнуть без причины (Kick, no reason) | `kick` | **squad** | `server_id, steam_id, reason_id` (empty) | RCON kick without a reason record | **Y** |
| 5 | Наказать → Забанить (Ban N days / permanent) | `ban` | **squad** | `server_id, steam_id, reason_id, description, days` | Ban player (days from selected radio; `-1`=perma) + kick | **Y** |
| 6 | Разбанить (Unban) | `unban` | **squad** | `steam_id, unban(bool)` | Lift active ban (`unban` checkbox = also clear error/appeal) | **Y** |
| 7 | Кик из сквада (Kick from squad) | `removePlayer` | **squad** | `server_id, steam_id` | RCON remove player from their squad (keeps them on server) | **Y** |
| 8 | Команда (Change team) | `changeTeam` | **squad** | `server_id, steam_id` | RCON force player to the other team | **Y** |
| 9 | Убить (Kill) | `kill` | **squad** | `server_id, steam_id` | RCON kill the player's character | **Y** |
| 10 | Сообщение (Warn / message) | `message` | player | `steam_id, time, msg, log(bool)` | Send in-game warning; `time`=repeat seconds; `log` writes it to the player card | **Y** (in-game effect) |
| 11 | Метка (Set suspicion mark) | `mark` | player | `steam_id, <1–8 or 0>` | Flag/clear cheat-suspicion label; highlights row `.player_mark` | **Y** |
| 12 | Группа (Change group / VIP) | `changeGroup` | player | `steam_id, date(expire), group, description, prefix, prefix_rgb, image` | Assign admin/VIP group with expiry, chat prefix + RGB colour + image | **Y** |
| 13 | Проверить баны (Check bans) | `checkBans` | player | `steam_id` | Query external/community ban lists | N |
| 14 | Поиск твинков (Find alts) | `twink` | player | `steam_id` | Return alt accounts sharing IPs (`name, steam_id, ips[], min_date`) | N |
| 15 | (alt) Онлайн compare | `twinkOnline` | player | `steam_id, compare_steam_id` | Compare online calendars of player vs. suspected alt | N |
| 16 | (alt) Проверить друзья (Check friends) | `findFriends` | player | `steam_id, compare_steam_id` | Cross-check Steam friend links between two accounts | N |
| 17 | Забанить ник (Ban nickname) | `addBanName` | player | `steam_id` (+ nickname context) | Add player's nick to the banned-names list | **Y** |
| 18 | Разбанить ник (Unban nickname) | `removeBanName` | player | `steam_id` | Remove nick from banned-names list | **Y** |
| 19 | Киты (Kits editor open) | `kits` | player | `steam_id` | Load per-player kit permissions | N |
| 20 | Сохранить (Save kits) | `kitSave` | player | `steam_id, kits[]` | Persist edited kit permissions | **Y** |
| 21 | Комментарии (Get comments) | `getComments` | player | `steam_id` | Load internal admin comments | N |
| 22 | (add comment) | `addComment` | player | `steam_id, <text>` | Append an admin comment to the card | **Y** |
| 23 | Скачать статистику (Download stats) | `downloadStat` | player (`post_to_url` form) | `steam_id` | Trigger a file download of the player's stats | N |

Client-only helpers (no server call): **Копировать телепорт** (`copyTeleport` → clipboard `AdminTeleportToPlayer <steam_id>`), **Заявка в OWI** (`copyReport` → clipboard a formatted OWI/BattleMetrics report template), **ссылка** (`copylink` → clipboard `?steam_id=`).

The full `player.php` action surface reachable from this page's modal (per `action_catalog.txt`): `addBanName, addComment, ban, changeGroup, changeTeam, checkBans, findFriends, get, getComments, getPlayerOnlineData, kick, kill, kits, kitSave, mark, message, removeBanName, removePlayer, twink, twinkOnline, unban, downloadStat` — with `ban/kick/kill/changeTeam/removePlayer/unban` routed through `script:'squad'`.

---

### 5. Forms & modals

**Ban / punish form** (`#player_ban`): reason multiselect (rule catalog) + duration radio group (kick or ban 1–30d / permanent, one auto-recommended) + optional comment textarea `player_ban-description` (max 512 chars). Submit `player.actionPlayer()` branches to `kick` vs `ban` on `squad`. If the player is online, `server_id` is attached from `player.info.online.server.id`.

**Group form** (`#player_group`): group select (0–5); expiry daterange (`player_group-expire`, disabled when group=0); comment (max 128); prefix text (max 64); prefix RGB (color picker `player_group-prefix_rgb-color` synced to a `r,g,b` text field, max 16); image URL (max 256). Submit `player.group.set()` → `changeGroup`. A quick-action variant "VIP +1 месяц" is present but `.hide`-gated.

**Message / warn form** (`#player_message`): a list of ~18 pre-written canned warnings (voice-flood, solo-vehicle, squad rules, TK, VIP grant, etc.) selectable via `player.message.set()`; free-text `player_message-msg` (max 512); repeat-duration select `player_message-time`; **"Добавить запись в карточку игрока"** checkbox `player_message-log` to also log the warning to the card. Submit → `message`.

**Kits modal** (`#player_kits-modal`): per-role permission list, saved via `kitSave` with a collected `kits[]` payload.

**Twink panel**: renders alt list with per-alt **Проверить друзья** and **Онлайн** buttons that fire `findFriends` / `twinkOnline` against `compare_steam_id`; shows IP-overlap counts and time deltas.

---

### 6. Permission / visibility logic

The modal ships every control but hides most by default (`style="display:none"` or `class="hide"`) and reveals them conditionally in `player.open()`:

| Element | Revealed when |
|---|---|
| **Сообщение** (message) | `player.info.online` truthy (player is on a server now) |
| **Команда** (change team) | `player.info.online.team` present |
| **Кик из сквада** (removePlayer) | `player.info.online.squad` present |
| **Убить** (kill) / **Кикнуть без причины** | `player.info.online` truthy |
| **Разбанить** (unban) | player currently has an active ban |
| **Забанить ник / Разбанить ник** | toggled by current name-ban state |
| **Киты** (kits) | shown once card data confirms kit-permission availability |
| VIP quick-grant button | `.hide` until group flow selects VIP |

Net effect: the entire destructive RCON toolset (kick/kill/team/squad) is **inert for offline players** and only lights up for live ones — the server enforces `server_id` requirement, and the client mirrors that by hiding the buttons. There is no visible client-side role check beyond presence gating; group-level authorization is assumed to be enforced server-side. A few SteamIDs are special-cased in `player.open()` (hard-coded owner/dev badges) — cosmetic only.

---

### 7. Notable UX & competitively interesting details

- **Playtime-by-role leaderboard.** Breaking playtime into 11 kit columns turns "who's online" into a role-competency table — instantly surfaces medics/SLs/pilots. Worth copying: it makes the page useful for recruiting and for spotting role-stackers, not just moderation.
- **One shared player-detail modal everywhere.** The same ~23-action card is embedded on every page (chat, bans, kills, top, etc.). An admin never leaves context to punish. High leverage; expensive to out-build piecemeal.
- **Presence-driven action gating.** Live RCON actions require `player.info.online.server.id`; the UI hides them when absent. Clean model: DB actions on `player.php`, live actions on `squad.php`.
- **Recommended ban length engine.** Each rule option encodes escalating 1st–4th-offence durations (`data-first..four`); the correct duration radio is auto-checked and tooltipped "Recommended." A strong consistency/fairness feature to beat.
- **Canned warnings + optional card logging.** Pre-written multilingual warnings with a "log to card" toggle and configurable in-game repeat interval — fast, auditable moderation.
- **Twink hunting.** IP-overlap alt detection with drill-down (shared IPs, time deltas, friend-graph cross-check, online-calendar comparison) is a serious anti-ban-evasion toolkit.
- **Clipboard integrations.** `AdminTeleportToPlayer` teleport command and a ready-to-paste OWI/BattleMetrics cheat-report template are copy-to-clipboard — low-friction admin ergonomics.
- **Rich context per player.** Geo-IP history with flags/timezones, primetime hours, Steam hours, VAC/game-ban badges, Discord link — a full intel dossier attached to the moderation surface.

---

### 8. Gaps / uncertainties

- `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster`, `downloadOnline` are **not present on this page**; per `action_catalog.txt` they belong to `main.html` (the server dashboard). This page's "online" is a **historical period aggregation**, not a real-time roster. Document the real-time roster under the servers/main section.
- Exact server-side field set for `action:'get'` beyond what the modal reads is not observable from the client.
- The `boost`/`queue`/`primetime` metrics' precise definitions are inferred from usage, not from a schema.
- `reason_id` value mapping to human-readable rule text lives server-side; only the option catalog is visible client-side.
- Kit-permission payload shape (`kits[]` from `player.kits.collect()`) is assembled client-side but its server schema is not exposed here.
