## 03. Players Directory (Все игроки)

> Canonical reference for the master player list **and** the shared **player-detail modal** that appears on virtually every page of SQSTAT. The modal's tabs, forms and ~25 actions are documented here in full; other sections should cross-reference this file rather than re-document the modal.

---

### 1. Purpose & Navigation

- **Nav id / entry point:** `players` → `pageLoad('players')` → `GET /ajax/page.php?page=players`, HTML fragment injected into `#content`.
- **Purpose:** Global searchable directory of every player ever seen across the project's servers (not just those currently online). It is the primary entry point to open a player card and perform moderation actions (ban, kick, group change, VIP, mark, message, twink hunt, kit denial, etc.).
- **Layout:** Two-column. Left (`col-md-3`, `position:fixed`) is a search/filter sidebar; right (`col-md-9`) is the results table `#allPlayers`.
- The fragment ALSO embeds the entire shared player-detail modal machinery (`#playerModal`, `#player_info`, `#player_ban`, `#player_group`, `#player_message`, `#player_twink-modal`, `#player_kits-modal`, `#player_findban-modal`, `#player_map-modal`, and the comments drawer). The near-identical `playersOnline.html` reuses the same modal and action set (see action catalog: both expose the identical ~21 actions).

---

### 2. The Page's OWN Table & Search

#### 2.1 Results table `#allPlayers`
DataTables-style server-side table built via `$('#allPlayers').buildTable({...})`. Only **three** visible columns:

| Column header (RU / EN gloss) | data key | Meaning |
|---|---|---|
| `SteamID` (with Steam icon) | `steam_id` | SteamID64, rendered inside a `<hashtag>` element. Click-to-copy identity. |
| `Ник` (Nickname) | `name` | Current in-game nickname. |
| `Заходил` (Last seen) | `date` | Last login timestamp, formatted via `formatDate(data,false,true)`. |

- `numrows: 100` per page. On mobile it switches to `mode:'list'` using the `#player_template` card (steam_id / name / date).
- **Row click** → `player.open( steam_id )` opens the detail modal. (Alt/Ctrl-click is suppressed so admins can copy text without triggering the modal.)
- If exactly one row is returned, it auto-opens that player (`:eq(0).trigger('click')`).

#### 2.2 Search / filter sidebar
Search is transmitted through `buildTable`'s `searchInput` mechanism (see §2.3). Controls:

| Control (id) | `data-search` key | Type | Meaning |
|---|---|---|---|
| `Поиск` button (`#allPlayers-btn`) | — | button | Triggers `buildTable('rebuild')`. |
| `Ник или SteamID` (`#allPlayers-name`) | `t1.player` | text | Free-text search on nickname or SteamID. Enter key or paste rebuilds the table. |
| `Прошлые ники` (Past nicknames) (`#with_other_names`) | `with_other_names` | checkbox | Extends the name search to historical nicknames, not just the current one. |
| `Полное совпадение` (Exact match) (`#full_match`) | `full_match` | checkbox | Toggles exact vs. partial matching. |
| `Заходил c` (Seen from) (`#allPlayers-startdate`) | `startdate` | datetime | Lower bound on last-login date (datetimepicker, ru locale). |
| `Заходил до` (Seen until) (`#allPlayers-enddate`) | `enddate` | datetime | Upper bound on last-login date. |
| `Добавить` (Add) (`#addPlayer-btn`) | — | button | Opens `#addPlayer_modal` to add a player by SteamID64 (see §6.1). |

#### 2.3 Table transport (shared across the whole panel)
`buildTable` collects `searchInput` values into a JSON object `{text, check, multiselect, managers, slider}`, URL-encodes it as `search`, and issues:

```
Action({ script:'table', action:'<tableName>', data:'&table=<tableName>&page=&numrows=&search=<json>&order_by=&order_sort=' })
→ POST /ajax/table.php
```

For the main list, `tableName = 'allPlayers'`, columns `["steam_id","name","date"]`. Column headers carrying `i[data-sort]` are click-sortable (`order_by` / `order_sort` asc|desc). This same transport powers every modal sub-tab table (§4) and every other page's tables.

---

### 3. Entity: Player (`player.info`) — the core data model

`player.open(steam_id)` → `Action({script:'player', action:'get', data:{steam_id}})` → `POST /ajax/player.php`. The returned `player` object is the richest entity in the app. Fields inferred from `setInfo()`:

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | SteamID64 (primary identity). |
| `eos_id` | string | Epic Online Services ID (Squad's newer identity). |
| `name` | string | Current nickname. |
| `names[]` | `{name, date}` | Historical nicknames dropdown ("Другие ники"). |
| `date` | ts | Last login ("Заходил"). |
| `create_date` | ts | First seen ("Создан"). |
| `baby` | bool | "New/young account" flag — shows a red warning icon next to online time. |
| `bonus` | number | Accumulated bonus points ("Бонусы"). |
| `playtime` | `{online, boost, server}` | Aggregate playtime, boost time, favourite server ("Сервер"). |
| `mark` | int 0–8 | Suspicion tag (see §4.4 mark values). |
| `group` | `{name, color, icon, description}` | Current privilege group badge; special art for `QueuePriority` (VIP) / `Moderator`. |
| `group_id`, `expire`, `group_description`, `prefix`, `prefix_rgb`, `image` | mixed | Group assignment details used by the group modal. |
| `ban` | `{expire, reason, admin_name, date, description}` | Active ban record (drives the red "забанен" panel + corner ribbon). |
| `bans[]` | `{admin_name, date, reason, description, impact, unban}` | Full punishment history (Наказания tab). `impact` = counts toward escalation; `unban='1'` = later reversed. |
| `canBan` | bool | Gates the "Наказать", kill, banname, kits controls. |
| `canUnban` | bool | Gates the "Разбанить" button. |
| `canChangeGroup` | bool | Gates the "Группа" button. |
| `canSelfKick` | bool | Gates "Кикнуть без причины". |
| `is_you` | bool | If true, group select + expire are disabled (can't edit self). |
| `name_banned` | bool | Whether current nick is on the banned-names list (toggles banname/unbanname menu items). |
| `vac` | `{ban, days}` | VAC ban status. |
| `steam_info` | `{ban:{vac,ban,days}, squad:{time}}` | Steam profile enrichment — VAC/game ban badge + Squad hours played. |
| `discord` | string(id)/false | Discord user id → "открыть" link to `discord.com/users/<id>`. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history (country flag, city, timezone, coords for map, **IP address**, seen date). First entry is current. |
| `primetime[]` | `{start, end}` | Typical active hours (unix → HH:mm ranges). |
| `clans[]` | `{clan_id, name}` | Clan memberships (link to `/clan.php?id=`). |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` / false | Live session — presence enables message/kill/changeTeam/removePlayer. |
| `stats` | object | Aggregate combat stats (kill, die, revive, winrate, kit, kit_name) rendered in the stat cards. |

Derived/rendered elsewhere: `kill`, `die`, `revive`, `winrate`, `kd`, favourite `kit`+`kit_name` (stat cards); an online chart (`getPlayerOnlineData`) with three series **Онлайн / Буст / Очередь** (online minutes / boost / queue).

---

### 4. The Shared Player-Detail Modal (`#player_info`)

Draggable modal. Header shows name, other-nicks dropdown, clan labels, group/VAC/ban badges, last-login/created, Steam hours, EOS id, VAC, geo-location (+ other-locations dropdown that opens a Leaflet map via `player.map.open(lat,lng)`), Discord, primetime, online/bonus/boost tiles, an online activity chart with **График / Календарь / По серверам** (Chart / Calendar / Per-server) sub-tabs, six stat cards (Побед/Кит/К-Д/Убийства/Смерти/Поднятий), and a second tab strip of detail tables.

#### 4.1 Detail sub-tabs (each a lazy-loaded `table`-script table keyed by `steam_id`)

| Tab (RU / EN) | table name | Columns (data keys) |
|---|---|---|
| Наказания (Bans) | *(from `player.info.bans`, accordion — not a table call)* | admin, date, reason, description, impact, unban |
| Варны (Warns) | `playerWarn` | `admin, text, date` |
| Чат (Chat) | `playerChat` | `server, date, team, type, msg` (obscenity flagged via `isObscene`) |
| Тимкиллы (Teamkills) | `playerTeamkill` | `server, date, killed, kit` |
| Киты (Kits) | `playerKits` | `kit, cnt` |
| Сквады (Squads) | `playerSquad` | `server, team, date, squad_id, name` |
| Убийства (Kills) | `playerKills` | `server, name, weapon, date` |
| Смерти (Deaths) | `playerDeath` | `server, weapon, date` |
| Игры (Games) | `playerGames` | `server, map, win, date` |
| Поднятия (Revives) | `playerRevive` | `server, name, date` |
| Урон (Damage) | `playerDamage` | `server, weapon, name, damage, date` |
| Техника (Vehicle) | `playerVehicle` | `server, vehicle, weapon, damage, date` |

All twelve POST to `/ajax/table.php` with `&steam_id=<id>` appended, `numrows` 10–20, `showPages:3`.

#### 4.2 Full action set — moderation capabilities (admin permissions)

All state-changing actions POST to `/ajax/player.php` (`script:'player'`) or `/ajax/squad.php` (`script:'squad'` = live-server RCON-style operations that require the player to be online). "Destructive?" = changes state / affects a real player.

| UI label (RU / EN) | action id | script → endpoint | data params | Effect | Destr.? |
|---|---|---|---|---|---|
| open card | `get` | player → player.php | `steam_id` | Load full `player.info`. | N |
| `Добавить` (Add player) | `add` | player | `steam_id` | Create a player record from a SteamID64, then open it. | Y |
| `Наказать`→`Кикнуть` (Kick w/ reason) | `kick` | squad | `steam_id, reason_id, description, noReason:false` | Kick from live server with a rulebook reason. | Y |
| `Кикнуть без причины` (Kick no reason) | `kick` | squad | `steam_id, reason_id, description, noReason:true` | Kick without a rule (confirm dialog). Gated by `canSelfKick`. | Y |
| `Наказать`→`Забанить` (Ban) | `ban` | squad | `server_id, steam_id, reason_id, description, days` | Ban for N days (1–30) or permanently (`days=-1`). `server_id` sent if online. | Y |
| `Разбанить` (Unban) | `unban` | squad | `steam_id, unban:<bool>` | Lift ban; `unban=true` fully erases the record ("выдан по ошибке"), else keeps it as reversed. Gated by `canUnban`. | Y |
| `Сообщение`→`отправить` (Message) | `message` | player | `steam_id, time, msg, log` | Push in-game warning message, repeated for `time` seconds (1 / 30 / 40 / 60 / 90 / 120); `log` optionally records it on the card. | Y |
| `Команда` (Switch team) | `changeTeam` | squad | `server_id, steam_id` | Force-swap the player's team (confirm). Online only. | Y |
| `Убить` (Kill) | `kill` | squad | `server_id, steam_id` | Kill the player in-game (loses their squad). Gated by `canBan`+online. | Y |
| `Кик из сквада` (Remove from squad) | `removePlayer` | squad | `server_id, steam_id` | Eject from their fireteam/squad. Online + in a squad. | Y |
| tag menu → `Подозрение…` / `Снять метку` | `mark` | player | `steam_id, mark` | Set/clear a suspicion tag 0–8. | Y |
| `Группа`→`Сменить группу` (Change group) | `changeGroup` | player | `steam_id, group_id, date(expire), description, prefix, prefix_rgb, image` | Assign privilege group + expiry + custom prefix/color/image (this is the **VIP grant** path too). Gated by `canChangeGroup`; disabled for self. | Y |
| `Забанить ник` (Ban nickname) | `addBanName` | player | `name` | Add current nick to the banned-names blacklist. | Y |
| `Разбанить ник` (Unban nickname) | `removeBanName` | player | `name` | Remove nick from blacklist. | Y |
| `Проверить баны` (Check bans) | `checkBans` | player | `steam_id` | Cross-project ban lookup (returns per-project `{name, discord, online, ban:{total,current:{reason,date,expire}}}`) shown in `#player_findban-modal`. | N |
| `Поиск твинков` (Find twinks/alts) | `twink` | player | `steam_id` | Alt-account detection (see §4.3). | N |
| twink → `Онлайн` (compare online) | `twinkOnline` | player | `steam_id, compare_steam_id, start, end` | Overlay two accounts' online sessions on a calendar to prove co-presence. | N |
| twink → `Проверить друзья` (friends) | `findFriends` | player | `steam_id, compare_steam_id` | Check whether two accounts are Steam friends (`in_friend`). | N |
| `Киты` (Kit deny) → `Сохранить` | `kits` / `kitSave` | player | get: `steam_id`; save: `steam_id, kits(JSON {kit:bool})` | View & toggle per-kit denial for the player. Modal warns it "may violate server license terms." | Y (save) |
| comments drawer (load) | `getComments` | player | `steam_id` | Load admin comments on the player. | N |
| comments drawer (send) | `addComment` | player | `steam_id, text` | Post an internal admin comment (≤256 chars). | Y |
| `Скачать статистику` (Download stats) | `downloadStat` | player.php (form POST via `post_to_url`) | `action, steam_id` | Download the player's stats as a file. | N |
| online chart data | `getPlayerOnlineData` | player | `steam_id, start, end` | Fetch online/boost/queue time series for the chart. | N |
| `Копировать телепорт` (Copy teleport) | *(clientside)* | — | — | Copies `AdminTeleportToPlayer <steam_id>` to clipboard. | N |
| `Заявка в OWI` (OWI report) | *(clientside)* | — | — | Copies a preformatted cheat-report template (name/EOS/Steam URL). | N |
| card link | *(clientside)* | — | — | Copies `https://<host>/?steam_id=<id>` deep-link. | N |

Note: the catalog also lists `twinkOnline` on essentially every page — the modal (and thus its whole action set) is embedded everywhere; `players.html` and `playersOnline.html` are the only fragments exposing the FULL set including `ban/kick/kill/kits/changeGroup/changeTeam/checkBans/add`.

#### 4.3 Twin / alt detection (`twink`) — competitively notable
`Поиск твинков` returns `text.list[]` where each candidate alt has: `steam_id, name, perm` (has a permanent ban), `min_date` (time delta), and `ips[]` of shared-IP hits `{loc, date, owner_date}`. The UI renders, per candidate:
- Name + SteamID + "открыть" deep-link.
- Red flag if the alt carries a **permanent ban** ("Есть перманентный бан").
- Collapsible list of **matching IPs**: count, humanized time-difference, each with the location and both accounts' seen-times side by side.
- **`Проверить друзья`** → Steam friends check between the two accounts.
- **`Онлайн`** → renders a weekly FullCalendar overlaying both accounts' sessions (`twinkOnline`) to visually prove they never/always play together.

This is a fully built shared-IP + Steam-friends + co-presence alt-hunting workflow — a strong feature to match or beat.

#### 4.4 Suspicion marks (`mark` values)
| value | Label (RU / EN) |
|---|---|
| 1 | Подозрение на WallHack |
| 2 | Подозрение на AimBot |
| 3 | Подозрение на SpeedHack |
| 4 | Подозрение на спавн объектов (object spawning) |
| 5 | Подозрение на перезарядку (reload exploit) |
| 6 | Подозрение на гриф (griefing) |
| 7 | Подозрение на конфиг (config exploit) |
| 8 | Токсичный игрок (toxic) |
| 0 | Снять метку (clear) |

A set mark adds a `player_mark` CSS class to the player's rows across tables and shows a pulsing warning banner in the card.

---

### 5. Forms & Modals (fields, options, validation)

#### 5.1 Ban form (`#player_ban`)
- **Reason select `#player_ban-reason`**: grouped rulebook (`optgroup`s: Особые / Общие / Для сквадных / Для техники / Милсим). Each `<option>` carries `value` = rule id (e.g. `110`, `171`), a rich HTML `label` with the rule number, and `data-first/second/third/four` (escalation day-tiers per offense count). Value `false` = "-Выберите причину-".
- **Punishment radios `player_ban-reason_type`**: Кикнуть (`value=-1 data-action=kick`), Забанить 1/2/3/4/5/6/7/10/14/30 дн (`data-action=ban data-day=N`), and Забанить навсегда (`value=-1 data-action=ban data-day=0`, permanent, dark-red).
- **`Дополнительный комментарий`** textarea `#player_ban-description` (≤512 chars).
- Submit `player.actionPlayer()` routes to kick vs. ban by the checked radio's `data-action`; if the reason itself is a pure kick (`-1`) it bans/kicks accordingly.

#### 5.2 Group / VIP form (`#player_group`)
- **`#player_group-groups`** multiselect: `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator), `5` Стажёр (trainee).
- **`#player_group-expire`** dateRange button with presets: justDay, +1/2/3/6 Month, +1 Year, infinity, reset. (Existing VIPs default to their `expire`, permanent → infinity.)
- `Комментарий` (≤128), `Префикс` (≤64), `Цвет префикса (RGB)` (color picker + `r,g,b` text), `Ссылка на изображение` (≤256).
- Buttons: `Игрок` (flip back), `Сменить группу`, and a hidden `VIP +1 месяц` quick-grant. Self-editing disabled (`is_you`).

#### 5.3 Message form (`#player_message`)
- Scrollable list of ~18 canned messages (`player.message.set`) — VIP grant notice, vehicle-solo/tandem warnings, squad-lock rules, mic requirement, TK apology, report-received, etc.
- `Добавить запись в карточку игрока` checkbox (`#player_message-log`) → mirrors message into the player's card.
- `Сообщение` textarea (≤512), repeat-`Время` select (1 раз / 30 / 40 сек / 1 мин / 1:30 / 2 мин).

#### 5.4 Add-player modal (`#addPlayer_modal`)
Single `SteamID64` input `#addPlayer_steam_id` → `addPlayer()` → `action:'add'`; on success opens the new card.

#### 5.5 Kit-deny modal (`#player_kits-modal`)
License-risk warning banner; list of kits each with a danger toggle (`data-kit`, checked = denied, shows "От <date>"); `Сохранить` serializes `{kit:bool}` JSON to `kitSave`.

#### 5.6 Other modals
`#player_twink-modal` (alt list), `#player_map-modal` (Leaflet OSM map of a location), `#player_findban-modal` (cross-project ban grid), `#player_info-placeholder` (skeleton/glow loading state), and the sliding `player_comments` drawer.

---

### 6. Permission / Visibility Logic

Buttons are hidden by default (inline `display:none` or `.hide`) and revealed by `setInfo()` per server-provided capability flags — the **server is the source of truth**, the client only reflects it:

- `canBan` → shows "Наказать"; when online, shows "Убить" and kit/banname menu items.
- `canUnban` → shows "Разбанить" + the ban corner ribbon.
- `canChangeGroup` → shows the "Группа" button.
- `canSelfKick` → shows "Кикнуть без причины".
- `is_you` → group select + expiry disabled (no self-promotion).
- `name_banned` → toggles "Забанить ник" vs "Разбанить ник".
- Online-only actions (message, changeTeam, kill, removePlayer) appear only when `player.info.online` (and squad/team sub-objects) is present.
- Mark menu, twink, checkBans, copy-teleport, OWI report, download-stat are shown to everyone who can open a card.

Group ids (1 Admin, 2 Moderator, 3 VIP, 4 Camera, 5 Trainee) define the role hierarchy; special header art for VIP/Moderator groups.

---

### 7. Notable UX / Competitive Details (worth copying or beating)

1. **One universal player card** embedded on every page — open a player from chat, kills, bans, clans, anywhere; no context switch. Draggable, flippable (ban/group/message forms flip in-place rather than stacking modals).
2. **Alt-account hunting suite** (`twink` + shared-IP timeline + Steam-friends check + co-presence calendar) is the standout feature — a serious anti-cheat / ban-evasion tool.
3. **Cross-project ban check** (`checkBans`) aggregates bans across a federation of servers, with per-project online time and current-ban reason/expiry.
4. **Escalating rulebook** encoded in `<option data-first/second/third/four>` — automatic day-tier per repeat offense, plus one-click canned kick/ban durations up to permanent.
5. **Rich identity graph**: SteamID64 + EOS id + Discord + VAC/game-ban + Steam hours + geo-IP history (with raw IPs, timezones, map) + nickname history + primetime hours + clan memberships — all on one screen.
6. **Group grant as branding**: custom prefix text, RGB color, and image URL per player group (monetizable VIP cosmetics).
7. **Quality-of-life**: copy teleport RCON command, copy OWI cheat-report template, copy shareable deep-link, canned in-game messages, obscenity flagging in chat logs, "baby/new account" risk badge, kit-denial (with an explicit license-risk disclaimer), downloadable per-player stats, and Easter-egg per-SteamID video/audio overlays.
8. **Search depth**: search across historical nicknames + exact/partial toggle + last-seen date range — beats a naive "search by current name only."
