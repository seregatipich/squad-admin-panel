# SQSTAT — Rival Admin Panel: Complete Functionality Analysis

**Target:** `breaking.sqstat.ru` — a SQUAD game-server management + statistics panel ("SQSTAT 2019–2026, by Enj0y")
**Purpose:** Competitive benchmark for this project's `squad-admin-panel`.
**Method:** Authenticated, **strictly read-only** exploration of the live panel + static analysis of its client bundle and observed API surface, plus a 24-agent parallel documentation pass over the captured corpus.
**Date:** 2026-07-04

> **Scope & ethics.** Nothing was created, modified, or deleted on the rival panel — only page views (`GET`) and client-side JS were inspected; no mutation/`Action` endpoint was ever called. This document describes **functionality, structure, entities, and permissions**. It deliberately avoids reproducing the rival's third-party user data (player SteamIDs, names, IPs, ban lists) beyond isolated anonymized examples needed to explain a feature.

---

## Executive Summary

SQSTAT is a mature, multi-server **all-in-one SQUAD server platform** that fuses four products most competitors ship separately:

1. **Live RCON control** of many servers (map/rotation, chat/broadcast, squad & team ops, kick/ban/kill, start/stop/restart, mods, config).
2. **A years-deep statistics engine** — per-player, per-clan, per-match, per-weapon/vehicle analytics.
3. **Moderation suite** — bans, banned-nicknames, suspect marking, admin comments, a **cross-community shared ban network ("Ру-Баны")**, reports/votes logs, and a full admin **audit journal**.
4. **Community & monetization** — clan directory + management, VIP/subscriptions, a bonus-points economy, Discord bot + webhooks, a public API, wiki, and a bug tracker.

**Technology:** PHP backend + Steam-OpenID auth; a jQuery 2.2 / Bootstrap 3.3 AJAX single-page shell (`pageLoad()` renders fragments; `Action({script,action,data})` posts mutations to six `/ajax/<script>.php` endpoints). Chart.js, Leaflet, FullCalendar, CodeMirror. A separate **bot/parser** process scrapes each server's RCON into the DB. It is *not* a modern SPA framework — a maintainability/UX gap to exploit.

**Scale on this one instance:** ~**385,350** players · ~**115,400+** audit-journal entries · ~**80** clans · **53** staff · **6** servers.

**Authorization is the most important structural finding.** SQSTAT has **no unified RBAC engine**; it stacks three loosely-coupled layers that share five group *names* but not a permission model:

| Layer | Identity | Capabilities | Scope | Edited in |
|---|---|---|---|---|
| **L1 Panel role** | per-player `group_id` 0–5 (`changeGroup`) | coarse server booleans (`canBan`, `canChangeGroup`, …) | **global** | Admins → player modal → Группа |
| **L2 In-game RCON** | same 5 group names | 21 Squad `Admins.cfg` tokens per group (`ban`, `kick`, `cheat`, `manageserver`, …) | **per server** | Settings → Группы |
| **L3 Clan ownership** | clan roster `type` (leader/deputy/member) + `vip_mode` | clan `access`/`canType` booleans | **per clan** | Clan page roster |

The five groups: **Administrator (1)**, **Moderator (2)**, **VIP = QueuePriority (3)**, **Cameraman (4)**, **Intern/Trainee (5)** — plus `0` = none. VIP conflates monetization with the access table; L2 conflates in-game power with the same names. See chapter **90** for the full matrix, enforcement model, and 7 privilege-escalation findings (unbounded grant ceiling, client-only gating, no per-server scoping, unlogged in-game actions, webhook-secret leakage, …).

**Per-player "dossier" (chapter 92)** is deep: identity (SteamID + **EOS ID** + name history + Discord + VAC + **IP-geolocation**), sessions/playtime/prime-time, bonuses/boost, K/D & winrate, per-weapon and per-vehicle kills/damage, and 12 detail-log tabs (punishments, warns, chat, teamkills, kits, squads, kills, deaths, games, revives, damage, vehicles).

**Biggest competitive opportunities:** unify RBAC (roles vs perks vs RCON) with a real capability matrix and grant-ceiling; add per-server admin scoping and a first-class owner role; audit every privilege change and in-game admin action; modernize the jQuery/BS3 stack; and separate monetization (VIP/subscriptions) from access control.

---

## Visual Evidence (screenshots)

Full-page captures in [`screenshots/`](screenshots/). Key surfaces:

| # | Surface | File |
|---|---|---|
| 1 | Public homepage (logged-out) | `screenshots/01-public-homepage.png` |
| 2 | Server dashboard & live RCON control | `screenshots/10-dashboard-main.png` |
| 3 | Admins roster (groups: Admin/Mod/Camera/Trainee) | `screenshots/11-admins-groups.png` |
| 4 | Settings → Servers | `screenshots/12-settings-config.png` |
| 5 | **Settings → Groups (permission matrix editor)** | `screenshots/13-settings-groups-permissions.png` |
| 6 | Admin audit journal (115k+ entries) | `screenshots/14-logs-audit-journal.png` |
| 7 | Clan management page | `screenshots/15-clan-management.png` |
| 8 | Public player profile | `screenshots/16-player-profile-dossier.png` |
| 9 | Players directory (385k players) | `screenshots/17-players-directory.png` |
| 10 | **Player admin dossier modal** | `screenshots/18-player-admin-modal.png` |
| 11 | Bans | `screenshots/19-bans.png` |
| 12 | Ру-Баны (shared ban network) | `screenshots/20-collabans-ruban.png` |
| 13 | Statistics | `screenshots/21-statistics.png` |
| 14 | VIP / privileges | `screenshots/22-vips.png` |
| 15 | Match history | `screenshots/23-games.png` |
| 16 | Chat log | `screenshots/24-chat.png` |

---

## Table of Contents

**Foundations**
- 00 — Overview & Architecture
- 01 — Server Dashboard & RCON Control
- 02 — In-game Chat & Broadcast

**Players & Moderation**
- 03 — Players Directory (Все игроки)
- 04 — Player Profile & Per-player Data Storage
- 05 — Administration: Admins, Groups & Permissions
- 06 — VIP / Privileges (Привилегии)
- 07 — Players Online (live)
- 08 — Player Comments & Suspect Marking
- 09 — Ban Management
- 10 — Banned Nicknames & Ru-Ban Shared Network

**Tools & Analytics**
- 11 — Statistics Dashboards
- 12 — Match History (Игры)
- 13 — Combat Logs: Kills / Deaths / Revives / Damage / Teamkills
- 14 — Votes & Reports
- 15 — Bug Tracker & Video/Demos
- 16 — Settings: Server Config, Rotation, Mods, Restarts
- 17 — Admin Audit Journal (Журнал)

**Clans, API & Extras**
- 18 — Clan Management
- 19 — Public API
- 20 — Top Online Leaderboard

**Cross-cutting Synthesis**
- 90 — Permission, Role & Group Model
- 91 — Entity & Data Model
- 92 — Per-Player Data & Logs Storage (the "dossier")
- 93 — Complete Action / RPC / RCON Catalog

---


---

## 00. Overview & Architecture

Reference analysis of the **rival SQUAD game-server admin panel "SQSTAT"** — instance `breaking.sqstat.ru` (branding: "SQSTAT 2019–2026, by Enj0y"). This document set was produced by direct authenticated exploration (read-only) of the live panel plus static analysis of its client bundle, for competitive benchmarking against this project's `squad-admin-panel`.

> **Scope & ethics:** All exploration was strictly **read-only** (no state was changed on the rival panel). This documentation describes *functionality, structure, entities and permissions*. It intentionally does **not** reproduce the rival's third-party user data (player SteamIDs, names, IPs, ban lists) beyond isolated anonymized examples needed to explain a feature.

---

### 1. What SQSTAT is

SQSTAT is a mature, multi-server **SQUAD server-management + statistics panel** with a public-facing stats site and a Steam-authenticated admin back-office. It combines, in one product:

- **Live RCON control** of multiple SQUAD servers (map/rotation control, chat/broadcast, squad & team management, kick/ban/kill, server start/stop/restart).
- **A deep statistics engine** — per-player, per-clan, per-match, per-weapon/vehicle analytics harvested from the game servers over years.
- **Moderation tooling** — bans, banned-nicknames, suspect marking, admin comments, a cross-community shared ban network ("Ру-Баны"), reports and votes logs, and a full admin audit journal.
- **Community features** — clan directory & management, VIP/subscription monetization, a bonus-points economy, Discord bot + webhooks, a public API, wiki/FAQ, and a bug tracker.

It is a direct, feature-rich competitor. The data scale on this single instance is large: **~385,350 players**, **~115,400+ admin-journal entries**, **~80 registered clans**, **53 staff members**, across **6 configured servers**.

---

### 2. Technology stack (observed)

| Layer | Technology | Evidence |
|---|---|---|
| Backend | **PHP** (session cookie `PHPSESSID` + custom `PHPSESID`; endpoints are `*.php`) | `/ajax/page.php`, `/ajax/player.php`, `/steam.php`, `/logout.php` |
| Auth | **Steam OpenID** (login redirects to `steamcommunity.com/openid/login` → returns to `/steam.php`) | console/network trace |
| Frontend | **jQuery 2.2.4** + **jQuery UI 1.13.2**, **Bootstrap 3.3.7** (server-rendered fragments + AJAX SPA) | `assets/js/*` |
| Client logic | Hand-written `assets/js/custom.js` (v0.8.3) — ~54 KB, defines `pageLoad()`, `Action()`, and the shared player modal | source |
| Charts | **Chart.js** (`chart.umd.js`) | statistics, player profile, clan pages |
| Maps | **Leaflet** | live in-game map with markers on the dashboard |
| Calendar | **FullCalendar + Scheduler** | rotation calendar / seeding calendar |
| Config editing | **CodeMirror** (properties mode) | settings → server config file editor |
| Widgets | roundslider (online gauges), bootstrap-multiselect, bootstrap-datetimepicker + moment (ru locale), pnotify (toasts) | asset list |
| Notifications | **Discord bot + webhooks** (configurable in settings) | settings sub-tabs |
| Data collector | A separate **"bot"/parser** process connects to each server's RCON and feeds the DB (panel shows "Версия бота неактуальна / Обновить бота"; actions `botUpdate`, `parserRestart`, `cacherRestart`, `serverMonitor`) | dashboard + settings |

The panel is **not** a modern SPA framework app (no React/Vue); it is a jQuery + Bootstrap-3 AJAX app with server-rendered HTML fragments. This is a maintainability/UX weakness worth beating.

---

### 3. Core architecture: how the app works

The entire admin panel is a **single-page shell** (`/`) whose `#content` div is swapped by AJAX. Two client primitives (both in `custom.js`) drive everything:

**3.1 Page rendering — `pageLoad(page)`**
```
pageLoad('players')  →  GET /ajax/page.php?page=players  →  HTML fragment injected into #content
```
- Nav links do not use real hrefs; they call `pageLoad('<page>')` and push `/?page=<page>` to history.
- `page.php` is **read-only rendering**. Every top-level section (see §4) is one `page` value.
- Sub-entities use query-style page ids, e.g. `pageLoad('clan&id=16')`.

**3.2 Mutations / RPC — `Action({script, action, data})`**
```
Action({script:'squad', action:'ban', data:{server_id, steam_id, reason_id, days, ...}})
       →  POST /ajax/squad.php   body: action=ban&server_id=…&steam_id=…
```
- All state-changing operations and server-side data reads (DataTables) go through `Action()`.
- **Six script endpoints** exist (`/ajax/<script>.php`):

| script → endpoint | Responsibility |
|---|---|
| `public` → `/ajax/public.php` | Unauthenticated/public actions (Steam auth, public stats) |
| `table` → `/ajax/table.php` | DataTables server-side data (paginated rows for every list) |
| `player` → `/ajax/player.php` | Player-scoped, **global** actions (comments, marks, group/VIP, ban-names, kits, twink detection, stats export) |
| `squad` → `/ajax/squad.php` | Live RCON, **per-server** actions (kick/ban/kill/team/squad/message) — always carry `server_id` |
| `clan` → `/ajax/clan.php` | Clan management (create, roster, tags, expiry, transfer, disband) |
| `settings` → `/ajax/settings.php` | Server config, groups/permissions, rotation, mods, messages, Discord |

A key structural insight for permission analysis: **`squad.*` actions are per-server** (they send `server_id`) while **`player.*` actions are global** (no `server_id`). See the permissions synthesis chapter (90) for the full matrix.

**3.3 The shared player modal.** Every rendered fragment embeds one large hidden **player-detail modal** (`#playerModal`) plus its `player.*` JS object. Clicking any player row anywhere opens the same modal — the per-player "dossier" (identity, stats, and ~22 moderation actions). Because it is embedded everywhere, its columns/actions appear in *every* fragment; the per-section chapters flag which controls are the page's own vs. this shared modal.

---

### 4. Navigation map (complete section inventory)

The authenticated top nav (`pageLoad` targets unless noted):

| Menu | Section | page id | Chapter |
|---|---|---|---|
| (brand) | Server Dashboard / live RCON | `main` | 01 |
| Чат | In-game chat & broadcast | `chat` | 02 |
| **Игроки** (Players ▾) | Все игроки (all players) | `players` | 03 |
| | Администрация (admins/groups) | `admins` | 05 |
| | Привилегии (VIP) | `vips` | 06 |
| | Онлайн (live online) | `playersOnline` | 07 |
| | Комментарии (comments) | `comments` | 08 |
| | Подозреваемые (suspects/marks) | `mark` | 08 |
| | Забаненные (bans) | `bans` | 09 |
| | Забанненые ники (ban-names) | `bannames` | 10 |
| | Ру-Баны (collab/shared bans) | `collabans` | 10 |
| | Топ онлайна (hidden) | `top` | 20 |
| **Инструменты** (Tools ▾) | Статистика | `statistics` | 11 |
| | Игры (matches) | `games` | 12 |
| | Убийства/Смерти/Поднятия/Урон/Тимкиллы | `kills`/`deaths`/`revives`/`damages`/`teamkills` | 13 |
| | Голосования (votes) | `votes` | 14 |
| | Репорты (reports) | `reports` | 14 |
| | Баг-трекер (issues) | `issues` | 15 |
| | Видео (video/demos) | `video` | 15 |
| | Wiki | `/faq/` (link) | — |
| | API | `/api/docs/` (link) | 19 |
| | Аптайм | `uptime.sqstat.ru` (link) | — |
| | Настройки (settings) | `settings` | 16 |
| Журнал | Admin audit journal | `logs` | 17 |
| **Кланы** (Clans ▾) | Add clan + clan pages | `createClan`, `clan&id=N` | 18 |
| IP ▾ | current admin IP allow entry | — | (dashboard) |
| (user ▾) | Профиль `/player/<steamid>`, Настройки (userSettings), Выйти `/logout.php` | — | 04 |

Cross-cutting synthesis chapters: **90** Permissions/Groups model · **91** Entity & data model · **92** Per-player data & logs storage · **93** Complete action/RPC/RCON catalog.

---

### 5. Server model

Six servers are configured on this instance, selectable as tabs on the dashboard and reorderable/licensable in settings:

| Slot | Name | Type |
|---|---|---|
| A | RAAS/AAS #1 | main rotation |
| B | БЕЗ ГОЛОСОВАНИЯ #2 (No-vote) | fixed layers |
| C | INVASION #3 | invasion mode |
| E | Custom для FW | community/clan custom |
| F | Custom для MDC | community/clan custom |
| G | Custom для BSS | community/clan custom |

Each server has: a license, an online/offline status indicator, a RCON connection, its own rotation/seeding config, and per-server stats. The "Custom для <TAG>" servers are dedicated to specific clans (FW, MDC, BSS), indicating a **paid/partner clan-server hosting** model.

---

### 6. Public vs. admin surface

- **Public site** (logged-out `/`): server rotation cards with live player-count gauges, recent match history, weekly stat leaderboards (kills/healing/revives), per-mod leaderboards, clan directory, player profiles (`/player/<id>`), wiki, public API.
- **Admin panel** (Steam login → staff group required): everything in §4 — live RCON, moderation, settings, journal, clan management.
- **Monetization layer** surfaced even to players: VIP with expiry, **Subscriptions** ("Подписки"), a **bonus-points economy** ("Ваши бонусы"), boost, and promo banners. VIP = group id 3 (`QueuePriority`) granting reserved-slot/queue priority.

See the following per-section chapters (01–20) and cross-cutting synthesis (90–93) for full detail.


---

## 01. Server Dashboard & RCON Control

> Competitive functionality analysis of SQSTAT (`breaking.sqstat.ru`). This section documents the **main per-server control panel** — the largest page fragment (~312 KB) and the operational heart of the panel. Everything an admin does to a live Squad server happens here.

---

### 1. Purpose & Navigation

| Attribute | Value |
|---|---|
| Nav location | `main` (default landing page) |
| Loader | `pageLoad('main')` → `GET /ajax/page.php?page=main` → fragment injected into `#content` |
| Deep links | `/?server_id=<id>` (open a specific server tab), `/?steam_id=<id>` (auto-open player modal), `/?start_seed=true` (auto-open the seeding helper) |
| Primary RPC script | `squad` → `POST /ajax/squad.php` (nearly all live-control actions) |
| Secondary scripts | `public` (rotation read / map calendar / auth), `player` (shared player-modal actions) |

**Layout.** A single full-width row split into:
- **Left ~75% (`col-md-9`, `data-hide="offline"`):** live player/squad board, with tabs **Игроки (Players)**, **Техника (Vehicles, hidden by default)**, **Очередь (Queue)**, **Отключившиеся (Disconnected)**.
- **Right ~25% (`col-md-3`):** the control sidebar — collapsible **Управление (Control)** and **Состояние (State/monitoring)** panels, an **Онлайн (Online)** gauge + chart, a live **Чат (Chat)** feed with a broadcast input, a **Карта (Map)** widget (current/next map, rotation, calendar), and a **legend for player markers**.

**Server tabs.** A `#servers` tab strip lists every server as `<a data-server="<id>">`. Each carries live badges refreshed on a 5s poll (`getServer`):
- `data-type="badge_online"` → `players/100` (or `OFF` with `.bg-important` when the server is down)
- `data-type="badge_queue"` → `+N` queue overflow (hidden when 0)
- `data-type="badge_admins"` → admin headcount on the server
- A `fa-user text-danger` icon is prepended to the tab where *you* are currently playing (`text.you`).

The header also shows **global online** as `N (percent%)` — this server group's share of all tracked Squad players worldwide (`text.global_online`), plus a **Squad sale** banner (`text.is_sale`) when a Steam discount is live.

---

### 2. Polling & State Machine

The page polls `squad.getServer` every **5000 ms** for the active tab.

**Request** `getServer`: `{ server_id, last_chat_id }` (chat delta cursor).
**Response** `text.server` drives `showServer()`; `text.servers` refreshes all tab badges; `text.global_online`, `text.you`, `text.is_sale` update globals.

Server display states (from `data.isConnect` / `data.block_start`):

| Condition | UI behavior |
|---|---|
| `isConnect === true` | Full board shown; control buttons enabled |
| `!isConnect && !block_start` | "Нет подключения (No connection)"; **Включить (Turn on)** button shown |
| `block_start` set | Shows `block_start.msg`; start button hidden. If `block_start.code == 4` → shows `data.update_log` in a `<pre>` (server is mid-update) |

Alert banners (each `display:none` until triggered): **Версия бота неактуальна (Bot version outdated)** with an inline **Обновить бота (Update bot)** link; **Проблемы с EOS backend (EOS backend problems)**; **На сервер идёт атака (Server under attack)** — triggered when `network.connections > 300`, shows connection count + **Открыть подключения (Open connections)**; **Скидка на Squad (Squad discount)**.

---

### 3. Entities & Data Model

Inferred from `showServer()` rendering, hidden `<template>` blocks, and Action payloads.

#### 3.1 Server (`data.server`)

| Field | Meaning |
|---|---|
| `isConnect` / `block_start` / `outdated` / `eos_problem` | Connectivity & health flags |
| `start_params.port` / `.query` / `.beacon_port` | Game / Steam-query / RCON-beacon ports |
| `start_params.ip` / `.new_ip` | Bound IP (and pending IP after restart) |
| `license` / `license_valid` | Server license key + validity flag |
| `version` / `build` | Squad server version & build number |
| `region`, `EOS_ping`, `EOS_online` | EOS backend region, filter ping, monitored online count |
| `cores` / `mem` | CPU core count / memory |
| `last_restart`, `bot_start`, `need_restart` | Timestamps (day/month/year/hour/minute) + pending-restart flag |
| `teams[0..1]` | `{ short, name, unit }` — faction short code, full name, unit label (drives team banner images `/assets/img/teams/<short>_bg.jpg`) |
| `players.active[]` / `players.dis[]` | Live players / recently disconnected |
| `squads[]` | Live squads |
| `calculateOnline[team].squads[id]` | Per-squad `{ avg, median }` playtime aggregates; also per-team totals (`online_all`, `online_avg`, `online_median`, `online_sl`) |
| `vote` | `{ isVote, mode: skip\|next\|current, map }` — active in-game map vote |
| `monitor[]` | Time-series of `{ data: { network.connections, ... } }` for the mini-charts |

#### 3.2 Player (row in `players.active[]`)

| Field | Meaning |
|---|---|
| `steam_id` | SteamID64 — row key (`data-id`), used by every player action |
| `eos_id` | Epic Online Services ID |
| `name`, `color` | Display name; optional clan-tag color (hex, rendered in `<code style="color:#…">`) |
| `team`, `squad`, `leader` | Team 1/2, squad id, is-squad-leader flag |
| `kit` | Raw kit string; regex-reduced to a base kit → icon `/assets/img/ico/kits/<kit>.svg` |
| `state` | e.g. `Playing`; non-Playing → dimmed row + skull icon |
| `in_vehicle` | `{ id, name, vehicle, icon, class }` — vehicle occupancy |
| `playtime` | `{ date, last_seen }` → session length badge |
| `location` | `{ country, iso, same }` — geo flag + count of players sharing this IP |
| `mark` | Boolean — flagged/watched player (row gets `.player_mark`) |
| `warning` | >3 punishments → `fa-user-secret` badge |
| `vac` | Steam ban within 100 days → Steam icon |
| `baby` | New player <30h → baby icon |
| `requests` | `{ admins, report, ban_ip }` → live admin-call / report / banned-IP indicators |

#### 3.3 Squad (`data.squads[]`, hidden `[data-template="squad"]`)

| Field | Meaning |
|---|---|
| `id` | Squad number (badge) |
| `name` | Squad name (blankable via `rename`) |
| `team` | Owning team |
| `create_id` / `create_name` | SteamID / name of the squad creator (crown icon) |
| `cmd` | Has a Commander (star icon; CMD squads sort to top) |
| `locked` | Locked squad (lock icon) |
| `size` | Member count, rendered `size/9` |
| `message` | Pending scheduled squad-message flag |

Squad panels expose an inline button row (`data-type="buttons"`): open-creator (crown), **squadMessage** (envelope), **transfer** (swap sides), **demote** (if CMD) or **rename** (if not), and **disband** (✕). Each squad table gets `data-leader=<steam_id>` for its leader.

#### 3.4 Vehicle (`in_vehicle`, hidden `[data-template="vehicle"]`) — team/vehicle board (tab is `.hide` by default, feature appears disabled).

#### 3.5 Queue & Disconnected tables

| Queue columns | Disconnected columns |
|---|---|
| Позиция (Position), EOS (id), Имя (Name), Время (Time) | SteamID, Имя (Name), Время (Time) |

---

### 4. Actions / Admin Capabilities

All POST to `/ajax/<script>.php` with body `action=<id>&<params>`. "Destructive" = mutates live server/game state.

#### 4.1 Server lifecycle — Управление (Control) panel — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Включить (Turn on) | `start` | `server_id` | Boots the game server (confirm dialog) | Y |
| Выключить (Turn off) | `stop` | `server_id` | Shuts the server down | Y |
| Рестарт (Restart) | `restart` | `server_id` | Restarts the game server | Y |
| Обновить (Update) | `update` | `server_id`, `afterMapChange` (bool) | Updates server; optionally defers until next map change | Y |
| RCON | `rconRestart` | `server_id` | Restarts the RCON connection | Y |
| Parser | `parserRestart` | `server_id` | Restarts the log parser | Y |
| (Steam Query) | `cacherRestart` | `server_id` | Restarts the Steam-query cacher | Y |
| Обновить бота (Update bot) | `botUpdate` | *(none)* | Updates the sqstat bot agent | Y |
| (IP select) | `setServerIP` | `server_id`, `ip` | Rebinds the server IP (takes effect after restart) | Y |

Confirmation dialogs (`$.question`) gate start/stop/restart/update/rcon/parser/cacher/botUpdate. `blockServerButtons()` disables the four lifecycle buttons while an op is in flight.

#### 4.2 Player control (live-server, from the shared player modal but scoped by `server_id`) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Кик (Kick) | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | Kicks player; `noReason:true` path skips reason | Y |
| Бан (Ban) | `ban` | `server_id`, `steam_id`, `reason_id`, `description`, `days` | Bans player (`days=0` → permanent) | Y |
| Разбан (Unban) | `unban` | `steam_id`, `unban` (bool: erase vs lift) | Removes ban; `unban:true` fully wipes the record | Y |
| Убить (Kill) | `kill` | `server_id`, `steam_id` | Kills the player in-game (drops their squad) | Y |
| Сменить команду (Change team) | `changeTeam` | `server_id`, `steam_id` | Force team-swap | Y |
| Исключить из сквада (Remove from squad) | `removePlayer` | `server_id`, `steam_id` | Removes from squad without kicking | Y |

> **Shared modal note:** the player-detail modal (tabs Chat/Kills/Deaths/Kits/Games/Comments and actions `mark`, `message`, `twink`, `twinkOnline`, `findFriends`, `addComment`, `getComments`, `changeGroup`, `kits`, `kitSave`, `checkBans`, `addBanName`, `removeBanName`, `get`, `downloadStat`, `getPlayerOnlineData`) is embedded on every page and is **not** owned by the dashboard. Those actions run on `script: 'player'`. Only the six live-server actions above (which require a `server_id`) are dashboard-specific. `copyTeleport()` copies an `AdminTeleportToPlayer <steam_id>` RCON string to the clipboard.

#### 4.3 Squad control (per-squad row buttons) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Расформировать (Disband) | `disband` | `server_id`, `team`, `squad` | Disbands the squad (confirm) | Y |
| Сменить сторону (Transfer) | `transfer` | `server_id`, `team`, `squad` | Moves whole squad to other team (confirm) | Y |
| Сбросить название (Rename/clear) | `rename` | `server_id`, `team`, `squad` | Clears the squad name (confirm) | Y |
| Снять CMD (Demote) | `demote` | `server_id`, `steam_id` (leader) | Strips Commander (confirm) | Y |
| Сообщение скваду (Squad message) | `squadMessage` | `server_id`, `team`, `squad`, `time`, `msg` | Sends a repeating in-game message to the squad | Y |

#### 4.4 Messaging & broadcast — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Broadcast (chat input) | `broadcast` | `server_id`, `msg` | Server-wide broadcast (min 2 chars; confirm) | Y |
| Сообщение скваду | `squadMessage` | see 4.3 | Targeted squad message with repeat cadence | Y |

Repeat-cadence `<select>` options (shared by squad-message and player-message forms): `1` = 1 раз (once), `30` = 30s, `40` = 40s, `60` = 1 min (default), `90` = 1 min 30s, `120` = 2 min. The squad-message modal shows the author's SteamID + Steam profile link, and a `{player}` placeholder that expands to the creator's name from message templates.

#### 4.5 Map & rotation — `script: 'squad'` (rotation read/write via `mapRotation.mode`, which is `'squad'` when opened from the dashboard cog)

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Сменить (Change map) | `changeMap` | `server_id`, `next` (bool), `map` (URI-encoded layer string), `vote` (bool) | Changes current (or next) map | Y |
| Следующая (Set next) | `changeMap` | `server_id`, `next:true`, `map`, `vote` | Sets the next map only | Y |
| (Skip / next round) | `changeMap` | `server_id`, `next:'skip'`, `map:'skip'`, `skip:true`, `vote` | Ends current round / skips map | Y |
| Очистить следующую (Clear next) | `clearNext` | `server_id` | Clears the queued next map | Y |
| (Load map catalog) | `getServerMaps` | `server_id` | Returns `{ maps[], units[] }` for the picker | N |
| Ротация — read | `getRotation` | `server_id` | Returns `{ rotation, list, canEdit }` | N |
| Ротация — Изменить (Edit) | `setRotation` | `server_id`, `rotation` (URI-encoded), `day` | Overwrites the rotation for a given day | Y |
| Календарь (Calendar) | `mapCalendar` | `server_id`, `start`, `end` | Read-only played-maps calendar (`script: 'public'`) | N |

**Map picker (`mapSelect`).** The `getServerMaps` catalog feeds a filterable grid (multi-selects **Карта (Map name)**, **Режим (Type)**, **Команды (Teams/factions)**, each showing a live count; plus a free-text "Сменить по названию (change by name)" input). Selecting a map opens a **configurator**: per-team faction `<select>` + unit `<select>`, live **tickets**, and a preview of each side's **kits** (role SVGs) and **vehicles** (name, count, respawn time `respawn/60`, optional delay). It assembles the RCON layer string as `<Map> <T1faction>+<T1unit> <T2faction>+<T2unit>`.

**Map entity fields** (`getServerMaps.maps[]`): `map` (layer name), `type` (mode: RAAS/AAS/Invasion/…), `weather`, `markers`, `teams.t_1|t_2 = { tickets, default:{faction,unit,prefix,postfix}, factions[]:{ name, default, units[] } }`. **Unit entity** (`units[]`): `{ roles[], vehicles[]:{ name, count, respawn, delay } }`.

**Rotation entity** (`getRotation`): `rotation.lists[day]` (newline-delimited layer list; `//` comments ignored), `rotation.current` (active day), `rotation.isWin` (win-based rotation → hides day tabs), `canEdit`. Days keyed `default`, `1`–`7` (Mon–Sun), rendered as tabs (Стандартная / Пн–Вс).

#### 4.6 Monitoring & analytics — `script: 'squad'` (calendar via `public`)

| UI label | action | Params | Returns | Destructive |
|---|---|---|---|---|
| Подробнее (Details) | `serverMonitor` | `start`, `end`, `server_id` | Time-series: mem, network_send/receive, disk_read/write, tps, network_connections | N |
| Онлайн chart | `serverOnline` | `start`, `end`, `server_id` | `{ players[], admins[], queue[], days[], maps{} }` | N |
| Онлайн — Админы (Admins timeline) | `serverOnlineAdmins` | `day`, `server_id` | `{ events, resources }` (per-admin presence timeline) | N |
| Онлайн — Бустеры (Boosters timeline) | `serverOnlineBooster` | `day`, `server_id` | `{ events, resources }` | N |
| Подключения (Connections) | `network` | `server_id` | `{ network.ips{ip:{conn[],country,city}}, network.sockets[] }` | N |
| (Ban IP, in network modal) | `blockIP` | `ip` | Blocks an IP at the firewall level (confirm; button is `.hide`-gated) | Y |

#### 4.7 Raw RCON console — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Выполнить (Execute) | `rconRaw` | `server_id`, `command` (URI-encoded) | Runs any raw RCON command; response rendered in a read-only CodeMirror pane (auto-pretty-prints JSON) | Y (depends on command) |

The console ships a **built-in command dictionary with autocomplete** (typeahead over both names and Russian help text): `AdminKick`, `AdminKickById`, `AdminBan`, `AdminBanById`, `AdminBroadcast`, `AdminEndMatch`, `AdminChangeMap`, `AdminSetNextMap`, `AdminSetMaxNumPlayers`, `AdminSetServerPassword`, `AdminSlomo`, `AdminForceTeamChange`, `AdminForceTeamChangeById`, `AdminListDisconnectedPlayers`, `AdminDemoteCommander(ById)`, `AdminDisbandSquad`, `AdminRemovePlayerFromSquad(ById)`, `AdminWarn(ById)`, `AdminRestartMatch`, `AdminReloadServerConfig`, `ListPlayers`, `ListSquads`, `ShowServerInfo` — each with a usage example. This exposes the full Squad admin command surface even for actions without a dedicated button (e.g. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`).

#### 4.8 Config & mod management (opened from the Control panel) — `script: 'squad'`

| UI label | action | Params | Effect | Destructive |
|---|---|---|---|---|
| Редактор конфигов (Config editor) | `getConfigFiles` / `getConfigFile` | `server_id`, file | List / load config files | N |
| " → Сохранить (Save) | `saveConfigFile` | file, contents | Writes a config file | Y |
| " → Перезагрузить (Reload) | `reloadConfig` | `server_id` | Reloads server config in-game | Y |
| " → По-умолчанию (Default) | `getDefaultConfig` | file | Loads the default template | N |
| Менеджер модов (Mod manager) | `getMods` | `server_id` | Lists installed Workshop mods | N |
| " → Install | `installMod` | mod id | Installs a Workshop mod | Y |
| " → Delete | `deleteMod` | mod id | Removes a mod | Y |

The config editor also has (mostly `.hide`-gated) **backup create/delete** and **merge/rebuild** controls, and a **синхронизировать скролл (sync-scroll)** toggle for side-by-side diff editing.

---

### 5. Forms & Modals

| Modal / form | Key fields |
|---|---|
| **Смена карты (Map select)** | `#map-name`, `#map-type`, `#map-team` multiselects; `#changemap-custom` free-text; grid of thumbnails; configurator with per-team faction/unit selects, ticket counts, kit/vehicle preview, assembled layer string (readonly), **Сменить** button |
| **Ротация карт (Rotation)** | Day tabs (default/Пн–Вс), scrollable layer list with faction flag icons, **Изменить (Edit)** → textarea (readonly unless `canEdit`) |
| **Сообщение скваду (Squad message)** | Author SteamID/link, message `<textarea>`, repeat-cadence select (default 60s), template quick-inserts with `{player}` |
| **RCON консоль** | Command input with datalist + live search dropdown, **Выполнить**, CodeMirror read-only output (80vh) |
| **Подключения (Network)** | Tabs Подключения / Сокеты; per-IP cards (rank, IP, conn count, up/down speed, geo country+city, external lookup link, `.hide` ban button); a 15s auto-refresh toggle; **Карта (Map)** → Leaflet geo-map of connections |
| **Config editor** | XL modal, CodeMirror, file dropdown, save/cancel/reload/default/merge/backup |
| **Mod manager** | Workshop cards (title, description, mod id, updated date, update/delete buttons) |
| **Player ban form** (`#player_ban`, shared) | `#player_ban-reason` select (grouped reasons, e.g. `<strong>0.1.</strong> Другое`, `0.2. Cheater neutralized by DPAC`), a dynamically-added "Навсегда (Forever)" option, progressive ban-length radios (`data-action=kick\|ban`, `data-first/second/third/four` day tiers), `#player_ban-description` |
| **Player message form** (`#player_message`, shared) | 512-char textarea, "add to player card" toggle, cadence select |
| **Group change select** (shared, `changeGroup`) | `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (Camera), `5` Стажёр (Trainee) |
| **Map calendar** / **Server monitor** / **Online** | FullCalendar/Chart.js views over the monitoring actions above |

**Validation observed:** broadcast requires ≥2 chars; RCON exec requires non-empty trimmed command; nearly every destructive action is wrapped in a `$.question` confirm dialog (many with a typed "confirm word" via `daPrevent`).

---

### 6. Permission & Visibility Logic

- **`data-hide="offline"`** blocks (player board, map widget) are hidden whenever the server is not connected; replaced by the start block / update log.
- **`class="hide"`** gates several capabilities regardless of connection state: the **Техника (Vehicles)** tab, the **Ban IP** button in the network modal, and most config-editor **backup/merge/default** controls. These are latent features enabled per-role server-side.
- **`getRotation` returns `canEdit`** — when false the rotation textarea becomes readonly and the save/cancel buttons hide, i.e. rotation *view* is broader than rotation *edit*.
- **Group taxonomy** (from `changeGroup` options) reveals the role model: Администратор > Модератор > VIP > Камера (spectator/camera) > Стажёр (trainee).
- All gating is presentational; the authoritative permission check is server-side in each `/ajax/*.php` action (the client simply hides controls the current role shouldn't invoke).

---

### 7. Notable UX & Competitively Interesting Details

1. **Everything on one screen, 5s live.** Multi-server tabs with inline online/queue/admin badges + a global-online market-share figure. The whole board self-refreshes without page reloads.
2. **Rich per-player threat signals inline.** VAC-recent, >3 punishments, same-IP alt detection (`location.same` with a count badge), new-player (<30h), active admin-call/report/banned-IP flags — all as small icons directly on the live roster, with a documented legend panel. Strong anti-cheat/anti-alt affordance worth beating.
3. **Squad intelligence.** Per-squad avg/median playtime, creator crown, "created squad then left" indicator, lock state, CMD detection with auto-sorting to top.
4. **Map configurator, not just a picker.** Faction + unit selection with live tickets, kit icons, and vehicle respawn/delay preview, producing the exact RCON layer string — far beyond a plain map dropdown.
5. **Rotation as code, per weekday.** Editable newline-delimited rotation lists per day (default + Mon–Sun), with comment support and a win-based mode.
6. **Raw RCON console with a full command dictionary + typeahead** — power users get the entire Squad admin command set (incl. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`) even where no button exists; JSON responses are auto-pretty-printed in CodeMirror.
7. **DDoS awareness built in.** Live connection count with an auto-triggered "server under attack" banner (>300 conns), a per-IP connection breakdown with geolocation (country/city + speeds), a Leaflet world-map of connections, and a one-click firewall **blockIP**.
8. **Deep hardware telemetry** beside game state: CPU load, network, disk, frequency, temperature, TPS, and socket-count mini-charts, plus a full `serverMonitor` time-series drill-down.
9. **Admin & booster presence timelines** (FullCalendar) per server — accountability/coverage tracking.
10. **Operational polish:** scheduled/repeating squad & player messages with `{player}` templating, config editor with backups/merge, mod manager wired to Steam Workshop, deep-link sharing (`/?steam_id=`, `/?server_id=`, `/?start_seed=true`), clipboard helpers for teleport commands and pre-formatted cheater-report templates.

---

### 8. Gaps / Notes for Analysts

- **Seeding controls** (`seeding`, `seedingSet*`) referenced by the dashboard only via `seedHelper.open()` and an `isSeeding` pulse indicator; the seeding-helper modal itself and its actions live in the shared/global template (see `player_profile.html`), not in this fragment.
- **`createSquad`** is *not* present in `main.html` despite being in scope — no create-squad action is wired here (only disband/transfer/rename/demote/message on existing squads).
- The **Vehicles** tab and per-vehicle board are fully templated but `.hide`-gated and commented-out in the render path — appears to be an in-progress/disabled feature.
- The **Leaflet** map on this page is used for **network-connection geolocation**, not the game map (the game "map" widget is a static image + layer metadata). OSM tiles are loaded lazily on first open.
- Exact server-side role→capability matrix is not visible client-side; only the presentational gates (`hide`, `canEdit`, `block_start.code`) are observable.


---

## 02. In-game Chat & Broadcast

### 1. Purpose and nav location

- **Nav item / page id:** `chat` — loaded via `pageLoad('chat')` → `GET /ajax/page.php?page=chat`, fragment injected into `#content`.
- **Purpose:** A searchable, filterable archive of every in-game chat message (all chat scopes plus admin broadcasts) captured across all monitored servers. It is a **read/audit surface** for chat history, not a live composer. The panel's outbound messaging (broadcast, per-player message, per-squad message) is triggered elsewhere (the `main` dashboard and the shared player-detail modal), but is documented here because it is the counterpart to this feed and is in scope for this section.
- **Source file analyzed:** `frags/chat.html` (2890 lines; only the top ~180 lines are page-specific — the remainder is the shared player-detail modal). Cross-referenced against `custom.js` and `frags/main.html`.

The page layout is a fixed left filter sidebar (`col-md-3`, `position:fixed`) and a wide results table (`col-md-9`).

---

### 2. Entities & fields

#### 2.1 Chat message (`playerChat` — the page's own table)

Inferred from the table column config in the fragment's inline script:
```
buildTable({ table: 'playerChat',
  collum: ["steam_id","server","date","team","name","type","msg","play"], order: ["date"], numrows: 300 })
```
and from the `data-search` attributes on the filter inputs, which expose the underlying SQL alias/column names (the feed is a JOIN of a chat table `t1` and a player table `t2`).

| Field | Source / alias | Type | Meaning |
|---|---|---|---|
| `steam_id` | `t2` (player) | string (SteamID64) | Author's SteamID. Rendered in a `class="hide"` column; used as the row's click key to open the player modal. |
| `server` / `server_id` | `server_id` | int → label | Which game server the message came from (server icon column). Filterable multiselect. |
| `date` | `t1.date` | datetime | Timestamp of the message. Default sort column (descending). |
| `team` | — | flag | Player's team at time of message; rendered as a flag/faction icon (`fa-flag` header). |
| `name` / `player` | `t2.player` | string | Author's in-game nickname. |
| `type` | `type` | enum | Chat scope / channel (see enum below). Rendered as colored `<code>` via the `type` callback: `'<code style="color:'+data.color+'">'+data.name+'</code>`. |
| `msg` | `t1.msg` | string | Message body. `word-break:break-all`; profanity-flagged client-side (see §7). |
| `play` | — | derived | Not stored data — a UI-only text-to-speech ("speak") action cell (see §7). |

**`type` enum (chat scope)** — from the filter `<select id="chatPlayers-type">` options:

| Value | Label | Meaning |
|---|---|---|
| `ChatAll` | Всем (All) | Server-wide all-chat |
| `ChatTeam` | Команда (Team) | Team chat |
| `ChatSquad` | Сквад (Squad) | Squad chat |
| `ChatAdmin` | Админ чат (Admin chat) | Admin-only channel |
| `broadcast` | Broadcast | Admin broadcast messages (outbound, logged back into the same feed) |

Each type carries a server-provided display `color` (used by the render callback), so channels are color-coded in the table.

#### 2.2 Server (referenced entity)

From the server multiselect `<option>` list: each server has an `id` (values seen: 1, 6, 7, 9, 10, 11) and a `label` (e.g. `RAAS/AAS #1`, `INVASION #3`, `Custom для FW`). This is the same server roster used panel-wide.

#### 2.3 Outbound message payloads (broadcast / message / squadMessage)

These are not table entities but the request shapes of the three messaging actions (see §4).

- **Broadcast:** `{ server_id, msg }`.
- **Direct player message:** `{ steam_id, time, msg, log }` — `time` = repeat cadence in seconds, `log` = whether to also write the message into the player's card.
- **Squad message:** `{ server_id, team, squad, time, msg }` — targets a specific squad on a specific team.

---

### 3. The page's own table (`#chatPlayers`)

**Columns** (in render order):

| # | Header | Column key | Notes |
|---|---|---|---|
| 1 | `SteamID` (`class="hide"`) | `steam_id` | Hidden; also forced hidden via inline CSS `td:first-child{display:none}`. Row-click key. |
| 2 | server icon (`fa-server`) | `server` | 50px, centered. |
| 3 | `Дата` (Date) | `date` | 130px. Default sort (desc). |
| 4 | flag icon (`fa-flag`) | `team` | 50px, team/faction flag. |
| 5 | `Ник` (Nick) | `name` | 150px. |
| 6 | `Чат` (Chat) | `type` | 90px, colored channel badge. |
| 7 | `Сообщение` (Message) | `msg` | Flexible width, profanity-flagged. |
| 8 | (empty) | `play` | 30px, TTS button cell. |

**Data fetch:** `buildTable` issues `POST /ajax/table.php` with `action=playerChat` and body `table=playerChat&page=<n>&numrows=300&search=<encoded filters>&order_by=date&order_sort=<asc/desc>` (server-side DataTables-style paging). Page size is **300 rows**.

**Filters / search controls** (left sidebar; each maps to a `data-search` alias that becomes part of `search`):

| Control | id | `data-search` | Type | Behavior |
|---|---|---|---|---|
| Search button | `chatPlayers-btn` | — | button (`fa-search`, "Поиск") | Triggers table (re)build. |
| Nick / SteamID | `chatPlayers-name` | `t2.player` | text | Free-text on player name or SteamID. |
| Message | `chatPlayers-msg` | `t1.msg` | text, `maxlength="17"` | Substring search within message body. |
| Server | `chatPlayers-server` | `server_id` | multiselect (`- Сервер -`) | Filter by one or more servers. |
| Chat type | `chatPlayers-type` | `type` | multiselect (`- Чат -`) | Filter by channel(s). |
| Date range | `chatPlayers-date` | `t1.date` | daterange (default `allTime`) | Time window. |
| Только Мат (Profanity only) | `chatPlayers-obscene` | `obscene` | checkbox slider, value `obscene` | Restrict to messages flagged as profane; `change` rebuilds the table. |

**Sorting:** column-header driven (`order_by`/`order_sort`), default `date desc`. **Pagination:** page-based via `buildTable` `page`/`numrows`.

**Row interaction:** clicking a row reads the hidden `steam_id` cell and, if length > 15 (valid SteamID64), calls `player.open(steam_id)` to open the shared player-detail modal. Clicks on the `play` cell are intercepted (`stopPropagation`) so TTS does not also open the modal.

---

### 4. Actions / capabilities

Two categories: (a) the chat page's own read action, and (b) the messaging actions in scope. All state-changing calls go through the `Action({script, action, data})` helper → `POST /ajax/<script>.php` with body `action=<action>&<data>`. `Action` treats a `{...}` `data` object by appending `&key=value` pairs and adding `action`. Success is gated on JSON `{status:'ok'}`; `auth:true` forces a page reload.

| UI label | action id | script → endpoint | Data params | Effect | Destructive (state-changing)? |
|---|---|---|---|---|---|
| (table load) Поиск | `playerChat` | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` | Fetch/filter chat rows | N (read) |
| Broadcast (paper-plane on `main`) | `broadcast` | `squad` → `/ajax/squad.php` | `server_id, msg` | Sends `AdminBroadcast` — a system message to **all** players on the server; echoed back into this feed as `type=broadcast` | **Y** |
| Сообщение (Message, player modal) | `message` | `player` → `/ajax/player.php` | `steam_id, time, msg, log` | Sends an in-game direct/admin warning message to one player, repeated for `time` seconds; optionally logs it to the player card | **Y** |
| Squad message (envelope on `main`) | `squadMessage` | `squad` → `/ajax/squad.php` | `server_id, team, squad, time, msg` | Sends a message to every member of a specific squad, repeated for `time` seconds | **Y** |
| (speak) | — | none (client `SpeechSynthesis`) | — | Text-to-speech read-aloud of a message cell | N (client only) |

> Note: the chat fragment also embeds the full shared player-detail modal, whose ~22 actions (`ban`, `kick`, `kill`, `kits`, `mark`, `twink`, `addComment`, `getComments`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `removePlayer`, `unban`, `addBanName`/`removeBanName`, `downloadStat`, `transfer`, `vipPlayer`, …) appear here but belong to the modal, not to the chat page. They are documented in the player-detail section. Only `message` (direct player message) is chat-relevant among them.

---

### 5. Forms & modals

#### 5.1 Direct-message composer (`#player_message`, shared modal, `class="hide"`)

Opened via `player.message.open()` ("Сообщение" button) from the player card; posts through `player.message.send()`.

| Element | id | Type | Notes / validation |
|---|---|---|---|
| Canned-message list | — | `list-group` of `<a onclick="player.message.set(...)">` | ~18 preset moderation phrases (VIP grant, vehicle-claim rules, TK apology, unreadable-nick warning, etc.). Clicking one fills the textarea. Supports `{player}` token substitution (used by squad variant). |
| Add to player card | `player_message-log` | checkbox | "Добавить запись в карточку игрока" — sets `log=true` so the message is recorded on the player's profile. |
| Message body | `player_message-msg` | textarea, `rows=3`, `maxlength="512"` | The text sent. |
| Repeat cadence | `player_message-time` | select | Options: `1`=1 раз (once), `30`s, `40`s, `60`s (default, "1 минута"), `90`s, `120`s — how long the on-screen message repeats. |
| Send | `player_message-send` | button | `player.message.send()` → `message` action. |

**Client validation:** broadcast composer on `main` (`#server_chat-msg`) refuses to send when `msg.length < 2`; broadcast additionally requires a confirm dialog (`$.question`, "Отправить сообщение как Broadcast??"). The player-message send has no explicit min-length guard beyond the textarea `maxlength`.

#### 5.2 Squad-message composer (`#serverSquadMessage`, on `main`)

Opened by `messageSquad.open(this)` from a squad's envelope button. Fields: `#serverSquadMessage` (textarea, `{player}`-templated with the squad leader's name), `#serverSquadMessage-time` (same cadence select). Submits `squadMessage` with `team`, `squad`, `time`, `msg`.

#### 5.3 Broadcast composer (on `main`)

A single inline input `#server_chat-msg` (placeholder "Broadcast") with a paper-plane icon (`sendSeverBroadcast()`). Confirmation dialog required before send; input cleared on submit.

---

### 6. Permission / visibility logic

- The chat table's `SteamID` column is doubly hidden (`class="hide"` + inline CSS), used only as an internal key — not a permission gate.
- All modal action buttons embedded in the fragment default to `style="display:none;"` (e.g. "Сообщение", "Команда", "Наказать/Разбанить", kick/kill/ban-name/kits list items). They are unhidden by the client based on the player context and the operator's role/group returned when `player.open()` loads the card — i.e. capability visibility is **server-driven per operator**, not baked into the fragment. The chat page itself exposes no role gating beyond this.
- `Action` responses carrying `auth:true` trigger `location.reload()`, the standard session/permission-expiry path.
- There is no visible per-server permission split on the chat page; the server multiselect lists every server the operator can see.

---

### 7. Notable UX & competitively interesting details

- **Unified profanity detection.** A large client-side Russian-profanity regex (`isObscene()`) flags messages: any offending `msg` cell is prefixed with a red warning triangle `<code style="color:#CD5C5C"><i class="fa fa-exclamation-triangle"></i></code>`, and the "Только Мат" toggle filters the whole feed to flagged messages (server-side `obscene` search). Worth beating with a configurable, server-side, multi-language profanity model rather than a single hardcoded regex.
- **Text-to-speech read-aloud.** Each row's `play` cell uses the browser `SpeechSynthesisUtterance` API to speak a message aloud (`speak(td)`, picks `voices[1]`). Niche but a low-cost accessibility / passive-monitoring feature.
- **Color-coded channels.** Chat scope is rendered as a server-colored badge, making all/team/squad/admin/broadcast instantly distinguishable in a dense feed.
- **Repeating on-screen messages.** Both direct and squad messages support a repeat cadence (1×, 30–120s). Combined with `{player}` templating and ~18 canned moderation phrases, this makes routine enforcement (vehicle-claim rules, nick warnings, TK apologies) a two-click operation — a strong workflow to match.
- **Message-to-card logging.** A single checkbox turns an in-game warning into a permanent record on the player's profile, tying live moderation to the audit trail.
- **Cross-scope archive.** Broadcasts are logged back into the same searchable feed as player chat, so the operator sees their own outbound announcements interleaved with player messages — good for accountability.
- **Fixed sidebar + 300-row pages** keep filters permanently visible while scanning large volumes; the `msg` search input is oddly capped at `maxlength=17`, a limitation worth exceeding.

---

### 8. Gaps / unverified

- The exact SQL schema behind `t1` (chat) / `t2` (player) is inferred from `data-search` aliases, not seen directly.
- The `team` column's rendering (flag/faction mapping) and the `color` value per chat type come from server-side table data not present in the fragment.
- `broadcast` and `squadMessage` live on the `main` dashboard and the player modal (script `squad`/`player`); their handlers were read from `frags/main.html`, not from `chat.html`. The chat page is read-only for these.


---

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


---

## 04. Player Profile & Per-player Data Storage

### 1. Purpose & Nav Location

**Route:** `/player/<steamid>` (e.g. `/player/76561199478348885`), optionally `?season=<all|old|1|2>`.

Reached from the top-right user dropdown: **Профиль (Profile)** → `/player/<steamid>`. This is a **full HTML document** (it ships its own `<nav>`, not a `#content` fragment), meaning the profile is a hard navigation / bookmarkable page rather than an `pageLoad()` AJAX fragment.

**Critical framing:** the captured `player_profile.html` is the **self-service public player profile / stat dashboard** for the *logged-in* player viewing their own SteamID (`[BSS] seregatipich`). It is the **read-facing statistics surface**, plus three account-owner tools bolted onto the same page (settings, clan creation, seeding helper). It is **NOT** the admin "per-player rap sheet." The heavy moderation/forensic per-player data (bans, mutes, chat, comments, suspect marks, IP history, twins/alts, votes, reports, kills/deaths logs) is **not rendered here** — it lives in:

- the **shared player-detail modal** embedded on every page (Chat/Kills/Deaths/Kits/Games/Comments tabs, ~22 actions), and
- the dedicated admin DataTables pages, all of which use `script: 'player'`: `bans.html`, `bannames.html`, `collabans.html`, `chat.html`, `comments.html`, `mark.html`, `damages.html`, `deaths.html`, `kills.html`, `revives.html`, `teamkills.html`, `reports.html`, `votes.html`, `logs.html`, `vips.html`, `admins.html`, `top.html`.

So this section documents (a) the **denormalized per-player statistics model** exposed here and (b) the **owner-account actions** on this page. It cross-references where the forensic data lives without misattributing it to this page.

Only **two script endpoints** are invoked from this page: `player` and `squad`. Only **two actions touch `player`**: `saveUserSettings`. Everything else (`createSquad`, `seeding*`) is `squad`.

---

### 2. Entities & Fields (the per-player statistics model)

The page denormalizes a large per-player, **per-season** stat aggregate. Seasons partition all stats by time window (see §3). Every number below is scoped to the selected season.

#### 2.1 Player identity / account header

| Field | UI label | Meaning / type |
|---|---|---|
| SteamID64 | (URL + dropdown) | 17-digit Steam ID, the profile primary key (`/player/76561199478348885`). |
| Display name | `[BSS] seregatipich` (H1) | Current in-game name incl. clan tag prefix. `data-text` mirrors it for a glitch/hover effect. |
| Bonus balance | Ваши бонусы (Your bonuses) | Integer loyalty/currency balance (e.g. `24307`). Spendable in-panel economy. |
| VIP status | VIP | Either "нет" or "до DD.MM.YYYY" (VIP until date). Green check when active. |
| Subscriptions | Подписки (Subscriptions) | Active recurring subscriptions, or "нет активных" (none active). Distinct from one-off VIP. |
| Rank | Ранг ??? | Present but **`class="hide"`** — a rank/progress-bar feature is built but disabled/hidden in this deployment. |
| Role image | (background) | `/assets/img/roles/RGF/SL.png` — faction (RGF) + main kit (SL) drive a hero image. |

#### 2.2 Skill / lifetime aggregate (per season)

Rendered in the "Скилл (Skill)" block. This is the core scoreboard row.

| Field | UI label | Type | Example |
|---|---|---|---|
| K/D ratio | К/Д | float | `0.51` |
| Win rate | Винрейт | percent | `49.6%` |
| Matches | МАТЧЕЙ | int | `281` |
| Wins | ПОБЕД | int | `131` |
| Losses | ПРОИГРЫШЕЙ | int | `133` |
| Kills | УБИЙСТВА | int | `332` |
| Deaths | СМЕРТИ | int | `647` |
| Damage | УРОН | int | `77,659` |
| Revives | ПОДНЯТИЯ (pick-ups/revives) | int | `108` |
| Teamkills | ТИМКИЛЛЫ | int | `75` |
| Online time | ОНЛАЙН | duration `Nч Nм` | `284ч 4м` (≈ playtime) |

Note wins+losses (131+133=264) < matches (281): draws/incomplete rounds are tracked separately. Charts derived from this entity: `player_kd_chart` (K/D donut), `player_kd_year` (K/D trend over the season), `player_aim` (damage/accuracy line).

#### 2.3 Kit usage (per player, per season)

"Киты (Kits)" table — playtime accumulated per role/kit.

| Column | Meaning |
|---|---|
| Kit | Role icon (`/assets/img/ico/kits/<Kit>.svg`) + name: `SL`, `SLPilot`, `Rifleman`, `SLCrewman`, `Medic`, `Sniper`, `Sapper`. |
| Playtime | Time in that kit, `Nч Nм` (e.g. SL `78ч 27м`). |

Implies a stored `player_kit_time[steamid, season, kit] = seconds`.

#### 2.4 Weapon stats (per player, per weapon, per season)

"Оружие (Weapon)" cards — one card per weapon, sorted by kills desc.

| Field | Icon | Meaning |
|---|---|---|
| Weapon name | — | `АК-74`, `2Б14`, `Colt Canada C7`, `СВД`, `M4A1`, `РПГ-28`, `M67`, ... |
| Kills | crosshairs | Kills with that weapon (e.g. AK-74 → 29). |
| Damage | explosion | Total damage with that weapon (e.g. AK-74 → 6,720). |

Implies `player_weapon_stat[steamid, season, weapon] = {kills, damage}`.

#### 2.5 Vehicle stats — driven/crewed ("Техника")

Vehicles the player **operated** and scored from.

| Column | Label | Meaning |
|---|---|---|
| # | — | Rank index (1..N). |
| Vehicle | Техника | Vehicle name (`Тигр`, `AAV-7`, `БМП-1`, `LAV-25`). |
| Kills | Убийств | Kills scored while in that vehicle. |
| Damage | Урон | Damage dealt from that vehicle. |

#### 2.6 Vehicle destruction — kills-against ("Уничтожение техники")

Enemy vehicles the player **destroyed**, keyed by the weapon used.

| Column | Label | Meaning |
|---|---|---|
| # | — | Rank index. |
| Weapon | Оружие | Weapon/projectile used (`2A46M`, `M1126`, `AK74M`, `RPG28`, `S8`, ...). |
| Vehicle | Техника | Internal asset name of the destroyed vehicle (`T72A_IMF`, `Kraz_6322`, `MI8_AFU`, `Armored_Technical4Seater`, ...). |
| Count | Количество | Number destroyed. |

Note: this table uses **raw internal asset IDs** (not the localized names used in §2.5), suggesting it is pulled straight from raw kill-log rows.

#### 2.7 Recent matches ("Матчи")

| Column | Label | Meaning |
|---|---|---|
| # | — | Row index. |
| Map | Карта | Layer name (`Gorodok RAAS v1`) + external link icon → `/game/<gameId>` (per-match detail page, e.g. `/game/33290`). |
| Teams | Стороны | Two faction icons (`AFU` vs `RGF`, etc.) for the two sides. |
| Win | Победа | `label-success` "Да" (Yes) or `label-danger` "Нет" (No) — whether the player's side won. |

The `/game/<id>` link ties each stat row back to a full match record (separate page).

#### 2.8 Season dimension

| value | Label | Window |
|---|---|---|
| `all` | Все сезоны (All seasons) | everything |
| `old` | Сезон 0 — до ICO | 01.01.2016 – 27.09.2023 |
| `1` | Сезон 1 — Squad 6.0 ICO on UE4 | 27.09.2023 – 03.09.2025 |
| `2` (default/selected) | Сезон 2 — Squad 9.0 UE5 | 03.09.2025 – present |

**Retention:** stats reach back to **2016** — i.e. multi-year, effectively permanent per-player history, sliced by game-version seasons. Very long retention is a core competitive feature.

#### 2.9 Owner account-settings entity (`saveUserSettings`)

Stored as a JSON blob keyed by setting name (see §5.2): `{ lang, theme, show_country }`.

#### 2.10 Clan / squad-priority entity (`createSquad`)

See §5.1 — the create/edit-clan form defines the clan record: `id, name, expire, max, discord_id, tags[]`.

---

### 3. The Page's Own Controls (filters / sort / pagination)

This is a **static rendered stat page, not a DataTable** — there is no server-side search/sort/pagination on this page. The only first-class control is:

- **Season multiselect** (`#stat-season`, styled as a banner button). `onChange` performs a **hard navigation**: `window.location.href = '/player/<steamid>?season=' + value`. So season filtering is a full page reload with a query param, not an AJAX refresh.

All inner tables (kits, weapons, vehicles, matches) are pre-rendered top-N slabs (weapons ~top 10, matches recent list) with no client sort controls.

---

### 4. Actions / Capabilities Available Here

Only three functional areas issue mutations; none of them are moderation actions. This page grants the **account owner** self-service powers, not admin powers over other players.

| # | UI label | action id | script → endpoint | data params | Effect | State-changing? |
|---|---|---|---|---|---|---|
| 1 | Настройки → Сохранить (Save settings) | `saveUserSettings` | `player` → `/ajax/player.php` | `data` = JSON string `{lang, theme, show_country}` | Persists the viewer's UI preferences, then reloads the page. | **Y** |
| 2 | Создание клана → Сохранить (Create/save clan) | `createSquad` | `squad` → `/ajax/squad.php` | `id, name, expire (unix), max, discord_id, tags (URL-encoded CSV)` | Creates (empty `id`) or edits (present `id`) a clan/priority group; on success redirects to `pageLoad('clan&id='+id)`. | **Y** |
| 3 | Помощник сидинга → Запустить/Остановить (Seed helper start/stop) | `seeding` | `squad` → `/ajax/squad.php` | `start (bool), isMobile, tab_id` | Registers the browser as a live seeding client; server returns server list + a join `link` the browser auto-opens; polls every 10s. | **Y** (registers seeding intent server-side) |
| 4 | (seed helper) server dropdown onChange | `seedingSetServer` | `squad` → `/ajax/squad.php` | `server_id` | Sets which server this player should seed. | **Y** |
| 5 | (seed calendar) render | `seedingGetCalendar` | `squad` → `/ajax/squad.php` | `start (unix), end (unix)` | Reads scheduled seeding events for the calendar; also returns `canServerAction` (permission gate). | N (read) |
| 6 | (seed rotation editor) open | `seedingGetPriority` | `squad` → `/ajax/squad.php` | `start (unix day)` | Reads the server priority list for a day (`server_list[]` with `id, short, name, priority`, plus `day.min_players`, `day.use_unattached`). | N (read) |
| 7 | (seed rotation editor) Сохранить (Save rotation) | `seedingSetPriority` | `squad` → `/ajax/squad.php` | `start (unix day), data (ordered server-id CSV), min_players, use_unattached (bool)` | Persists the drag-sorted server priority/rotation for that day. | **Y** |

**Read helper (page load):** `seeding` also acts as the periodic read (returns `servers[]` each with `id, short, name, players, link, need_seed, you, mods`, plus `needSeed{server_id, go}` and `serverPriority`).

> The ~22 shared-modal moderation actions (`ban, kick, kill, kits, mark, message, twink, addComment, getComments, changeExpire, transfer, vipPlayer, unban, addBanName, removeBanName, changeGroup, changeTeam, findFriends, checkBans, removePlayer, downloadStat, ...`) do **not** appear on this profile page. They are documented with the shared player-detail modal / players listing pages.

---

### 5. Forms & Modals

#### 5.1 Create/Edit Clan modal (`#createClan_modal`, action `createSquad`)

| Field | id | Type / constraints |
|---|---|---|
| Название клана (Clan name) | `createClan_name` | text, `maxlength=32` |
| Окончание приоритета (Priority end) | `createClan_expire` | date-range button (`justDay`..`infinity`); sends `.data('start')` unix. |
| Приоритетов (Priority slots) | `createClan_max` | text, `maxlength=3`, placeholder `10` (max simultaneous priority members). |
| Discord ID роль (Discord role ID) | `createClan_discord_id` | text, `maxlength=64` (links clan to a Discord role). |
| Теги (Tags) | `createClan_tags` | chip list built via a secondary modal `#createClanTags_modal` (`createClanTag_name`); "очистить" (clear) button; serialized as URL-encoded CSV of chip innerHTML. |
| Hidden id | `createClan_id` | `class="hide"` hidden input — empty = create, populated (via `createClan.edit(clan)`) = edit. |

Validation is minimal/client-light (tags only added if non-empty length); server enforces the rest.

#### 5.2 User Settings modal (`#userSettings_modal`, action `saveUserSettings`)

Generic pattern: every `[data-setting]` control is harvested into `data[setting]=value` and sent as one JSON blob. On save the page reloads.

| Setting | id / `data-setting` | Options | Default |
|---|---|---|---|
| Язык (Language) | `userSettings-lang` / `lang` | `ru` (Русский), `en` (English) | `ru` |
| Тема (Theme) | `userSettings-theme` / `theme` | `0` (Светлая/Light), `dark` (Тёмная/Dark) | (empty) |
| Флаги на главной (Country flags on main) | `userSettings-show_country` / `show_country` | `hide`, `show` | `hide` |

#### 5.3 Seeding Helper modals

- **`#seedHelper_modal`** — live seeding driver. Templates `#seedHelper_template` (per-server card: short, name, `players`/100, invite link yes/no, mods flag, `need_seed` yes/no, "you" marker) and `#seedHelper_template_admins`. Start/Stop buttons toggle `seeding` action. Auto-opens a `joinlink` to launch the game (FAQ warns the browser must be allowed to open external protocol links).
- **`#seedHelperCalendar_modal`** — FullCalendar of scheduled seeding (`seedingGetCalendar`).
- **`#seedHelperPriority_modal`** — day rotation editor: two jQuery-UI `sortable` lists **Приоритет (Attached/priority)** vs **Неприкреплённые (Unattached)** (drag between them; priority `<999` = attached), plus `min_players` (placeholder 70) and `use_unattached` toggle. Saves via `seedingSetPriority`.
- **`#seedHelperFaq_modal`** — help text.

---

### 6. Permission / Visibility Logic

- The whole owner-toolset (settings save, clan creation, seeding priority editing) is only meaningful for the **authenticated owner** of the profile; the header dropdown (Профиль / Настройки / Выйти) is the account menu.
- **`class="hide"` gated elements:** the **Rank** block + progress bar (`Ранг ???`) — a built-but-disabled feature; the hidden clan `id` field (create-vs-edit toggle); a hidden `admin_server` multiselect in the seed helper (`col-md-6 hide`) revealed programmatically; a hidden `seedHelper_link`.
- **Server-driven permission flag:** `seedingGetCalendar` returns **`canServerAction`**, cached in `seedHelper.calendar.canServerAction` — the server decides whether this user may edit seeding rotation (i.e. rotation editing is a privileged capability gated server-side, not just UI-hidden).
- `serverPriority` from the `seeding` response marks the user's currently chosen seeding server in the dropdown.

---

### 7. Notable UX & Competitively Interesting Details

- **Season model reaching back to 2016**, cut on game-version boundaries (UE4 ICO / UE5), with an "all seasons" rollup. Long-horizon per-player history is a headline feature — worth matching or beating.
- **Rich denormalized stat surface** on one page: K/D donut, K/D-over-time trend, damage/accuracy chart, per-kit playtime, per-weapon kills+damage, vehicles driven vs vehicles destroyed (keyed by weapon), and recent matches each deep-linking to `/game/<id>`. Everything cross-links (match → game page, kit → role art).
- **Integrated economy on the profile**: bonus balance, VIP-until date, and subscriptions surfaced at the top — the profile doubles as a store/loyalty dashboard, not just stats.
- **Seeding Helper (Beta)** is a standout: a browser-resident agent that polls server population every 10s and auto-launches the game via a join link to the highest-priority server needing seeding, with an admin-editable per-day rotation calendar and a `min_players` threshold. This turns the panel into an active community-ops tool, not a passive dashboard.
- **Clan/priority groups** carry a `discord_id` role mapping and a priority-slot cap with an expiry date — clan management is wired to Discord and to in-game reserved-slot priority.
- **Vehicle-destruction table leaks raw asset IDs** (`T72A_IMF`, `MI8_AFU`) — a small polish gap (unlocalized) but confirms the data comes straight from parsed kill logs; a competitor could localize these for a cleaner UX.
- Hard-navigation profile (own `<nav>`, `?season=` query param) rather than an AJAX fragment — makes profiles shareable/bookmarkable/SEO-able.

---

### 8. Gaps / Cross-references

- The **forensic per-player rap sheet** (bans/mutes history, chat log, comments/notes, suspect marks, IP history, twins/alts/friends, votes, reports, per-round kills/deaths/revives/teamkills detail) is **not on this page** — it is the shared player-detail modal + the `script:'player'` DataTables pages (`bans/chat/comments/mark/damages/deaths/kills/revives/teamkills/reports/votes/logs/collabans/bannames`). Document those in their own sections for the full storage model.
- Exact `saveUserSettings`/`createSquad`/`seeding*` server-side schemas (column types, ownership checks) are not observable from the client; inferred from payloads only.


---

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


---

## 06. VIP / Privileges (Привилегии)

### 1. Purpose & Navigation

- **Nav id / loader:** `vips` — the nav item calls `pageLoad('vips')` → `GET /ajax/page.php?page=vips`, and the returned HTML fragment is injected into `#content`.
- **Purpose:** A read-and-drill roster of all players who currently hold a **group/privilege** (VIP, Admin, Moderator, Camera, Trainee, …). It is effectively a filtered view of the player base joined against the "group assignment" table, showing who has a privilege, when it expires, when they last connected, and the admin's note.
- **Important architectural note:** The `vips` page itself is *read-only browsing + search*. It has **no add/edit/delete controls of its own**. All privilege mutation is performed through the **shared player-detail modal** ("Смена группы" / Change group sub-panel) that every fragment embeds. Clicking any row opens that modal for the selected player. So the "VIP management" capability physically lives in the shared modal, but is reached from this page.

---

### 2. Entities & Data Model

The page exposes two entities: the **VIP/privilege roster row** (the page's own table) and the **group assignment** record (edited via the shared modal). Fields are inferred from the `buildTable` `collum` array, the search `data-search` attributes, the `changeGroup` payload, and the group `<select>`/`dateRange` options.

#### Entity A — VIP roster row (`vipPlayers` table)

`buildTable({ table:'vipPlayers', collum:["steam_id","name","expire","date","time","vipdesc"] })`

| Field (collum key) | Column header | Meaning / Type | Notes |
|---|---|---|---|
| `steam_id` | SteamID | Player Steam64 id | Rendered inside a `<hashtag>` element; used as the drill key (`player.open(...)`). |
| `name` | Ник (Nick) | Current/last known player name | String. |
| `expire` | Срок (Term) | Privilege expiry timestamp | Unix seconds. `expire == '0'` ⇒ **permanent** ("infinity"). Drives the roster's core sort/meaning. |
| `date` | Заходил (Last seen) | Last-login timestamp | Unix seconds; the "Заходил c / до" filters range over this. |
| `time` | (clock icon `fa-clock-o`) | Time metric per row | A right-aligned narrow (80px) column keyed on a clock icon — represents accumulated online time / duration; not separately labelled in UI. |
| `vipdesc` | Описание (Description) | Admin note attached to the privilege | Free text; searchable via `t1.description`. |

The search `data-search` hints leak the server-side schema: `t1.description` (the privilege/assignment table, alias `t1`) and `t2.player` (the player table, alias `t2`), i.e. the roster is a JOIN of a **group-assignment table (t1)** and a **player table (t2)**.

#### Entity B — Group / privilege assignment (edited via `changeGroup`)

Payload of `player.group.set` → `Action({script:'player', action:'changeGroup', data:{...}})`:

| Field | Source control | Meaning / Type |
|---|---|---|
| `steam_id` | `player.info.steam_id` | Target player. |
| `group_id` | `#player_group-groups` (`<select>`) | The privilege/role granted (see group list below). `0` = remove group. |
| `date` | `#player_group-expire` dateRange (`.data('start')`) | Expiry start/term. `0` / infinity ⇒ permanent. |
| `description` | `#player_group-description` (`<textarea>`, maxlength 128) | Admin comment shown as `vipdesc` in the roster. |
| `prefix` | `#player_group-prefix` (maxlength 64) | In-game chat/name prefix/tag granted with the privilege. |
| `prefix_rgb` | `#player_group-prefix_rgb` (+ color picker, maxlength 16) | RGB color of the prefix, stored as `"r,g,b"`; a `<input type=color>` and hex↔rgb converters (`stringRgbToHex`,`hexToRgb`) keep the two synced. |
| `image` | `#player_group-image` (maxlength 256) | URL to an image/badge associated with the privilege. |

Group catalog (from the `<select id="player_group-groups">` options — this is the full privilege taxonomy):

| group_id | Label | Icon |
|---|---|---|
| `0` | -Нет группы- (No group) | — |
| `1` | Администратор (Administrator) | user-circle |
| `2` | Модератор (Moderator) | id-badge |
| `3` | **VIP** | star |
| `4` | Камера (Camera / spectator) | video-camera |
| `5` | Стажёр (Trainee) | graduation-cap |

So "VIP" is one value (`group_id=3`) inside a general **group/role system** — the same mechanism grants staff roles and VIP alike, differentiated only by `group_id`.

---

### 3. The Page's Own Table (`#vipPlayers`)

- **Columns:** SteamID · Ник · Срок (expiry) · Заходил (last seen) · clock-icon (time) · Описание. (See Entity A.)
- **Pagination / page size:** server-side via `POST /ajax/table.php` (script `table`, action = table name `vipPlayers`); `numrows: 50` rows/page. Page counts fetched with a separate `&pagination=true` call.
- **Search/filter controls** (left fixed sidebar, `#vipPlayers-*`, applied by the "Поиск" button `#vipPlayers-btn`):

| Control | id | `data-search` target | Meaning |
|---|---|---|---|
| Ник или SteamID (Nick or SteamID) | `vipPlayers-name` | `t2.player` | Text match on player name/id. |
| Заходил c (Last-seen from) | `vipPlayers-startdate` | `startdate` | Datetime picker (ru locale), range start on last-login. |
| Заходил до (Last-seen to) | `vipPlayers-enddate` | `enddate` | Datetime picker, range end; each has an inline clear (✕). |
| Описание (Description) | `vipPlayers-desc` | `t1.description` | Text match on the admin note. |

- **Row interaction:** `$('#vipPlayers tbody > tr').on('click', ...)` → `player.open(<steam_id from hashtag>)` opens the shared player-detail modal. There is **no sort UI, no per-row action buttons, no bulk-select** on this page — it is a browse/search surface only.

---

### 4. Actions / Permissions available from this page

The only *page-native* interaction is search + drill-in. Every state change is delegated to the shared player modal reached via row click. Actions relevant to VIP/privileges:

| UI label | action id | script → endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| (row click) | — | — | — | `player.open(steam_id)` — loads player card + `get` data. | N |
| Сменить группу (Change group) | `changeGroup` | `player` → `POST /ajax/player.php` | `steam_id, group_id, date, description, prefix, prefix_rgb, image` | Grants / changes / (with `group_id=0`) removes a privilege; sets expiry, note, prefix, color, image. This is the **VIP add + edit + remove** operation. | **Y** |
| VIP +1 месяц (VIP +1 month) | `changeGroup` | `player` → `POST /ajax/player.php` | same payload (quick-grant, expire preset to +1 month, group=VIP) | Convenience one-click VIP grant. Button carries class `hide` — rendered but hidden by default (shown only in certain contexts/roles). | **Y** |

Additional shared-modal actions embedded in this fragment (per the action catalog for `vips.html`) but **not part of the VIP workflow** — they belong to the universal player modal and are documented in the Players section: `ban`, `unban`, `kick`, `kill`, `kits`, `kitSave`, `mark`, `message`, `twink`, `twinkOnline`, `addComment`, `getComments`, `changeTeam`, `checkBans`, `findFriends`, `getPlayerOnlineData`, `removePlayer`, `addBanName`, `removeBanName`, `get`, `downloadStat` (scripts `player` and `squad`).

Note: On the **clan** page the same star-checkbox uses a *different* action — `Action({script:'clan', action:'vipPlayer', data:{clan_id, steam_id, vip:true|false}})` — which toggles a clan-scoped reserved/VIP flag per member. The `vips` roster page itself does **not** use `vipPlayer`; it uses `changeGroup`. This is a meaningful distinction: **global privilege = `changeGroup` (group_id=3)**, **clan reserved-slot = `vipPlayer` boolean**.

---

### 5. Forms & Modals

**"Смена группы" (Change group) panel** — `#player_group` (flip side of the player card; opened via `player.group.open()` from the card's "Группа" button `#player_info-group_btn`):

| Field | Control | Options / Validation |
|---|---|---|
| Group | `#player_group-groups` bootstrap-multiselect | The 5-role catalog + "No group"; pre-selected to the player's current `group_id`; `enableHTML` for icon labels. |
| Expire | `#player_group-expire` custom `dateRange` widget | Presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. Default = **infinity** if player already has a permanent group (`expire=='0'`), else a single-day range from current expiry/now. `infinity` ⇒ stored as `0` = permanent. |
| Комментарий (Comment) | `#player_group-description` textarea | maxlength **128**. |
| Префикс (Prefix) | `#player_group-prefix` text | maxlength **64**. |
| Цвет префикса RGB | `#player_group-prefix_rgb` + `type=color` swatch | maxlength 16; auto-synced hex↔`r,g,b`. |
| Ссылка на изображение (Image URL) | `#player_group-image` text | maxlength **256**. |
| Submit | "Сменить группу" / "VIP +1 месяц" | Both call `player.group.set(this)`; a confirm dialog (`$.question`, "Сменить группу?") shows the target group label before firing. |

**Self-protection:** if `player.info.is_you` (admin editing their own card), the group multiselect and the expire control are **disabled** — an admin cannot change their own group/expiry through the UI.

---

### 6. Permission / Visibility Logic

- **`class="hide"` gating:** `#player_group` and `#player_info` panels ship hidden and are cloned into the flip modal on demand. The **"VIP +1 месяц"** quick-grant button carries `hide` by default while **"Сменить группу"** is always visible — implying the one-click VIP button is surfaced only in specific contexts (e.g., a role/permission or a page where quick VIP granting is enabled).
- **Self-edit block:** `is_you` disables the group + expire controls (see above).
- **No client-side role fences beyond that** are visible in the fragment; server-side `player.php` presumably authorizes `changeGroup`. The page trusts the server to enforce who may grant Admin vs VIP (the client offers the full group list to anyone who can open the modal).
- The roster query itself is scoped server-side (aliases `t1`/`t2`); no per-server selector is present *on this page* — privilege scope (global vs per-server) is not exposed in the `vips` fragment, whereas the clan `vipPlayer` flag is explicitly clan-scoped (`clan_id`).

---

### 7. Notable UX & Competitively Interesting Details

- **Unified group system:** VIP, Admin, Moderator, Camera, Trainee are one `group_id` field, not separate subsystems. One modal + one `changeGroup` endpoint covers grant/edit/revoke for every role. Simple to clone; note the single-endpoint design.
- **Rich privilege metadata:** a privilege isn't just a boolean — it carries **expiry, admin note, chat prefix, prefix RGB color, and an image/badge URL**. The color picker with live hex↔rgb sync is a polished touch worth matching.
- **Expiry presets + "infinity":** the dateRange widget's fixed presets (day / 1-2-3-6 months / 1 year / permanent / reset) make term-setting one click. Permanent is encoded as `0`.
- **Quick "VIP +1 месяц":** a dedicated one-tap "extend/grant a month of VIP" button — a fast path for the most common operation (rewarding players). Copy this; it's the highest-frequency admin action for a VIP roster.
- **Search ergonomics:** last-seen date-range filtering lets staff find **expired-but-inactive** or **soon-to-lapse active** VIPs quickly; description search finds notes like "donation #123". Good for VIP retention workflows.
- **Self-protection guard:** blocking self-group-edit prevents an admin from accidentally (or maliciously without a second admin) altering their own privileges.
- **Two distinct "VIP" concepts to beat:** global privilege (`changeGroup`, group=VIP) vs clan reserved-slot toggle (`vipPlayer` boolean with `clan_id`). A competing panel should decide whether to unify these or keep them separate.

---

### Gaps / Unknowns

- The clock-icon column (`time`) has no text label; its exact semantic (total online time vs remaining term vs session length) is inferred, not confirmed by a label.
- Reserved-slot semantics for VIP (in-game slot priority) are implied by the role but not described in this fragment; the closest explicit reserved-slot mechanism is the clan `vipPlayer` boolean.
- Per-server scoping of a global VIP is not exposed on this page; whether `changeGroup` is global or server-scoped is server-side and not visible here.
- The condition that un-hides "VIP +1 месяц" is not determinable from the static fragment.


---

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


---

## 08. Player Comments & Suspect Marking

Documentation of SQSTAT's per-player admin note system (**Комментарии / Comments**) and its suspect-tagging system (**Метки / Marks**). These are two distinct but related moderation-storage features that attach free-form notes and structured "cheat suspicion" flags to a player identity (keyed by SteamID). Both surface as dedicated nav pages **and** as controls inside the shared `player-detail` modal that is embedded on every page.

---

### 1. Purpose & Nav Location

| Feature | Nav item | Page id | AJAX fragment | Own table id |
|---|---|---|---|---|
| Player comments log | `comments` | `comments` | `GET /ajax/page.php?page=comments` | `#playerComments` |
| Suspect marks log | `mark` | `mark` | `GET /ajax/page.php?page=mark` | `#playerMark` |

- **Comments page** = a global, cross-player audit feed of every admin note ever written, with search by target player, authoring admin, and note text.
- **Mark page** = a global roster of every player who currently carries a suspicion/toxicity flag, filterable by mark type; effectively a "watchlist" of suspected cheaters and toxic players.
- Both are read/browse surfaces. The *write* side (adding a comment, setting/clearing a mark) happens inside the shared player modal, which both pages also embed. Clicking any row opens that player's modal via `player.open(steam_id)`.

The underlying capabilities (`addComment`, `getComments`, `mark`) are available from **every** page in the panel (admins, bans, chat, kills, players, reports, etc. — confirmed in the action catalog), because they are part of the shared modal. The two pages documented here are just the dedicated *browse/report* views over the same stored data.

---

### 2. Entities & Fields

#### 2.1 Entity: `player_comment` (admin note)

Inferred from the `#playerComments` table columns (`buildTable` `collum: ["steam_id","date","admin","player","text"]`), the search inputs (`t1.text`, `t2.player`, `t5.player`), and the `addComment` / `getComments` payloads.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Target player the note is attached to. |
| `date` | datetime | When the note was written (rendered via `formatDate(date,false)`). |
| `admin` | string | Display name of the authoring admin (join alias `t2.player`). |
| `player` | string | Current nickname of the target player (join alias `t5.player`). |
| `text` | string, `maxlength=256` | The note body. Free text, one line, up to 256 chars. |
| `name` | string | In the `getComments` response, the author's display name (`comment.name`) rendered above each message. |

Notes on structure:
- The search aliases `t1`, `t2`, `t5` reveal a multi-table join server-side: `t1` = comments table (has `.text`), `t2` = admin/author table (has `.player`), `t5` = target player table (has `.player`). This confirms comments are stored in their own table and joined to both the author admin and the target player records.
- Comments are **append-only** from the UI — there is no edit or delete control anywhere in the fragment. Notes accumulate as an immutable thread per player.
- A per-player **comment count** (`comments_count`) is delivered with the player modal payload and shown as a badge on the comment button.

#### 2.2 Entity: `player_mark` (suspicion / toxicity flag)

Inferred from the `#playerMark` table (`collum: ["steam_id","player","date","mark","ban"]`), the `<select id="playerMark-mark">` options, the modal `player.mark` object, and the `mark` action payload.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Player carrying the mark. |
| `player` | string | Player nickname. |
| `date` | datetime | Last-seen timestamp — column header is **Заходил (Last logged in)**, not mark date. |
| `mark` | enum int `0`–`8` | The suspicion category (see enum below). `0` = no mark / cleared. |
| `ban` | (flag/status) | **Бан (Ban)** column — indicates whether this suspected player is currently banned, letting admins triage suspects who have not yet been actioned. |

**`mark` enum (suspicion categories):** This is the competitively interesting core of the feature — a fixed taxonomy of cheat/behaviour suspicions, each with its own FontAwesome icon.

| Value | Russian label | English gloss | Icon |
|---|---|---|---|
| `1` | Подозрение на WallHack | Suspected WallHack | `fa-eye` |
| `2` | Подозрение на AimBot | Suspected AimBot | `fa-crosshairs` |
| `3` | Подозрение на SpeedHack | Suspected SpeedHack | `fa-tachometer` |
| `4` | Подозрение на спавн объектов | Suspected object spawning | `fa-bomb` |
| `5` | Подозрение на перезарядку | Suspected reload exploit | `fa-refresh` |
| `6` | Подозрение на гриф | Suspected griefing | `fa-free-code-camp` |
| `7` | Подозрение на конфиг | Suspected illegal config | `fa-file-excel` |
| `8` | Токсичный игрок | Toxic player | `fa-biohazard` |
| `0` | Снять метку | Remove mark (clear) | `fa-times` |

- A player carries **exactly one** mark at a time (setting a new value replaces the old; `mark.set(0)` clears). It is a single scalar enum column, not a multi-tag set — even though the *mark page filter* is a multiselect (that multiselect is an OR filter over the log, not a per-player multi-value store).
- The mark enum table is hardcoded client-side in `player.mark.get()` as a JSON map (id → `{name, icon}`), duplicated between the page's filter `<select>` and the modal dropdown. A competing panel could make this taxonomy server-configurable.

---

### 3. The Pages' Own Tables

#### 3.1 `#playerComments` (comments page)

Server-side DataTables-style table via jQuery `buildTable` (`table:'playerComments'`, `numrows:100`). Row click → `player.open(steam_id)`.

| # | Header | Data key | Meaning |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Target player id (also the row's click key). |
| 2 | Дата (Date) | `date` | Note timestamp, centered. |
| 3 | Админ (Admin) | `admin` | Authoring admin. |
| 4 | Ник (Nick) | `player` | Target player nickname. |
| 5 | Комментарий (Comment) | `text` | Note body. |

**Search/filter controls** (left fixed sidebar, submitted by the **Поиск (Search)** button `#playerComments-btn`):

| Input | Placeholder | Server field | Filters on |
|---|---|---|---|
| `#playerComments-name` | Игрок (Player) | `t5.player` | Target player nickname |
| `#playerComments-admin` | Админ (Admin) | `t2.player` | Authoring admin |
| `#playerComments-text` | Текст (Text) | `t1.text` | Note body substring |

No column-sort UI or pagination widgets are present in the fragment beyond the `numrows:100` page size; loading is server-side.

#### 3.2 `#playerMark` (mark page)

Same `buildTable` engine (`numrows:100`). Row click → `player.open(steam_id)`. Rows carrying a mark get CSS class `player_mark` (highlight styling).

| # | Header | Data key | Meaning |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Suspect player id. |
| 2 | Ник (Nick) | `player` | Nickname. |
| 3 | Заходил (Last seen) | `date` | Last login time. |
| 4 | Причина (Reason) | `mark` | Suspicion category (enum → icon+label). |
| 5 | Бан (Ban) | `ban` | Whether the suspect is currently banned. |

**Search/filter controls** (left sidebar):

| Control | Type | Server field | Filters on |
|---|---|---|---|
| `#playerMark-name` | text, placeholder Игрок (Player) | `t1.player` | Nickname |
| `#playerMark-mark` | `<select multiple>` (bootstrap-multiselect, `nonSelectedText:'- Метка -'`, `enableHTML:true`) | `mark` | One or more mark categories (OR) |

The multiselect renders each option with its inline icon via `enableHTML`. This is the "watchlist filter": e.g. show me all players flagged AimBot **or** WallHack.

---

### 4. Actions / Admin Capabilities

All three actions post to the same script endpoint. `Action({script, action, data})` → `POST /ajax/<script>.php` with body `action=<action>&<data...>`.

| UI label / trigger | action id | Endpoint | Data params | Effect | Destructive (state-change)? |
|---|---|---|---|---|---|
| Comment thread open (auto-load) | `getComments` | `/ajax/player.php` | `steam_id` | Returns `{comments:[{name,date,text},…]}` for the player; populates the slide-out thread. | N (read) |
| Send note (Enter or ▶ submit) | `addComment` | `/ajax/player.php` | `steam_id`, `text` (trimmed, non-empty, ≤256) | Persists a new note authored by the current admin; on complete re-runs `getComments`. | **Y** |
| Set/clear suspicion mark (dropdown `player.mark.set(n)`) | `mark` | `/ajax/player.php` | `steam_id`, `mark` (0–8) | Sets the player's mark enum; `0` clears it. Updates modal warning banner + row highlight. | **Y** |

Supporting client behaviour:
- `addComment` clears the input on success and always refetches the thread on `complete`, so the new note appears immediately.
- `mark` on success plays a flip animation (`animateCss('flip_panel_full')`), destroys/rebuilds the comment panel, re-renders the mark banner, and toggles the `player_mark` row class across any visible table (`tr[data-id="<steam_id>"]`).
- Errors from either write action surface via `addAlert(text, "exclamation-triangle")`.

> Note: the action catalogs for `comments.html` and `mark.html` also list the full shared-modal action set (`ban`, `kick`, `kill`, `kits`, `kitSave`, `message`, `twink`, `unban`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `addBanName`, `removeBanName`, `removePlayer`, `getPlayerOnlineData`, `downloadStat`, `get`) plus `script:'squad'`. Those belong to the embedded player modal, **not** to the comments/mark pages themselves, and are documented in the shared-modal section.

---

### 5. Forms & Modals

#### 5.1 Comment slide-out panel (`.player_comments`, inside the player modal)

- **Trigger:** comment button with unread/count badge (`.player_comments_button` desktop, `.player_comments_button-mobile` mobile) → `player.comment.open()` toggles the `open` class; opening triggers `get()`.
- **Composer:** single `<input class="form-control" maxlength="256">` + submit button `.player_comments_sumbit`. Submits on Enter (keyCode 13) or click.
- **Validation:** client trims input and drops empty strings (`if(text=='') return;`). Only a 256-char max and non-empty check; no server-echoed validation shown.
- **Thread rendering:** each message shows author name + formatted date header and the note text (with `&amp;quot;` unescaped back to `"`).
- **States:** loading spinner (`.player_comments_load`), empty state **Нет комментариев (No comments)** (`.player_comments_nomessage`), and a live count badge via `player.comment.count()`.

#### 5.2 Mark dropdown (inside the player modal header)

- A **tags** dropdown button (`fa-tags`) next to the **Группа (Group)** button opens `#player_info-mark`, listing the 8 suspicion options + a divider + **Снять метку (Remove mark)**.
- Each `<li><a onclick="player.mark.set(n)">` fires the mark action directly — no confirmation dialog.
- The currently-active mark's menu item gets `class="disabled"` via `mark.render()`, so admins see which flag is set.
- When a mark is set, a pulsing warning banner (`#player_info_mark`, `alert-warning`, `animated pulse infinite`) shows the icon + label at the top of the player panel; cleared marks hide it.

---

### 6. Permission / Visibility Logic

- The whole player template block lives inside `<div id="player_info" class="hide">` — it is a hidden client-side template cloned into `#playerModal` when a player is opened; the `hide` class here is a rendering mechanism, not a permission gate.
- **No explicit role/group gating** is present on the comment composer or the mark dropdown in these fragments — unlike sibling controls (e.g. **Убить (Kill)**, **Кикнуть без причины (Kick w/o reason)**, ban-name actions) which ship with `style="display:none;"` and are revealed by role logic elsewhere. This suggests comments and marks are available to any admin who can open the modal (a relatively low privilege bar), whereas punitive actions are gated tighter.
- Authorship is server-attributed: `addComment` sends only `steam_id`+`text`; the admin identity is taken from the session, and every note is stamped with the author name shown in the comments feed and thread. This makes the comments page an **accountability/audit trail** of which admin said what about whom.
- Marks are **not** author-attributed in the visible schema (the mark page shows last-seen date, not who flagged) — a possible weakness to beat: no audit of who set/cleared a suspicion.

---

### 7. Notable UX & Competitive Takeaways

- **Structured cheat taxonomy.** The 8-value suspicion enum (WallHack, AimBot, SpeedHack, object-spawn, reload-exploit, grief, illegal-config, toxic) with per-type icons is a clean, low-friction watchlist primitive. Setting a flag is one click, no dialog. Worth copying — but make the taxonomy **server-configurable** rather than hardcoded in JS in two places.
- **Ban-aware watchlist.** The mark page's **Бан** column lets moderators immediately see which flagged suspects are still unbanned — a ready-made triage queue for "suspected but not yet actioned" cheaters.
- **Cross-player audit feed.** The comments page is a global, searchable log of every admin note (searchable by author admin), doubling as staff accountability. Notes are immutable/append-only.
- **Ubiquitous access.** Because comments+marks ride the shared modal, an admin can annotate/flag a player from *any* page (chat, kills, reports…) without navigating away — very low friction. The count badge keeps prior notes discoverable.
- **Gaps to beat:**
  - No edit/delete/soft-delete of comments; no threading or attachments; 256-char single-line cap.
  - Only one mark per player (single enum) — cannot flag both "AimBot" and "toxic" simultaneously despite the multiselect *filter* implying otherwise.
  - No visible mark-author audit or mark history/timeline.
  - Mark taxonomy and enum→label map are hardcoded client-side and duplicated between filter and modal.
  - No pagination beyond a fixed 100-row server page; no explicit sort controls.


---

## 09. Ban Management

### 1. Purpose and Navigation

- **Nav id / entry point:** `bans` → `pageLoad('bans')` → `GET /ajax/page.php?page=bans`, HTML fragment injected into `#content`.
- **Purpose:** A searchable, paginated register of every ban ever issued on the project (the "ban archive"). It is a *read/lookup* surface: the list shows who is/was banned, why, when, and until when. All *mutation* of a ban (issue, extend, revoke) is performed not from a row form but from the **shared player-detail modal** that opens when you click a row.
- **Related pages that reuse the exact same machinery:** `collabans` (collaborative / shared cross-community ban list — identical fragment, action set, and modal) and `admins` / `chat` / `clan_*` (which also embed the same player modal with `ban`/`unban`/`checkBans`). This section documents `bans`; where behavior is shared it is called out.

The page is a two-column layout: a fixed left **filter sidebar** (`col-md-3`, `position:fixed`) and a right **results table** (`col-md-9`).

---

### 2. Entities & Fields

#### 2.1 Ban (the row entity — table `banPlayers`, server-side view over `t1`)

Inferred from the table columns, the `data-search` aliases on the filter inputs, the `player.info.ban` object consumed by the modal, and the `checkBans` response.

| Field | Origin / alias | Type | Meaning |
|---|---|---|---|
| `steam_id` | column 0 (`t2.player`) | string (Steam64), rendered inside a `<hashtag>` element | Identity of the banned player. Column is CSS-hidden (`class="hide"` + `td:first-child{display:none}`) but drives the row-click. NB: the panel has since migrated identity to a UUID elsewhere; here it is still the SteamID. |
| `name` | column 1 | string | Player nick at time of lookup. |
| `reason` | column 2 (`t1.reason`) | string | Human-readable reason text, resolved from a rules catalog (see reason `<select>` §5.1). |
| `date` | column 3 | datetime | When the ban was issued ("Забанен"). |
| `expire` | column 4 | datetime or `0` | Ban expiry ("До"). `0` / empty = **permanent**. |
| `description` | filter `t1.description` | string (≤512 chars) | Free-text admin comment attached to the ban. Not shown as a column, only searchable + shown in modal. |
| `admin_name` | `t3.player` (filter "Админ") | string | The admin who issued the ban. Searchable; shown in modal (`#player_info_ban-admin`) and in each ban history entry. |
| `impact` | `ban.impact` (modal) | bool | Whether this ban counts toward *progressive* escalation ("Влияет на наказание"). |
| `unban` | `ban.unban` (modal) | bool/"1" | Whether the ban was later revoked ("Игрок был разбанен"). |
| `permanent` | filter `permanent` | bool | Filter-only flag (`expire == 0`). |

SQL aliasing exposed by the `data-search` attributes reveals the underlying join: **`t1` = bans**, **`t2` = banned player**, **`t3` = issuing admin**.

#### 2.2 Player (context object `player.info`, loaded by `script:'player', action:'get'`)

The row click loads the full player object; ban-relevant sub-fields:

| Field | Meaning |
|---|---|
| `player.info.ban` | The *current active* ban ( `{reason, expire, date, admin_name, description}` ), or falsy if none. |
| `player.info.bans[]` | Full ban **history** array (`{admin_name, date, reason, description, impact, unban}`), rendered in the modal's "Наказания" accordion. |
| `player.info.canBan` | Permission flag — may this admin issue bans on this player. |
| `player.info.canUnban` | Permission flag — may this admin revoke the current ban. |
| `player.info.canPermanent` | Permission flag — may issue a permanent ban. |
| `player.info.progressiveBan` | Whether progressive/escalating durations apply to this player. |
| `player.info.name_banned` | Whether the player's *nick* is currently name-banned. |
| `player.info.online` | If set, contains `online.server.id` — used to scope live bans to a server. |

#### 2.3 Reason (rules catalog — the ban `<select>`)

| Attr | Meaning |
|---|---|
| `value` | Rule id (`reason_id`) sent to backend, e.g. `1`=`0.1 Другое (Other)`, `2`=`0.2 DPAC anti-cheat`, `110`=`1.1 Оскорбления (Insults)`, `160`=`1.6 Cheating/exploits`, `173`=`Teamdamage`. |
| `data-first` / `data-second` / `data-third` / `data-four` | Escalating ban length in **days** for the 1st/2nd/3rd/4th qualifying offense (progressive ban tiers). `data-four="30"` is the common cap. |
| `<optgroup>` | Rule category: Особые (Special), Общие (General), Для сквадных (Squad leaders), Для техники (Vehicles), Милсим (Milsim). |

---

### 3. The Page's OWN Table & Controls

**Table `#banPlayers`** — DataTables-style *server-side* grid built by the custom `$.fn.buildTable` helper (`custom.js`), not native DataTables.

**Columns (own table only — NOT the modal):**

| # | Header | Key | Notes |
|---|---|---|---|
| 0 | SteamID | `steam_id` | Hidden; wrapped in `<hashtag>`, feeds row-click. |
| 1 | Ник (Nick) | `name` | 200px, centered. |
| 2 | Причина (Reason) | `reason` | Flexible width. |
| 3 | Забанен (Banned) | `date` | 130px. |
| 4 | До (Until) | `expire` | 130px; empty/`0` ⇒ permanent. |

`buildTable` config: `numrows: 100`, `order: ["steam_id","name","reason","date","expire"]`.

**Data request (competitively important):** `Action({script:'table', action:'banPlayers', data:'&table=banPlayers&page=<n>&numrows=100&search=<urlencoded-json>&order_by=<col>&order_sort=<asc|desc>'})` → `POST /ajax/table.php`. A **separate** call with `&pagination=true` returns `{totalPage, totalRows, count_time}` so page count is computed lazily (server logs the SQL count time to the browser console).

**Filter sidebar controls** (each carries a `data-search` SQL alias; all feed the JSON `search` payload):

| Control | id | `data-search` | Type | Effect |
|---|---|---|---|---|
| Поиск (Search) button | `banPlayers-btn` | — | button | Triggers rebuild. |
| Ник или SteamID | `banPlayers-name` | `t2.player` | text | Match player nick/SteamID. Enter key submits. |
| Админ (Admin) | `banPlayers-admin` | `t3.player` | text | Match issuing admin. |
| Причина (Reason) | `banPlayers-reason` | `t1.reason` | text | Match reason text. |
| Комментарий (Comment) | `banPlayers-description` | `t1.description` | text | Match admin comment. |
| Перманенты (Permanents) | `banPlayers-permanent` | `permanent` | checkbox | Show only permanent bans; `change` re-runs the table immediately. |
| Start/End date | `banPlayers-startdate` / `-enddate` | — | datetimepicker (ru) | Wired in `searchInput` as a date range (pickers initialized even though the visible inputs are collapsed in this fragment). |

**Sorting:** click a `<th>` (each carries a `data-sort`); toggles `order_by`/`order_sort` asc↔desc, page resets to 1.
**Pagination:** numeric pager with first/prev/next/last, window of 9 pages (3 on mobile); shows "Страница X из Y — Всего: N".
**Row click:** `player.open( <hashtag> text )` opens the shared player-detail modal for that SteamID.

---

### 4. Actions / Admin Capabilities

All ban mutations route through the shared player modal. `Action` helper posts `action=<id>&<data>` to `/ajax/<script>.php`; success requires `text.status=='ok'` (else `text.auth===true` forces a full reload — session expiry).

| UI label | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| Наказать (Punish) → issue ban | `ban` | `squad` → `/ajax/squad.php` | `server_id` (if online), `steam_id`, `reason_id` (rule value), `description`, `days` (radio value: N days, `0`/`-1`=permanent) | Creates/records a ban; removes player from live `#players` grid and refreshes active server. | **Y** |
| Кикнуть (Kick) | `kick` | `squad` → `/ajax/squad.php` | `steam_id`, `reason_id`, `description`, `noReason:false` | Kicks online player with a reason. | **Y** |
| Кикнуть без причины (Kick, no reason) | `kick` | `squad` | same + `noReason:true` | Kick without stated reason (confirm dialog). | **Y** |
| Разбанить (Unban) | `unban` | `squad` → `/ajax/squad.php` | `steam_id`, `unban` (bool: "issued in error" → **fully erase** the ban vs. just lift it) | Revokes the active ban; re-opens modal with flip animation. | **Y** |
| Забанить ник (Ban nick) | `addBanName` | `player` → `/ajax/player.php` | `name` | Name-ban: blocks the player's current nick. | **Y** |
| Разбанить ник (Unban nick) | `removeBanName` | `player` → `/ajax/player.php` | `name` | Lifts a name-ban. | **Y** |
| Проверить баны (Check bans) | `checkBans` | `player` → `/ajax/player.php` | `steam_id` | **Cross-project ban lookup** — returns `{projects:[{name, discord, online, ban:{total, current:{reason, date, expire}}}]}` and renders a per-community grid of ban status. | N (read) |
| Скачать статистику (Download stats) | `downloadStat` | `player` → `/ajax/player.php` | `steam_id` | Builds a hidden auto-submitting form (`post_to_url`) → file download. | N |
| Заявка в OWI (OWI report) | (client only) | — | — | `copyReport()` copies a formatted cheat-report (Name / EOSID / SteamID / Steam URL) to clipboard for the official Offworld ban appeal channel. | N |
| Метка (Mark) 1–8 / снять | `mark` | `player` | mark id | Flags suspicion (WallHack/AimBot/SpeedHack/spawn/reload/grief/config/toxic). | Y |
| Смена группы (Change group) | `changeGroup` | `player` | group id, expire | Assigns role/VIP (gated by `canChangeGroup`). | Y |
| Команда (Change team) | `changeTeam` | `squad` | `server_id`, `steam_id` | Force-swap team (online only). | Y |
| Убить (Kill) | `kill` | `squad` | `server_id`, `steam_id` | Kills player, dissolves their squad. | Y |
| Поиск твинков (Find alts) | `twink` | `player` | steam_id | Alt-account detection. | N |
| Комментарии (Comments) | `addComment`/`getComments` | `player` | steam_id, text | Internal admin notes on the player. | Y/N |

*(kick/kill/team/mark/kits/message/twink/comments belong to the shared modal and appear on every page — listed here for completeness, but the **ban-specific** capabilities are `ban`, `unban`, `addBanName`, `removeBanName`, `checkBans`.)*

---

### 5. Forms & Modals

#### 5.1 Punishment form (`#player_ban`, reached via `player.flipBan()` — a card *flip*)

- **Reason select** `#player_ban-reason` (multiselect, filterable, HTML-enabled) — the rules catalog (§2.3). Value `false` = "-Выберите причину- (Choose reason)".
- **Duration radios** `name="player_ban-reason_type"` — preset tiles rendered as colored boxes: **Кикнуть (Kick)** `value=-1 data-action=kick`; **Забанить N дн.** for N ∈ {1,2,3,4,5,6,7,10,14,30} (`data-action=ban data-day=N`, amber); **Забанить навсегда (Ban forever)** `value=-1 data-action=ban data-day=0` (crimson).
- **Progressive-ban logic (`banRadio`):** when `player.info.progressiveBan` is on, the reason's `data-first/second/third/four` values relabel the tiers, and only tiers up to `(#prior impact bans + 1)` are enabled; deeper tiers are disabled with a tooltip "Необходимо наказаний N (need N more punishments)". The last enabled tier is auto-checked and tooltipped "Рекомендуемое (Recommended)". Non-progressive players get all tiers enabled.
- **Permanent tier** only injected when `canPermanent && progressiveBan`.
- **Comment** `#player_ban-description` — textarea, `maxlength=512`.
- **Submit** `#player_ban-btn` → `player.actionPlayer()` — dynamically relabels to "Забанить на Nдн." / "Кикнуть" / "Забанить навсегда", disabled until a valid reason+tier is chosen. Routes to `banPlayer()` or `kickPlayer()` by the checked radio's `data-action`. "Игрок (Player)" button flips back.

#### 5.2 Unban dialog (`player.unban`)

Confirmation modal with a toggle **"Бан был выдан по ошибке" (Ban was issued by mistake)** → `unban-error` checkbox. Help text: *"Если включить, то бан полностью будет стёрт" (if enabled the ban is fully erased)*. Distinguishes a normal lift (kept in history, `unban=1`) from an error-erase.

#### 5.3 Check-bans modal (`#player_findban-modal`)

Grid of community cards from `checkBans`: per project shows name, Discord link, aggregate online time, total punishments, and current ban (reason + From/To dates, or "Перманент"), with a red ban / green check icon.

#### 5.4 Active-ban banner (`#player_info_ban`)

When `player.info.ban` exists: shows "до <date>" or "НАВСЕГДА", reason, admin, issue date, and comment (or "Без комментария"). The "Наказать" button is hidden and, if `canUnban`, an "Unban" button + corner badge appear.

---

### 6. Permission / Visibility Logic

Visibility is server-driven via boolean flags on `player.info`; the client shows/hides buttons accordingly (default state is `display:none` / `class="hide"`, revealed on load):

| Element | Gate |
|---|---|
| "Наказать" (issue ban) | shown only if **no active ban** AND `canBan`. |
| "Разбанить" (unban) + corner | shown only if active ban AND `canUnban`. |
| Забанить/Разбанить ник | requires `canBan`; which one shows depends on `name_banned`. |
| Киты (kits) menu | requires `canBan`. |
| Смена группы (group) | requires `canChangeGroup`. |
| Проверить баны / Поиск твинков / Скачать статистику / Копировать телепорт | ungated (visible to all admins who can open the modal). |

The ban list page itself has no per-row gating — filtering/reading is available to anyone who can open `bans`. The distinction between the regular `bans` page and `collabans` (collaborative/cross-community ban list) is the primary scope boundary.

---

### 7. Notable UX & Competitive Takeaways

1. **Progressive ban engine** — the single strongest feature to match/beat. Each rule carries escalating day-counts (1st→2nd→3rd→4th offense), the UI auto-recommends the correct tier based on the player's prior *impact* bans, and locks tiers the player hasn't "earned" yet. This turns ban duration into policy-as-data, not admin discretion. Note the visible cap at 30 days before permanent.
2. **Cross-project ban check (`checkBans`)** — one click surfaces the player's ban status across *every* federated community, with Discord links and current-ban details. This is a network-effect moat (shared reputation). `collabans` is the collaborative list backing it.
3. **Error-erase vs. lift** on unban — preserving revoked bans in history (`unban=1`, still shown greyed with "Игрок был разбанен") vs. fully deleting mistaken bans is a thoughtful audit distinction worth copying.
4. **Server-scoped issuance, global archive** — `ban` sends `server_id` when the target is online (live enforcement on that server) but the archive/list is project-wide.
5. **Rich, aliased server-side search** (`t1/t2/t3` joins over reason, banned player, admin, comment, permanent flag, date range) with lazy pagination counting — fast even over very large ban tables.
6. **OWI report generator** — pre-formats an official cheater-report payload (Name/EOSID/SteamID/Steam URL) to clipboard, smoothing the appeal-to-developer workflow.
7. **Everything runs inside one draggable, flip-animated player modal** shared across all pages — consistent muscle memory for admins; the ban list is just one of many entry points into it.
8. **Name bans** are a distinct axis from account bans (`addBanName`/`removeBanName` on nick text), useful against impersonation/tag abuse.

> Scope note: the shared modal's tabbed tables (Chat/Kills/Deaths/Kits/Games/Comments and columns Дата/Чат/Сообщение/Убил/Кит/Карта/Оружие/Урон/Техника…) are **not** part of the bans page's own schema — they are the ubiquitous player-detail modal and are documented with the player entity, not here.


---

## 10. Banned Nicknames & Ru-Ban Shared Network

Two related but distinct capabilities live under this section:

- **`bannames`** — a blacklist of forbidden nicknames (name-based auto-ban rules).
- **`collabans`** — the "Ру-Баны" (Ru-Bans) collaborative ban network: a cross-community/cross-project registry of banned players, queried and displayed through the shared player-detail modal.

Both are SPA fragments loaded via `pageLoad('bannames')` / `pageLoad('collabans')` → `GET /ajax/page.php?page=<page>`, injected into `#content`. All mutations go through the JS helper `Action({script, action, data})` → `POST /ajax/<script>.php`.

---

### 10.1 Purpose and nav location

| Page id | Nav label (RU / gloss) | Purpose |
|---|---|---|
| `bannames` | "Забаненные ники" (Banned nicknames) | Maintain a list of nickname strings that are forbidden. A player connecting under a listed nick is presumably auto-actioned by the game-server bot. |
| `collabans` | "Ру-Баны" (Ru-Bans) | Browse the shared/federated ban registry aggregated across participating communities ("projects"). Each ban row can be expanded into the full shared player-detail modal, including a cross-project ban check. |

---

### 10.2 `bannames` — Banned Nicknames

**File:** `frags/bannames.html` (fully self-contained — no shared modal on this page).

#### 10.2.1 Entity: `ban_names`

Inferred from the DataTable config (`table: 'ban_names'`), the columns, and the add/remove payloads.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The banned nickname. This is the identity key of the rule; `removeBanName` looks the row up by `name`. |
| `date` | datetime | When the rule was added (rendered via `formatDate(data,false,true)`; column header "Добавлен" / Added). |

There is **no** visible severity, regex flag, expiry, scope, or author column exposed in the UI. The stored value is the literal nickname string; whether the backend treats it as a substring/regex is **not** discernible from the client — the input placeholder is simply "Ник" (Nickname) and no pattern hint/validation is present. (See Gaps.)

The hidden `#player_template` reveals the underlying record can also carry `steam_id` and `name` — i.e. the same template used elsewhere — but the ban_names table only binds `name` + `date`.

#### 10.2.2 Page's own table

Table `#ban_names`, `mode: 'table'`, `numrows: 100`.

| Column (RU / gloss) | Bound field | Notes |
|---|---|---|
| "Ник" (Nickname) | `name` | The forbidden nick. |
| "Добавлен" (Added) | `date` | Formatted date. |
| (blank, 40px) | — | Per-row red delete button (`remove_ban_names(this)`). |

**Search / filter controls** (left fixed sidebar):

| Control | id | Bound search key | Effect |
|---|---|---|---|
| "Поиск" (Search) button | `#ban_names-btn` | — | Triggers table rebuild. |
| Nick text input | `#ban_names-name` | `data-search="t1.name"` | Server-side filter on the nickname column (`searchInput: ["ban_names-name"]`). |
| "Добавить" (Add) button | `#add_ban_names-btn` | — | Opens `#add_ban_names_modal`. |

No sort/pagination UI beyond the 100-row page size; filtering is server-side via DataTables (`script: 'table'`).

#### 10.2.3 Actions

| UI label (RU / gloss) | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| "Добавить" (Add) | `addBanName` | `player` → `POST /ajax/player.php` | `name` | Inserts a new banned-nickname rule; on success closes modal and rebuilds the table. | Y (creates a rule) |
| (red trash icon) | `removeBanName` | `player` → `POST /ajax/player.php` | `name` | Deletes the rule matching that nickname; rebuilds the table. | Y |

Note: `addBanName` / `removeBanName` are **ubiquitous** — they appear on nearly every page (players, chat, kills, bans, main, etc.) because any nickname shown anywhere can be added to / removed from the blacklist from context menus. `bannames` is just the dedicated management screen for the same rule set.

#### 10.2.4 Add modal (`#add_ban_names_modal`)

- Single text input `#add_ban_names_name`, placeholder "Ник" (Nickname).
- Submit button "Добавить" (Add) → `add_ban_names(this)` → `addBanName`.
- **No client-side validation** (no length/pattern check, no empty-guard). An empty submit would send `name=''`.

---

### 10.3 `collabans` — Ru-Ban Shared Network

**File:** `frags/collabans.html`. Page-own content is lines 1–130; **everything after** (`#playerModal`, `#player_info`, `player.*` object, ~2700 lines) is the **shared player-detail modal** and must not be attributed to this page specifically.

#### 10.3.1 Concept

`collabans` presents a **federated ban registry**. A single banned player is keyed by SteamID and may carry ban records contributed by **multiple communities ("projects")**. The page groups all bans for a player and shows a card per contributing project, with that project's ban type, admin, reason, count, and date. This is the competitively significant feature: a shared, cross-server ban-intelligence network. (The site name is breaking.sqstat.ru; "Ру-Баны" = the Russian-community shared ban pool.)

#### 10.3.2 Entities & fields

**Entity A — federated ban row (`collabans` table).** Inferred from `buildTable({table:'collabans', collum:["steam_id","reason","date","expire"]})`, the table `<th>`s, and the `#ban_template`.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Player identity; the hidden first column. Row click → `player.open(steam_id)`. |
| `name` | string | Player nickname; callback renders `<b>name</b>` or `<code>Нет ника</code>` ("No nick") when empty. |
| `reason` | string | Ban reason (aggregate/representative). Column "Причина". |
| `date` | datetime | When banned. Column "Забанен" (Banned). |
| `expire` | datetime / `0` | Ban expiry; `0` = permanent. Column "До" (Until). |
| `projects` | array<Project> | Per-community ban breakdown (see Entity B), rendered as cards. |

**Entity B — per-project ban card (`project`).** Inferred from `#project_template` `data-project="…"` bindings and the `projects` callback.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The contributing community/project name. |
| `admin_name` | string | Admin who issued the ban (rendered in `<code>`). |
| `reason` | string | That project's stated reason. |
| `date` | datetime | That project's ban date. |
| `expire` | datetime / `0` | `0` → red "Перманент" (Permanent) label + `panel-danger`; else "Временный" (Temporary) label + `panel-warning`. |
| `cnt` | int | Number of gavel/ban actions (rendered with a gavel icon `<i class="fa-solid fa-gavel">`). Represents how many times/records this project logged. |

**Entity C — cross-project ban check result (`checkBans` → `projects[]`).** Returned by the shared modal's "Проверить баны" action (see 10.3.4). Each element:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Community/project name. |
| `discord` | url (optional) | Project Discord invite; rendered as a Discord icon link if present. |
| `online` | seconds | Player's total online time on that project (`secToTime`). |
| `ban.total` | int | Number of punishments on that project ("Наказаний: N"); absent/0 → "Нет наказаний" (No punishments). |
| `ban.current` | object\|null | The active ban, if any. Presence flips the icon to a red ban vs. green check. |
| `ban.current.reason` | string | Active ban reason. |
| `ban.current.date` | datetime | Active ban start. |
| `ban.current.expire` | datetime / `0` | `0` → "Перманент"; else From/To date range. |

This is the heart of the trust/source model: **per-project attribution** (name + Discord + admin + online history) lets an admin judge the credibility of each contributing community before trusting a shared ban.

#### 10.3.3 Page's own table & filters

Table `#banPlayers`, `mode: 'list'`, `numrows: 100`. CSS hides the first (`steam_id`) column.

| Column (RU / gloss) | Bound field | Width | Notes |
|---|---|---|---|
| "SteamID" | `steam_id` | hidden (`class="hide"`) | Identity; used for row-click → modal. |
| "Ник" (Nickname) | `name` | 200px | Bold, or "Нет ника" if empty. |
| "Причина" (Reason) | `reason` | — | Ban reason. |
| "Забанен" (Banned) | `date` | 130px | Formatted date. |
| "До" (Until) | `expire` | 130px | Expiry / permanent. |

**Search / filter controls** (left fixed sidebar):

| Control | id | Bound search key | Effect |
|---|---|---|---|
| "Поиск" (Search) button | `#banPlayers-btn` | — | Rebuilds table. |
| "Ник или SteamID" (Nick or SteamID) input | `#banPlayers-name` | `data-search="s.player"` | Search by nickname or SteamID. |
| "Причина" (Reason) input | `#banPlayers-reason` | `data-search="s.reason"` | Search by reason text. |
| Permanent filter | `#banPlayers-permanent` | (in `searchInput`) | Referenced in `searchInput` and a `.change()` rebuild handler, but the actual checkbox/control markup is not present in this fragment. Filters to permanent bans. |

A datetimepicker is initialised for `#banPlayers-startdate` / `#banPlayers-enddate` (RU locale, time enabled), though those inputs are likewise not present in this fragment — evidence of a date-range filter that is conditionally rendered.

#### 10.3.4 Actions on this page

The row list itself is read-only browse; row click opens the **shared player-detail modal**, which brings its full ~22-action surface. The actions genuinely relevant to the Ru-Ban network:

| UI label (RU / gloss) | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| "Проверить баны" (Check bans) | `checkBans` | `player` → `POST /ajax/player.php` | `steam_id` | Returns `projects[]` = the player's ban/online status across **all** federated communities. Read-only intelligence lookup — the core Ru-Ban query. | N |
| "Скачать статистику" (Download statistics) | `downloadStat` | `player` → `POST /ajax/player.php` (via `post_to_url`, form-post → file download) | `action`, `steam_id` | Exports the player's stats as a file download (not AJAX; navigates a synthetic form). | N |
| "Заявка в OWI" (OWI report) | `copyReport` (client-only) | — | — | Copies a formatted report to clipboard for submission to OWI (Squad's developer). No server call. | N |
| (row click) | `get` | `player` | `steam_id` | Opens/loads the shared modal for the player. | N |

The shared modal additionally exposes (all `script:'player'` unless noted) the standard destructive player actions — `ban`, `unban`, `kick`, `kill`, `mark`, `message`, `twink`/`twinkOnline`, `findFriends`, `changeGroup`, `changeTeam`, `addComment`/`getComments`, `kits`/`kitSave`, `removePlayer`, plus `getPlayerOnlineData`; and `script:'squad'` for game-server commands. These belong to the shared modal (documented in the player-detail section), not to the collabans page proper, and are listed here only for completeness of what an admin can do from a Ru-Ban row.

#### 10.3.5 Related sync/network actions (defined on *other* pages)

The federation is populated/refreshed by actions that live outside these two fragments but are integral to the network:

| UI label (RU / gloss) | action id | script → endpoint | Data params | Where | Effect |
|---|---|---|---|---|---|
| "Обновить бота" (Update bot) | `botUpdate` | `squad` → `POST /ajax/squad.php` | (none) | `main.html` (shown when "Версия бота неактуальна" / bot version outdated) | Triggers the game-server bot to update — the bot is what enforces bans/bannames in-game and syncs with the shared list. Confirmation dialog first. |
| "Скачать список" (Download list) | `downloadList` | `clan` → `POST /ajax/clan.php` | `clan_id` | `clan_16.html` | Exports a clan/community roster as a file (form-post download). Adjacent `downloadOnline` exports online history. |

**Note on "network":** the `network` action/object seen in `main.html` is **unrelated** — it is the live TCP/connection monitor (`#networkModal`, DOS-attack detection, connection map), *not* the ban network. Do not conflate.

The client does not expose an explicit "import shared bans" / "downloadList of bans" / "sync now" button on these two pages; synchronisation appears to be **server/bot-side** (the panel is a consumer/viewer of the aggregated `collabans` + `checkBans` data), with `botUpdate` the only client-triggered refresh of the enforcement agent.

#### 10.3.6 Forms & modals

- **No add/edit form on `collabans`** — unlike `bannames`, admins do not manually author federated ban rows here; they browse aggregated data. New bans enter the pool via the normal `ban` action in the shared modal (which then federates server-side).
- **`#playerModal` / `#player_info`** — the shared player-detail modal (name, alternate nicknames dropdown "Другие ники" / Other nicks, clans, badges, last-login/created dates, active-ban alert panel with admin/date/reason/description, online chart, kits, comments, cross-project ban check). Fully documented in the shared-modal section.
- The `checkBans` results modal renders one card per project with name, Discord link, online time, punishment count, and current-ban details.

#### 10.3.7 Permission / visibility logic

- `class="hide"` — the `steam_id` column, and the `#ban_template`/`#project_template`/`#player_info` clone-source templates are hidden by class and cloned at runtime.
- Inline `style="display:none;"` gates several shared-modal items (e.g. the "Киты"/Kits menu item, the active-ban alert `#player_info_ban`, panel corner ban flag) — shown only when data warrants (e.g. player is banned) rather than by role. No explicit role/group class checks are visible in these fragments; server-side rendering of `page.php` presumably decides which actions the current admin group may see.
- The "Версия бота неактуальна" / `botUpdate` block on `main.html` is conditionally shown only when the bot is outdated.

---

### 10.4 Notable UX & competitively interesting details

1. **Federated, per-project ban attribution (the killer feature).** A single player row aggregates bans from many communities, each card carrying the community name, its admin, reason, ban count (`cnt`), type (perm/temp), and date. `checkBans` extends this with online-time and Discord link per project. This turns bans into shared *reputation intelligence*, not just local enforcement — strong signal worth matching/beating (add a trust score / verification badge per source community; show agreement count across communities).
2. **Trust surfacing via Discord + admin + online history.** Rather than a blind shared blacklist, each source is identifiable and contactable (Discord), and the player's *time played* on each community is shown — letting an admin weigh whether a ban is credible. A competitor should formalise this into an explicit reputation/consensus model.
3. **Perm vs temp visual language.** `expire == 0` → red `panel-danger` + "Перманент"; else amber `panel-warning` + "Временный". Consistent, instantly scannable.
4. **Empty-nick handling.** Missing nickname renders as a distinct `<code>Нет ника</code>` chip rather than a blank cell — small but polished.
5. **Ubiquitous quick-blacklist.** `addBanName`/`removeBanName` are reachable from virtually every page's context menu, so an admin can blacklist a nick from wherever they spot it, not only the `bannames` screen. Low-friction moderation.
6. **OWI report + stat export.** One-click "Заявка в OWI" (clipboard report to Squad's developers) and `downloadStat` export make cross-platform escalation easy — Ru-Ban intelligence feeds upstream to the official anti-cheat channel.
7. **Bot-version nag + one-click update.** The panel actively warns when the enforcement bot is stale and offers `botUpdate` inline — keeps the sync agent current without leaving the dashboard.

---

### 10.5 Gaps / not determinable from client

- Whether `bannames` entries are matched as exact string, substring, or **regex** is not visible client-side (no pattern flag/validation in the UI). Backend behaviour unknown.
- No `bannames` fields for author, scope (per-server vs global), severity, or expiry are exposed — the schema may be richer server-side.
- The `#banPlayers-permanent` filter control and the start/end datetime inputs are referenced by JS but their markup is absent from the fragment (conditionally rendered), so their exact appearance/behaviour is inferred, not observed.
- The actual **import/sync mechanism** for the federated `collabans` pool is not client-driven in these fragments; it is server/bot-side. `checkBans` is a read query; `botUpdate` updates the agent. How bans propagate between communities (push API, polling, shared DB) is not observable here.
- `checkBans` response `ban.total` vs the table's per-project `cnt` may be the same or different counters; not disambiguated in the client.


---

## 11. Statistics Dashboards

### 1. Purpose and Nav Location

- **Nav item:** `statistics` — invoked via `pageLoad('statistics')` → `GET /ajax/page.php?page=statistics`, injected into `#content`.
- **Source fragment:** `frags/statistics.html`.
- **Purpose:** A single-page, all-graphical analytics dashboard rendering ~20 Chart.js charts covering server population (online/queue), staff coverage (admins online), moderation volume (bans/punishments), match throughput, chat/teamkill volume, and per-server combat aggregates (kills/deaths/revives/wounds). It is a **read-only reporting screen** — there is no table, no row-level actions, and no export button on the page itself. All data is pulled by a single RPC (`action:'statistics'`, `script:'squad'`) driven by two controls: a date-range picker and a multi-server selector.

This page is unusual for SQSTAT: unlike the DataTables list pages (players, bans, chat, kills, etc.), it does **not** carry the `downloadStat` export action and, notably, its embedded fragment does **not** appear to include the shared player-detail modal wiring in the analyzed slice — it is a pure visualization surface.

---

### 2. Entities & Fields (inferred data model)

#### 2.1 Server (client-side `servers` map)

A `var servers = {...}` object is inlined in the fragment (`<script>` block, line 204) and drives dataset creation, coloring, and labels. One anonymized example entry:

```json
"1": { "id":"1","ip":"80.242.59.123","port":"0","pass":"","name":"RAAS/AAS #1",
       "short":"A","ext_short":"","mods":false,"types":false,
       "licensed":"1","sort":"1","chan_id":"","disabled":"0" }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | Server primary key; used as dataset `id`, color index (`colors[id]`), and response-map key. |
| `ip` | string | Server IP (all six configured servers share one host in this deployment). |
| `port` | string(int) | Query/RCON port (0 here → likely resolved elsewhere). |
| `pass` | string | RCON/query password (empty in the delivered fragment). |
| `name` | string | Full display name, e.g. "RAAS/AAS #1", "БЕЗ ГОЛОСОВАНИЯ #2" (No Voting #2), "INVASION #3". |
| `short` | string | Single-letter tag (A, B, C, E, F, G) used as the chart dataset `label`/legend and axis short code. |
| `ext_short` | string | Extended short label (unused/empty here). |
| `mods` | bool | Whether the server runs mods. |
| `types` | bool | Layer/type restriction flag. |
| `licensed` | string(int) | License/enabled flag (1 = licensed). |
| `sort` | string(int) | Display ordering. |
| `chan_id` | string | Associated Discord channel id (empty here). |
| `disabled` | string(int) | 0 = active. |

**Competitive note:** server ids are non-contiguous (1, 6, 7, 9, 10, 11 — id 8 and others missing), implying servers are soft-deleted / retired rather than renumbered.

#### 2.2 Statistics response payload (`text` from `action:'statistics'`)

The RPC returns one JSON object; keys are either flat time-series (`{label: value}`) or **nested per-server** (`{serverId: {label: value}}`). Axis label arrays are shared across charts.

| Response key | Shape | Feeds chart | Meaning |
|---|---|---|---|
| `days` | array | X labels (most time-series) | Date buckets for the selected range. |
| `hours` | array | X labels | Hour-of-day buckets (0–23) for the hourly chart. |
| `dayofweek` | array | X labels | Weekday buckets for the day-of-week chart. |
| `online` | `{serverId:{day:val}}` | `chartOnline` | Average online per server per day (stacked). |
| `max` | `{serverId:{day:val}}` | `chartOnlineMax` | Peak players incl. queue, per server per day (stacked). |
| `admins` | `{day:val}` | `chartAdmins` | Average admin count online (single series, line). |
| `maxAdmins` | `{day:val}` | `chartAdminsMax` | Peak admins online per day (single series, bar). |
| `bans` | `{day:val}` | `chartBans` | Punishments issued per day (single series; subtitle shows total). |
| `onlineHour` | `{serverId:{hour:val}}` | `chartOnlineHour` | Avg online by hour of day, per server (stacked). |
| `onlineDay` | `{serverId:{weekday:val}}` | `chartOnlineDay` | Avg online by weekday, per server (stacked). |
| `modes` | `{modeName:count}` | `chartModes` | Match count per game mode (doughnut). |
| `maps` | `{mapName:count}` | `chartMaps` | Match count per map, excluding Skirmish/Seed (bar). |
| `new` | `{day:val}` | `chartNew` | New/first-seen players per day. |
| `chat` | `{serverId:{day:val}}` | `chartChat` | Chat messages per server per day (stacked; subtitle: avg/max/total). |
| `teamkill` | `{serverId:{day:val}}` | `chartTeamkill` | Teamkills per server per day (stacked). |
| `queue` | `{serverId:{day:val}}` | `chartQueue` | Queue length per server per day (stacked). |
| `games` | `{serverId:{day:val}}` | `chartGames` | Matches played per server per day (stacked). |
| `kills` | `{serverId:{day:val}}` | `chartKills` | Kills per server per day (stacked). |
| `death` | `{serverId:{day:val}}` | `chartDeaths` | Deaths per server per day (stacked). |
| `revival` | `{serverId:{day:val}}` | `chartRevivals` | Revives per server per day (stacked). |
| `wound` | `{serverId:{day:val}}` | `chartWounds` | Wounds (downs) per server per day (stacked). |

Two additional charts, **`chartKits` (Количество китов / Kit count, horizontalBar)** and **`chartUnique` (Уникальных игроков / Unique players)**, are defined in JS but their surrounding HTML `<canvas>` blocks are **commented out** (lines 182–201) — dead/disabled features not currently rendered.

---

### 3. The Page's OWN Table

**None.** This page renders zero DataTables and zero HTML `<table>`. It is entirely `<canvas>`-based Chart.js output inside Bootstrap grid `block-box` cards. There is no per-row sort/search/pagination. The only "filter" controls are the global date range and server multiselect (Section 5).

---

### 4. Actions / Admin Capabilities

Only **one** action exists on this page, and it is a pure read (non state-changing).

| UI trigger | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Auto-run on load, on date-range change, and on server-select dropdown close (`getStatistic()`) | `statistics` | `POST /ajax/squad.php` (`script:'squad'`) | `start` (range start, from `#stat_date` `data-start`), `end` (range end, from `data-end`), `servers` (array of selected server ids from `#stat-server`) | Returns the aggregated statistics JSON (Section 2.2); client redraws all charts. | **N** (read-only) |

Notes:
- Payload is exactly `{ start, end, servers }` — see `getStatistic()` at `statistics.html:980`.
- There is **no** `downloadStat`, `stats`, CSV, or Excel export on this dashboard, in contrast to nearly every list page in the app (admins, bans, chat, kills, players, etc. all carry `downloadStat`). Server-side statistics are visualized only, not exportable from the UI here — a competitive gap worth beating.

---

### 5. Forms & Controls

No `<form>` element; two standalone controls at the top of `#stat_wrapper`:

**5.1 Date range — `#stat_date`** (`<button type="daterange">`)
- Initialized via `.dateRange({...})` plugin.
- Preset options offered: `justMonth`, `justDay`, `justWeek`, `justYear`, `range` (custom), `today`, `yesterday`, `currentWeek`, `lastWeek`, `currentMonth`, `lastMonth`, `last30days`.
- **Default:** `last30days`.
- Emits `crm_dateRange` event → calls `getStatistic()`. Exposes `data-start` / `data-end` consumed by the RPC.

**5.2 Server multiselect — `#stat-server`** (`<select multiple>` → Bootstrap `multiselect`)
- Options are the six configured servers (value = server id, label = full name), **all selected by default**.
- Placeholder when empty: `- Сервер -`.
- `enableHTML: true`.
- Change is **debounced to dropdown close**: an `onChange` flag is set, and `getStatistic()` only fires in `onDropdownHide` if something actually changed — avoids one RPC per checkbox toggle. Good UX pattern to copy.

**Loading state:** during a fetch, the date button is disabled, the multiselect is disabled (`.multiselect('disable')`), `#stat_wrapper` gets class `load`, and a spinner overlay (`.load_block` with `fa-spinner fa-pulse`) shows. Controls re-enable on completion. Charts are updated inside `Promise.all([...])` so all redraw together.

---

### 6. Permission / Visibility Logic

- No `class="hide"`, role checks, or group gating are present within the fragment itself. Access control is enforced upstream: whether the `statistics` nav item is rendered and whether `POST /ajax/squad.php action=statistics` is authorized is decided server-side (not visible in this fragment).
- The server list injected into `servers` is pre-filtered server-side to the servers this operator may view — the client trusts and iterates it directly.
- The commented-out `chartKits`/`chartUnique` cards are hidden by HTML comment, not by permission class.

---

### 7. Chart Inventory & Notable UX / Competitive Details

Full rendered chart list (title text is Russian in-source; English gloss added):

| Canvas id | Type | Title (RU → EN) | Grid width | Series model |
|---|---|---|---|---|
| `chartOnline` | bar (stacked) | Средний онлайн (10:00 - 03:00) → Average online (10:00–03:00) | col-6 | per-server |
| `chartOnlineMax` | bar (stacked) | Максимально игроков (с очередью) → Peak players (incl. queue) | col-6 | per-server |
| `chartAdmins` | line | Среднее кол-во админов (10:00 - 03:00) → Avg admins online | col-4 | single |
| `chartAdminsMax` | bar | Максимально админов → Peak admins | col-4 | single |
| `chartBans` | bar | Выдано наказаний → Punishments issued | col-4 | single |
| `chartOnlineHour` | bar (stacked) | Средний онлайн по часам дня → Avg online by hour of day | col-6 | per-server |
| `chartOnlineDay` | bar (stacked) | Средний онлайн по дням недели → Avg online by weekday | col-6 | per-server |
| `chartMaps` | bar | Количество карт (не Skirmish или Seed) → Map counts (excl. Skirmish/Seed) | col-8 | single |
| `chartModes` | doughnut | Game-mode distribution | col-4 | single |
| `chartNew` | bar | Новых игроков → New players | col-7 | single |
| `chartChat` | bar (stacked) | Сообщений чата → Chat messages | col-5 | per-server |
| `chartTeamkill` | bar (stacked) | Тимкиллы → Teamkills | col-6 | per-server |
| `chartQueue` | bar (stacked) | Очередь → Queue | col-6 | per-server |
| `chartGames` | bar (stacked) | Игр → Matches | col-6 | per-server |
| `chartKills` | bar (stacked) | Убийств → Kills | col-6 | per-server |
| `chartDeaths` | bar (stacked) | Смертей → Deaths | col-4 | per-server |
| `chartRevivals` | bar (stacked) | Поднятий → Revives | col-4 | per-server |
| `chartWounds` | bar (stacked) | Ранений → Wounds | col-4 | per-server |
| `chartKits` *(disabled)* | horizontalBar | Количество китов → Kit count | — | single |
| `chartUnique` *(disabled)* | bar | Уникальных игроков → Unique players | — | single |

Competitively interesting details:

- **Subtitle stat strip:** every time-series chart computes and displays a subtitle line reading `Среднее: <avg>, Максимум: <max>, Всего: <total>` (Average / Maximum / Total), computed client-side via helper array methods `.average()`, `.max()`, `.sum()`, and `.sum2d()` (for stacking per-server series into a per-day total). Totals are formatted with `Intl.NumberFormat("en-US")` (thousands separators). This gives at-a-glance KPIs without a separate stat panel.
- **Business-hours windowing:** several titles hard-code the analysis window **10:00–03:00**, i.e. the servers' active hours — averages deliberately exclude dead night hours to avoid diluting "average online". A subtle but meaningful methodology choice to replicate.
- **Map chart explicitly excludes Skirmish and Seed layers** from "real match" counts — separating warmup/seeding from competitive rounds.
- **Consistent per-server coloring:** a fixed `colors[]` palette indexed by server id keeps a server the same color across all charts, aiding cross-chart reading.
- **Coordinated redraw:** all charts update inside a single `Promise.all`, so the dashboard refreshes atomically rather than popping in piecemeal.
- **Debounced multi-server filter** (fires only on dropdown close) minimizes RPC chatter.
- **Gaps vs. a competitor build:** no export/download, no drill-down from chart to underlying rows, seeding volume not charted as its own metric (only inferred via queue/online), playtime hours not directly charted, and the Kits/Unique-players charts are shipped-but-disabled. These are low-hanging features to differentiate on.


---

## 12. Match History (Игры)

### 1. Purpose & Navigation

The **Игры** (Games / Match History) page is a searchable log of every match (round) played across all monitored Squad servers. It answers "which layer was played, on which server, when, and who won by how many tickets." Each row is a completed (or in-progress) round; clicking a row drills into a full per-match detail page.

- **Nav id / entry point:** `pageLoad('games')` → `GET /ajax/page.php?page=games`, HTML fragment injected into `#content`.
- **Fragment file analyzed:** `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/games.html` (110 lines).
- **Layout:** a fixed left filter sidebar (`col-md-3`, `position:fixed`) plus a wide results panel (`col-md-9`) holding table `#games`.
- **Data source:** the table is populated client-side via the shared `buildTable()` helper (defined in `custom.js`), which issues a server-side-paginated request to the `table` script endpoint. There is **no** `<form>` POST and **no** page-specific `Action()` mutation on this page — it is a **read-only reporting screen**.

---

### 2. Entities & Fields

#### 2.1 Entity: `Game` (a match / round) — the page's list rows

Inferred from the `collum` array in `buildTable`, the `<thead>`, and the row fields referenced by the render callbacks (`row.t1_tickets`, `row.t2_tickets`, `row.win`, `this.dataset.id`).

| Field | Column key | Type | Meaning |
|---|---|---|---|
| Server | `server` | int (server_id) | Which monitored server hosted the round; rendered as `[<id>]` in a `<code>` chip. Filterable via multiselect. |
| Map / Layer | `map` | string | The Squad layer name (e.g. `Gorodok_RAAS_v1`). Free-text searchable via `t1.map`. |
| Start | `start` | datetime (epoch) | Round start timestamp; rendered with `formatDate(data, true, true)`. Also the date-range filter key (`t1.start`). |
| End | `end` | datetime (epoch) | Round end timestamp; same date formatting. Empty/ongoing rounds render blank. |
| Team 1 name | `t1` | string | Faction/team-1 label. Rendered as a ticket badge + name. |
| Team 2 name | `t2` | string | Faction/team-2 label. Rendered as a ticket badge + name. |
| Team 1 tickets | `t1_tickets` | int | Remaining tickets for team 1 at round end. Not a separate column; injected into the `t1` cell as a colored label. |
| Team 2 tickets | `t2_tickets` | int | Remaining tickets for team 2. Injected into the `t2` cell. |
| Duration | `time` | int (seconds) | Round length; rendered `secToTime(data)` inside a dark `<code>` chip. |
| Winner | `win` | enum `'t1' | 't2' | null` | Which team won. Drives the green/red coloring of the ticket badges and the trophy column. |
| Match id | (row `id`) | int | Primary key of the game row. Not shown as a cell; carried on `tr[data-id]` and used to navigate to `/game/<id>`. |

Note the win/ticket coloring logic couples three raw fields into two display cells:
- `t1` cell: `<span class="label label-{success if win=='t1' else danger}">{t1_tickets}</span> {t1_name}`.
- `t2` cell: mirror image keyed on `win=='t2'`.
- `win` cell (trophy): shows the winner label as a green `label-success` badge, or a neutral `—` (`fa-minus`) badge when `win` is falsy (draw / unfinished).

#### 2.2 Entity: `Server` (filter option source)

Rendered as `<option value=... label=...>` inside the `#games-server` multiselect. `value` = `server_id`, `label` = human server name.

| server_id | Label (name) |
|---|---|
| 1 | RAAS/AAS #1 |
| 6 | БЕЗ ГОЛОСОВАНИЯ #2 (No Voting #2) |
| 7 | INVASION #3 |
| 9 | Custom для FW (Custom for FW) |
| 10 | Custom для MDC (Custom for MDC) |
| 11 | Custom для BSS (Custom for BSS) |

This list is a useful competitive artifact: it reveals the rival's live server fleet, their game modes, and that server ids are sparse/non-contiguous (1, 6, 7, 9, 10, 11 — implying deleted/retired servers 2–5, 8).

#### 2.3 Entity: `Match Detail` (per-match player performance) — NOT in this fragment

Row click executes a **full browser navigation**, not an AJAX `pageLoad`:

```js
$('#games tbody > tr').on('click', function(){
    window.location.href = '/game/' + this.dataset.id;
});
```

So the per-match detail view (per-player kills/deaths/score, team rosters, ticket graph, etc.) is a **separately routed, server-rendered page** at `/game/<id>` and is **not** part of this captured fragment. Its schema cannot be documented from the local files — see Gaps.

---

### 3. The Page's Own Table (`#games`)

Configured by a single `buildTable()` call:

```js
$('#games').buildTable({
    table: 'games',
    collum: ["server","map","start","end","t1","t2","time","win"],
    numrows: 100,
    searchInput: ["games-map","games-date","games-server"],
    mode: 'table'
});
```

**Displayed columns (in order):**

| # | Header | Icon | Column key | Render |
|---|---|---|---|---|
| 1 | (server) | `fa-server` | `server` | `[<id>]` code chip |
| 2 | Карта (Map) | — | `map` | raw layer string |
| 3 | Начало (Start) | — | `start` | `formatDate` |
| 4 | Конец (End) | — | `end` | `formatDate` |
| 5 | Команда 1 (Team 1) | — | `t1` | ticket badge + name |
| 6 | Команда 2 (Team 2) | — | `t2` | ticket badge + name |
| 7 | (duration) | `fa-clock` | `time` | `secToTime` chip |
| 8 | (winner) | `fa-trophy` | `win` | winner badge / `—` |

**Pagination:** server-side, `numrows: 100` rows per page. A second `table` request with `&pagination=true` returns `totalPage` / `totalRows` and renders a numeric pager (`#games-infoblock`) showing `Страница X из Y · Всего: N` (Page X of Y · Total: N). `showPages` = 9 on desktop, 3 on mobile.

**Sorting:** the generic `buildTable` supports header-click sorting (`order_by` / `order_sort` asc/desc) **only** for columns listed in `settings.order` and only when a `<th>` carries an `i[data-sort]` marker. This page passes **no `order` option**, so sorting is effectively disabled here — the list is server-ordered (implicitly newest-first by start). This is a gap worth beating: a competitor should make every column sortable.

**Row interaction:** whole-row click → navigate to `/game/<id>` (see 2.3). No inline row actions, checkboxes, or bulk operations.

---

### 4. Actions & Admin Capabilities

This page exposes **no state-changing actions**. It is purely read/report. The only backend call is the DataTables-style row fetch.

| UI element | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Table load / Поиск (Search) button `#games-btn` | `games` (table name used as action) | `POST /ajax/table.php` | `action=games&table=games&page=<n>&numrows=100&search=<urlencoded JSON>&order_by=<>&order_sort=<>` | Returns paginated match rows (`text.data.row[]`, `data.currentPage`) | **N** (read) |
| Pagination click | `games` | `POST /ajax/table.php` | same + `&pagination=true` | Returns `totalPage`, `totalRows` for the pager | **N** (read) |

The `search` payload is a URL-encoded JSON object of the form `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. For this page it carries:
- `text["t1.map"]` — map substring,
- `text["t1.start.startdate"]` / `text["t1.start.enddate"]` — date range bounds,
- `multiselect["server_id"]` — array of selected server ids.

Note the `t1.` / `server_id` prefixes are raw SQL-ish table aliases leaking through to the client — a hint that the backend builds `WHERE` clauses directly from these `data-search` keys (potential injection surface to probe, and a naming convention to mirror or avoid).

---

### 5. Forms, Filters & Controls (left sidebar)

There is no `<form>`; filters are loose inputs wired into `buildTable` via `searchInput: ["games-map","games-date","games-server"]`. Pressing Enter in the text field, changing the date range, or clicking **Поиск** rebuilds the table (`page:1, isSearch:true`).

| Control | id | Type | `data-search` key | Behavior |
|---|---|---|---|---|
| Поиск (Search) button | `games-btn` | button | — | Triggers a filtered rebuild; shows "Ищем" (Searching) load state. |
| Карта (Map) | `games-map` | text input (`fa-map` addon) | `t1.map` | Substring match on layer name; submits on Enter. |
| Server multiselect | `games-server` | Bootstrap multiselect (`type=multiselect`, `multiple`) | `server_id` | Multi-pick from the 6 servers; placeholder `- Сервер -`; `enableHTML:true`. |
| Date range | `games-date` | custom `dateRange` widget (`type=daterange`) | `t1.start` | Presets: month, day, week, year, custom range, today, yesterday, current/last week, current/last month, last 30 days. Default `allTime` (start:0,end:0). Fires `crm_dateRange` → rebuild. Splits into `.startdate`/`.enddate`. |

**Validation:** none client-side; empty inputs are simply omitted from the search JSON (`if(val != "")`). The `+` character is escaped to `%2B` before submission (multiselect and text values) to survive form-encoding.

---

### 6. Permission / Visibility Logic

- This fragment contains **no** `class="hide"` gating, no role/group checks, and no `Action`-guarded buttons. Every authenticated viewer who can reach the page sees the full match log and all six servers.
- Access control is therefore entirely upstream: whether `pageLoad('games')` is offered in the nav and whether `/ajax/table.php?action=games` authorizes the caller. Nothing here narrows visibility by admin group.
- Contrast with the shared player-detail modal (embedded elsewhere) whose ~22 moderation actions are permission-sensitive — none of those appear on this read-only page.

---

### 7. Notable UX & Competitive Notes

- **Ticket-as-badge encoding.** Remaining tickets are shown as a colored pill fused onto each team name (green = winner, red = loser), so the outcome and margin read at a glance without a separate "score" column. Clean, copyable pattern.
- **Trophy column doubles as draw indicator.** A single `fa-trophy` column shows the winning faction, degrading to a neutral `—` when `win` is null (draw/ongoing) — compact status signaling.
- **Fixed filter rail.** The sidebar is `position:fixed`, staying pinned while the (up-to-100-row) result set scrolls — good for large logs; note it can collide with content on short viewports (`mobile-left` class hints at a mobile reflow).
- **Rich date presets.** The `dateRange` widget ships ~11 presets (today/yesterday/this-week/last-30-days/…) plus custom range — a strong baseline to match or exceed.
- **Server-side pagination with async page-count.** Row fetch and total-count are two separate requests; the count request is deferred and logged with timing (`Подсчёт страниц занял …`), keeping first paint fast on huge tables. Worth replicating for scale.
- **Weaknesses to beat:** (1) no column sorting wired up; (2) no CSV/stat export on this page (the rival exposes `downloadStat` elsewhere, not here); (3) raw SQL alias keys (`t1.map`, `t1.start`, `server_id`) sent from the client suggest thin server-side validation — a competitor should use opaque filter keys and parameterized queries; (4) match detail lives on a full page reload (`/game/<id>`) rather than an in-app modal/route, breaking the SPA flow.

---

### Gaps / Unknowns

- **Per-match player performance schema is not in these files.** The detail view is a server-rendered route `/game/<id>`; its columns (per-player kills/deaths/score, rosters, ticket timeline) cannot be documented from the captured fragment. Requires capturing `/game/<id>` HTML.
- **Exact backend column mapping** for `t1`/`t2`/`t1_tickets`/`win` (table/JOIN structure) is inferred from client keys only; the `table.php` server logic was not provided.
- **Sort defaults** (implicit ordering) are assumed newest-first but not confirmed server-side.


---

## 13. Combat Logs: Kills, Deaths, Revives, Damage, Teamkills

### 13.1 Purpose and Navigation

SQSTAT exposes five near-identical combat-event log pages, each a filterable, server-side-paginated table over one class of in-game combat event. They are separate nav entries that call `pageLoad('<page>')` → `GET /ajax/page.php?page=<page>`, each returning an HTML fragment injected into `#content`.

| Page id | Fragment file | Table DOM id | Event logged |
|---|---|---|---|
| `kills` | `kills.html` | `#playerKills` | A player killed another player (weapon recorded) |
| `deaths` | `deaths.html` | `#playerDeath` | A player died (subject + weapon that killed them) |
| `revives` | `revives.html` | `#playerRevive` | A medic revived a downed player |
| `damages` | `damages.html` | `#playerDamage` | A damage-dealt event (attacker, victim, weapon) |
| `teamkills` | `teamkills.html` | `#playerTeamkill` | A friendly-fire kill (attacker + victim, same team) |

All five share the identical two-pane layout: a fixed left filter rail (`col-md-3`, `position:fixed`) and a right results table (`col-md-9`). All five also embed the shared **player-detail modal** (`#player_info`, `#playerModal`) with its Chat/Kills/Deaths/Kits/Games/Comments tabs and ~22 actions. That modal is documented separately; below, the page's OWN table/controls are strictly separated from the shared modal, and the modal's columns (Чат/Сообщение/Кит/Карта/Победа/Урон etc.) are NOT attributed to these pages.

### 13.2 Data Model (inferred)

Each row of a combat log is a **combat event** joining an event table to one or two **player** records. The client column keys (`collum` array in `buildTable`) plus the row template reveal the fields.

**Combat event entity (per row)**

| Field key | UI column | Meaning / type | Present in |
|---|---|---|---|
| `steam_id` | (hidden, `class="hide"`) | SteamID64 of the primary/subject player; used to open the player modal on row click | all 5 |
| `victim_steam_id` | (hidden, in row template) | SteamID64 of the secondary player (the "Кого"/victim); makes the target clickable | kills (confirmed in template); implied for damage/revive/teamkill |
| `server` | server icon column | Server the event occurred on (rendered as an icon/badge; backing value is `server_id`) | all 5 |
| `date` | Дата (Date) | Event timestamp; rendered client-side via `formatDate(data,false,true)` | all 5 |
| `player_name` | Кто (Who) / Игрок (Player) | Display name of the primary actor (killer / medic / attacker / the deceased) | kills, deaths, revives, damages |
| `player` | Кто (Who) | Same role as `player_name` but keyed `player` on the teamkill table | teamkills |
| `name` | Кого (Whom) | Display name of the secondary player (victim / revived player) | kills, revives, damages |
| `killed` | Кого (Whom) | Same role as `name` but keyed `killed` on the teamkill table | teamkills |
| `weapon` | Оружие (Weapon) | Weapon/entity used | kills, deaths, damages |

**Server entity (filter `<option>` set, shared across all 5 pages)**

| server_id | Label |
|---|---|
| 1 | `RAAS/AAS #1` |
| 6 | `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2) |
| 7 | `INVASION #3` |
| 9 | `Custom для FW` |
| 10 | `Custom для MDC` |
| 11 | `Custom для BSS` |

Note the id gap (no 2–5, 8): the server list is filtered to this panel's own servers.

**Underlying SQL join aliases (leaked via `data-search`).** The filter inputs carry raw table-alias.column references, exposing the server-side query shape. The same physical event table is joined to player tables under different aliases depending on which side each page treats as "primary":

| Page | "Кто" filter → | "Кого" filter → | Date → |
|---|---|---|---|
| kills | `t2.player` | `t4.player` | `t1.date` |
| deaths | `t5.player` | `t2.player` | `t1.date` |
| revives | `t5.player` | `t2.player` | `t1.date` |
| damages | `t2.player` | `t5.player` | `t1.date` |
| teamkills | `t5.player` | `t2.player` | `t1.date` |

`t1` is the event row (holds `date`, `server_id`); `t2`/`t4`/`t5` are player joins. This confirms combat events are stored once and both parties resolved by join, and it exposes internal schema aliases to the client (a competitive/security note — our panel should not leak raw SQL identifiers into `data-search`).

### 13.3 Page-Own Tables

The primary results table is DataTables-style but driven by SQSTAT's custom `$.fn.buildTable` (in `custom.js`), which fetches rows server-side. The first `<thead class="table-dark">` in each fragment is the page's own table; every later `<thead>` in the file belongs to the shared player-detail modal tabs and is out of scope here.

**Kills — `#playerKills`** (`numrows: 500`)

| # | Column (icon/label) | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (`class="hide"`) | `steam_id` | Hidden; drives modal open |
| 2 | server icon | `server` | 50px, centered |
| 3 | Дата (Date) | `date` | 130px |
| 4 | user icon + Кто (Who) | `player_name` | Killer |
| 5 | crosshairs + Кого (Whom) | `name` | Victim |
| 6 | gun icon + Оружие (Weapon) | `weapon` | |

**Deaths — `#playerDeath`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Subject (the player who died) |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Игрок (Player) | `player_name` | The deceased player |
| 5 | gun + Оружие (Weapon) | `weapon` | Weapon that killed them |

Deaths shows only 5 columns (no explicit "killer" column) yet its filter rail still offers both Кто/Кого inputs — the killer is filterable but not displayed as a table column.

**Revives — `#playerRevive`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Reviving medic |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player_name` | Medic |
| 5 | crosshairs + Кого (Whom) | `name` | Revived player |

No weapon column (revives have no weapon).

**Damages — `#playerDamage`** (`numrows: 500`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Attacker |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player_name` | Attacker |
| 5 | crosshairs + Кого (Whom) | `name` | Victim |
| 6 | gun + Оружие (Weapon) | `weapon` | |

Notable: the damages table does **not** surface a numeric damage-amount column, even though the shared modal's own "damage" tab has a Урон (Damage) column. Damage magnitude exists in the model but is omitted from this page's grid — an easy win for a competing panel (show/sort by damage).

**Teamkills — `#playerTeamkill`** (`numrows: 100`)

| # | Column | Data key | Notes |
|---|---|---|---|
| 1 | SteamID (hidden) | `steam_id` | Offender (teamkiller) |
| 2 | server | `server` | |
| 3 | Дата | `date` | |
| 4 | user + Кто (Who) | `player` | Offender |
| 5 | crosshairs + Кого (Whom) | `killed` | Team victim |

Teamkills uses a lower page size (`numrows: 100` vs 500) and distinct data keys (`player`/`killed` instead of `player_name`/`name`). No weapon column. There is **no dedicated teamkill flag, punishment, forgive, or auto-action UI** on this page — it is a passive log; teamkills are simply the event class filtered to friendly-fire. Enforcement, if any, happens only via the shared modal's ban/kick actions against the offender.

### 13.4 Filters, Search, Sort, Pagination

Left rail controls (identical structure across all five pages; ids prefixed with the table id, e.g. `playerKills-*`):

| Control | id suffix | Type | `data-search` key | Behavior |
|---|---|---|---|---|
| Поиск (Search) button | `-btn` | button | — | Triggers `buildTable()` re-fetch |
| Кто (Who) | `-name` | text | `t2.player` / `t5.player` (page-specific) | Substring match on primary player name; Enter key submits |
| Кого (Whom) | `-killed` | text | `t4.player` / `t2.player` / `t5.player` | Substring match on secondary player name |
| Сервер (Server) | `-server` | Bootstrap multiselect (`multiple`) | `server_id` | IN-list filter; placeholder `- Сервер -`; `enableHTML` |
| Date range | `-date` | `dateRange` button | `t1.date` | Range picker; presets: `justMonth, justDay, justWeek, justYear, range, today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days`; default `allTime` |

Search assembly (`buildTable`, custom.js): filters are collected into a structured object `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` keyed by the raw `data-search` value, URL-encoded (`+` → `%2B`), and sent as the `search` param. Text inputs submit on Enter (`e.which==13`); the date picker re-fetches on its `crm_dateRange` event.

**Fetch mechanism.** `buildTable` issues `Action({script:'table', action:'<tableName>', data:'&table=<tableName>&page=<n>&numrows=<n>&search=<json>&order_by=<col>&order_sort=<dir>'})` → `POST /ajax/table.php`. Pagination is a second `script:'table'` call with `&pagination=true` returning `totalPage`/`totalRows` and a server-timed count (`count_time` logged to console). Sorting is supported by the engine (`order_by`/`order_sort`) but these pages ship with no explicit `order` config, so default server ordering applies. Row fetch timeout is 120 s. Client-side rebuild guard (`tmpTable`) prevents concurrent double-loads of the same table.

### 13.5 Row Interactions & Templates

- **Row click** → `player.open(<steam_id from hidden cell>)`: opens the shared player-detail modal for the primary actor. Wired on all five pages.
- **Kills page only** additionally binds `[data-action="player"]` buttons so the *victim* is also clickable (`player.open` on `victim_steam_id`), and defines a custom mobile-list `kill_template` (`#kill_template`) with `mode: isMobile ? 'list':'table'` and a `date` render callback. The other four pages use the default table renderer, bind only the primary `steam_id` click, and rely on the default responsive table (no bespoke list template). So on kills the target is directly openable; on damages/revives/teamkills only the primary subject is one-click openable from the grid.

### 13.6 Actions / Admin Capabilities

**Page-owned actions (originate on the combat pages themselves):**

| UI label | action id | script → endpoint | Data params | Effect | Destructive |
|---|---|---|---|---|---|
| (implicit) load rows | `<tableName>` (e.g. `playerKills`) | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` | Fetch/paginate log rows | N |
| Скачать статистику (Download statistics) | `downloadStat` | `player` → `/ajax/player.php` | `steam_id` | Triggers a stat-export download (`post_to_url`, form-submit) for the opened player | N (read/export) |

The only mutation surface reachable from these pages is via the **shared player-detail modal** opened on row click. Those are not combat-log features per se, but they are the admin capabilities exposed *through* this screen. Summarized (all present in these fragments' embedded modal):

| Modal action | script → endpoint | Destructive | Purpose |
|---|---|---|---|
| `ban` | `squad` → `/ajax/squad.php` | Y | Ban player (`server_id, steam_id, reason_id, description, days`) |
| `kick` | `squad` | Y | Kick from server |
| `kill` | `squad` | Y | Force-kill in game |
| `changeTeam` | `squad` | Y | Move player to other team |
| `changeGroup` | `player` | Y | Change admin/permission group |
| `removePlayer` | `squad` | Y | Remove player from squad/server |
| `unban` | `squad` | Y | Lift ban |
| `mark` | `player` | Y | Flag/mark player |
| `message` | `player` | Y | Send in-game message |
| `addComment` / `getComments` | `player` | Y / N | Admin comments on player |
| `addBanName` / `removeBanName` | `player` | Y | Manage forbidden-name list |
| `checkBans` | `player` | N | Cross-check ban status |
| `twink` / `twinkOnline` | `player` | N | Alt-account (twink) detection |
| `findFriends` | `player` | N | Social-graph lookup |
| `kits` / `kitSave` | `player` | N / Y | Player kit history / save |
| `getPlayerOnlineData` | `player` | N | Online-time chart data |

(Full modal spec belongs to the shared-modal section; listed here only to document what an admin can do while triaging a combat-log entry.)

### 13.7 Permission / Visibility Logic

- No role/group gating is expressed in these fragments' page-own markup — the filter rail, table, and Download-statistics link are unconditionally present. Access control to the pages themselves is enforced server-side (`page.php`) and to mutations server-side (`squad.php`/`player.php`); the `Action` wrapper reloads the page if a response carries `auth:true` (session/permission failure).
- `class="hide"` is used purely for layout/data plumbing (hidden `steam_id`/`victim_steam_id` cells, hidden `#player_info` template), not for role-based visibility on these pages.
- Server multiselect is pre-populated only with this tenant's six servers, implicitly scoping every query to servers the admin owns.

### 13.8 Competitively Interesting Details

- **Five separate pages for one event model.** Kills/deaths/revives/damages/teamkills are the same joined event table re-projected. A competing panel could unify these into one "Combat Log" view with an event-type facet, cutting nav clutter and code duplication.
- **Damage magnitude is captured but never shown** on the damages grid (only the killer/victim/weapon). Surfacing and sorting by actual damage numbers is a clear differentiator.
- **Teamkills is a passive log** — no forgive/punish/auto-kick/teamkill-count workflow, no per-player TK tally on the page. Friendly-fire moderation tooling (thresholds, auto-flag, repeat-offender surfacing) is an obvious gap to beat.
- **Big page sizes** (`numrows: 500` for most, 100 for teamkills) with a separate count query per page — heavy for large servers; cursor/keyset pagination would outperform.
- **Raw SQL aliases leak to the client** via `data-search="t2.player"` etc. This is both a maintenance smell and a mild info-leak; our panel should map filters to opaque field names server-side.
- **Consistent UX**: fixed filter rail, icon-labeled columns, one-click row → rich player modal with immediate moderation actions. The row→modal→ban/kick flow is tight and worth matching. Weakness: on non-kills pages only the primary player is clickable from the grid; making every named party openable everywhere is a small, high-value polish.
- **Date presets** are generous (12 range presets incl. `allTime` default) — a good baseline to match.


---

## 14. Votes & Reports

Competitive analysis of the SQSTAT admin panel's **Votes log** (`votes`) and **player Report system** (`reports`). Both are read/monitor pages built on the same client-side `buildTable` engine (server-side paginated data), rendered as a scrollable **list-group of cards** (not a classic `<table>`), and both embed the shared player-detail modal that carries all the mutating admin actions.

Source fragments analyzed:
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/votes.html`
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/frags/reports.html`
- Client engine: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/custom.js` (`$.fn.buildTable`, lines ~605–1090)

---

### 14.1 Purpose & Navigation

| Page | Nav id | Loaded via | Purpose |
|------|--------|-----------|---------|
| Votes | `votes` | `pageLoad('votes')` → `GET /ajax/page.php?page=votes` | Historical log of in-game votes (map change / re-roll / skip votes). Shows who triggered the vote, on what server, whether it passed or was cancelled, current/next/target map, and the yes-count vs. threshold. |
| Reports | `reports` | `pageLoad('reports')` → `GET /ajax/page.php?page=reports` | Log of player-submitted in-game reports (the Squad `!report` / admin-request flow). Shows the reported player, the report text, server, and timestamp, with a one-click jump into the reported player's full admin card. |

Both pages share a **two-column layout**: a `position:fixed` left sidebar (240px) with filters, and a right `col-md-8` content area holding the results list (`#votes_list` / `#reports_list`, a `<ul class="list-group">`).

---

### 14.2 Data flow / rendering engine

Neither page renders rows with `<thead>/<th>`. Instead:

- A hidden `<div id="template" class="hide">` holds a single `<li>` card whose child elements carry `data-table="<field>"` attributes. `buildTable` clones this template per row and fills each `data-table` placeholder from the server response.
- Config is passed inline: `$('#votes_list').buildTable({ table: 'votes', mode: 'custom', numrows: 30, template: $('#template > li'), searchInput: [...] })` (reports uses `table: 'reports'`).
- Row data is fetched with the standard RPC helper: `Action({ script: 'table', action: '<votes|reports>', data: <query> })` → **POST `/ajax/table.php`** with `action=votes` (or `reports`). Pagination issues the same call with `&pagination=true` to get `totalPage` / `totalRows`.
- Page size is fixed at **30 rows**; server-side pagination renders numeric page links plus first/prev/next/last.
- The `<th>` elements present in both fragments belong exclusively to the **shared player-detail modal** (Chat/Kills/Deaths/Kits/Games/Damage tabs: Дата, Чат, Сообщение, Убил, Кит, ID, Название, Карта, Победа, Игрок, Оружие, Поднял, Урон, Техника). They are NOT columns of the votes/reports lists and must not be attributed to these pages.

Search is assembled client-side into a JSON object grouped by input type — `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` — keyed by each input's `data-search` attribute, then `encodeURIComponent(JSON.stringify(...))` and sent in the table query. Text inputs submit on Enter (keypress 13) or the search button; multiselect submits on change.

---

### 14.3 Votes page

#### 14.3.1 Entity: Vote log record

Fields inferred from the `#template` card's `data-table` placeholders:

| Field (`data-table`) | UI label | Meaning / type |
|----------------------|----------|----------------|
| `short` | shown in `<kbd>[…]</kbd>` | Server short tag / vote-type short code (e.g. server prefix badge). |
| `name` | bold player name | Display name of the vote **initiator**. |
| `steam_id` | `<hashtag>` | Initiator's SteamID64; also fed to `player.open()` when the **открыть (open)** button is clicked. |
| `date` | right-aligned | Timestamp of the vote. |
| `cancel` | **Статус (Status)** | Vote outcome/status (e.g. passed vs. cancelled/aborted). Rendered as-is from server. |
| `mode` | **Режим (Mode)** | Vote type/mode (map change, skip, re-roll, etc.). |
| `players_sum` | **Набралось (Collected)** | Number of yes-votes actually gathered. |
| `players_need` | **Необходимо (Required)** | Threshold of votes required to pass. |
| `map_current` | **Текущая (Current)** | Current map at time of vote. |
| `map_next` | **Следующая (Next)** | Next map in rotation. |
| `map_vote` | **На какую (Target)** | Map the vote is proposing to switch to. |
| `map_current_img` | (image) | Thumbnail for current map. |
| `map_next_img` | (image) | Thumbnail for next map. |

This is a rich, purpose-built vote-audit record: initiator identity + result + threshold math + map context (current → next → proposed) with map thumbnails.

#### 14.3.2 Votes list controls (page's own controls)

| Control | id / attr | Type | `data-search` | Effect |
|---------|-----------|------|---------------|--------|
| Server filter | `#votes-server` | `multiselect` (bootstrap-multiselect, placeholder `- Сервер -`) | `server_id` | Filters votes to selected server(s); rebuilds the list on change. |

Server options (shared across both pages) are the project's live servers, e.g. `RAAS/AAS #1` (id 1), `БЕЗ ГОЛОСОВАНИЯ #2` (id 6), `INVASION #3` (id 7), `Custom для FW` (9), `Custom для MDC` (10), `Custom для BSS` (11).

- **No text search and no explicit search button** on the votes sidebar — filtering is server-multiselect only.
- Pagination: 30/page, numeric + first/prev/next/last, with a "Страница X из Y · Всего: N" info footer.

#### 14.3.3 Votes page actions

| Label | Trigger | Endpoint | Data | State-changing? |
|-------|---------|----------|------|-----------------|
| **открыть (open)** | `a[data-type="btn_open"]` click → `player.open(steam_id)` | POST `/ajax/player.php` `action=get` | `steam_id` | N (read) — opens the shared player modal for the initiator |

The votes page itself has **no destructive actions**; all mutations come from the shared modal (§14.5).

---

### 14.4 Reports page

#### 14.4.1 Entity: Report record

Fields inferred from the `#template` card:

| Field (`data-table`) | UI label | Meaning / type |
|----------------------|----------|----------------|
| `short` | `<kbd>` badge | Server short tag / report code. |
| `date` | right-aligned | Report timestamp. Formatted client-side via `callback.date → formatDate(data, false, true)`. |
| `player_name` | bold | Display name of the **reported (target) player**. |
| `steam_id` | `<hashtag>` | Target player's SteamID64; drives the **открыть (open)** button → `player.open()`. |
| `text` | `<p>` block | Free-text body of the report (the reason/description submitted in-game). |

**Data-model note (JOIN aliases):** the reports search inputs use qualified aliases — `t1.text` (report row: the message text) and `t2.player` (joined player row: name/SteamID). This reveals the server query joins a **reports table (t1)** to a **players table (t2)**. The rendered card surfaces the target player and the report text; the reporter's identity is not exposed in the card template (either not shown in this list or stored server-side only).

#### 14.4.2 Reports list controls (page's own controls)

| Control | id / attr | Type | `data-search` | Effect |
|---------|-----------|------|---------------|--------|
| **Поиск (Search)** button | `#reports_list-btn` | button (`fa-search`) | — | Submits the current filter set; re-fetches page 1 with `isSearch=true`. |
| Name/SteamID filter | `#reports-name` (placeholder "Ник или SteamID") | text | `t2.player` | Filter by reported player's nick or SteamID (submits on Enter or via search button). |
| Text filter | `#reports-killed` (placeholder "Текст") | text | `t1.text` | Full-text search over report body. |
| Server filter | `#reports-server` | `multiselect` (`- Сервер -`) | `server_id` | Filter by server(s); rebuilds on change. |

Note the `#reports-killed` element id is a copy-paste artifact from a kill-log page; its actual bound field is `t1.text` (report text), not a kill.

Pagination identical to votes: 30/page, numeric + edges, totals footer.

#### 14.4.3 Reports page actions

| Label | Trigger | Endpoint | Data | State-changing? |
|-------|---------|----------|------|-----------------|
| **открыть (open)** | `a[data-type="btn_open"]` → `player.open(steam_id)` | POST `/ajax/player.php` `action=get` | `steam_id` | N (read) — opens the target player's admin card |

Reports has **no report-lifecycle mutation of its own** in this fragment — no "resolve / close / assign / mark-handled" action on the report entity. Handling a report is done by opening the reported player and applying a modal action (kick/ban/message), plus optionally logging a canned "Ваш репорт рассматривается модерацией" message. This is a notable gap to beat (see §14.7).

---

### 14.5 Shared player-detail modal (mutating admin capabilities)

Both pages embed the standard `#playerModal`. Clicking **открыть** loads the player via `action=get` and renders the card, which flips to sub-panels for punishment, group change, and messaging. These are the actual admin **permissions/capabilities** reachable from votes & reports. All identical across the panel; documented here because they are the only state-changing surface on these two pages.

| Capability | UI | Script endpoint | Action | Key data params | Destructive? |
|-----------|----|-----------------|--------|-----------------|--------------|
| Load player card | открыть | `/ajax/player.php` | `get` | `steam_id` | N |
| Kick from server | Наказание panel, radio `data-action=kick` (value -1) | `/ajax/squad.php` | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | Y |
| Ban (temp/perm) | Наказание radios `data-action=ban` `data-day` 1/2/3/4/5/6/7/10/14/30/0 | `/ajax/squad.php` | `ban` | `server_id` (if online), `steam_id`, `reason_id`, `description`, `days` (`-1`/`value` = permanent) | Y |
| Unban | Разбанить dialog | `/ajax/squad.php` | `unban` | `steam_id`, `unban` (bool — true = fully erase ban) | Y |
| Remove from squad | Выкинуть из сквада | `/ajax/squad.php` | `removePlayer` | `server_id`, `steam_id` | Y |
| Switch team | Сменить команду | `/ajax/squad.php` | `changeTeam` | `server_id`, `steam_id` | Y |
| Kill player | Убить игрока | `/ajax/squad.php` | `kill` | `server_id`, `steam_id` | Y |
| Change group/role | Смена группы panel | `/ajax/player.php` | `changeGroup` | `steam_id`, `group_id`, `date` (expire), `description`, `prefix`, `prefix_rgb`, `image` | Y |
| Send in-game message | Сообщение panel | `/ajax/player.php` | `message` | `steam_id`, `msg`, `time` (repeat seconds), `log` (record in card) | Y |
| Mark (flag) player | mark toggle | `/ajax/player.php` | `mark` | `steam_id`, `mark` | Y |
| Add comment to card | comments | `/ajax/player.php` | `addComment` | comment payload | Y |
| Get comments | comments tab | `/ajax/player.php` | `getComments` | `steam_id` | N |
| Find twinks/friends | твинки | `/ajax/player.php` | `twink`, `twinkOnline`, `findFriends` | `steam_id` | N |
| Check bans | checkBans | `/ajax/player.php` | `checkBans` | `steam_id` | N |
| Kits / kit save | kits tab | `/ajax/player.php` | `kits`, `kitSave` | `steam_id` (+ kit) | N / Y |
| Ban-name allow/deny list | — | `/ajax/player.php` | `addBanName`, `removeBanName` | name payload | Y |
| Online telemetry | — | `/ajax/player.php` | `getPlayerOnlineData` | `steam_id` | N |
| Download stat / copy cheat report | downloadStat / clipboard | `/ajax/player.php` | `downloadStat` | `steam_id` | N |

#### Ban/kick form (Наказание) details
- **Причина (Reason)** `<select id="player_ban-reason">` — a full rule catalog grouped in `<optgroup>`s: **Особые (Special)**, **Общие (General)**, **Для сквадных (For SLs)**, **Для техники (For vehicles)**, **Милсим (Milsim)**. Each option value is a rule id (e.g. `110` = "1.1. Оскорбления, разжигание ненависти", `510` = "5.1. flood/soundpad in main during prep", `2` = DPAC anti-cheat auto-ban). Options carry `data-first/second/third/four` attributes (escalation-tier default ban lengths in days).
- **Reason type radios** (`player_ban-reason_type`): Кикнуть (kick, value -1), then Забанить N дней for 1/2/3/4/5/6/7/10/14/30, and **Забанить навсегда (permanent)** (value -1, `data-day=0`, red).
- **Дополнительный комментарий (Additional comment)**: `<textarea maxlength=512>`.
- Special case: if reason == `-1` (Другое), it routes straight to `banPlayer` bypassing the type radios.

#### Group change (Смена группы) details
Groups: `0` -Нет группы- (none), `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator/camera), `5` Стажёр (trainee). Plus expiry daterange, comment (128), **prefix** text (64), **prefix RGB color** picker (16), and an **image URL** (256). A dedicated "VIP +1 месяц" quick button exists (hidden by default).

#### In-game message (Сообщение) details
- 18 canned message templates (VIP grant, vehicle-solo warning, squad-lock rules, TK apology, "Ваш репорт рассматривается модерацией" = "your report is under review", etc.).
- **Add record to player card** checkbox (`player_message-log`).
- Free-text `<textarea maxlength=512>`.
- Repeat **time** select: 1 раз / 30с / 40с / 60с (default) / 90с / 120с.

---

### 14.6 Permission / visibility logic

- Every sub-panel and the modal itself ship in the fragment wrapped in `class="hide"` (`#player_ban`, `#player_group`, `#player_message`, `#player_info`, `#template`) and are revealed by JS flip/clone — visibility is client-driven, not evidence of role gating in the fragment itself.
- No explicit role/group conditional markup is present in these two fragments: the ban reason catalog, all ban-day tiers (incl. permanent), group assignment (incl. Администратор), kill, and messaging are all present in the DOM regardless of viewer. Authorization is therefore expected to be **enforced server-side** on `/ajax/squad.php` and `/ajax/player.php` per action; the client renders the full capability set. A competing panel should not assume the client hides anything sensitive.
- The `open` (`action=get`) call is the only capability the votes/reports pages expose directly; everything destructive is one modal-flip away but requires a server-side permission check.

---

### 14.7 Notable UX & competitively interesting details

- **Card-list over grid:** votes/reports use a readable card layout (map thumbnails, status/threshold blocks) rather than a dense table — better for at-a-glance triage on mobile (`mobile-left`, `col-xs` grid). Worth copying for a moderation feed.
- **Vote record is analytics-grade:** it captures `players_sum` vs `players_need` and the full map triple (current/next/target) with images — enables detecting vote-abuse patterns (e.g. repeated map-skip initiators). A competitor can go further by also logging each individual voter and per-server pass rates.
- **One-click pivot to enforcement:** both feeds put an "открыть" button that deep-links the offender straight into the full admin card with the entire ban/kick/message arsenal — tight report→action loop.
- **Rule-id driven bans with escalation defaults:** the reason `<select>` encodes a structured rule taxonomy with per-tier default durations (`data-first..four`). This standardizes moderation and feeds analytics; strong feature to match.
- **Gaps to beat:**
  - **No report lifecycle:** reports have no status/assignee/resolution/"handled-by" field or action — a moderator cannot mark a report resolved, claim it, or see who handled it. Building a proper report queue (open/claimed/resolved, SLA timers, dedupe of repeat reports on the same target) is a clear differentiator.
  - **Reporter identity not surfaced** in the card — no way to weight trusted reporters or detect false-report spam. Adding reporter reputation is an opportunity.
  - **No filters on the votes page** beyond server (no date range, no mode filter, no initiator search) and **no date-range filter on reports** — easy wins to exceed.
  - Fixed 30/page with no adjustable page size or column sort on these feeds.
  - Minor code-quality tell: reused ids (`#reports-killed`, duplicate `id="player_group-btn"`) indicate template copy-paste — a cleaner data model is a low bar to clear.


---

## 15. Bug Tracker & Video/Demos

Two loosely related admin-utility pages that share the SPA shell but are functionally independent:

- **Bug Tracker** — nav id `issues`, page fragment `frags/issues.html`. A GitHub-Issues-style ticket list where admins file bugs/suggestions against the SQSTAT panel itself.
- **Video / Demos** — nav id `video`, page fragment `frags/video.html`. A large-file (MP4) uploader that ships recorded evidence/demo clips out to the project's YouTube + Telegram channels.

Both are loaded the usual way (`pageLoad('issues')` / `pageLoad('video')` → `GET /ajax/page.php?page=…`), and each fragment carries its own inline `<script>` object (`var issues = {…}`, `var video = {…}`) that self-initializes on `$(document).ready`.

> Note: Neither page embeds the shared **player-detail** modal or any `script:'table'` DataTables grid. The bug tracker uses a hand-built `<ul class="list-group">` rendered client-side, and the video page is a drag-and-drop upload zone. None of the ~22 player-modal actions apply here; every action below is genuinely local to these two pages.

---

### 15.1 Bug Tracker (`issues`)

#### 15.1.1 Purpose & layout

A minimal issue tracker for the panel itself (bugs and feature suggestions). The layout is a two-column split:

- **Left rail** (`#issues_list_buttons`, `position:fixed`, 240px): action buttons — Создать (Create), Открытые (Open), Закрытые (Closed).
- **Right column** (`#issues_list`): a `list-group` of issue cards, populated by JS. Shows a spinner overlay (`.load_block`) while fetching and `Данных нет` (No data) when the list is empty.

There is **no** DataTables grid, no server-side search, and no column sorting here — filtering is purely by the two state buttons, and paging is by a `page` integer argument (see below).

#### 15.1.2 Entity: Issue

Inferred from the `issues_get` response shape consumed in `issues.list.build()` and the `issues_create` payload:

| Field | Type | Source / meaning |
|---|---|---|
| `id` | int | Ticket number, rendered as `#<id>` in a `<hashtag>` element |
| `title` | string | Issue title (shown bold). Note: **not** a create-form input — server-derived (likely first line / auto-generated), see gaps |
| `body` | string | Free-text description, max 512 chars (`textarea maxlength="512"`) |
| `state` | enum `open` \| `closed` | Lifecycle status. `open` → green "Открыто" (Open) with unlock icon; `closed` → "Закрыто" (Closed) with lock icon |
| `create` | timestamp | Creation time, run through `formatDate()` for display |
| `labels` | array of Label | Category tags (see below) |

Entity: **Label** (embedded array on each Issue)

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Label text, rendered with a `fa-tag` icon |
| `color` | string | Hex color **without** `#` (JS prepends it: `background-color:#`+`l.color`) |

The create form hard-codes exactly two selectable labels:

| `value` | Label | Color |
|---|---|---|
| `1` | Баг (Bug) | `#e11d21` (red) |
| `2` | Предложение (Suggestion) | `#207de5` (blue) |

#### 15.1.3 The page's own "table" (issue list)

Rendered as cards, not a `<table>`. Each `<li class="list-group-item">` shows:

| Card element | Content |
|---|---|
| `#<id>` | Ticket number (`<hashtag>`) |
| Title | `v.title` in a `<label>` |
| State badge | `<code>` pill — green "Открыто" / grey "Закрыто" (pull-right) |
| Date | `formatDate(v.create)` `<small>`, pull-right |
| Body | Full description paragraph |
| Labels | One `<span class="label">` per label with tag icon + colored background |

Filter/sort/pagination controls:

- **State filter:** two buttons call `issues.list.get('open',1)` / `issues.list.get('closed',1)`.
- **Pagination:** `get(state, page=1)` sends a `page` param, but the fragment renders **no page navigation UI** — only page 1 is ever requested from the buttons. The backend clearly supports paging; the frontend does not yet expose it (competitive gap).
- **No search box, no per-column sort.**

#### 15.1.4 Actions / capabilities

| UI label | Trigger | action id | Script endpoint | Data params | Effect | State-changing? |
|---|---|---|---|---|---|---|
| Открытые (Open) | `issues.list.get('open',1)` | `issues_get` | `POST /ajax/squad.php` | `state=open`, `page=1` | Fetch open issues → rebuild list | N (read) |
| Закрытые (Closed) | `issues.list.get('closed',1)` | `issues_get` | `POST /ajax/squad.php` | `state=closed`, `page=1` | Fetch closed issues → rebuild list | N (read) |
| Создать (Create) — open modal | `issues.create.show()` | — | — (client only) | — | Opens `#issuesModal_create`, inits the multiselect | N |
| Создать (Create) — submit | `issues.create.create(this)` | `issues_create` | `POST /ajax/squad.php` | `body=<textarea>`, `labels=<array of value ids>` | Creates a new ticket, then reloads the open list and hides the modal | **Y** |

Notes on the endpoint contract (from the shared `Action()` helper):

- All calls go to `/ajax/squad.php`; body is `action=<id>&…` URL-encoded (objects are flattened to `&key=value`).
- Success is gated on `text.status == 'ok'`; `text.auth === true` forces a full `location.reload()` (session expiry). Errors surface via `addAlert(msg, …)`.
- On create success the client re-requests `issues_get(open,1)` — so a newly created issue is assumed to land in `open` state (no client-side status is sent).

There is **no close/reopen/edit/delete/comment action in this fragment.** Admins can only create and read issues; the `closed` state exists in data but no UI here transitions an issue to it (likely handled elsewhere or by maintainers server-side). This is a notably thin CRUD surface.

#### 15.1.5 Create modal (`#issuesModal_create`)

| Element | id | Type | Validation / notes |
|---|---|---|---|
| Описание проблемы (Problem description) | `issuesModal_create-body` | `textarea` rows=4 | `maxlength="512"`; no client-side "required" check — empty submit is possible client-side |
| Метки (Labels) | `issuesModal_create-labels` | `<select multiple>` → Bootstrap `multiselect` | `nonSelectedText:'- Метки -'`, `enableHTML:true` (option labels contain styled `<span>` HTML). Optional; sends array of value ids (`1`/`2`) |
| Создать (Create) | — | button | `btnload('Создаём')` spinner during submit; resets on success/error |

`enableHTML:true` on the multiselect is what lets each option render as a colored pill (`Баг` red / `Предложение` blue) inside the dropdown.

#### 15.1.6 Permissions / visibility

No `class="hide"`, no role/group gating in this fragment. Every element is visible to anyone who can load the `issues` page — access control is entirely upstream (whether the nav item / `page.php?page=issues` is served). Both mutating and reading actions hit `script:'squad'`, implying this page is scoped to squad/panel admins rather than the general `public` script.

---

### 15.2 Video / Demos (`video`)

#### 15.2.1 Purpose & layout

A big-file uploader for demo/evidence videos (rule-violation clips, highlights). Uploaded MP4s are fanned out by the backend pipeline: **Browser → Sqstat → YouTube + Telegram** (stated verbatim in the modal help text). Header links point at the project's Telegram (`t.me/sqstat`) and YouTube channel.

Layout:

- **Header row**: Telegram link, YouTube link, and a pull-right button **Генерировать ссылку** (Generate link) that opens the token modal.
- **Drop zone** (`#drag.drop_file_zone`, ~76vh): full-height drag-and-drop area with a cloud-upload prompt "Загрузите файлэ" and a "(2ГБ)" size hint. Contains a hidden `<input type="file" accept=".mp4">`.
- Two modals: upload metadata (`#loadModal`) and token generation (`#tokenModal`).

#### 15.2.2 Entity: Video upload

Inferred from the `uploadVideo` `FormData` payload:

| Field | Type | Source | Meaning |
|---|---|---|---|
| `name` | string | `#video-name` | Short title, e.g. placeholder «Нарушение правил Enj0y» (Rule violation, player Enj0y) |
| `description` | string | `#video-description` | Free-text description of what happens in the clip |
| `file` | binary (MP4) | drop zone `input[type=file]` | The video file itself |
| `token` | string \| null | `getURLParameter('token')` | One-time upload token pulled from the page URL query string (see token flow) |

Accepted types: the drop handler is wired for `['.mp4','.avi']` (`dragFile(['.mp4','.avi'])`) while the `<input accept=".mp4">` only advertises MP4. Effective size ceiling advertised: **2 GB**. Client upload timeout: **300 s** (`timeout: 300*1000`).

> **Linkage to matches/players is not modeled client-side.** There is no match id, server id, round id, SteamID/UUID, or player selector in the payload — only free-text `name`/`description`. Any association to a specific match or offender is human-entered prose, not a foreign key. This is a meaningful contrast to a panel that could link demos directly to a match/kill/report record.

#### 15.2.3 Entity: Upload token

| Field | Type | Meaning |
|---|---|---|
| `token` | string | One-time upload credential returned by `uploadVideo_token`, shown read-only in `#upload-token` |

Token semantics (from modal help text): the generated link is **valid for 2 hours** and **usable exactly once** («Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз»). The intent is delegated uploads — an admin generates a link and hands it to someone (e.g. a player submitting evidence) who is not otherwise authenticated. On the upload page the token is read from the URL (`?token=…`) and attached to the `uploadVideo` call.

#### 15.2.4 Actions / capabilities

| UI label | Trigger | action id | Script endpoint | Data params | Effect | State-changing? |
|---|---|---|---|---|---|---|
| Генерировать ссылку → open modal | `video.token.show()` | — | — (client) | — | Opens `#tokenModal` | N |
| Создать токен (Create token) | `video.token.gen()` | `uploadVideo_token` | `POST /ajax/squad.php` | *(none)* — `data:{}` | Returns a one-time upload `token`, populated into `#upload-token` | **Y** (mints a credential) |
| Загрузить (Upload) | `video.upload()` | `uploadVideo` | `POST /ajax/public.php` | `FormData`: `name`, `description`, `file`, `token` | Uploads the MP4; backend forwards to YouTube + Telegram | **Y** |

Key endpoint split (competitively interesting):

- **Token minting uses `script:'squad'`** (authenticated admin context) — only a logged-in admin can create a token.
- **The actual upload uses `script:'public'`** — the public endpoint, authorized by the one-time `token` rather than a session. This is what enables handing an upload link to an unauthenticated third party.

Because `data` is a `FormData` instance, the `Action()` helper sets `processData=false`, `contentType=false`, and appends `action=uploadVideo` into the form — a standard multipart file POST with upload-progress instrumentation.

#### 15.2.5 Upload modal (`#loadModal`) — fields & UX

| Element | id | Type | Notes |
|---|---|---|---|
| Название видео (Video name) | `video-name` | text | Help: "Короткое название видео" (short title). Placeholder example «Нарушение правил Enj0y» |
| Описание видео (Video description) | `video-description` | textarea rows=2 | Help: "Опишите что происходит на видео" (describe what happens) |
| Загрузить (Upload) | `video-upload` | button | Hidden during upload; triggers `video.upload()` |
| Progress bar | `load_bar` | div | Live width %, big `%` label |
| Progress detail | `load_bar-upload_progress` / `load_bar-upload_speed` | spans | "`<uploaded> / <total> МБ`" and "`<speed> Мбит/c`" (Mbit/s) |

No explicit client-side validation (name/description can be blank; only extension is checked in the drop handler). During upload the modal is made non-dismissable: a `hide.bs.modal` handler calls `e.preventDefault()` so the user cannot close it mid-transfer; on error/completion the handler is detached (`.off('hide.bs.modal')`).

Progress metering comes from the shared `Action()` helper's `xhr.upload` `progress` listener, which computes MB total, MB uploaded, and Mbit/s throughput each tick and hands them to the fragment's `progress` callback.

Help text also warns that **YouTube has a daily upload quota** — videos may post "immediately or the next day" — whereas **Telegram uploads immediately**. So the two fan-out targets have different latency guarantees.

#### 15.2.6 Token modal (`#tokenModal`)

| Element | id | Type | Notes |
|---|---|---|---|
| Token field | `upload-token` | text, `readonly` | Displays the minted token/link |
| Создать токен (Create token) | `generate-token` | button | Calls `video.token.gen()`; `btnreset(600)` cooldown after |
| Help text | — | — | "Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз" (valid 2h, single use) |

Minor bug worth noting: `video.token.gen` is bound in the HTML as `onclick="video.token.gen()"` (no argument), but the JS body reads `gen: function(btn){ $btn = $(btn); … }` — so `btn` is `undefined` and `$btn` becomes an empty jQuery set; the `btnload()`/`btnreset()` spinner on the button silently no-ops. The Action call itself still works.

#### 15.2.7 Drag-and-drop mechanics

`$.fn.dragFile(ext)` (custom.js) wires the drop zone: on `drop` or `click` it takes the first file, validates the extension against the allowed list, injects it into the hidden `<input type=file>` via a synthetic `DataTransfer`, and fires an `end` event carrying the file. The fragment's `init()` listens for `end` to open the metadata modal, and for `start`/`progress`/`error` (mostly console logging). Files failing the extension check are silently rejected (`return false`); a null file triggers `alert('Ошибка файла')` (File error).

#### 15.2.8 Permissions / visibility

No `class="hide"` or role checks in the fragment. The security model is endpoint-based rather than DOM-based:

- Loading the `video` page and minting a token requires the authenticated `squad` context.
- The `public` upload endpoint trusts the one-time, 2-hour, single-use `token` — this is the mechanism for delegating uploads to non-admins.

---

### 15.3 Competitively interesting takeaways

- **Two-endpoint upload auth (`squad` mint + `public` consume):** a clean pattern for letting players submit evidence without accounts — admin generates a single-use, time-boxed link; upload happens on the public endpoint. Worth copying, and easy to beat by also binding the token to a specific report/match id so submitted footage auto-links to a case.
- **No structured linkage of videos to matches/players/reports** — SQSTAT stores only free-text `name`/`description`. A competing panel that attaches demos to a match/kill/ban record (foreign keys, jump-to-timestamp) is strictly more useful.
- **Fan-out to YouTube + Telegram with quota-aware messaging** — the backend externalizes storage to free platforms (2 GB clips) and honors YouTube's daily quota. Cheap hosting, but no in-panel playback and latency is inconsistent (YouTube may lag a day).
- **Bug tracker is create/read only, no pagination UI, no status transitions** — `state=closed` and `page` exist in the API but are not fully wired in the UI. A richer tracker (assignee, comments, close/reopen, search, real pagination) is an easy differentiator.
- **512-char body cap and only two labels (Bug/Suggestion)** — deliberately lightweight; the tracker is for panel feedback, not game moderation cases.


---

## 16. Settings: Server Config, Rotation, Mods, Restarts

This section documents SQSTAT's entire **server-management surface** — the operator-facing tooling that lets an admin reconfigure, restart, and reprovision a live Squad game server. It spans two physical locations in the SPA:

1. **The `settings` page** (`pageLoad('settings')` → `GET /ajax/page.php?page=settings`) — a tabbed configuration console: server inventory, admin permission groups, in-game rules, canned messages, Discord bot / webhook wiring. Its own RPC is `script:'settings'`.
2. **The server dashboard on `main.html`** (the SPA shell, the "Управление" (Management) panel and its modals) — the live operations tooling: CodeMirror config-file editor, map-rotation editor, mod manager, RCON console, and the start/stop/restart/update lifecycle buttons. **All of these use `script:'squad'`** (a couple use `script:'public'`).

> **Attribution note.** The task brief lists the config-editor / rotation / mod / restart actions under "settings," but in the captured markup they physically live in `main.html`, *not* in the `settings.html` fragment. The `settings.html` fragment only owns two RPC actions (`getServerSettings`, `setServerSettings`) plus a bulk `script:'settings'` save. Both surfaces are documented here because together they constitute the "settings / server-management" competitive area. Locations are called out per feature.

The shared player-detail modal (Chat/Kills/Deaths/Kits/Games/Comments tabs, ~22 actions) is **not** part of this surface and is deliberately excluded.

---

### 16.1 Purpose & navigation map

| Surface | Entry point | Backing script | Nature |
|---|---|---|---|
| Settings console | left nav → `pageLoad('settings')`; deep-links via `#setting_servers` etc. | `settings` | Persisted configuration (bulk save) |
| Server settings modal | Settings › Сервера tab › gear icon `setting.server.open(id)` | `settings` | Per-server CRUD |
| Management panel | `main.html` server dashboard → "Управление" accordion | `squad` | Live server lifecycle |
| Config editor | Управление › "Редактор конфигов" `configEditor.open()` | `squad` | Live file edit (CodeMirror) |
| Mod manager | Управление › "Менеджер модов" `modManager.open()` | `squad` | Workshop mod install/remove |
| Map rotation | dashboard gear `mapRotation.open('squad')` | `squad` | Rotation edit + weekday schedule |
| Map calendar | dashboard calendar widget `mapCalendar.get()` | `public` | Read-only history of played maps |
| User settings | avatar menu `userSettings.open()` (in `player_profile.html`) | `player` | Personal UI prefs |

The Settings console is a Bootstrap tab layout: a left-hand `#setting_list` nav (`col-md-3`) and a right-hand `#settings_tabs` content pane (`col-md-9`). A single global **Сохранить (Save)** button (`setting.save(this)`) persists whichever tab is active. Tab state is reflected into the URL hash (`/?page=settings#setting_servers`) via `pushState`, so tabs are deep-linkable. There is a hidden/disabled **Основное (Main)** tab (`li.disabled.hide`) — a placeholder for a general-settings tab not yet shipped.

---

### 16.2 Bulk-save mechanism (the `settings` script contract)

Every Settings tab shares one generic serializer. `setting.save()` prompts a confirm dialog ("Вы точно хотите сохранить настройки?" — Are you sure you want to save settings?) then POSTs:

```
POST /ajax/settings.php
  action = <implicit; per-tab>        // driven by script:'settings' + data.type
  type   = <tab data-tab>             // servers | groups | rules | squad_messages | discordbot | discord
  settings = <JSON.stringify(collect)>
```

`setting.collect(tab)` walks every `[data-setting]` element inside the active tab and encodes by its `type` attribute:

| Element `type` | Encoding | Example settings |
|---|---|---|
| `checkbox` | `1` / `0` | `vip_sync`, `report_enabled` |
| `list` | array of child `[data-list="text"]` text values | `servers`, `squad_rules`, `squad_messages` |
| `group` | `{description, color, permissions:[…data-perm]}` | admin groups |
| *(default)* | raw `.value` | `guild_id`, webhook URLs |

This is the schema-inference goldmine: the panel's persisted config model is exactly the union of the `data-setting` keys below.

---

### 16.3 Entities & data model

#### Entity: **Server** (`servers` list + server modal)

The Сервера tab renders a **sortable** (`jQuery UI .sortable`, drag handle) list — drag order defines the server display order (index letters A, B, C…). Each row shows the server short-name, a license badge ("Лицензия"), and a connection dot (green `Подключено` / red `Нет подключения`), plus a power-off icon for disabled servers. The gear opens `settingServer_modal`.

Server fields (from modal `data-input` attrs + `setting.server.new()` defaults + `getServerSettings`/`setServerSettings` payloads):

| Field (`data-input`) | Type | Meaning |
|---|---|---|
| `id` | hidden int | Server PK (empty ⇒ create new) |
| `licensed` | checkbox | Лицензионный сервер (licensed server) |
| `disabled` | checkbox | Сервер неактивный (inactive/disabled) |
| `short` | text (≤16) | Индекс — internal server index/short code |
| `ext_short` | text (≤16) | Отображаемый индекс (public-facing display index) |
| `ip` | text (≤15) | Server IP (e.g. `46.174.48.77`) |
| `port` | text (≤5) | **Порт JS агента** — port of the *rnsquad JS agent*, default `3000` (confirms an out-of-process Node agent per server) |
| `name` | text (≤128) | Server display name |
| `chan_id` | text | Discord channel ID; channel name auto-renamed to a live status string e.g. `🟢c_100x7_👮2` (green / current map code / player count / admin count) |
| `types` | list of checkboxes | Enabled game modes: `AAS`, `RAAS`, `Invasion`, `tc` (TC), `Insurgency`, `Destruction` |
| `mods` | list of checkboxes | Enabled mod flags: `ge` (Global Escalation), `sd` (Steel Division), `supermod` (SuperMod), `KOTH`, `squadZ` |

**Important gotcha for a competitor:** on `getServerSettings` the modal calls `.find('input').attr('disabled', true)` — i.e. **editing existing servers via this modal is disabled in the current build** (read-only form). Only the `new()` path leaves fields editable. So server IP/port editing happens elsewhere (see `setServerIP`, §16.7). `setServerSettings` returning `text.new` triggers a full `pageLoad('settings')` refresh.

#### Entity: **Permission Group** (`groups` tab)

Five hard-coded Squad admin groups, each a `[data-setting="<Group>"][type="group"]` block: **Admin**, **Moderator**, **QueuePriority**, **Cameraman**, **Intern**. Each group has:

| Field | Type | Meaning |
|---|---|---|
| `description` (`data-group="description"`) | text (≤32) | Localized display name (e.g. Admin → "Администратор") |
| `color` (`data-group="color"`) | hex text (≤16) + native `<input type="color">` mirror | Group tag color (e.g. `e50606`) |
| `permissions` | array of checked `[data-perm]` | Squad server-admin permission tokens |

The 21 permission tokens (the full Squad `Admin` config vocabulary) are: `startvote`, `changemap`, `pause`, `cheat`, `private`, `balance`, `chat`, `kick`, `ban`, `config`, `cameraman`, `immune`, `manageserver`, `featuretest`, `reserve`, `demos`, `clientdemos`, `debug`, `teamchange`, `forceteamchange`, `canseeadminchat`. These map 1:1 to Squad's `Admins.cfg` groups. A warning icon (tooltip **"Не будет логироваться в панели"** — "Will not be logged in the panel") is attached to `changemap`, `kick`, and `ban`, flagging that using the in-game admin cam/console for those actions bypasses SQSTAT's audit log. Default Admin grants everything except `startvote`, `private`, `immune`, `demos`, `clientdemos`, `forceteamchange`; this is the effective template a competitor should benchmark against.

The tab links out to the Squad wiki (`https://squad.fandom.com/wiki/Server_Administration`) for permission docs.

#### Entity: **Rules** (`rules` tab, `data-tab="rules"`)

A two-level structure: **categories** (`data-setting="squad_category"`, sortable nav-tabs) each containing **rules** (`data-setting="squad_rules"`, `type="list"`, `contenteditable` list items). A "Прогрессивная система" (Progressive system) toggle exists (escalating punishment ladder). Add-rule / add-category buttons and a drag-to-trash zone (`.sortable_delete`, red dashed drop target, "Удалить"). Note the client-side `setting.squad_rules.collect()` currently `return rules` as an empty object with the real logic commented out — **the rules-save serializer is stubbed/incomplete in this build** (a competitive weakness). The captured data holds a real 24-item Russian rulebook (bans, TK policy, solo-vehicle bans, CMD-obedience, nickname legibility, etc.).

#### Entity: **Canned Messages** (`squad_messages` tab)

A flat sortable list (`data-setting="squad_messages"`, `type="list"`, `contenteditable`) of pre-written admin warn/broadcast messages (VIP grant notice, vehicle-solo warnings, squad-lock rules, TK apology prompts, etc.). Add button `addMessage()` prepends a new editable item; drag-to-trash deletes. These feed the in-game `!warn`/message admin actions.

#### Entity: **Discord Bot config** (`discordbot` tab)

Bot invite link is hard-coded (`client_id=532918416151937044`). Fields (`data-setting`):

| Key | Type | Meaning |
|---|---|---|
| `guild_id` | text | Discord server (guild) ID |
| `vip_sync` / `vip_id` | checkbox / role ID | Sync VIP role |
| `moderator_sync` / `moderator_id` | checkbox / role ID | Sync moderator role |
| `moderatorInactive_sync` / `moderatorInactive_id` | checkbox / role ID | Give "Inactive" role to mods with <10h/month |
| `customRole_notify` / `customRole_id` | checkbox / channel ID | Announce role grants in a channel |
| `top1Kill_sync`/`_id`, `top1Medic_sync`/`_id`, `topCMD_sync`/`_id`, `topSL_sync`/`_id`, `topVehicle_sync`/`_id`, `topMortar_sync`/`_id`, `clanKiller_sync`/`_id`, `pilot_sync`/`_id`, `knifeKiller_sync`/`_id` | checkbox / role ID | Auto-award leaderboard roles (top-5 kills / top-5 medic / top-3 CMD / top-5 SL / top-5 mechanic / top-3 mortar / top-5 "clan slayer" / top-5 pilot / knife-kill role), scoped to last-7-days performance among Discord-linked players |
| `seeders_sync` / `seeders_id` / `seeders_hours` | checkbox / role ID / int | Seeder role above N hours/month (default 20) |
| `playtime_sync` + `playtime{100,300,500,1000,2000,3000,5000}_id` | checkbox / role IDs | Tiered playtime roles at 100/300/500/1000/2000/3000/5000 hours |

This is a **large, differentiated Discord gamification engine** — arguably the most competitively interesting entity in the whole panel. A rival should treat the full "auto-award roles from live leaderboards" set as a feature to match.

#### Entity: **Discord Webhooks** (`discord` tab)

Carries a warning banner ("Не отправляйте эти значения… кому либо" — don't share these values/screenshots). Each row = an `_enabled` checkbox + a webhook-URL/channel text field:

| Key(s) | Purpose |
|---|---|
| `report_enabled` / `report` | In-game `!r` / `!report` destination |
| `log_enabled` / `log` | Moderation journal (bans + map changes) |
| `alert_enabled` / `alert` + `alert_everyone` | Alert when a *marked* player joins; optional `@everyone` when a joiner's IP matches a ban |
| `cheater_enabled` / `cheater` | Cheater notifications |
| `grief_enabled` / `grief` | FOB/HAB destruction (griefing) events |
| `crash_enabled` / `crash` | Server-crash notifications |
| `endmatch_enabled` / `endmatch` + `endmatch_broadcast` | Match-end summary; optional in-game broadcast |
| `weekend_enabled` / `weekend` | Weekly stats image |
| `monitoring_enabled` / `monitoring_id` / `monitoring` | Server-monitoring channel + webhook |
| `request_enabled` / `request` | Admin-application submissions (`/request.php`) |
| `collab_ban_enabled` / `collab_ban` | Push bans to a **cross-server** ("межсервер") Discord |
| `collab_warn_enabled` / `collab_warn` | Push suspicious players cross-server |

> **Privacy/security finding:** the captured fragment contains **live, un-redacted Discord webhook URLs with tokens** rendered directly into the HTML `value=""` attributes (moderation log, weekly stats, monitoring, requests, collab-ban, collab-warn). Any admin who can load the Settings page can read every webhook secret from page source. This is a real leak vector a competitor should *not* replicate — store secrets server-side and never echo tokens into markup.

#### Entity: **User settings** (personal, `player` script)

`userSettings` modal (in `player_profile.html`), saved via `saveUserSettings`:

| Key | Options | Meaning |
|---|---|---|
| `lang` | `ru` / `en` | Panel language |
| `theme` | `0` (light) / `dark` | Panel theme |
| `show_country` | `hide` / `show` | Show player country flags on the main page |

---

### 16.4 CodeMirror config-file editor (`configEditor`, `script:'squad'`)

Opened from Управление → "Редактор конфигов". A modal-xl split view: left = CodeMirror editor (`mode:"properties"`, line numbers, `spellcheck=false`), right = a file browser (`#configEditor_files`). CodeMirror assets are lazy-loaded (`codemirror.js`, `properties/properties.js`) only when the modal first opens; the second `default_editor` is a read-only pane for side-by-side default comparison.

**File browser** — `getConfigFiles` returns `{files: {<dirName>: {files:[{name, date, symlin}]}}}`. Files are grouped by directory (`<h3>` per dir), each button shows the filename, a link icon if `symlin` (symlink), and a formatted `moment` timestamp. Empty dirs are skipped.

**Actions:**

| UI label | action id | script | data params | Effect | Destructive? |
|---|---|---|---|---|---|
| *(browse)* | `getConfigFiles` | squad | `server_id` | List config files grouped by dir | N |
| *(open file)* | `getConfigFile` | squad | `server_id, file, dir` | Load file text into editor; response `{text, hasDefault}` | N |
| Сохранить (Save) | `saveConfigFile` | squad | `server_id, text (URI-encoded), file, dir` | **Overwrite the server config file on disk** | **Y** |
| По-умолчанию (Default) | `getDefaultConfig` | squad | `file` | Load stock/default version into read-only pane; enables split view | N |
| Перезагрузить (Reload) | `reloadConfig` | squad | `server_id` | **Tell the server to hot-reload its config** | **Y** |
| Отмена (Cancel) | *(local)* | — | — | Re-fetch current file, discarding edits | N |
| Пересобрать (Merge) | *(client-only, `configEditor.merge`)* | — | — | For `Server.cfg` only: merge current values over the default template client-side | N (until saved) |
| Скролл (Sync scroll) | *(local)* | — | — | Lock scroll between the two editors | N |

Notable: **no auth check is visible client-side on `saveConfigFile`** — it blindly POSTs `server_id` from the ambient `server_id` global (note the save uses the global `server_id`, not `configEditor.server_id`, a subtle bug if the editor is ever opened for a non-active server). Direct-write to server config files + a hot-reload trigger is the highest-blast-radius capability on the panel; a competitor must gate this behind the `config`/`manageserver` permission and log every save with a diff. There are also **hidden, disabled** backup controls (`#configEditor_backup-save`, `#configEditor_backup-delete`, and a "Текущая" version dropdown, all `class="hide"` and `disabled`) — evidence of an in-progress config-versioning/backup feature not yet enabled. Shipping visible config backups/versioning would beat this.

---

### 16.5 Map-rotation editor (`mapRotation`, `script:'squad'` — `mode` is parametrized)

Opened via the dashboard gear `mapRotation.open('squad')`. `mode` (the RPC script) is passed in, so the same widget can drive different backends. The modal (`#serverMapRotation`) has weekday tabs: **Стандартная (Default)** + Пн–Вс (Mon–Sun, `data-day` 1–7). Each day tab's icon shows ✔ (green) if a custom list exists for that day, ✘ (red) if it falls back to default; the *current active* day is highlighted (`.current`).

| UI label | action id | script | data params | Effect | Destructive? |
|---|---|---|---|---|---|
| *(load)* | `getRotation` | `<mode>` (squad) | `server_id` | Response `{rotation:{lists:{default,1..7}, current, isWin}, list, canEdit}` | N |
| Изменить (Edit) → Сохранить | `setRotation` | `<mode>` (squad) | `server_id, rotation (URI-encoded textarea), day` | **Overwrite the rotation list for that weekday** | **Y** |

The edit modal is a raw `<textarea rows=30>` of the rotation file (one layer per line; `//` comments honored client-side). Each rotation line is rendered as a list item with faction-flag icons resolved from `list[layer].teams`. **Permission gate:** `getRotation` returns a `canEdit` boolean; when false, `openEdit()` sets the textarea `readonly` and hides the Save/Cancel buttons — a clean server-authoritative read-only mode. If `rotation.isWin` is set the weekday tabs are hidden entirely (a "win-based"/seeding rotation mode). A per-day schedule (different rotation per weekday) is a nice differentiator worth matching.

---

### 16.6 Map calendar (`mapCalendar`, `script:'public'`)

A FullCalendar widget on the dashboard showing which map layers were played on which dates. `mapCalendar.get()` → action `mapCalendar`, data `{start (unix), end (unix), server_id}`, response `{maps:[…events]}` rendered as calendar events. **Read-only, and notably served by the `public` script** (not `squad`) — so map history is a public/less-privileged read. A competitor could surface this as a shareable public "what's been played" view.

---

### 16.7 Server lifecycle & restart actions (`script:'squad'`)

All live in the "Управление" accordion on `main.html`. Every one is wrapped in a `$.question` confirm dialog and uses `retryAbort:false` (no auto-retry on failure). `server_id` comes from the active-server global. Lifecycle actions call `blockServerButtons(true)` to lock the start/stop/restart/update buttons while the op is in flight.

| UI label | action id | script | data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Включить (Start) | `start` | squad | `server_id` | Boot the game server | **Y** |
| Выключить (Stop) | `stop` | squad | `server_id` | Shut down the server | **Y** |
| Рестарт (Restart) | `restart` | squad | `server_id` | Restart the server process | **Y** |
| Обновить (Update) | `update` | squad | `server_id, afterMapChange (bool)` | Update server; optional deferral until after next map change | **Y** |
| RCON | `rconRestart` | squad | `server_id` | Restart the RCON connection | **Y** |
| Parser | `parserRestart` | squad | `server_id` | Restart the log-journal parser | **Y** |
| *(Steam Query restart)* | `cacherRestart` | squad | `server_id` | Restart the Steam Query/A2S cacher | **Y** |
| Обновить бота (Update bot) | `botUpdate` | squad | *(none)* | Update the Discord bot (global, no server_id) | **Y** |
| IP dropdown change | `setServerIP` | squad | `server_id, ip` | Switch the server's bound IP (from `#server_ips` multiselect); shows a "restart to apply" hint when a `new_ip` differs from active | **Y** |
| *(change map)* | `getServerMaps` | squad | `server_id` | List available layers/factions for the change-map modal | N |
| Monitoring chart | `serverMonitor` | squad | `start, end, server_id` | Time-series metrics (network connections, etc.) for the monitor charts | N |

The `botUpdate` prompt also surfaces on the dashboard as an inline "Версия бота неактуальна" (bot version out of date) banner with an "Обновить бота" quick-action. `update`'s **"После смены карты" (after map change)** deferral is a thoughtful UX touch — updates apply at the next natural map break instead of dropping players mid-round; worth copying.

---

### 16.8 Mod manager (`modManager`, `script:'squad'`)

Opened via "Менеджер модов". Lists installed Steam Workshop mods and supports install/remove with a **live install-progress poller**.

| UI label | action id | script | data params | Effect | Destructive? |
|---|---|---|---|---|---|
| *(list)* | `getMods` | squad | `server_id, only_status` | Response `{mods:[…], mod_status}`; `only_status:true` polls just install progress | N |
| Установить (Install) | `installMod` | squad | `server_id, mod_id, fix:true` | Download/install a workshop mod | **Y** |
| Удалить (Delete) | `deleteMod` | squad | `server_id, mod_id` | Remove an installed mod | **Y** |

`modManager.parseUrl()` accepts a raw workshop URL or ID. During an active install, `getMods` reports `mod_status` and the UI shows a spinner ("Идёт установка мода <mod_id>") and **auto-polls every 5s** (`only_status:true`) while the modal is open, then re-fetches the full list once install finishes. This progress-polling UX is polished and worth matching. Confirm dialogs guard both install and delete.

---

### 16.9 Permission & visibility logic

- **Server-authoritative read-only** is the dominant pattern: `getRotation` → `canEdit` toggles edit affordances; the server-settings modal disables all inputs after load for existing servers. The competitor takeaway: enforcement is (mostly) server-side, but the *action endpoints themselves are not visibly permission-checked client-side* — the security boundary is entirely on the PHP side.
- The 21-token permission group model (§16.3) is the panel's RBAC vocabulary. `manageserver`, `config`, `ban`, `kick` are the sensitive tokens; the panel warns that `changemap`/`kick`/`ban` performed in-game aren't audit-logged.
- **Hidden in-progress features** (all `class="hide"` / `disabled`): the Основное (Main) settings tab, config-editor backups + version dropdown, and rotation team-icon panels (`serverMapRotation_t1-ico`/`t2-ico`). These reveal the rival's roadmap: general settings, config versioning/backups, and richer rotation faction display.
- The Управление panel itself is a Bootstrap collapse; the whole block is presumably server-gated by `manageserver` (only rendered for privileged operators), though the gating happens server-side before fragment delivery.

---

### 16.10 Competitively interesting details (copy / beat)

1. **Discord gamification engine** (§16.3) — auto-awarding a dozen leaderboard-derived roles (top killer/medic/CMD/SL/pilot/mortar/mechanic/knife/clan-slayer + tiered playtime + seeder roles) is a strong retention hook. This is the single richest feature to match or exceed.
2. **Per-weekday map rotations** with a visual ✔/✘ schedule and a `win`/seeding rotation mode.
3. **Update "after map change" deferral** — player-friendly maintenance.
4. **Live mod-install progress polling** and **CodeMirror config editing with a side-by-side default/merge** — polished ops UX.
5. **Cross-server ("межсервер") ban & warn propagation** via shared Discord webhooks — a network-effect feature for server communities.
6. **Things to beat, not copy:** (a) live Discord webhook **tokens leaked into page HTML** — a real secret-exposure bug; keep secrets server-side. (b) The server-settings modal is **read-only for existing servers** (editing disabled) — SQSTAT quietly cannot edit a server's name/IP/mods after creation from that modal; shipping true in-place server editing is an easy win. (c) The **rules-save serializer is stubbed** (`collect()` returns `{}`) — rules editing appears non-functional. (d) Config saves aren't diffed/versioned/backed-up (feature is present but hidden/disabled). (e) `saveConfigFile` reads the ambient global `server_id` rather than the editor's own `server_id`, a latent cross-server write bug.


---

## 17. Admin Audit Journal (Журнал)

### 1. Purpose and Navigation

The **Журнал** (Journal / Audit Log) is a read-only, server-side-paginated audit trail of admin actions performed through the SQSTAT panel. It answers "who did what, on which server, and when."

- **Nav item:** calls `pageLoad('logs')` → `GET /ajax/page.php?page=logs`, whose HTML fragment is injected into `#content`.
- **Fragment file analyzed:** `frags/logs.html`. Lines 1–107 are the page's own content; lines 108+ are the shared **player-detail modal** (`#playerModal`) embedded on every page — its columns and ~22 actions are NOT part of this page and are documented in the shared-modal section, not here.
- **Table bootstrap:** an inline `<script>` (bottom of fragment) calls `$('#logTable').buildTable({ table: 'logs', ... })`.

The page consists of a single filter bar plus one DataTable-style table (`#logTable`). There are **no state-changing controls of its own** — the only interaction beyond filtering is clicking a `<hashtag>` inside a row to open the shared player modal.

---

### 2. Entities & Fields

#### 2.1 Log Entry (`logs` table, alias `t1`)

The audit record. Inferred from the returned column set (`collum: ["serverName","name","date","log"]`), the `<thead>`, and the `data-search` aliases used by the filters.

| Field (returned) | UI column | SQL source (from filter aliases) | Meaning / Type |
|---|---|---|---|
| `serverName` | Сервер (Server) | joined via `server_id` | Human-readable server name (e.g. `RAAS/AAS #1`). String. |
| `name` | Админ (Admin) | `t2.player` (admins table `t2`) | Display name of the admin who performed the action. Joined from the admin/player table. String. |
| `date` | Дата (Date) | `t1.startdate` / `t1.enddate` filter on the row's timestamp | Timestamp of the action. Rendered ~120px column, centered. |
| `log` | Действие (Action) | `t1.log` | Free-text/structured description of the logged action. String; may embed `<hashtag>` tokens (clickable player references). |

Implied underlying columns not shown but used for filtering/joins: `server_id` (FK to server), an admin FK (joins `t2.player`), and the timestamp used by `t1.startdate`/`t1.enddate` range filters.

#### 2.2 Server (referenced entity)

Populated as `<option value="<id>" label='<name>'>` in the multiselect. Observed IDs are non-contiguous (`1, 6, 7, 9, 10, 11`), confirming `server_id` is a stable DB primary key, not a UI index.

| Field | Type | Example |
|---|---|---|
| `server_id` | int PK | `1` |
| server label | string | `RAAS/AAS #1`, `INVASION #3`, `Custom для FW` |

#### 2.3 Admin (referenced entity, alias `t2`)

The audit joins to a players/admins table aliased `t2`; the filterable field is `t2.player` (the admin's identity/name). This is the same identity that the shared modal opens when a `<hashtag>` is clicked.

---

### 3. The Page's Own Table (`#logTable`)

**Columns** (`<thead class="table-dark">`):

| # | `<th>` | Width | Align | Data key |
|---|---|---|---|---|
| 1 | Сервер (Server) | 200px | left | `serverName` |
| 2 | Админ (Admin) | auto | left | `name` |
| 3 | Дата (Date) | 120px | center | `date` |
| 4 | Действие (Action) | auto | left | `log` |

**Data source / request.** `buildTable` issues the row request through the generic `Action()` helper:

- **Endpoint:** `POST /ajax/table.php`
- **Body:** `action=logs&table=logs&page=<n>&numrows=100&search=<urlencoded JSON>&order_by=<false|col>&order_sort=<asc|desc>`
- `action` = the table name (`logs`); response is `{status:'ok', data:{ row:[...], query_time, count_time, ... }}`.
- **Page size:** `numrows: 100` per page.
- **Sorting:** no `order` array is passed in the bootstrap call, so **column-header sorting is not enabled** on this page (rows come back in the server's default order, effectively newest-first by date). The `buildTable` engine *supports* sort via `order_by`/`order_sort`, but the logs page opts out.
- **Pagination:** server-side; `buildTable` renders a pager (`showPages: 9` desktop / `3` mobile) below the table when total rows exceed 100.

**Search JSON shape** (built by `buildTable` from the `searchInput` list, then `encodeURIComponent(JSON.stringify(...))`):

```
{
  "text":        { "t2.player": "<admin>", "t1.log": "<action text>",
                   "t1.startdate": "<from>", "t1.enddate": "<to>" },
  "check":       {},
  "multiselect": { "server_id": ["1","7", ...] },
  "managers":    {},
  "slider":      {}
}
```

Only non-empty inputs are included. `+` characters are pre-escaped to `%2B`.

---

### 4. Filters / Search Controls

Declared in the filter bar and wired via `searchInput: ["logTable-name","logTable-startdate","logTable-enddate","logTable-user","logTable-server"]`.

| Control | Element id | `data-search` alias | Type | Placeholder | Behavior |
|---|---|---|---|---|---|
| Admin name | `logTable-user` | `t2.player` | text | Администратор (Administrator) | Substring filter on the acting admin. Enter key triggers search. |
| Action text | `logTable-name` | `t1.log` | text | Действие (Action) | Free-text filter over the log/action description. Enter key triggers search. |
| From date | `logTable-startdate` | `t1.startdate` | text (readonly, datetimepicker) | От (From) | Lower bound of date range. Bootstrap datetimepicker, `language: 'ru'`, `pickTime: true`, side-by-side. Clear icon zeroes the field. |
| To date | `logTable-enddate` | `t1.enddate` | text (readonly, datetimepicker) | До (To) | Upper bound of date range. Same picker config; clear icon resets. |
| Server | `logTable-server` | `server_id` | multiselect (`multiple`) | `- Сервер -` | `bootstrap-multiselect`, HTML-enabled, multi-value. Filters to selected `server_id`s. |
| Search button | `logTable-btn` | — | button | Поиск (Search) | Fires the query with current filter state. |

Notes:
- Date fields are `readonly` — values only settable via the picker (prevents malformed input).
- The two date-clear `<span>` addons run inline `$('#...').val('')`; they clear the field but do **not** auto-refresh — the user must press Поиск (or Enter in a text field).

---

### 5. Actions Available on This Page (Permissions/Capabilities)

The audit journal is deliberately **read-only**. It exposes no ban/kick/edit/delete/export controls of its own.

| UI trigger | Action id | Script endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Load / filter / paginate the table | `logs` | `POST /ajax/table.php` | `table=logs&page&numrows=100&search&order_by&order_sort` | Fetch audit rows (server-side paginated/filtered). | N (read-only) |
| Click a `<hashtag>` in a row | (opens modal) `player.open(steamid)` | — (then shared modal loads via `player`/`squad` scripts) | steam id from the clicked token | Opens the shared player-detail modal for the referenced identity. | N |

The `end` callback binds: `$('#logTable tbody > tr hashtag').on('click', ...) → player.open($(this).text())`. So any player reference rendered inside a log line is a drill-down link into the shared modal.

> The action tokens pre-extracted for `logs.html` in `action_catalog.txt` (`ban`, `kick`, `kill`, `kits`, `mark`, `message`, `twink`, `unban`, `addComment`, `getComments`, `changeGroup`, `changeTeam`, `checkBans`, `findFriends`, `removePlayer`, `addBanName`, `removeBanName`, `twinkOnline`, `getPlayerOnlineData`, `downloadStat`, `kitSave`, `get`) together with `script:'player'` and `script:'squad'` all belong to the **embedded shared player modal**, NOT to the audit journal. They are the actions the modal can perform on whatever player you open from a log row — do not attribute them to this page.

---

### 6. Forms & Modals

The page has **no forms/modals of its own** beyond the filter bar. The only modal in the fragment is the shared `#playerModal` (player-detail), reached by clicking a player `<hashtag>` in a log row. Its fields, tabs, and actions are covered in the shared-modal section.

---

### 7. Permission / Visibility Logic

- The fragment contains no per-element `class="hide"` or role gating within the journal's own markup — the entire page is a single filterable table. (All `hide`/`display:none` elements in the file are inside the shared player modal.)
- Access control for the journal is therefore expected to be **page-level** (server-side gating of `pageLoad('logs')` by admin group). The client fragment assumes the requester is already authorized to see it.
- `Action()` transparently handles session expiry: if `table.php` responds `auth === true`, it triggers `location.reload()` (re-auth), so an expired session on the audit page bounces to login rather than showing stale data.

---

### 8. Notable UX & Competitively Interesting Details

- **Minimal, single-purpose page.** Four columns, five filters, one button. It reads as an accountability/compliance view (who-did-what) rather than an operations console — the deliberate absence of any mutating control is the point: an audit log you can't edit is more trustworthy.
- **The `log` column is free-text**, filtered by substring on `t1.log`. This implies actions are stored as rendered strings, not as a normalized `{action_type, target, params}` schema. **Competitive opportunity:** store audit events structurally (actor, action enum, target entity + id, before/after diff, server, timestamp) so you can filter by exact action type, link every target, and render a rich timeline. Their text-search-only model can't reliably answer "show all *bans* by admin X this week."
- **No column sorting** is wired here (order array omitted) — you can filter but not re-sort. Easy to beat by enabling sort on Date/Admin/Server.
- **Date range uses two separate readonly pickers** (`t1.startdate` / `t1.enddate`) rather than a single daterange widget (the engine supports a `daterange` type elsewhere). Clearing a date does not auto-refresh, a minor friction point.
- **Server filter keys off DB `server_id`** (non-contiguous ids), and the server label is denormalized into the row (`serverName`) — cheap to render, but means historical server renames would rewrite past display names unless snapshotted.
- **Drill-down via `<hashtag>`:** player identities embedded in log lines are live links into the shared modal — a nice touch that turns the audit log into an investigation entry point. Worth copying: make every actor and target in an audit row a clickable entity link.
- **Retention:** nothing in the client indicates a retention/rotation policy or an age cap on queries — pagination is unbounded (`page` increments, `numrows=100`), and the date filter defaults to empty (all history). Retention, if any, is enforced server-side and is not observable from the fragment.


---

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


---

## 19. Public API

### 1. Purpose & Nav Location

- **Nav location / page id:** `/api/docs/` (loaded as a page fragment, not via the usual `pageLoad('<page>')` → `/ajax/page.php` mechanism; it is a self-contained documentation page).
- **Purpose:** SQSTAT ships a **documented public HTTP API** intended for third-party integrations — most obviously Discord bots (one param is literally described as "Ваш ключ бота" / "Your bot key") and external stat/ban lookups. The docs page states: *"Здесь описаны методы для взаимодействия с панелью SQSTAT"* ("Here are the methods for interacting with the SQSTAT panel"). Discussion/feature requests are routed to a Discord server.
- **API version shown in sidebar:** `0.8.3`.
- This is a **separate REST-style surface** from the internal admin RPC (`/ajax/<script>.php` + `Action({script,action,data})`). The public API lives under `https://breaking.sqstat.ru/api/<group>/<method>.php` and is organized into three groups: **Сервер (Server)**, **Игрок (Player)**, **Клан (Clan)**.

Sidebar structure:

| Group | Method (RU / gloss) | data-target |
|---|---|---|
| Сервер (Server) | Состояние (State) | `api-server_info` |
| Сервер (Server) | Чат (Chat) | `api-server_chat` |
| Сервер (Server) | Смена карты (Change map) | `api-server_map` |
| Игрок (Player) | Информация (Info) | `api-player_info` |
| Игрок (Player) | Статистика (Statistics) | `api-player_stats` |
| Игрок (Player) | Выдача VIP (Grant VIP) | `api-player_vip` |
| Игрок (Player) | Бан (Ban) | `api-player_ban` |
| Игрок (Player) | Наличие бана (Has ban) | `api-player_hasBan` |
| Игрок (Player) | Наличие бана на проектах (Has ban across projects) | `api-player_hasBanAll` |
| Игрок (Player) | Комментарии (Comments) | `api-player_comments` |
| Игрок (Player) | Бонусы (Bonuses) | `api-player_bonus` |
| Клан (Clan) | Информация (Info) | `api-clan_get` |

---

### 2. Endpoint Catalog (Overview)

All endpoints use `Content-Type: application/x-www-form-urlencoded`. Responses are JSON. Most successful responses wrap payload as `{"status":"ok","data":{...}}`, though a few (chat, hasBan) return the payload at the top level alongside `"status":"ok"` — the envelope is **inconsistent** across endpoints.

| # | Endpoint | Method | Auth (`key`) | State-changing? | Purpose |
|---|---|---|---|---|---|
| 1 | `/api/server/stat.php` | GET | **No key documented** (only `server`) | N | Live server state + current online roster |
| 2 | `/api/server/chat.php` | GET | **Yes** (`key`) | N | Last 100 chat messages |
| 3 | `/api/server/setmap.php` | POST | **Yes** (`key`) | **Y** | Set current / next map or skip |
| 4 | `/api/player/info.php` | GET | **Yes** (`key`) | N | Player profile / identity / ban summary |
| 5 | `/api/player/stats.php` | GET | **Yes** (`key`) | N | Player statistics, games, kits, weapons |
| 6 | `/api/player/vip.php` | GET \| POST | **Yes** (`key`) | **Y** | Grant / extend VIP |
| 7 | `/api/player/ban.php` | POST | **Yes** (`key`) | **Y** | Ban one or many players |
| 8 | `/api/player/hasBan.php` | GET | **No key documented** (only `steam_id`) | N | Ban check on this project |
| 9 | `/api/player/hasBanAll.php` | GET | **Yes** (`key`) | N | Ban check across all projects |
| 10 | `/api/player/comments.php` | GET | **Yes** (`key`) | N | Admin comments on a player |
| 11 | `/api/player/bonus.php` | POST | **Yes** (`key`) | **Y** | Add/remove/set bonus points |
| 12 | `/api/clan/get.php` | GET | Optional (`key` only if clan is private) | N | Clan info + member roster |

> **Competitively important auth observations:**
> - **`hasBan.php` requires NO API key** — anyone with a SteamID64 can query whether that player is banned on this project (returns full ban records incl. admin SteamID, reason, expiry, mark). This is a deliberately public ban-lookup surface.
> - **`stat.php` requires NO API key** — the live server state, full player roster (names, SteamID64s, kits, admin flag), squads and teams are exposed with only a `server` short-name. This is effectively a public "who's online" endpoint.
> - `hasBanAll.php` (cross-project federation) **does** require a key — the federated view is gated even though the single-project view is not.
> - `clan/get.php` key is **conditional**: public clans are readable anonymously; only private clans require a key.

---

### 3. Authentication, Format & Transport

- **Auth mechanism:** a single opaque `key` (API key) passed as a **request parameter** (query string for GET, form body for POST) — *not* an HTTP header, *not* a bearer token. Described variously as "API ключ" (API key) and "Ваш ключ бота" (your bot key), implying per-integration/per-bot keys.
- **No documented rate limits, quotas, throttling, or pagination limits** (except chat's implicit "last 100 messages" cap and an optional `page` param on chat). No documented error schema, HTTP status-code contract, or `status:"error"` example — only the happy path (`status:"ok"`) is shown.
- **Format:** all requests `x-www-form-urlencoded`; all responses JSON.
- **No CORS/origin, versioning-in-URL, or auth-scope documentation** is present on the page. The version `0.8.3` is informational only.

---

### 4. Endpoint Reference (Params & Responses)

Legend for "Req?": **Да** = required (red), **Нет** = optional (green).

#### 4.1 `GET /api/server/stat.php` — Состояние (Server State)
*Получение информации о состоянии сервера и текущем его онлайне* (server state + current online).

**Request params**

| Field | Req? | Meaning |
|---|---|---|
| `server` | Да | Short server name |

**Response `data` fields**

| Field | Meaning |
|---|---|
| `name` | Server name |
| `enabled` | Enabled/disabled (bool) |
| `map` | Current map |
| `nextMap` | Next map (may include factions string, e.g. `"Harju_Seed_v1, factions USMC RGF"`) |
| `map_start` | Map start, Unixtime |
| `players` | Array `[player]` (see below) |
| `squads` | Array `[squads]` |
| `teams` | Array `[teams]` |
| `last_restart` | Object with restart date parts (`month,year,day,hour,minute,seconds,ms,unix`) |
| `vote` | Object: `isVote` (bool), `votes.yes[]`, `votes.no[]`, `map`, `mode` (e.g. `skip`) — live map-vote state |
| `queue_players` | Number of players queued (docs field label misspelled `queue_playrs` but example JSON uses `queue_players`) |

`[player]` sub-object: `name`, `steam_id` (SteamID64), `kit`, `playtime` (`{date, last_seen}` in JS ms Unixtime), `isAdmin` (bool).
`[squads]` sub-object: `name`, `team` (team index).
`[teams]` sub-object: `id` (team index), `name`, `unit` (e.g. `CombinedArms`), `short`.

> Notable: exposes **whether each online player is an admin** (`isAdmin`) and their current kit — anonymous, keyless. Also exposes live vote/queue state, useful for a public "server browser" widget.

#### 4.2 `GET /api/server/chat.php` — Чат (Chat)
*Последние 100 сообщений чата сервера* (last 100 chat messages).

**Request params**

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | API key |
| `page` | Нет | Page from the search (pagination) |

**Response** — top-level `chat` array + `status`. `[chat]` fields:

| Field | Meaning |
|---|---|
| `id` | Message ID |
| `server_id` | Server ID |
| `steam_id` | Player SteamID64 |
| `name` | Player name |
| `team` | Player team (e.g. `INS`) |
| `type` | Chat type (e.g. `ChatAll`, presumably also ChatTeam/ChatSquad/ChatAdmin) |
| `date` | Unixtime |
| `msg` | Message text |

#### 4.3 `POST /api/server/setmap.php` — Смена карты (Change Map) — **DESTRUCTIVE**
*Меняет текущую или следующую карту* (changes current or next map).

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | API key |
| `server` | Да | Server index |
| `map` | Да | Map |
| `mode` | Да | `next` \| `current` \| `skip` |

Response: `status:"ok"` with empty `data` (no documented body). **State-changing**: forces map/rotation on a live server via API.

#### 4.4 `GET /api/player/info.php` — Информация (Player Info)
*Основная информация по игроку.*

**Request params**

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | API key |
| `steam_id` | Да | Player SteamID64 |

**Response `data` fields** (identity + rights + ban summary — the richest read endpoint):

| Field | Meaning |
|---|---|
| `baby` | Whether the player is new |
| `ban` | Array `[ban]` (see below) |
| `bans` | Ban history (count/history) |
| `bonus` | Bonus-point balance |
| `create_date` | Player creation date, Unixtime |
| `date` | Last-online date, Unixtime |
| `discord` | Discord ID |
| `eos_id` | EOS ID (Epic Online Services) |
| `expire` | Rights expiry, Unixtime |
| `group_description` | Comment on the rights/group |
| `group_id` | Group ID (admin group) |
| `image` | VoiceConnect image URL |
| `mark` | Mark/flag ID on the player |
| `name` | Player nick |
| `names` | Array `[names]` (name history) |
| `online` | On server or not (bool) |
| `playtime` | Array `[playtime]` |
| `prefix` | VoiceConnect prefix |
| `prefix_rgb` | VoiceConnect prefix color |
| `steam_id` | SteamID64 |

`[ban]` sub-object: `id`, `steam_id`, `date` (Unixtime), `reason`, `description`, `admin_id` (admin SteamID64), `expire` (Unixtime), `unban` (was lifted), `admin_name`.
`[names]` sub-object: `date`, `name`.
`[playtime]` sub-object: `boost` (seeding time), `online` (total online), `queue` (time in queue), `server` (favorite server).

> Exposes cross-identity linkage (**SteamID64 ↔ EOS ID ↔ Discord ID**), full name history, admin group membership + expiry, and full ban records including the acting admin's SteamID and name. Rich target for a competitor to match/exceed.

#### 4.5 `GET /api/player/stats.php` — Статистика (Player Statistics)

**Request params:** `key` (Да), `steam_id` (Да).

**Response `data` fields:**

| Field | Meaning |
|---|---|
| `damage` | Total damage |
| `eos_id` | EOS ID |
| `games` | Array `[games]` |
| `is_play` | Currently on a server (bool) |
| `kits` | Array `[kits]` |
| `name` | Player nick |
| `primetime` | Array `[primetime]` |
| `stats` | Array `[stats]` (name/value pairs) |
| `steam_id` | SteamID64 |
| `teamkill` | Teamkill count |
| `weapons` | Array `[weapons]` |

`[games]`: `id`, `map`, `server_id`, `start`, `end`, `playtime` (minutes), `t1`, `t1_tickets`, `t2`, `t2_tickets`, `win` (win status).
`[kits]`: `kit` (kit name), `cnt` (minutes on kit), `steam_id`.
`[primetime]`: `start`/`end` (Unixtime bucket), `cnt` (minutes in bucket), `sum` (all-time minutes in bucket), `sort` (hh:mm of bucket start) — i.e. an hour-of-day activity histogram.
`[stats]`: `name`/`value` pairs. Observed names: `Online`, `Boost`, `Favorite kit`, `Matches`, `Winrate` (e.g. `"W:12 L:18 (40%)"`), `K/D`, `Kills`, `Deaths`, `Revivals`.
`[weapons]`: `name` (weapon/vehicle), `cnt` (kills with it), `damage`, `image` (image filename). Example values include `LAV6`, `M1 Abrams`, `M16A4`, `M4A1`.

#### 4.6 `GET | POST /api/player/vip.php` — Выдача VIP (Grant VIP) — **DESTRUCTIVE**
Note: *"Обязательно или expire или add"* — either `expire` **or** `add` must be supplied (they are mutually exclusive despite both being marked required in the table).

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | API key |
| `steam_id` | Да | Player SteamID64 |
| `expire` | Да* | Absolute expiry, Unixtime (seconds) |
| `add` | Да* | Duration to add to current expiry |
| `description` | Нет | Description/reason |

Response `data`: `msg` (message), `expire` (date array), `player` (name + steamid array). **State-changing**: grants/extends VIP entitlement.

#### 4.7 `POST /api/player/ban.php` — Бан (Ban) — **DESTRUCTIVE**
*Выдача бана игроку.* `key` here is labeled "Ваш ключ бота" (your bot key).

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | Bot key |
| `steam_id` | Да | Player SteamID64 **or an array of players** (bulk ban) |
| `rule` | Да | Punishment reason (rule) |
| `days` | Да | Days; `0` = permanent |
| `description` | Нет | Additional comment |

Response `data`: `msg`. **State-changing + bulk-capable**: a single call can ban multiple SteamIDs.

#### 4.8 `GET /api/player/hasBan.php` — Наличие бана (Has Ban) — **NO KEY**
*Проверка есть ли бан у игрока.* Only param: `steam_id` (Да). **No API key required.**

Response `data`: `ban` (array `[ban]`), `ban_count`, `mark` (mark on player), `last_ban` (Unixtime).
`[ban]` sub-object: `id`, `steam_id`, `date`, `reason`, `description`, `admin_id`, `expire`, `unban`, `admin_name` — i.e. full ban detail including acting admin identity, returned **anonymously**.

#### 4.9 `GET /api/player/hasBanAll.php` — Наличие бана на проектах (Has Ban Across Projects)
*Проверка есть ли бан у игрока на всех проектах.* Params: `steam_id` (Да), `key` (Да).

Response `data`: `ban` (array `[ban]`). `[ban]` sub-object: `id`, `steam_id`, `date`, `reason`, `admin_id`, `expire`, `unban`, `admin_name` (note: **no `description`** in the federated variant). This is a **cross-project / federated ban network** lookup — a notable competitive feature (shared ban intelligence across all SQSTAT-hosted projects).

#### 4.10 `GET /api/player/comments.php` — Комментарии (Comments)
*Получение комментариев на игрока.* Params: `key` (Да), `steam_id` (Да).

Response `data`: `comments` (array). `[comments]` sub-object: `id`, `steam_id`, `admin_id`, `date` (Unixtime), `text`, `admin_name`. Exposes internal admin notes on players via API (key-gated).

#### 4.11 `POST /api/player/bonus.php` — Бонусы (Bonuses) — **DESTRUCTIVE**
*Начисление и снятие бонусов* (add/remove bonus points).

| Field | Req? | Meaning |
|---|---|---|
| `key` | Да | API key |
| `steam_id` | Да | Player SteamID64 |
| `method` | Да | `add` / `remove` — add, remove or set (docs text: "начислить, удалить или установить") |
| `amount` | Да | Number of bonus points |

Response `data`: `old` (previous balance), `new` (new balance), `amount` (delta). **State-changing**: mutates the player's bonus economy (a virtual currency, cf. `bonus` field in player/info).

#### 4.12 `GET /api/clan/get.php` — Информация (Clan Info)
*Получение информации о клане.*

| Field | Req? | Meaning |
|---|---|---|
| `key` | Нет | API key — **only needed if the clan is private** |
| `id` | Да | Clan ID |

Response `data`: `name`, `tags` (clan tags), `players` (array). `[players]` sub-object: `eos_id`, `name`, `online` (current online), `steam_id`. Enables anonymous roster enumeration for public clans.

---

### 5. Data Model Inferred From The API

The public API surfaces the following core entities (consistent with the internal admin panel's schema):

- **Server:** `name`, `enabled`, `map`/`nextMap`/`map_start`, `last_restart`, live `vote` state, `queue_players`, and a live roster.
- **Team / Squad:** teams have `id`, `name`, `unit`, `short`; squads have `name` + `team` index.
- **Player (identity):** `steam_id` (SteamID64), `eos_id`, `discord`, name + `names` history, `create_date`, `date` (last seen), `online`, `baby` (new), `image`/`prefix`/`prefix_rgb` (VoiceConnect cosmetics), `group_id`/`group_description`/`expire` (admin rights), `mark`, `bonus`.
- **Player (stats):** aggregate `damage`, `teamkill`, per-`games`, per-`kits`, per-`weapons`, `primetime` hour-of-day histogram, and a name/value `stats` block (Online, Boost, Matches, Winrate, K/D, Kills, Deaths, Revivals, Favorite kit).
- **Ban:** `id`, `steam_id`, `date`, `reason`/`rule`, `description`, `admin_id`, `admin_name`, `expire`, `unban`; aggregated by `ban_count`/`last_ban`; federated across projects via `hasBanAll`.
- **Comment:** admin note `{id, steam_id, admin_id, admin_name, date, text}`.
- **Clan:** `id`, `name`, `tags`, `players[]` (with online state), public/private visibility.
- **VIP / Bonus:** VIP is an expiry-based entitlement (`expire`, extendable via `add`); Bonus is an integer currency mutated via `add`/`remove`/set.

---

### 6. Permission / Visibility Logic

- There is no `class="hide"` gating on the docs page itself — it is public documentation. Access control is enforced server-side by the **`key` parameter**, and the docs make the gating explicit per endpoint (see the auth column in §2).
- **Effective public (keyless) surface:** live server state + roster (`stat.php`) and single-project ban lookup (`hasBan.php`), plus public-clan rosters (`clan/get.php`). This is intentional public exposure.
- **Key-gated surface:** everything that reads private admin data (chat, comments, cross-project bans, full player info/stats) or mutates state (setmap, vip, ban, bonus).
- **Destructive/admin capabilities exposed over API:** map control (`setmap`), VIP grants (`vip`), bans incl. bulk (`ban`), and bonus economy edits (`bonus`). Possession of a valid `key` therefore confers real moderation power — the key is a high-value secret.

---

### 7. Notable UX & Competitively Interesting Details

1. **Federated ban network (`hasBanAll`)** — cross-project ban intelligence is a strong differentiator; a competing panel should offer an equivalent shared/opt-in ban database.
2. **Keyless ban lookup (`hasBan`)** returning full ban detail (including the acting admin's SteamID and name) is a privacy-forward-leaning choice — a competitor could match the "public ban transparency" feature while redacting admin PII.
3. **Bulk ban in one call** (`steam_id` accepts an array) — convenient for anti-cheat/bot integrations.
4. **Bot-first framing** — `ban.php`'s key is literally "your bot key"; the API is designed around Discord bot automation. Worth replicating the ergonomics (single form-encoded key param, no header ceremony).
5. **Cross-identity graph** — `player/info` ties SteamID64 ↔ EOS ID ↔ Discord ID with full name history; strong for account-tracking/alt detection.
6. **Primetime histogram** (`primetime`) — hour-of-day activity buckets with per-bucket and all-time sums; a nice analytics primitive to copy.
7. **VoiceConnect cosmetics** (`prefix`, `prefix_rgb`, `image`) surfaced via API implies a Discord voice-integration product tier.
8. **Live vote & queue state** in `stat.php` supports rich public server-browser widgets.
9. **Weaknesses to beat:** inconsistent response envelope (`{status,data}` vs top-level `chat`/`ban`); no documented error contract, HTTP status semantics, rate limits, versioning, or pagination beyond chat; auth via query/body param (leaks into logs/URLs) rather than an `Authorization` header. A competitor can win on API polish: consistent envelope, typed errors, header auth, documented rate limits, OpenAPI spec.

---

### 8. Endpoints Not in `/ajax/*` RPC

This public API is **entirely separate** from the internal `Action({script,action,data})` → `/ajax/<script>.php` admin RPC and from the shared player-detail modal's ~22 actions. None of the modal columns/actions are part of this page; the overlap is only conceptual (both can ban/VIP/comment). The `action_catalog.txt` contains **no** tokens for these `/api/*` methods, confirming they are a distinct, publicly-documented surface rather than internal DataTables/RPC calls.


---

## 20. Top Online Leaderboard (Топ онлайна)

### 1. Purpose and nav location

A player activity leaderboard that ranks players across the whole database by cumulative online time, accrued bonuses, or boost. It is a pure read/browse page: a left-hand search/filter rail plus a right-hand ranked table. Clicking any row opens the shared **player-detail modal** for that player.

- **Page id:** `top`
- **Invoked by:** `pageLoad('top')` → `GET /ajax/page.php?page=top` → HTML fragment injected into `#content`.
- **Nav visibility:** marked **[hidden]** — there is no `top-menu` link that calls `pageLoad('top')`. The page is reachable only by directly invoking `pageLoad('top')` (e.g. console, deep link, or a conditionally-rendered menu entry). See §6 for the visibility inference.
- **Fragment file:** `frags/top.html`. Lines 1–88 are the page's own content; lines ~90–2811 are the **shared player-detail modal** (`#playerModal` / `#player_info`) that is embedded on every page and must NOT be attributed to this page.

The page's own footprint is deliberately tiny: one filter rail, one table, one inline `$(document).ready` bootstrap.

---

### 2. Entities & fields

#### 2.1 Leaderboard row (the `topPlayers` table dataset)

Server-side rows are fetched via `script:'table'` (DataTables-style). The client maps six columns by key (`custom.js` `buildTable` call, top.html:75): `['place', 'steam_id', 'name', 'online', 'bonuses', 'boost']`.

| Field | Source key | Type | Meaning |
|---|---|---|---|
| Rank | `place` | int | 1-based rank position within the current sort/filter/page. |
| Steam ID | `steam_id` | string(17) | Player SteamID64. Rendered inside a `<hashtag>` element (via the `hashtag` column formatter) and used as the click key to open the modal. |
| Nickname | `name` | string | Player's display nick (aliased in search as `t2.name`, i.e. the joined player/identity table `t2`). |
| Online | `online` | duration | Cumulative playtime metric — the primary ranking value (clock icon `fa-clock-o`). Rendered server-side as human-readable time. |
| Bonuses | `bonuses` | int | Accumulated bonus points (gift icon `fa-gift`). |
| Boost | `boost` | number | Boost metric / multiplier contribution (double-up icon `fa-angle-double-up`). |

Row-level `data-*` (generic to `buildTable`): each `<tr>` may carry `data-id`, `data-toggle="tooltip"`/`data-original-title`, plus any keys under a row `dataset` object. The SteamID cell carries `data-contact="steam_id"` and wraps the value in `<hashtag>`, which the click handler reads.

#### 2.2 Player (as surfaced by the shared modal, for context)

The three leaderboard metrics correspond to fields on the player object loaded into the modal (`player.info`, top.html:1051–1056):
- `playtime.online` (Онлайн / Online), also flagged with a warning icon when a threshold/anomaly condition holds (top.html:1052–1053).
- `bonus` (Бонусы / Bonuses).
- `playtime.boost` (Буст / Boost).

Per-player time-series `online_data` (keyed by timestamp; each point has `minute`, `boost`, `queue`) powers the modal's activity chart — this is the granular counterpart of the leaderboard's aggregate `online`.

---

### 3. The page's OWN table

**Table id:** `topPlayers` — `<table class="table table-hover">`, empty `<tbody>` filled by `buildTable`.

**Columns (as authored in `<thead>`, top.html:42–47):**

| # | Header | Icon | Bound key | Notes |
|---|---|---|---|---|
| 1 | `#` | — | `place` | Width 25px. Rank. |
| 2 | `SteamID` | — | `steam_id` | Width 151px. Click target. |
| 3 | `Ник` (Nick) | — | `name` | Centered. |
| 4 | (icon only) | `fa-clock-o` | `online` | Width 100px, centered. Online time. |
| 5 | (icon only) | `fa-gift` | `bonuses` | Width 70px, centered. Bonuses. |
| 6 | (icon only) | `fa-angle-double-up` | `boost` | Width 100px, centered. Boost. |

**Fetch contract (via `buildTable` → `Action`):**
- Endpoint: `POST /ajax/table.php`
- `action = topPlayers` (the table name is used as the action id).
- `data`: `&table=topPlayers&page=<n>&numrows=30&search=<urlencoded JSON>&order_by=<col|false>&order_sort=<asc|desc|false>`
- Pagination count is a second call with `&pagination=true` returning `totalPage`/`totalRows`.

**Pagination:** server-side, **30 rows/page** (`numrows: 30`). Numbered pager with first/prev/next/last, plus an info line `Страница N из M / Всего: K` (Page N of M / Total: K). Windowed to ±9 page links (±3 on mobile).

**Sorting:** No clickable header sort is wired on this page (`buildTable` `order` option is not passed, so it defaults to `[]` and no `data-sort` handlers/icons are attached to the `<th>`s). Ordering is driven **only** by the sidebar sort selector (§4.1), which sets the server `sort` search key. Default ordering is by online time descending (implied by the `online` option being `selected`).

**Search binding:** the `searchInput` array `["topPlayers-name", "topPlayers-steam_id", "topPlayers-sort"]` is serialized into the `search` JSON: text inputs go under `search.text[<data-search>]`, the multiselect under `search.multiselect['sort']`.

---

### 4. Actions available here

#### 4.1 Page-own controls

| UI label | Element | Kind | Endpoint / effect | Params | State-changing? |
|---|---|---|---|---|---|
| Поиск (Search) | `#topPlayers-btn` | button | Rebuilds `topPlayers` table with current filters. `POST /ajax/table.php` action `topPlayers`. | `table=topPlayers`, `page`, `numrows=30`, `search` (JSON of name/steam_id/sort), `order_by`, `order_sort` | N (read) |
| Ник (Nick filter) | `#topPlayers-name` `data-search="t2.name"` | text input | Adds `t2.name` to `search.text`. Placeholder "Ник". | free text | N |
| Steam ID filter | `#topPlayers-steam_id` `data-search="t2.steam_id"` | text input, `maxlength=17` | Adds `t2.steam_id` to `search.text`. Placeholder "Steam ID". | 17-char SteamID64 | N |
| Sort selector | `#topPlayers-sort` `data-search="sort"` | single-value `multiselect` | Sets `search.multiselect['sort']`; server ranks by chosen metric. Placeholder `- Сортировка -`. | `online` \| `bonus` \| `boost` | N |
| (row click) | `#topPlayers tbody > tr` | click handler | Opens shared player-detail modal for that row: `player.open(<steam_id>)`. Suppressed when Alt/Ctrl held (to allow text selection). | SteamID from `<hashtag>` | N (opens modal) |

Sort options (top.html:25–27):

| Value | Label | Metric |
|---|---|---|
| `online` (default) | По онлайну (By online) | Cumulative playtime |
| `bonus` | По бонусам (By bonuses) | Bonus points |
| `boost` | По бусту (By boost) | Boost |

There are **no destructive/state-changing actions on the page itself** — it is entirely a read/browse surface.

#### 4.2 Actions reachable via the row-click modal (shared component)

All state-changing capabilities on this page come from the **shared player-detail modal** opened on row click, not from the leaderboard. The `action_catalog` tokens for `top.html` are those shared-modal actions; they hit `script:'player'` (`POST /ajax/player.php`) or `script:'squad'`. Documented in full in the shared-modal section; the two most relevant to this leaderboard's domain (online/activity) are:

| UI label | action id | Script / endpoint | Params | Effect | State-changing? |
|---|---|---|---|---|---|
| Скачать статистику (Download statistics) | `downloadStat` | `player` → `POST /ajax/player.php` (via `post_to_url` form submit, file download) | `steam_id` | Downloads the player's statistics export. | N (export) |
| (activity chart load) | `getPlayerOnlineData` | `player` → `POST /ajax/player.php` | `steam_id`, `start`, `end` | Returns `online_data` time-series (`minute`, `boost`, `queue` per timestamp) to render the modal's online chart over a chosen date range. | N (read) |

Other shared-modal action ids present in `top.html` (belonging to the modal, listed for completeness, all state-changing unless noted): `ban`, `unban`, `kick`, `kill`, `mark`, `message`, `changeGroup`, `changeTeam`, `twink`/`twinkOnline`, `findFriends` (read), `checkBans` (read), `addComment`/`getComments` (read), `addBanName`/`removeBanName`, `removePlayer`, `kits`/`kitSave`, `get` (read). These are the admin permissions surfaced by the modal, not by the leaderboard.

---

### 5. Forms & modals

The page has **no form of its own** and **no page-specific modal** — only the three filter inputs in the left rail and the embedded shared `#playerModal`/`#player_info`.

- **Steam ID input:** hard `maxlength="17"` (SteamID64 length). No other client-side validation; empty inputs are simply omitted from the search JSON.
- **Sort:** rendered by the `multiselect` plugin (`enableHTML: true`, `nonSelectedText: '- Сортировка -'`) with HTML labels (icon + text). Single-select in practice; `online` pre-selected.
- **Vestigial datepicker (bug/dead code):** the ready-handler initializes `datetimepicker` on `#topPlayers-startdate, #topPlayers-enddate` (top.html:62–66, Russian locale, `pickTime`, `sideBySide`) — **but those inputs do not exist in this fragment.** So the leaderboard has **no date-window control**; the online metric is an all-time cumulative aggregate. A date range only exists inside the modal chart (`getPlayerOnlineData` `start`/`end`). This looks like leftover code from a planned per-window ranking that was never shipped on this page.

---

### 6. Permission / visibility logic

- **Nav gating:** the page is hidden from the nav (no `top-menu` entry calling `pageLoad('top')`). There is no per-element `class="hide"` or role check inside `top.html`'s own content — the only `hide` element is `#player_info` (the shared modal's template holder, hidden by design and cloned into the modal on open). So visibility gating is at the **nav/routing layer**, not inside the fragment.
- **Inference on why hidden:** the page exposes every player's cumulative online/bonus/boost ranking across the whole database, which is (a) staff/internal-facing rather than public, (b) partially superseded — the same three metrics are shown per-player in the modal and the intended date-window control was never wired (§5). It reads as an internal/legacy or admin-only tool kept out of the normal menu. This is an inference from structure, not an explicit ACL in the fragment.
- **Row actions inherit modal permissions:** any actual authority (ban/kick/kits/group changes, etc.) is enforced by the shared modal's own action endpoints, so who can *do* things from here is governed by the same role checks as everywhere else the modal appears; the leaderboard itself grants only browse + open.

---

### 7. Notable UX & competitively interesting details

- **Three-axis activity ranking in one view.** A single leaderboard pivots between playtime, bonuses, and boost from one selector — a clean pattern for surfacing "most active / most rewarded / most boosted" players. Worth copying, and worth beating by making the three metrics **sortable columns** (this panel's headers are non-sortable; ranking is selector-only).
- **Icon-only metric headers** (clock/gift/double-up) keep the table compact but are unlabeled — an accessibility gap (no visible text/`title`/`aria-label`). Easy to beat with labeled, tooltipped, sortable headers.
- **Fixed sidebar filter rail** (`position:fixed`) keeps search controls in view while scrolling long result sets — good UX to replicate.
- **Row-click-to-drilldown** into the full player dossier (with Alt/Ctrl escape hatch to allow copy/select) is a slick interaction; the SteamID is embedded as a `<hashtag>` so it doubles as a copyable token.
- **Server-side pagination at 30/page with a separate count query** scales to a large player base; the info line shows total rows via `Intl.NumberFormat` (thousands separators).
- **Missing time window is the key competitive gap.** Because the datepicker targets non-existent inputs, there is no "top online this week/month" — the leaderboard is all-time only. A competitor can win immediately by offering selectable windows (daily/weekly/monthly/custom) on the leaderboard, reusing the same `online_data` (`minute`/`boost`/`queue`) time-series that already backs the per-player chart.
- **Anomaly flag on online time** (warning icon prepended when a condition holds, seen in the modal) hints at anti-boost/cheat-detection logic tied to playtime — a signal worth investigating and matching.


---

## Permission, Role & Group Model (Synthesis)

This cross-cutting chapter reconstructs the **complete authorization system** of SQSTAT (breaking.sqstat.ru) by synthesizing three per-section chapters — *05. Administration: Admins, Groups & Permissions*, *16. Settings (Server Management)*, and *18. Clan Management* — against the ground-truth JS (`frags/admins.html`, `custom.js`) and the `action_catalog.txt` action-id inventory. The goal is a single, precise picture of *who can do what, and how that is enforced.*

The headline finding: **SQSTAT has no unified RBAC engine. It layers three loosely-coupled authorization namespaces that share group *names* but not a common permission model**, and every client-side control is gated by opaque server-supplied booleans rather than a declarative capability set. This is the panel's single biggest architectural weakness and the richest area for a competitor to beat.

---

### 1. The Three Authorization Layers

SQSTAT authorization is not one system but three, stacked:

| # | Layer | "Who is X?" defined where | "What can X do?" defined where | Scope | Edited via |
|---|---|---|---|---|---|
| **L1** | **Panel role / group** (staff identity) | `changeGroup` → per-player `group_id` (0–5) — *05. Admins* | Coarse server-side booleans returned on `player.get` (`canBan`, `canChangeGroup`, …) | **Global** (panel-wide, no `server_id`) | Admins page → player modal → **Группа (Group)** button |
| **L2** | **In-game Squad admin permissions** (RCON power) | The *same* 5 group names, keyed by `data-setting` | 21 Squad `Admins.cfg` permission tokens per group (`ban`, `kick`, `cheat`, `manageserver`, …) — *16. Settings §3* | **Per Squad server** (written into each server's `Admins.cfg`) | Settings page → **groups** tab → `setServerSettings` |
| **L3** | **Clan / squad membership** (ownership of a paid clan) | Clan roster `type` (0/1/2) + `vip_mode` — *18. Clans* | Per-viewer booleans `access`, `v.access`, `canType` on the clan payload | **Per clan** | Clan page roster (`addPlayer`, `removePlayer`, `vipPlayer`, `setting`) |

The three layers **share the five group names** but are otherwise independent data:

| `group_id` (L1) | L1 Russian label (gloss) | Internal `name` (L1 & L2 key) | L2 settings block `data-setting` | Icon / color |
|---|---|---|---|---|
| `0` | -Нет группы- (No group) | *(clears group)* | — | — |
| `1` | Администратор (Administrator) | *Admin* | `Admin` | `fa-user-circle-o` / `#e50606` red |
| `2` | Модератор (Moderator) | `Moderator` | `Moderator` | `fa-id-badge` / `#2df044` green |
| `3` | VIP | `QueuePriority` | `QueuePriority` | `fa-star` / per-record |
| `4` | Камера (Camera) | *Camera* | `Cameraman` | `fa-video-camera` / `#7d059e` purple |
| `5` | Стажёр (Trainee) | *Trainee* | `Intern` | `fa-graduation-cap` / `#b57c03` orange |

> The mapping is confirmed by matching the `player.info.group.name` branch checks in `admins.html` (`== 'QueuePriority'`, `== 'Moderator'`, lines 1149–1152) to the five `data-setting` blocks enumerated in *16. Settings §3* (`Admin`, `Moderator`, `QueuePriority`, `Cameraman`, `Intern`). The L1 `description` field (e.g. "Администратор") is edited on the L2 groups tab (`data-group="description"`), so the two layers write to the same underlying group row — but L1 controls *panel* access while L2 controls *in-game* power, and neither is derivable from the other in the client.

---

### 2. Layer 1 — Panel Roles & Scope

**Fixed enum, not free-form roles.** Exactly six values (0 + five groups); no create-group / edit-capability UI exists in any fragment. One group per player (no stacking). See *05. Admins §2*.

**Group grant is a single opaque action.** The entire lifecycle — add / promote / demote / expire / revoke — is one `changeGroup` call with a different `group_id` (and `0` = remove). There is **no** distinct `promote`/`demote`/`addAdmin`/`removeAdmin` action at the panel level. Payload (`player.php`, action `changeGroup`, lines 2239–2249):

```
steam_id, date(expire), group_id, description, prefix, prefix_rgb, image
```

**Scope is GLOBAL.** The `changeGroup` payload carries **no `server_id`** — contrast every L2/L3 action which always sends `server_id`/`clan_id`. A panel role therefore applies across all servers at once; there is no per-server panel-admin assignment.

**A "group" carries cosmetic + identity payload, not just a tier:** `{group_id, expire, description, prefix (≤64), prefix_rgb, image (≤256)}` scoped to the player. Expiry (including `0` = infinity) lets trainee/camera access and VIP subscriptions auto-expire through the same mechanism.

#### 2.1 The L1 permission flags (the effective panel-permission model as the client sees it)

The server returns booleans on `player.get`; the modal only shows/hides controls (*05. Admins §3.3, §6*). These are the entire client-visible panel-permission vocabulary:

| Flag | Gates (client show/hide) | Source line |
|---|---|---|
| `canChangeGroup` | The **Группа (Group)** button → whether the operator may assign *any* group (up to Administrator). | admins.html 1130–1133 |
| `canBan` | Ban flow, name-ban, kits, and (online) kill; **also hides the Group button entirely when false** (1120). | 1119–1128, 1169 |
| `canUnban` | The "unban" control on an existing ban. | 1114–1115 |
| `canSelfKick` | The "kick without reason" (`kickNoReason`) control (online only). | 1172–1173 |
| `canPermanent` | Whether the operator may issue a *permanent* ban (vs progressive) in the ban flow. | 1648 |
| `is_you` | If target == operator: the group multiselect **and** expiry are **disabled** — you cannot edit your own group *in the UI*. | 2185–2190 |

There is **no** flag for "can grant group X but not Y", no per-server flag, and no tiered promotion rule. `canChangeGroup` is binary: hold it and you can grant Administrator.

---

### 3. Layer 2 — In-Game Squad Permission Tokens

L2 is the real capability matrix, but it governs **in-game RCON power**, not panel access. Each of the five groups holds a subset of the **21 Squad `Admins.cfg` tokens** (*16. Settings §3*), edited on the settings **groups** tab and written per-server:

`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`

Default **Admin** template grants everything **except** `startvote, private, immune, demos, clientdemos, forceteamchange`. Tokens `changemap`, `kick`, `ban` carry a warning icon "Не будет логироваться в панели" (Will not be logged in the panel) — using the in-game admin cam/console for those **bypasses SQSTAT's audit log**.

Inferred default token distribution by group (from the token names + group intent; the panel does not print each group's full set, but the group semantics are unambiguous):

| Token → in-game capability | Admin (1) | Moderator (2) | QueuePriority/VIP (3) | Cameraman (4) | Intern (5) |
|---|:--:|:--:|:--:|:--:|:--:|
| `reserve` (queue priority / reserved slot) | ✓ | ✓ | **✓** | ✓ | ✓ |
| `chat` (see/use admin chat) | ✓ | ✓ | — | — | ✓ |
| `canseeadminchat` | ✓ | ✓ | — | — | ✓ |
| `kick` | ✓ | ✓ | — | — | possibly |
| `ban` | ✓ | ✓ | — | — | — |
| `changemap` | ✓ | ~ | — | — | — |
| `balance` / `teamchange` | ✓ | ~ | — | — | — |
| `forceteamchange` | — (off by default) | — | — | — | — |
| `pause` | ✓ | — | — | — | — |
| `cheat` (admin cheat cmds) | ✓ | — | — | — | — |
| `config` / `manageserver` | ✓ | — | — | — | — |
| `cameraman` (admin cam) | ✓ | ~ | — | **✓** | — |
| `demos` / `clientdemos` | — (off by default) | — | — | — | — |
| `immune` (immune to admin actions) | — (off by default) | — | — | — | — |
| `private` / `startvote` | — (off by default) | — | — | — | — |
| `featuretest` / `debug` | ✓ | — | — | — | — |

Legend: ✓ = expected on, ~ = operator's choice, — = expected off. **VIP's only meaningful token is `reserve`** — it is a monetized queue-priority perk, not staff power. **Cameraman** is a near-empty group whose defining token is `cameraman` (spectator/admin-cam for content creators). **Intern** is a supervised subset of Moderator.

> L2 is fully editable per group and per server via `setServerSettings`, so these are *defaults/intent*, not hard guarantees. The point for a competitor: L2 is where the fine-grained capability model actually lives — but it is siloed to in-game RCON and never merged with L1 panel access.

---

### 4. Layer 3 — Clan Ownership Axis

Clan membership is a **separate ownership dimension** orthogonal to L1/L2 (*18. Clans §2, §6*):

| Clan concept | Field | Values | Governs |
|---|---|---|---|
| Clan role | member `type` | `1` = Глава (leader), `2` = Зам (deputy), `0`/'' = member | Who leads the clan (the clan "owner" axis) |
| Priority state | `vip_mode` | `1` = ON, `0` = OFF, `2` = granted elsewhere (locked) | Whether member holds a queue slot |
| Viewer-may-manage-priority | `text.access` (clan-level) | bool | Renders the entire VIP/priority column |
| Viewer-may-remove-this-member | `v.access` (per-row) | bool | Renders each row's remove button |
| Viewer-may-assign-leader/deputy | `clan.canType` | bool | Enables the leader/deputy add-menu; else members join as type 0 |

Clan priority (VIP) is a **paid product**: clans have an `expire` date and a `max` slot count ("X из 999"), and grant priority per-member via `vipPlayer` counted against the pool. This is a *second, independent path to VIP* — distinct from L1 `changeGroup(group_id=3)`. `vip_mode==2` marks priority "from another source" as a locked ban icon, reconciling the two paths visually but not in data.

---

### 5. The Permission Matrix — Actions × Enforcement

There is **no client-visible action×group matrix**; the client only knows the L1 booleans of §2.1 plus L3 `access`/`canType`. The matrix below is **reconstructed** by grouping every action id from `action_catalog.txt` by its `script` endpoint, its gating flag/token, and the **inferred minimum group** required. "Inferred" columns are marked *(inf.)*; they are the analyst's best reconstruction from UI gating, `hide` logic, and Squad token semantics, not a value the panel prints.

#### 5.1 Read / lookup actions — available to all authenticated staff

Every logged-in operator who can open a page can fire these; no destructive flag gates them. `script:'table'` powers all DataTables loads.

| action | script | Purpose | Min group *(inf.)* |
|---|---|---|---|
| `auth` | public | Login / session | any (pre-auth) |
| `get` | player | Open player modal (returns the L1 flags) | any staff |
| `getComments` | player | Read admin notes | any staff |
| `twink`, `twinkOnline`, `findFriends`, `checkBans` | player | Alt-account / cross-ban lookup | any staff |
| `getPlayerOnlineData` | player | Player online history | any staff |
| `list`, `stats` | clan | Clan roster + dashboard | any staff / public if `public` |
| `findPlayer` | clan | Player search to add | clan `canType`/`access` |
| `statistics` | squad | Server statistics page | any staff |
| `issues_get` | squad | Read issue reports | any staff |
| `getServer`, `getServerMaps`, `getRotation`, `getMods`, `getConfigFile(s)`, `getDefaultConfig`, `serverMonitor`, `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster`, `network`, `mapCalendar` | squad | Server read/telemetry (dashboard/settings) | Admin *(inf.)* — page reachability gated |
| `getServerSettings` | settings | Load settings tabs (groups, rules, discord) | Admin *(inf.)* |
| `(table load)` | table | Server-side row data everywhere | any staff |
| `downloadStat`, `downloadList`, `downloadOnline` | player/clan | CSV/file exports (form POST) | any staff / clan `access` |

#### 5.2 Player-moderation actions — gated by L1 booleans (Moderator+ *(inf.)*)

These are the shared player-modal actions embedded on **every** page. `script:'squad'` variants require the player **online** and always send `server_id` (per-server); `script:'player'` variants are global.

| action | script | Per-server? | Client gate | Backed by L2 token *(inf.)* | Min group *(inf.)* |
|---|---|:--:|---|---|---|
| `ban` | squad | ✓ | `canBan` (+`canPermanent` for perma) | `ban` | Moderator+ |
| `unban` | squad | — | `canUnban` | `ban` | Moderator+ |
| `kick` | squad | ✓ | (online) | `kick` | Moderator+ |
| `kickNoReason` | squad | ✓ | `canSelfKick` | `kick` | Moderator+ |
| `kill` | squad | ✓ | `canBan` + online | `cheat`/`kick` | Moderator+ |
| `changeTeam` | squad | ✓ | online + has team | `teamchange` | Moderator+ |
| `removePlayer` | squad | ✓ | online + in squad | `kick` | Moderator+ |
| `message` | player | (server ctx) | online | `chat` | Moderator+ |
| `addBanName` / `removeBanName` | player | — | `canBan` | `ban` | Moderator+ |
| `kits` / `kitSave` | player | — | `canBan` (kits shown) | — | Moderator+ |
| `mark` | player | — | (modal) | — | Moderator+ |
| `addComment` | player | — | (modal) | — | any staff |
| `changeExpire` | player | — | (modal) | — | Moderator+ |
| `transfer` | player | — | (modal) | — | Admin *(inf.)* |

#### 5.3 Privileged / grant actions — Administrator-tier *(inf.)*

| action | script | Client gate | Effect | Min group *(inf.)* |
|---|---|---|---|---|
| `changeGroup` | player | **`canChangeGroup`** | Grant/change/**revoke** any L1 group (incl. Administrator) or VIP; `group_id=0` removes | Administrator (super-admin) |
| `vipPlayer` | player / clan | `access` (clan) / `canChangeGroup` | Grant/revoke queue priority | Admin / clan manager |
| `setServerSettings` | settings | (settings page reachable) | Edit L2 token sets, rules, Discord wiring, **groups' permissions** | Admin (`manageserver`/`config`) |
| `add` | player | (players page) | Add a new player record | Admin *(inf.)* |

#### 5.4 Server-control actions (`script:'squad'`, main dashboard) — Administrator + `manageserver`/`config` *(inf.)*

The highest-blast-radius tier. All send `server_id`; reachability is gated by the operator's L1 group and (server-side) L2 `manageserver`/`config` tokens.

| Category | action ids | L2 token *(inf.)* |
|---|---|---|
| Lifecycle | `start`, `stop`, `restart`, `update`, `botUpdate`, `reloadConfig` | `manageserver` |
| RCON / process | `rconRaw`, `rconRestart`, `parserRestart`, `cacherRestart`, `serverMonitor`, `setServerIP` | `manageserver` |
| Match control | `changeMap`, `setRotation`, `getRotation`, `clearNext`, `broadcast`, `squadMessage` | `changemap` / `chat` |
| In-game squad ops | `disband`, `demote` (demote squad leader), `rename`, `transfer` | `kick` / `teamchange` |
| Config files | `getConfigFile(s)`, `getDefaultConfig`, `saveConfigFile` | `config` / `manageserver` |
| Mods | `getMods`, `installMod`, `deleteMod` | `manageserver` |
| Network / bans | `blockIP` | `ban` / `manageserver` |
| Content | `uploadVideo`, `uploadVideo_token`, `issues_create`, `seeding*`, `createSquad`, `saveUserSettings` | mixed / self |

> Note on naming: `demote` here is an **in-game squad-leader demotion** (RCON), *not* an L1 role demotion — L1 demotion is `changeGroup` to a lower `group_id`. Do not conflate them.

#### 5.5 Clan-scope actions (`script:'clan'`) — gated by L3, not L1

| action | Client gate | Min authority |
|---|---|---|
| `addPlayer` | `canType` for leader/deputy; else any manager | clan manager |
| `removePlayer` | per-row `v.access` | clan manager |
| `vipPlayer` | clan `access` | clan priority manager |
| `changeExpire`, `setting`, `delete` | (manager) | clan owner/manager |
| `createSquad` (create/edit) | `script:'squad'` | clan owner |

---

### 6. Enforcement Model

Enforcement is **server-side, opaque, and per-endpoint** — there is no declarative policy in the client. Three complementary mechanisms:

1. **Server-computed booleans (L1).** `player.get` returns `canBan`, `canUnban`, `canChangeGroup`, `canSelfKick`, `canPermanent`, `is_you`, computed from the *viewer's own* group. The client only calls `.show()`/`.hide()` on these; it never evaluates a group→action rule itself.
2. **Client `hide`/`disable` is cosmetic only.** Every gated control is `class="hide"` in markup and revealed by JS (`#player_group` starts `hide`; the Group button is `.show()`-ed only if `canChangeGroup`; `is_you` merely `disable`s the multiselect). *16. Settings §231* confirms the same pattern server-wide: "the action endpoints themselves are not visibly permission-checked client-side — the security boundary is entirely on the PHP side." **A hidden control is not a protected control** — the real gate must be the `/ajax/<script>.php` handler.
3. **L2 tokens flow to the game, not the panel.** `setServerSettings` writes the 21-token sets into each server's `Admins.cfg`; enforcement of in-game `ban`/`kick`/`cheat` is by the Squad server itself, out of the panel's control. The panel warns that `changemap`/`kick`/`ban` done in-game bypass its audit log entirely (*16. Settings §3*).

Because L1 gating is a handful of coarse booleans and the client cannot be trusted, **correctness rests entirely on each PHP endpoint re-deriving the viewer's group and checking it.** Any endpoint that trusts a client-sent `steam_id`/`server_id`/`group_id` without re-checking the caller is an escalation hole.

---

### 7. VIP vs Admin vs Owner Distinctions

| Actor | How defined | Powers | Not |
|---|---|---|---|
| **VIP** | L1 `group_id=3` (`QueuePriority`) with expiry, **or** L3 clan `vipPlayer` against a slot pool | Queue priority / reserved slot (`reserve` token) only | Not staff; no panel moderation, no `canBan`/`canChangeGroup` |
| **Camera** (4) / **Intern** (5) | L1 group | Camera: admin-cam spectator (`cameraman`); Intern: supervised subset of Moderator | Not full moderators; limited L2 tokens |
| **Moderator** (2) | L1 group; `Moderator` header art (`/assets/img/moderator.jpg`) | Player moderation (ban/kick/kill/kits/mark/message) via `canBan`+ | No `canChangeGroup`, no `manageserver` *(inf.)* |
| **Administrator** (1) | L1 group; typically the only holder of `canChangeGroup` | Everything: grants groups, edits L2, server control | — |
| **Owner / super-admin** | **No explicit role.** De-facto = whoever the server hands `canChangeGroup`; on clans, `type=1` (Глава/leader) | Sole grantor of groups incl. Administrator; clan leader controls roster | Not a distinct enum value — invisible, unauditable |

There is **no first-class "owner" role.** Top authority is implicit in the `canChangeGroup` flag (panel) and clan `type=1` (clan). VIP conflates **monetization** with the **access-control** table; L2 conflates **in-game RCON** with the same group names. These conflations are the model's defining smell.

---

### 8. Privilege-Escalation-Relevant Design

Ordered by severity; all are structural, not incidental.

1. **Unbounded grant ceiling.** `canChangeGroup` is binary and the group `<select>` includes `Администратор (1)` with no "max grantable level". Any operator the server marks `canChangeGroup=true` can promote **anyone (or an alt) to Administrator**, or self-elevate. There is no tiered "can grant up to N" rule anywhere in the client — the server must enforce a ceiling, and nothing in the captured code proves it does.
2. **Self-edit is only *disabled*, not *forbidden*.** `is_you` merely `disable`s the multiselect/expiry client-side (admins.html 2185–2190). The `changeGroup` payload still accepts an arbitrary `steam_id`. If the PHP handler does not reject `steam_id == caller`, an operator can POST a self-promotion directly, bypassing the disabled control.
3. **Client-only gating everywhere.** Per *16. Settings §231*, endpoints are not visibly permission-checked client-side. If any `/ajax/*.php` handler trusts client input, the entire `hide`-based model collapses. `saveConfigFile` is called out (*§16 §170*) as blindly POSTing the ambient `server_id` — direct server-config write is the highest-blast-radius action and shows the weakest client discipline.
4. **No per-server panel scoping (L1 is global).** A single `changeGroup` makes someone admin across **all** servers; there is no way to scope panel-admin to one server. A compromised or rogue mid-tier admin is a fleet-wide problem.
5. **Two divergent VIP paths, one lock.** L1 `changeGroup(3)` and L3 clan `vipPlayer` both grant priority; only `vip_mode==2` reconciles them visually. Divergent write paths to the same perk invite double-grants and accounting drift against the clan slot `max`.
6. **Audit blind spots.** In-game `changemap`/`kick`/`ban` are explicitly **not logged** (*§16 §3*), and `changeGroup` has **no dedicated audit action** — promotion/demotion/removal all collapse into one opaque call whose only trace is the free-text `description` (*05. Admins §7*). Privilege changes are therefore under-audited by design.
7. **Secret exposure to all settings-readers.** Live Discord webhook URLs with tokens are rendered into `value=""` attributes (*§16 §137*) — any operator who can reach Settings reads every webhook secret from page source. Violates least privilege for the L2/settings tier.

---

### 9. Competitor Takeaways

- **Collapse the three namespaces into one RBAC engine.** Separate cleanly: (a) roles/permissions, (b) subscriptions/perks (VIP), (c) in-game RCON tokens — but drive them from *one* declarative capability set with a real action×capability matrix, not scattered booleans.
- **Add a grant ceiling and first-class owner role.** "Can grant up to level N", an explicit Owner, and hard self-edit prevention (server-enforced, not `disable`d) close the top escalation vectors.
- **Per-server admin scoping.** Model panel-admin per server/server-group, not globally.
- **Audit every privilege change and in-game admin action** with a dedicated, immutable event (who/what/old→new), including config saves with diffs — beating SQSTAT's unlogged `changeGroup` and in-game-action blind spots.
- **Never echo secrets into markup**; gate config-write behind `config`/`manageserver` and re-check the caller server-side on *every* endpoint.

Cross-references: *05. Administration: Admins, Groups & Permissions* (L1 mechanics, `changeGroup`, flags), *16. Settings (Server Management) §3* (L2 groups tab, 21 tokens, enforcement note §231, webhook leak §137, config-save §170), *18. Clan Management §6* (L3 clan `access`/`canType`/`type`/`vip_mode`).


---

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


---

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


---

## Complete Action / RPC / RCON Catalog (Synthesis)

> Cross-cutting synthesis of every server-side capability SQSTAT (`breaking.sqstat.ru`) exposes to a logged-in admin. This chapter is the **union** of the per-section chapters — it consolidates the ~85 distinct `action` ids scattered across 28 page fragments into one authoritative reference. It is the panel's full **permission surface**: every row is a POST an authenticated session can issue.

### 1. How the RPC layer works

Every mutation and most reads go through a single JS helper defined in `custom.js`:

```js
Action({ script: '<script>', action: '<action>', data: {…} })
  → POST /ajax/<script>.php
     body: action=<action>&<k1>=<v1>&<k2>=<v2>…
```

Key mechanics extracted from the helper:

- **Endpoint = `script`.** Only six PHP endpoints exist: `public`, `player`, `squad`, `clan`, `settings`, and the DataTables-only `table`. The `action` id is what actually selects behaviour inside each endpoint; the endpoint is just a coarse router.
- **Envelope.** Responses are JSON with `{status:'ok'|…, msg, auth}`. A response carrying `auth:true` triggers `location.reload()` (session expiry). Otherwise `text.status=='ok'` runs the success callback; anything else surfaces `msg` via `addAlert()`.
- **Two data encodings.** Most calls pass a `data:{}` object (jQuery serialises it to `&k=v`); a handful of RCON-facing calls hand-build the query string (e.g. `data: '&server_id='+id+'&steam_id='+sid`). Both reach PHP identically as URL-encoded POST fields.
- **Bulk/file exports bypass `Action()`** and use `post_to_url('/ajax/<script>.php', {action:'download…', …})` to force a full-page POST that streams a file download.
- **`script:'table'`** is the DataTables server-side processing endpoint (row data for every grid). It is not an `action` in the mutation sense and is covered per-page, not here.

Because the shared **player-detail modal** (Chat/Kills/Deaths/Kits/Games/Comments tabs) is embedded into *every* page fragment, its ~22 actions appear in the ground-truth catalog under all 20+ pages. Those are listed **once** here under *player-mod*, not duplicated per page — see §4 for the "everywhere" invocation note.

### 2. Endpoint → category map (at a glance)

| Endpoint (`/ajax/*.php`) | Primary role | Categories served |
|---|---|---|
| `public.php` | Unauthenticated / session bootstrap + public reads | auth, video (upload), map calendar |
| `player.php` | Player database & annotations (non-RCON) | player-mod (DB side), stats read, user settings |
| `squad.php` | Live-server RCON + server ops + seeding + statistics + issues | RCON, player-mod (RCON side), stats, seeding, issues, video token |
| `clan.php` | Clan/community roster & config | clan, VIP |
| `settings.php` | Per-server settings form | server-config |
| `table.php` | DataTables row feeds (per page) | — (not an RPC action) |

The most sensitive observation for a competitor: **`squad.php` is a single endpoint that fronts raw RCON, process control (start/stop/restart/update), config file writes, seeding, and statistics.** One permission bit gating `squad.php` would be catastrophically coarse; SQSTAT must gate per-`action` server-side (not observable from the client, but implied by the group system in [05. Admins & Permissions](05-admins-permissions.md)).

### 3. Category totals

| Category | # actions | Endpoint(s) | Destructive actions present? |
|---|---:|---|---|
| player-mod | 23 | `player`, `squad` | Yes (ban/kick/kill/unban/removePlayer) |
| RCON | 22 | `squad` | Yes (start/stop/restart/update/blockIP/disband) |
| server-config | 17 | `squad`, `settings` | Yes (saveConfigFile/setRotation/installMod/deleteMod/setServerSettings) |
| clan | 10 | `clan`, `player` | Yes (delete/setting/addPlayer) |
| VIP | 1 | `clan` | Yes (vipPlayer) |
| stats | 6 | `squad`, `public` | No (read-only analytics) |
| seeding | 5 | `squad` | Yes (seedingSetPriority/seedingSetServer) |
| video | 2 | `public`, `squad` | Yes (uploadVideo) |
| issues | 2 | `squad` | Yes (issues_create) |
| auth | 1 | `public` | Yes (session) |
| misc | 1 | `player` | No |

Grand total: **~85 distinct action ids** across 6 endpoints.

---

### 4. player-mod — player moderation & annotation (23 actions)

Invoked from the **shared player-detail modal** and its ban/kick/message sub-modals, which are embedded in *every* page (`players.html`, `bans.html`, `chat.html`, `admins.html`, `vips.html`, `kills.html`, `deaths.html`, `damages.html`, `teamkills.html`, `revives.html`, `votes.html`, `reports.html`, `comments.html`, `mark.html`, `logs.html`, `top.html`, `collabans.html`, `playersOnline.html`, `clan_16.html`, `main.html`). Cross-ref: [03. Players](03-players.md), [08. Notes & Suspects](08-notes-suspects.md), [09. Bans](09-bans.md).

Split by endpoint: **DB/annotation actions → `player.php`**; **actions that must reach the live game server → `squad.php`** (RCON-backed).

| Action id | Endpoint | Data params | Effect | Destructive |
|---|---|---|---|:--:|
| `ban` | squad | `server_id?`, `steam_id`, `reason_id`, `description`, `days` | Ban player (permanent when days=0); if online, RCON-kicks from `server_id` | **Yes** |
| `kick` | squad | `steam_id`, `reason_id`, `description`, `noReason` | RCON-kick from live server (with/without reason string) | **Yes** |
| `kill` | squad | `server_id`, `steam_id` | RCON-kill the player's current pawn (soft punish) | **Yes** |
| `unban` | squad | `steam_id` (+ ban ref) | Lift an existing ban | **Yes** |
| `changeTeam` | squad | `server_id`, `steam_id` | Force-swap player's team via RCON | **Yes** |
| `removePlayer` | squad | `server_id`, `steam_id` | Remove/kick player from server roster | **Yes** |
| `message` | player | `steam_id`, `time`, `msg`, `log` | Send in-game warn/message to player; optionally log it | No |
| `changeGroup` | player | `steam_id`, `date`, `group_id`, `description`, `prefix`, `prefix_rgb`, `image` | Assign admin/VIP group + cosmetic prefix/color/icon, with expiry | **Yes** |
| `mark` | player | `steam_id`, `mark` | Flag/annotate player (suspect marker) | No |
| `addComment` | player | `steam_id`, `text` | Attach an internal note to the player | No |
| `getComments` | player | `steam_id` | Read player's internal notes | No |
| `checkBans` | player | `steam_id` | Cross-check player (and linked accounts) against ban DBs | No |
| `findFriends` | player | `steam_id`, `compare_steam_id` | Compare Steam friend graphs (alt/twink detection) | No |
| `twink` | player | `steam_id` | List shared-IP / linked accounts (twinks) | No |
| `twinkOnline` | player | `steam_id`, `compare_steam_id`, `start`, `end` | Overlay two accounts' online sessions to prove co-play | No |
| `addBanName` | player | `name` | Add player's nick to the banned-names blocklist | **Yes** |
| `removeBanName` | player | `name` | Remove nick from banned-names blocklist | No |
| `kits` | player | `steam_id` | Read the player's kit history | No |
| `kitSave` | player | `steam_id`, `kits` | Persist edited kit assignment for the player | No |
| `get` | player | `steam_id` | Load full player profile into the modal | No |
| `add` | player | `steam_id` | Register/import a player record by SteamID | No |
| `getPlayerOnlineData` | player | `steam_id`, `start`, `end` | Fetch online-time series for the profile chart | No |
| `downloadStat` | player | `steam_id` (via `post_to_url`) | Export the player's stat sheet as a file | No |

---

### 5. RCON — live server & process control (22 actions)

All on `squad.php`, invoked from the **Server Dashboard** (`main.html`). Cross-ref: [01. Server Dashboard & RCON Control](01-dashboard.md). These are the operator's live levers on a running Squad server.

| Action id | Data params | Effect | Destructive |
|---|---|---|:--:|
| `rconRaw` | `server_id`, `command` | **Send an arbitrary raw RCON command** to the server (free-text console) | **Yes** |
| `start` | `server_id` | Start the game server process | **Yes** |
| `stop` | `server_id` | Stop the game server process | **Yes** |
| `restart` | `server_id` | Restart the game server | **Yes** |
| `update` | `server_id`, `afterMapChange` | Trigger game update (optionally deferred to next map change) | **Yes** |
| `rconRestart` | `server_id` | Restart the RCON bridge/connection | **Yes** |
| `parserRestart` | `server_id` | Restart the log parser worker | **Yes** |
| `cacherRestart` | `server_id` | Restart the cache worker | **Yes** |
| `botUpdate` | — | Update the backend bot/agent | **Yes** |
| `broadcast` | `server_id`, `msg` | Server-wide in-game broadcast | No |
| `squadMessage` | `server_id`, `team`, `squad`, `time`, `msg` | Send a message to a specific squad | No |
| `changeMap` | `server_id`, `next`, `map`, `vote` | Set current or next map (optionally via vote) | **Yes** |
| `clearNext` | `server_id` | Clear the queued "next map" | No |
| `disband` | `server_id`, `team`, `squad` | Disband a squad | **Yes** |
| `rename` | `server_id`, `team`, `squad` | Rename a squad | No |
| `demote` | `server_id`, `steam_id` (squad leader) | Demote a squad leader | **Yes** |
| `transfer` | `server_id`, `team`, `squad` | Move a squad between teams | **Yes** |
| `blockIP` | `ip` | Block an IP at the network layer | **Yes** |
| `network` | `server_id` | Read live network/IP map for the server | No |
| `getServer` | `server_id`, `last_chat_id` | Poll live server state + incremental chat | No |
| `getServerMaps` | `server_id` | List available maps/units for the server | No |
| `setServerIP` | `server_id`, `ip` | Set/rebind the server's IP | **Yes** |

---

### 6. server-config — configuration, rotation, mods, settings (17 actions)

`squad.php` (config editor, mod manager, rotation) + `settings.php` (per-server settings form). Cross-ref: [16. Settings: Server Config, Rotation, Mods, Restarts](16-settings.md).

| Action id | Endpoint | Data params | Effect | Destructive |
|---|---|---|---|:--:|
| `getConfigFiles` | squad | `server_id` | List editable config files/dirs | No |
| `getConfigFile` | squad | `server_id`, `file`, `dir` | Read a config file into the editor | No |
| `saveConfigFile` | squad | `server_id`, `text`, `file`, `dir` | **Overwrite a raw server config file** | **Yes** |
| `getDefaultConfig` | squad | `file` | Load stock/default version of a config file | No |
| `reloadConfig` | squad | `server_id` | Hot-reload config on the server | **Yes** |
| `getRotation` | squad | `server_id` | Read current map rotation + map list | No |
| `setRotation` | squad | `server_id`, `rotation`, `day` | **Overwrite the map rotation** (optionally per-day) | **Yes** |
| `getMods` | squad | `server_id`, `only_status` | List installed Workshop mods / status | No |
| `installMod` | squad | `server_id`, `mod_id`, `fix` | **Install a Workshop mod** on the server | **Yes** |
| `deleteMod` | squad | `server_id`, `mod_id` | Remove a Workshop mod | **Yes** |
| `getServerSettings` | settings | `server_id` | Load the server settings form | No |
| `setServerSettings` | settings | full settings form body | **Persist server settings** (name, limits, flags…) | **Yes** |
| `serverMonitor` | squad | `start`, `end`, `server_id` | Read server health/monitor time series | No |
| `serverOnline` | squad | `start`, `end`, `server_id` | Read online-count history | No |
| `serverOnlineAdmins` | squad | `day`, `server_id` | Read admin-presence for a day | No |
| `serverOnlineBooster` | squad | `day`, `server_id` | Read booster-presence for a day | No |
| `setServerIP` *(also RCON)* | squad | `server_id`, `ip` | Listed under RCON §5; provisioning-adjacent | **Yes** |

---

### 7. clan — community/clan roster & config (10 actions)

`clan.php` (roster) + one `squad.php` creator + `player.php` export. Cross-ref: [18. Clan Management](18-clans.md), [04. Player Profile](04-player-profile.md) (create-squad entry point).

| Action id | Endpoint | Data params | Effect | Destructive |
|---|---|---|---|:--:|
| `list` | clan | `clan_id` | List clan members (nick, kit, discord, joined) | No |
| `findPlayer` | clan | `clan_id`, `find` | Search players to add to the clan | No |
| `addPlayer` | clan | `clan_id`, `steam_id`, `type` | Add a player to the clan (role via `type`) | **Yes** |
| `stats` | clan | `clan_id`, `start`, `end` | Clan online/boost/primetime analytics | No |
| `setting` | clan | `clan_id`, `key`, `value` | Change a single clan setting (key/value) | **Yes** |
| `changeExpire` | clan | `clan_id`, `date` | Change the clan's expiry date | **Yes** |
| `delete` | clan | `clan_id` | **Delete the clan** (redirects to `/`) | **Yes** |
| `createSquad` | squad | `id`, `name`, `expire`, `max`, `discord_id`, `tags` | Create a new clan/community | **Yes** |
| `downloadList` | clan | `clan_id` (via `post_to_url`) | Export clan roster file | No |
| `downloadOnline` | clan | `clan_id`, dates (via `post_to_url`) | Export clan online-history file | No |

---

### 8. VIP (1 action)

Cross-ref: [06. VIPs](06-vips.md), [18. Clan Management](18-clans.md). Note: `vips.html` itself only hosts the shared player modal + a search UI; the toggle that actually grants VIP lives in the clan roster view. VIP expiry more broadly rides on the player-mod `changeGroup` action (§4).

| Action id | Endpoint | Data params | Effect | Destructive |
|---|---|---|---|:--:|
| `vipPlayer` | clan | `clan_id`, `steam_id`, `vip` (bool) | Toggle VIP slot for a clan member | **Yes** |

---

### 9. stats — read-only analytics (6 actions)

Analytics reads (no state change). Cross-ref: [11. Statistics](11-statistics.md), [12. Games](12-games.md), [20. Top](20-top.md).

| Action id | Endpoint | Data params | Effect |
|---|---|---|---|
| `statistics` | squad | `start`, `end`, `servers` | Aggregate statistics dashboard data |
| `mapCalendar` | public | `start`, `end`, `server_id` | Map-history calendar events |
| `serverMonitor` *(also §6)* | squad | `start`, `end`, `server_id` | Health time series |
| `serverOnline` *(also §6)* | squad | `start`, `end`, `server_id` | Online-count history |
| `serverOnlineAdmins` *(also §6)* | squad | `day`, `server_id` | Admin presence |
| `serverOnlineBooster` *(also §6)* | squad | `day`, `server_id` | Booster presence |

---

### 10. seeding — seeding scheduler & priority (5 actions)

All `squad.php`, invoked from `player_profile.html` seed-helper. Cross-ref: [04. Player Profile](04-player-profile.md).

| Action id | Data params | Effect | Destructive |
|---|---|---|:--:|
| `seeding` | `start`, `isMobile`, `tab_id` | Start/join the live seeding session view | No |
| `seedingGetCalendar` | `start`, `end` | Read seeding calendar events (+ `canServerAction`) | No |
| `seedingGetPriority` | `start` | Read the seeding priority list for a day | No |
| `seedingSetPriority` | `start`, `data`, `min_players`, `use_unattached` | **Write** the seeding priority order/rules | **Yes** |
| `seedingSetServer` | `server_id` | Set the admin's seeding target server | **Yes** |

---

### 11. video (2 actions)

Cross-ref: [15. Issues & Video](15-issues-video.md).

| Action id | Endpoint | Data params | Effect | Destructive |
|---|---|---|---|:--:|
| `uploadVideo_token` | squad | — | Mint an upload token (CSRF/session gate) | No |
| `uploadVideo` | public | `FormData` (file + token), 300 s timeout | **Upload a video** (evidence/clip) | **Yes** |

---

### 12. issues (2 actions)

`squad.php`, `issues.html`. Backed by an external issue tracker (labels/state/paging). Cross-ref: [15. Issues & Video](15-issues-video.md).

| Action id | Data params | Effect | Destructive |
|---|---|---|:--:|
| `issues_get` | `state`, `page` | List issues (paginated, filtered by state) | No |
| `issues_create` | `body`, `labels` | **Create an issue** with labels | **Yes** |

---

### 13. auth & misc (2 actions)

Cross-ref: [00. Overview](00-overview.md), [05. Admins & Permissions](05-admins-permissions.md).

| Action id | Endpoint | Category | Data params | Effect | Destructive |
|---|---|---|---|---|:--:|
| `auth` | public | auth | `tz` (browser timezone) | Session bootstrap / login handshake; may return `url` to redirect | **Yes** |
| `saveUserSettings` | player | misc | `data` (JSON blob) | Persist the admin's own UI/user settings | No |

---

### 14. Destructive-surface matrix (blast radius)

The competitively important slice: which actions **change third-party state** and how far the blast radius reaches. Any permission model must gate these individually.

| Blast radius | Representative actions | Endpoint | Risk |
|---|---|---|---|
| **Whole game server** | `start`, `stop`, `restart`, `update`, `changeMap`, `setRotation`, `saveConfigFile`, `reloadConfig`, `installMod`, `deleteMod`, `setServerSettings`, `setServerIP` | squad / settings | Server downtime / misconfig |
| **Arbitrary console** | `rconRaw` | squad | Anything RCON allows — superset of every other server action |
| **Individual player (live)** | `ban`, `kick`, `kill`, `unban`, `changeTeam`, `removePlayer`, `blockIP`, `demote`, `disband`, `transfer` | squad | In-game punishment |
| **Player record (DB)** | `changeGroup`, `addBanName`, `kitSave`, `mark`, `addComment` | player | Persistent DB annotation / privileges |
| **Community** | `createSquad`, `delete`, `setting`, `addPlayer`, `vipPlayer`, `changeExpire` | clan | Clan roster / VIP economy |
| **Scheduling** | `seedingSetPriority`, `seedingSetServer` | squad | Seeding fairness |
| **Content/tracker** | `uploadVideo`, `issues_create` | public/squad | External artifacts |

### 15. Competitive takeaways

1. **Single raw-RCON escape hatch.** `rconRaw` (§5) is a free-text console; any admin who can reach it effectively holds every other server-side capability. A competing panel should treat `rconRaw` as its own top-tier permission and audit-log every command (SQSTAT routes it through `squad.php` like everything else — see [01. Dashboard](01-dashboard.md)).
2. **Endpoint ≠ permission.** Six PHP files front ~85 actions; `squad.php` alone fronts RCON, process control, config writes, seeding, statistics, and issues. Authorization must be per-`action`, never per-endpoint.
3. **Uniform envelope.** The `{status, msg, auth}` contract + `Action()` helper is trivial to reimplement; the moat is the **breadth** of the action set (live RCON + config editor + mod manager + seeding + clan economy + statistics in one SPA), not the transport.
4. **Shared modal = 23 actions everywhere.** Because the player-detail modal ships on every page, a competitor gets maximal leverage by building that one component well; it is the single most-reused surface in the product.
5. **Export via full-page POST.** `download*` actions deliberately sidestep the AJAX helper (`post_to_url`) to stream files — an easy-to-miss but load-bearing pattern for CSV/roster exports.
