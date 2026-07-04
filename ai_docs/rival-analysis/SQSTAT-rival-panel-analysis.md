# SQSTAT — Rival Admin Panel: Complete Functionality Analysis (spec-grade)

**Target:** `breaking.sqstat.ru` — a SQUAD game-server management + statistics panel ("SQSTAT 2019–2026, by Enj0y")
**Purpose:** Competitive benchmark for this project's `squad-admin-panel`.
**Method:** Two passes — (1) authenticated read-only exploration + static analysis of the client bundle; (2) a **parallel-browser live-capture pass** where a fleet of subagents each drove its **own** headless Chromium (authenticated via the session cookie) and intercepted the real AJAX traffic, so the chapters carry **exact captured API contracts** (endpoint, params, response field types), not just inferred shapes.
**Date:** 2026-07-04

> **Scope & ethics.** Nothing was created, modified, or deleted on the rival panel. The live-capture browsers ran behind a network interceptor that **aborted any mutating `Action` at the wire** — verified **0 mutations attempted** across the entire fleet. Only page renders and the app's own auto-fired read endpoints were observed. This document describes **functionality, structure, entities, and permissions**, and avoids reproducing the rival's third-party user data beyond isolated redacted examples.

> **How to read it.** Per-section chapters (01–20) each carry a **"### Live API Contracts"** block backed by captured request/response schemas. Cross-cutting chapters synthesize those: **90** permission model, **91** entity/data model (full DB/ERD spec from live schemas), **92** per-player storage (the dossier), **93** the complete action/RPC/RCON catalog.

---

## Executive Summary

SQSTAT is a mature, multi-server **all-in-one SQUAD server platform** fusing four products most competitors ship separately:

1. **Live RCON control** of many servers (map/rotation, chat/broadcast, squad & team ops, kick/ban/kill, start/stop/restart, mods, config).
2. **A years-deep statistics engine** — per-player, per-clan, per-match, per-weapon/vehicle analytics.
3. **Moderation suite** — bans, banned-nicknames, suspect marking, admin comments, a **cross-community shared ban network ("Ру-Баны")**, reports/votes logs, and a full admin **audit journal**.
4. **Community & monetization** — clan directory + management, VIP/subscriptions, a bonus-points economy, Discord bot + webhooks, a public API, wiki, and a bug tracker.

**Technology:** PHP backend + Steam-OpenID auth; a jQuery 2.2 / Bootstrap 3.3 AJAX single-page shell (`pageLoad()` renders fragments; `Action({script,action,data})` posts to six `/ajax/<script>.php` endpoints). Chart.js, Leaflet, FullCalendar, CodeMirror. A separate **bot/parser** process scrapes each server's RCON into the DB. Not a modern SPA framework — a maintainability/UX gap to exploit.

**API shape (captured live):** every list grid funnels through one **`POST /ajax/table.php`** envelope — request carries `table`, `numrows`, `page`, `order`, and a 5-bucket `search` object keyed by each control's raw **SQL alias** (e.g. `t2.player`); response is `{ data:{ row[], totalPage, totalRows, currentPage, query_time }, status, exec_time }`. Every scalar arrives as a **JSON string**; unix timestamps are 10-digit string seconds (live-presence uses 13-digit ms); some cells ship **pre-rendered HTML inside the JSON**. Real captured table ids include `allPlayers, banPlayers, vipPlayers, adminPlayers, playerComments, playerMark, playerKills, playerDeath, playerRevive, playerDamage, playerTeamkill, games, votes, reports, ban_names, collabans, topPlayers, logs, playersOnline` + 11 player-modal sub-tabs.

**Live structural finding:** a **SteamID64 → UUID primary-key migration is in progress** — rewritten global tables (`adminPlayers`, `playerComments`, `playerMark`, `logs`, `changeGroup`) emit a 36-char UUID under the legacy `steam_id` column, while high-volume event/archive tables and the whole public API still key on SteamID64. A reimplementation must treat `steam_id` as an opaque identity column.

**Scale on this one instance:** ~**385,350** players · ~**115,400+** audit-journal entries · ~**80** clans · **53** staff · **6** servers.

**Authorization (chapter 90)** — **no unified RBAC**; three stacked layers sharing five group *names* but not a permission model:

| Layer | Identity | Capabilities | Scope | Edited in |
|---|---|---|---|---|
| **L1 Panel role** | per-player `group_id` 0–5 (`changeGroup`) | coarse server booleans (`canBan`, `canChangeGroup`, …) | **global** | Admins → player modal → Группа |
| **L2 In-game RCON** | same 5 group names | 21 Squad `Admins.cfg` tokens per group | **per server** | Settings → Группы |
| **L3 Clan ownership** | clan roster `type` + `vip_mode` | clan `access`/`canType` booleans | **per clan** | Clan page roster |

Groups: **Administrator (1)**, **Moderator (2)**, **VIP·QueuePriority (3)**, **Cameraman (4)**, **Intern (5)**, `0`=none. VIP conflates monetization with the access table; L2 conflates in-game power with the same names. Seven privilege-escalation findings in ch. 90.

**Biggest competitive opportunities:** unify RBAC (roles vs perks vs RCON) with a real capability matrix + grant-ceiling; add per-server admin scoping and a first-class owner role; audit every privilege change and in-game admin action; modernize the jQuery/BS3 stack; separate monetization from access control; finish (and normalize) the SteamID64→UUID migration.

---

## Visual Evidence (screenshots)

Full-page captures in [`screenshots/`](screenshots/): public homepage, dashboard/RCON, admins roster, **Settings→Groups permission editor**, audit journal, clan management, public profile, players directory, **player admin dossier modal**, bans, Ру-Баны, statistics, VIP, games, chat. See the table in each relevant chapter.

---

## Table of Contents

**Foundations** — 00 Overview & Architecture · 01 Server Dashboard & RCON · 02 Chat
**Players & Moderation** — 03 Players Directory · 04 Player Profile & Storage · 05 Admins/Groups/Permissions · 06 VIP · 07 Online · 08 Comments & Marks · 09 Bans · 10 Ban-names & Ru-Bans
**Tools & Analytics** — 11 Statistics · 12 Games · 13 Combat Logs · 14 Votes & Reports · 15 Issues & Video · 16 Settings · 17 Audit Journal
**Clans, API & Extras** — 18 Clans · 19 API · 20 Top
**Cross-cutting Synthesis** — 90 Permission Model · 91 Entity/Data Model · 92 Per-Player Storage · 93 Action/RPC/RCON Catalog

---


---


---

## 00. Overview & Architecture

Reference analysis of the **rival SQUAD game-server admin panel "SQSTAT"** — instance `breaking.sqstat.ru` (branding: "SQSTAT 2019–2026, by Enj0y"), for competitive benchmarking against this project's `squad-admin-panel`.

> **Method (two passes).** (1) Authenticated exploration of the live panel + static analysis of the client bundle. (2) A **live-capture pass**: a fleet of subagents each drove its **own** headless Chromium (authenticated via the session cookie), driving each section and intercepting the real AJAX traffic, so the per-section chapters and the cross-cutting chapters (91 data-model, 92 per-player storage, 93 action catalog) carry **exact captured request/response contracts** — endpoint, params, and response field types — not just inferred shapes. Chapters marked "### Live API Contracts" are backed by captured schemas.

> **Scope & ethics:** All exploration was strictly **read-only** (no state was changed on the rival panel). The live-capture browsers ran behind a network interceptor that **aborted any mutating action at the wire** (verified: 0 mutations attempted across the whole fleet). This documentation describes *functionality, structure, entities and permissions*, and does **not** reproduce the rival's third-party user data (player SteamIDs, names, IPs, ban lists) beyond isolated redacted examples needed to explain a feature.

> **Notable live finding:** the captures reveal a **SteamID64 → UUID primary-key migration in progress** — rewritten global tables (`adminPlayers`, `playerComments`, `playerMark`, `logs`, `changeGroup`) now emit a 36-char UUID under the legacy `steam_id` column, while high-volume event/archive tables and the entire public API still key on SteamID64. See chapter 91 §identity.

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

> Competitive functionality analysis of SQSTAT (`breaking.sqstat.ru`). This section documents the **main per-server control panel** — the largest page fragment (~332 KB rendered `#content`) and the operational heart of the panel. Everything an admin does to a live Squad server happens here. The **Live API Contracts** subsection below is captured ground truth: a headless authenticated browser rendered `/?server_id=1` and recorded the app's own auto-load AJAX (read-only; zero mutations fired — see `_blocked.json` = `[]`).

Capture provenance: `caps/dashboard/__server_id_1.network.json` (contracts), `caps/dashboard/__server_id_1.content.html` (rendered fragment), `caps/dashboard/__server_id_1.png` (screenshot). 1 live contract captured (`squad.getServer`), 0 blocked mutations.

---

### 1. Purpose & Navigation

| Attribute | Value |
|---|---|
| Nav location | `main` (default landing page) |
| Loader | `pageLoad('main')` → `GET /ajax/page.php?page=main` → fragment injected into `#content` |
| Deep links | `/?server_id=<id>` (open a specific server tab), `/?steam_id=<id>` (auto-open player modal), `/?start_seed=true` (auto-open the seeding helper) |
| Primary RPC script | `squad` → `POST /ajax/squad.php` (nearly all live-control actions) |
| Secondary scripts | `public` (rotation read / map calendar / auth), `player` (shared player-modal actions), `table` (DataTables server side) |

**Layout.** A single full-width row split into:
- **Left ~75% (`col-md-9`, `data-hide="offline"`):** live player/squad board, tab strip **Игроки (Players → `#players`)**, **Техника (Vehicles → `#vehicles`, `.hide`-gated)**, **Очередь (Queue → `#queue`)**, **Отключившиеся (Disconnected → `#disconnected`)**.
- **Right ~25% (`col-md-3`):** the control sidebar — collapsible **Управление (Control)** and **Состояние (State/monitoring)** panels, an **Онлайн (Online)** gauge + chart, a live **Чат (Chat)** feed with a broadcast input, a **Карта (Map)** widget (current/next map, rotation, calendar), and a **legend for player markers**.

**Server tabs.** A `#servers` strip lists every server as `<a data-server="<id>" data-toggle="tab">`. In the live capture the account can see server ids `1, 6, 7, 9, 10, 11`. Each tab carries live badges refreshed on the 5 s `getServer` poll:

| Badge attr | Source field | Rendering |
|---|---|---|
| `data-type="badge_online"` | `servers[id].players` | `players/100` (or `OFF` + `.bg-important` when down) |
| `data-type="badge_queue"` | `servers[id].queue` | `+N` (hidden when 0) |
| `data-type="badge_admins"` | `servers[id].admins` | admin headcount |
| `data-type="you_play"` | `you` (SteamID) | `fa-user text-danger` prepended on the tab where *you* are playing |

Header globals: **global online** rendered `N (percent%)` from `global_online`; a **Squad sale** banner when `is_sale != 0`; a **seeding** pulse when `isSeeding == true`.

---

### 2. Live API Contracts

> This is the authoritative endpoint spec, built directly from the captured schema. All requests are `POST /ajax/<script>.php` with an `application/x-www-form-urlencoded` body. The client's `Action()` helper (see §2.4) serializes an object `data` map by **raw concatenation** `&<key>=<value>` with `action=<action>` appended — values are **not** URL-encoded by the helper, so callers pre-encode any value containing `&`/`=`/spaces themselves (e.g. `encodeURIComponent(map)`).

#### 2.1 `getServer` — live server-state poll (CAPTURED)

The only auto-load read on this page. Polled every **5000 ms** for the active tab.

**Endpoint:** `POST /ajax/squad.php`
**Captured request body:** `&server_id=1&last_chat_id=false&action=getServer`

| Param | Type | Required | Meaning |
|---|---|---|---|
| `server_id` | int | Y | Active server tab id |
| `last_chat_id` | int \| `false` | Y | Chat delta cursor. `false` on first poll → full chat tail; thereafter the highest `chat[].id` seen, so each poll returns only new messages |
| `action` | const | Y | `getServer` |

**Response** `application/json; charset=utf-8`. Root envelope (`text`):

| Field | Type | Meaning |
|---|---|---|
| `status` | enum `"ok"`\|err | `Action()` runs `success` only when `== "ok"` |
| `exec_time` | float | Server render time (s) |
| `test` | object | Per-stage timing telemetry: `getAdmin`, `queue`, `stat`, `post`, `chat` — floats (seconds); `queue` also carries a unix-seconds float marker |
| `server` | object | The full server-state object (see 2.1.1) — drives `showServer()` |
| `you` | str(SteamID) \| `false` | Your SteamID if you are currently in *this* server, else `false` |
| `servers` | map<id, {players:int, admins:int, queue:int}> | Per-server tab badge counts for every visible server |
| `ips` | map<ip, str> | IP → count of active players sharing it (alt-detection source; redacted example `{"46.174.48.77":"4"}`) |
| `panelAdmins` | array<{name:str, steam_id:str, online:bool}> | Panel admins assigned to this server + presence |
| `global_online` | int | Total tracked Squad players worldwide (market-share numerator) |
| `is_sale` | int (0/1) | Steam Squad discount active flag |
| `isSeeding` | bool | Seeding-helper active pulse |
| `discord` | array | Linked Discord voice/presence rows (empty in capture) |

##### 2.1.1 `server` object (live field spec)

| Field | Type | Meaning / notes |
|---|---|---|
| `map` | str | Current layer display name, e.g. `"Sumari Seed v1"` |
| `nextMap` | str | Queued next layer; `""` when none set |
| `map_start` | str(unix-sec) | Epoch when current layer started |
| `players.active[]` | array | Live roster — see 2.1.2 |
| `players.dis[]` | array | Recently disconnected (same row shape; empty in capture) |
| `squads[]` | array | Live squads — see 2.1.3 |
| `teams[]` | array<{id, name, unit, short}> | 2 entries; `short` faction code (e.g. `WPMC`) drives banner `/assets/img/teams/<short>_bg.jpg`; `unit` e.g. `CombinedArms` |
| `server` | str | Server letter designator, e.g. `"A"` |
| `isConnect` | bool | RCON/bot connected → full board vs "Нет подключения" |
| `block_start` | bool \| {msg, code} | `false` normally; object blocks the Start button. `code == 4` → server mid-update, render `update_log` in `<pre>` |
| `update_log` | str | Live update stdout (shown when `block_start.code == 4`) |
| `need_restart` | bool | Pending-restart flag (config changed) |
| `outdated` | bool | Bot version outdated → "Обновить бота" banner |
| `eos_problem` | bool | EOS backend degraded → banner |
| `last_restart` | {day,month,year,hour,minute,seconds,ms,unix} | All **strings**; `unix` = epoch seconds |
| `bot_start` | {…same shape} | Bot process start time |
| `start_params` | {ip, port, query} | Bound IP / game port / Steam-query port; each `false` when unset, else value |
| `beacon_port` | str | RCON beacon port, e.g. `"15000"` |
| `region` | str | EOS region, e.g. `"eu-west-2"` |
| `pings` | map<region, str-ms> | EOS filter ping per region (9 regions: `ap-east-1`, `ap-southeast-1/2`, `eu-central-1`, `eu-north-1`, `eu-west-2`, `me-central-1`, `us-east-1`, `us-west-1`) |
| `eos_online` | str | EOS-monitored online count |
| `license` / `license_valid` | str / bool | License id + validity |
| `squad_version` | {version:str, build:str} | Game server version, e.g. `10.5.1` / `627303` |
| `version` | str | Panel/bot agent version, e.g. `"1.2.9a"` |
| `vote` | {isVote:bool, votes:{yes:[],no:[]}, map:str, mode:enum} | In-game map vote; `mode` ∈ `skip`\|`next`\|`current` |
| `queue_list[]` | array | Players waiting in queue (empty in capture) |
| `flags[]` | array | Server-level flags/warnings |
| `calculateOnline` | map<teamId, {time, avg, sl, median, squads:map<sqId,{avg,median}>}> | Per-team & per-squad playtime aggregates as **pre-formatted RU strings** (e.g. `"1,576ч 7м"`); `sl` = squad-leaders' avg |
| `stat.online` | {date[], players[], admins[], queue[]} | Parallel arrays (62 samples in capture) for the online mini-chart; `date` = `"HH:MM"` labels |
| `stat.maps[]` | array<{map, start(unix-str), end:bool\|unix, t1, t2, id:bool\|int}> | Recent played layers with faction shorts `t1`/`t2` |
| `monitor[]` | array (60) | Hardware time-series — see 2.1.4 |
| `chat[]` | array | Chat feed delta — see 2.1.5 |
| `playtime` | str | Your current session length (RU formatted) |
| `time` | {work:float, current_time:str, prev_time:str} | Server clock; `*_time` = `"DD.MM.YYYY HH:MM:SS"` |
| `joinlink` | bool \| str | Steam `connect` deep-link when available |

##### 2.1.2 `players.active[]` row (live)

| Field | Type | Meaning |
|---|---|---|
| `id` | str | In-server player slot id (e.g. `"11"`) |
| `steam_id` | str(17) | SteamID64 — row key `data-id`, target of every player action |
| `eos_id` | str(32) | Epic Online Services id |
| `name` | str | Display name |
| `team` | str `"1"`\|`"2"` | Team |
| `squad` | bool \| str-id | `false` = unassigned; else squad id |
| `leader` | bool | Is squad leader |
| `kit` | str | Raw kit token (e.g. `WPMC_LAT_01`); regex-reduced to base kit → `/assets/img/ico/kits/<kit>.svg` |
| `ip` | str | Player IP (used with root `ips` map for same-IP alt count) |
| `isAdmin` | bool | Player is a panel admin |
| `color` | bool \| str-hex | Clan-tag color; `false` or hex rendered `<code style="color:#…">` |
| `mark` | int | Watch/flag level (`0` = none) → row `.player_mark` |
| `warning` | bool | >3 punishments → `fa-user-secret` badge |
| `vac` | bool | Steam/VAC ban within 100 days → Steam icon |
| `baby` | bool | New player (<30 h) → baby icon |
| `playtime` | {date:int, last_seen:int} | **Unix milliseconds**: session start + last-seen |
| `requests` | {admins:bool, report:bool} | Live admin-call / report indicators |
| `location` | {iso:str(2), country:str, city:str} | Geo (e.g. `RU` / `Россия` / `Chita`) → flag + tooltip |

> Fields the earlier draft listed (`state`, `in_vehicle`) are **not present** in the live active-player row for this server; vehicle occupancy is templated (`data-template="vehicle"`) but the Техника tab is `.hide`-gated (see §6).

##### 2.1.3 `squads[]` row (live)

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Squad number (badge) |
| `name` | str | Squad name (clearable via `rename`) |
| `team` | str `"1"`\|`"2"` | Owning team |
| `size` | str | Member count, rendered `size/9` |
| `locked` | bool | Locked squad → lock icon |
| `cmd` | bool | Has a Commander → star icon; CMD squads sort to top |
| `create_id` | str(SteamID) | Creator SteamID64 (crown icon) |
| `create_name` | str | Creator display name |
| `eos_id` | str(32) | Creator EOS id |
| `message` | bool | Pending scheduled squad-message |

##### 2.1.4 `monitor[]` sample (hardware telemetry)

Each `{date:str(unix-sec), data:{…}}`:

| `data` key | Type | Meaning |
|---|---|---|
| `pid` | str | Server process id |
| `mem` | str | RSS memory (GB) |
| `network` | {send, receive, format, connections:int} | Throughput (`format` unit e.g. `"Mb"`); `connections` drives the "under attack" banner when > 300 |
| `cpu` | array<int> | Per-core / aggregate CPU load % |
| `disk` | {read, write} | Disk MB/s |
| `freq` | array<str> | Core frequency (GHz) |
| `temp` | array<int> | Core temperature (°C) |
| `tps` | str | Server tick rate |

##### 2.1.5 `chat[]` delta row

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Monotonic chat id → next poll's `last_chat_id` cursor |
| `server_id` | str | Origin server |
| `steam_id` | str | Author SteamID64 |
| `name` | str | Author name |
| `team` | str | Faction short (e.g. `MEI`) |
| `type` | enum | Channel: `ChatAll`, `ChatTeam`, `ChatSquad`, `ChatAdmin`, command (`!stats`) etc. |
| `date` | str(unix-sec) | Timestamp |
| `msg` | str | Message body (commands like `!stats` visible) |
| `group_id` | str | Author admin-group id |
| `type_format` | {name, color(hex), icon(fa-\*)} | Channel badge styling (e.g. `ChatAll` → `#00C3FF` / `fa-globe`) |
| `color` | str-hex | Author name color |

**Redacted example row:** `{ "id":"800848","server_id":"1","steam_id":"<redacted:17>","name":"<redacted:10>","team":"MEI","type":"ChatAll","date":"1783145247","msg":"!stats","group_id":"5","type_format":{"name":"<redacted:4>","color":"#00C3FF","icon":"fa-globe"},"color":"#..." }`
Cite: `caps/dashboard/__server_id_1.network.json`.

#### 2.2 Reads fired on user interaction (not auto-loaded, so not in the capture)

These only fire when the corresponding modal/panel is opened, so the read-only capturer (which performs no clicks) did not record them. Shapes below are from `main.html` render code and prior analysis — flagged as **inferred**, not captured.

| Action | Script | Params | Returns (inferred) | Destructive |
|---|---|---|---|---|
| `getRotation` | squad | `server_id` | `{rotation:{lists:map<day,str>, current, isWin:bool}, list, canEdit:bool}` | N |
| `getServerMaps` | squad | `server_id` | `{maps[], units[]}` map picker catalog | N |
| `serverMonitor` | squad | `start`, `end`, `server_id` | time-series: mem, network_send/receive, disk_read/write, tps, network_connections | N |
| `serverOnline` | squad | `start`, `end`, `server_id` | `{players[], admins[], queue[], days[], maps{}}` | N |
| `serverOnlineAdmins` | squad | `day`, `server_id` | `{events, resources}` admin presence timeline | N |
| `serverOnlineBooster` | squad | `day`, `server_id` | `{events, resources}` booster timeline | N |
| `network` | squad | `server_id` | `{network:{ips:map<ip,{conn[],country,city}>, sockets[]}}` | N |
| `mapCalendar` | public | `server_id`, `start`, `end` | played-maps calendar | N |
| `getConfigFiles` / `getConfigFile` | squad | `server_id` / file | config file list / contents | N |
| `getDefaultConfig` | squad | file | default template | N |
| `getMods` | squad | `server_id` | installed Workshop mods | N |

#### 2.3 Server tables (`script: 'table'` — DataTables server-side)

The dashboard's own Queue/Disconnected/roster panels render from the `getServer` payload directly (client-side), not via `table.php`. The `table` script backs the paginated grids on sibling pages (players, bans, chat, …). Live table headers observed in the rendered fragment:

| Panel | Column headers (RU → EN) |
|---|---|
| Отключившиеся (Disconnected) | `SteamID`, `Имя` (Name), `Время` (Time) |
| Очередь (Queue) | `Позиция` (Position, w80), `EOS` (id, w160), `Имя` (Name), `Время` (Time, w100) |
| Чат (Chat feed) | `Дата` (Date, w120), `Чат` (Channel, w80), `Сообщение` (Message) |

#### 2.4 `Action()` request serializer (from `custom.js`)

`Action({script, action, data, …})` → `$.ajax({ url:'/ajax/'+script+'.php', type:'POST' })`.

| data form | Serialization |
|---|---|
| `FormData` | appends `action`; `contentType:false` (multipart, used for uploads) |
| plain object | `$.map(data, (v,i)=>'&'+i+'='+v).join('')` then `+= action` — **no URL-encoding**; callers must pre-encode |
| string | `"action="+action+data` |

Cross-cutting flags: `retryAbort:true` aborts any in-flight request of the same `name` before firing; `pageAbort:true` cancels on navigation; `connectCheck:true` short-circuits when offline. Success gate: `text.status == 'ok'`, else `error(msg)` → `addAlert(msg,'exclamation-triangle')`.

---

### 3. Polling & State Machine

The page polls `squad.getServer` every **5000 ms** for the active tab, advancing `last_chat_id` each cycle.

Server display states (from `server.isConnect` / `server.block_start`):

| Condition | UI behavior |
|---|---|
| `isConnect === true` | Full board shown; control buttons enabled |
| `!isConnect && block_start === false` | "Нет подключения (No connection)"; **Включить (Turn on)** button shown |
| `block_start` is object | Shows `block_start.msg`; Start button hidden. `block_start.code == 4` → renders `update_log` in a `<pre>` (server mid-update) |

Alert banners (each `display:none` until triggered):
- **Версия бота неактуальна (Bot outdated)** when `outdated == true` — inline **Обновить бота (Update bot)** link (`botUpdate`).
- **Проблемы с EOS backend** when `eos_problem == true`.
- **На сервер идёт атака (Under attack)** when any `monitor[].data.network.connections > 300` — shows connection count + **Открыть подключения (Open connections)** (`network`).
- **Скидка на Squad** when `is_sale != 0`.

---

### 4. Actions / Admin Capabilities

All POST to `/ajax/<script>.php` with body `action=<id>&<params>`. "Destructive" = mutates live server/game state (⇒ these equal the permission surface). Params are the object keys passed to `Action({data:{…}})`.

#### 4.1 Server lifecycle — Управление (Control) panel — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Включить (Turn on) | `start` | `server_id`(int) | Boots the game server (confirm) | Y |
| Выключить (Turn off) | `stop` | `server_id`(int) | Shuts the server down | Y |
| Рестарт (Restart) | `restart` | `server_id`(int) | Restarts the game server | Y |
| Обновить (Update) | `update` | `server_id`(int), `afterMapChange`(bool) | Updates server; optionally defers to next map change | Y |
| RCON | `rconRestart` | `server_id`(int) | Restarts the RCON connection | Y |
| Parser | `parserRestart` | `server_id`(int) | Restarts the log parser | Y |
| (Steam Query) | `cacherRestart` | `server_id`(int) | Restarts the Steam-query cacher | Y |
| Обновить бота (Update bot) | `botUpdate` | *(none)* | Updates the sqstat bot agent | Y |
| (IP select) | `setServerIP` | `server_id`(int), `ip`(str) | Rebinds server IP (effective after restart) | Y |

Confirmation dialogs (`$.question`) gate start/stop/restart/update/rcon/parser/cacher/botUpdate. `blockServerButtons()` disables the four lifecycle buttons while an op is in flight.

#### 4.2 Player control (live-server, scoped by `server_id`) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Кик (Kick) | `kick` | `steam_id`(str), `reason_id`(int), `description`(str), `noReason`(bool) | Kicks player; `noReason:true` skips reason | Y |
| Бан (Ban) | `ban` | `server_id`(int), `steam_id`(str), `reason_id`(int), `description`(str), `days`(int) | Bans player (`days=0` → permanent) | Y |
| Разбан (Unban) | `unban` | `steam_id`(str), `unban`(bool) | Removes ban; `unban:true` fully wipes the record | Y |
| Убить (Kill) | `kill` | `server_id`(int), `steam_id`(str) | Kills player in-game | Y |
| Сменить команду (Change team) | `changeTeam` | `server_id`(int), `steam_id`(str) | Force team-swap | Y |
| Исключить из сквада (Remove from squad) | `removePlayer` | `server_id`(int), `steam_id`(str) | Removes from squad without kicking | Y |

> **Shared modal note:** the player-detail modal (tabs Chat/Kills/Deaths/Kits/Games/Comments; actions `mark`, `message`, `twink`, `twinkOnline`, `findFriends`, `addComment`, `getComments`, `changeGroup`, `kits`, `kitSave`, `checkBans`, `addBanName`, `removeBanName`, `get`, `downloadStat`, `getPlayerOnlineData`) is embedded on every page on `script: 'player'` — not owned by the dashboard. Only the six `server_id`-scoped actions above are dashboard-specific. `copyTeleport()` copies `AdminTeleportToPlayer <steam_id>` to the clipboard.

#### 4.3 Squad control (per-squad row buttons) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Расформировать (Disband) | `disband` | `server_id`(int), `team`(str), `squad`(str) | Disbands the squad (confirm) | Y |
| Сменить сторону (Transfer) | `transfer` | `server_id`(int), `team`(str), `squad`(str) | Moves whole squad to other team (confirm) | Y |
| Сбросить название (Clear name) | `rename` | `server_id`(int), `team`(str), `squad`(str) | Clears the squad name (confirm) | Y |
| Снять CMD (Demote) | `demote` | `server_id`(int), `steam_id`(str, leader) | Strips Commander (confirm) | Y |
| Сообщение скваду (Squad message) | `squadMessage` | `server_id`(int), `team`(str), `squad`(str), `time`(int), `msg`(str) | Repeating in-game message to the squad | Y |

Per-squad button row is `data-type="buttons"`; each squad table gets `data-leader=<steam_id>`; `data-type="squadMessage"` marks the envelope trigger; `data-type="avg"`/`data-type="median"` cells bind `calculateOnline` playtime aggregates.

#### 4.4 Messaging & broadcast — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Broadcast (chat input) | `broadcast` | `server_id`(int), `msg`(str) | Server-wide broadcast (min 2 chars; confirm) | Y |
| Сообщение скваду | `squadMessage` | see 4.3 | Targeted squad message with repeat cadence | Y |

Repeat-cadence `<select>` (shared by squad- and player-message forms): `1` = 1 раз (once), `30` = 30 s, `40` = 40 s, `60` = 1 min (**default**), `90` = 1 min 30 s, `120` = 2 min. The squad-message modal shows the author SteamID + Steam profile link and a `{player}` placeholder expanding to the creator name.

#### 4.5 Map & rotation — `script: 'squad'` (rotation read/write via `mapRotation.mode`, `'squad'` when opened from the dashboard cog)

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Сменить (Change map) | `changeMap` | `server_id`(int), `next`(bool), `map`(str, URI-encoded layer), `vote`(bool) | Changes current (or next) map | Y |
| Следующая (Set next) | `changeMap` | `server_id`(int), `next:true`, `map`(str), `vote`(bool) | Sets the next map only | Y |
| (Skip / next round) | `changeMap` | `server_id`(int), `next:'skip'`, `map:'skip'`, `skip:true`, `vote`(bool) | Ends current round / skips map | Y |
| Очистить следующую (Clear next) | `clearNext` | `server_id`(int) | Clears the queued next map | Y |
| (Load map catalog) | `getServerMaps` | `server_id`(int) | Returns `{maps[], units[]}` for the picker | N |
| Ротация — read | `getRotation` | `server_id`(int) | Returns `{rotation, list, canEdit}` | N |
| Ротация — Изменить (Edit) | `setRotation` | `server_id`(int), `rotation`(str, URI-encoded), `day`(str) | Overwrites rotation for a given day | Y |
| Календарь (Calendar) | `mapCalendar` | `server_id`(int), `start`, `end` | Read-only played-maps calendar (`script: 'public'`) | N |

**Map picker (`mapSelect`).** The `getServerMaps` catalog feeds a filterable grid — multiselects **Карта (`#map-name`)**, **Режим (`#map-type`)**, **Команды (`#map-team`)** each with a live count, plus free-text **Сменить по названию (`#changemap-custom`)**. Selecting a map opens a **configurator**: per-team faction `<select>` + unit `<select>`, live **tickets**, and previews of each side's **kits** (role SVGs) and **vehicles** (name, count, respawn `respawn/60`, optional delay). It assembles the RCON layer string as `<Map> <T1faction>+<T1unit> <T2faction>+<T2unit>`.

**Map entity** (`getServerMaps.maps[]`): `map`, `type` (RAAS/AAS/Invasion/…), `weather`, `markers`, `teams.t_1|t_2 = {tickets, default:{faction,unit,prefix,postfix}, factions[]:{name, default, units[]}}`. **Unit entity** (`units[]`): `{roles[], vehicles[]:{name, count, respawn, delay}}`.

**Rotation entity** (`getRotation`): `rotation.lists[day]` (newline-delimited layers; `//` comments ignored), `rotation.current` (active day), `rotation.isWin` (win-based → hides day tabs), `canEdit`. Days keyed `default`, `1`–`7` (Mon–Sun) → tabs Стандартная / Пн–Вс.

#### 4.6 Monitoring & analytics — `script: 'squad'` (calendar via `public`)

| UI label | action | data keys (type) | Returns | Destructive |
|---|---|---|---|---|
| Подробнее (Details) | `serverMonitor` | `start`, `end`, `server_id`(int) | mem, network_send/receive, disk_read/write, tps, network_connections series | N |
| Онлайн chart | `serverOnline` | `start`, `end`, `server_id`(int) | `{players[], admins[], queue[], days[], maps{}}` | N |
| Онлайн — Админы | `serverOnlineAdmins` | `day`, `server_id`(int) | `{events, resources}` per-admin presence timeline | N |
| Онлайн — Бустеры | `serverOnlineBooster` | `day`, `server_id`(int) | `{events, resources}` | N |
| Подключения (Connections) | `network` | `server_id`(int) | `{network:{ips:map<ip,{conn[],country,city}>, sockets[]}}` | N |
| (Ban IP, in network modal) | `blockIP` | `ip`(str) | Firewall-blocks an IP (confirm; button `.hide`-gated) | Y |

> The dashboard's own online mini-chart is fed inline from `server.stat.online` (see 2.1.1) — these `serverOnline`/`serverMonitor` actions back the full drill-down modals.

#### 4.7 Raw RCON console — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Выполнить (Execute) | `rconRaw` | `server_id`(int), `command`(str, URI-encoded) | Runs any raw RCON command; response in read-only CodeMirror (auto-pretty-prints JSON) | Y (command-dependent) |

Ships a **built-in command dictionary with autocomplete** (typeahead over names + RU help): `AdminKick`, `AdminKickById`, `AdminBan`, `AdminBanById`, `AdminBroadcast`, `AdminEndMatch`, `AdminChangeMap`, `AdminSetNextMap`, `AdminSetMaxNumPlayers`, `AdminSetServerPassword`, `AdminSlomo`, `AdminForceTeamChange(ById)`, `AdminListDisconnectedPlayers`, `AdminDemoteCommander(ById)`, `AdminDisbandSquad`, `AdminRemovePlayerFromSquad(ById)`, `AdminWarn(ById)`, `AdminRestartMatch`, `AdminReloadServerConfig`, `ListPlayers`, `ListSquads`, `ShowServerInfo` — each with a usage example. Exposes the full Squad admin surface even where no dedicated button exists (`AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`).

#### 4.8 Config & mod management (from the Control panel) — `script: 'squad'`

| UI label | action | data keys (type) | Effect | Destructive |
|---|---|---|---|---|
| Редактор конфигов | `getConfigFiles` / `getConfigFile` | `server_id`(int) / file(str) | List / load config files | N |
| " → Сохранить (Save) | `saveConfigFile` | file(str), contents(str) | Writes a config file | Y |
| " → Перезагрузить (Reload) | `reloadConfig` | `server_id`(int) | Reloads server config in-game | Y |
| " → По-умолчанию (Default) | `getDefaultConfig` | file(str) | Loads the default template | N |
| Менеджер модов (Mod manager) | `getMods` | `server_id`(int) | Lists installed Workshop mods | N |
| " → Install | `installMod` | mod id(str) | Installs a Workshop mod | Y |
| " → Delete | `deleteMod` | mod id(str) | Removes a mod | Y |

Config editor also has (mostly `.hide`-gated) **backup create/delete** and **merge/rebuild** controls plus a **синхронизировать скролл** toggle for side-by-side diff editing.

---

### 5. Forms & Modals

| Modal / form | Key fields (`#id` / name / type / rule) |
|---|---|
| **Смена карты (Map select)** | `#map-name`, `#map-type`, `#map-team` multiselects; `#changemap-custom` free-text; thumbnail grid; configurator with per-team faction/unit selects, ticket counts, kit/vehicle preview, assembled layer string (readonly), **Сменить** button |
| **Ротация карт (Rotation)** | Day tabs (default/Пн–Вс); scrollable layer list with faction flags; **Изменить (Edit)** → textarea (readonly unless `canEdit`) |
| **Сообщение скваду (Squad message)** | Author SteamID/link; message `<textarea>`; repeat-cadence select (default `60`); template quick-inserts with `{player}` |
| **RCON консоль** | Command input + `<datalist>` + live search dropdown; **Выполнить**; CodeMirror read-only output (80vh) |
| **Подключения (Network)** | Tabs Подключения/Сокеты; per-IP cards (rank, IP, conn count, up/down speed, geo country+city, external-lookup link, `.hide` ban button); 15 s auto-refresh toggle; **Карта** → Leaflet geo-map |
| **Config editor** | XL modal; CodeMirror; file dropdown; save/cancel/reload/default/merge/backup |
| **Mod manager** | Workshop cards (title, description, mod id, updated date, update/delete) |
| **Player ban form** (`#player_ban`, shared) | `#player_ban-reason` grouped select (e.g. `0.1. Другое`, `0.2. Cheater neutralized by DPAC`); dynamic "Навсегда (Forever)" option; progressive ban-length radios (`data-action=kick|ban`, `data-first/second/third/four` day tiers); `#player_ban-description` |
| **Player message form** (`#player_message`, shared) | 512-char textarea; "add to player card" toggle; cadence select |
| **Group change select** (shared, `changeGroup`) | `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера, `5` Стажёр |
| **Map calendar / Server monitor / Online** | FullCalendar / Chart.js views over the monitoring actions above |

**Validation observed:** broadcast requires ≥2 chars; RCON exec requires non-empty trimmed command; nearly every destructive action is wrapped in a `$.question` confirm (many with a typed "confirm word" via `daPrevent`).

---

### 6. Permission & Visibility Logic

- **`data-hide="offline"`** blocks (player board, map widget) hide whenever `server.isConnect == false`; replaced by the start block or `update_log`.
- **`class="hide"`** gates capabilities regardless of connection: the **Техника (Vehicles)** tab (`data-template="vehicle"` exists but tab is `.hide`), the **Ban IP** button in the network modal, and most config-editor backup/merge/default controls. Latent features enabled per-role server-side.
- **`getRotation.canEdit`** — when false the rotation textarea is readonly and save/cancel hide; rotation *view* is broader than *edit*.
- **`panelAdmins[]`** in the live payload enumerates which admins are assigned to this server (and their `online` flag) — the accountability roster.
- **Group taxonomy** (from `changeGroup`): Администратор > Модератор > VIP > Камера (spectator) > Стажёр (trainee).
- All gating is presentational; the authoritative permission check is server-side in each `/ajax/*.php` action.

---

### 7. Notable UX & Competitively Interesting Details

1. **Everything on one screen, 5 s live.** One `getServer` poll hydrates the entire board — roster, squads, chat delta (cursor-paged), tab badges, global online, hardware telemetry, and playtime aggregates — with no page reloads.
2. **Rich per-player threat signals inline.** `vac` (VAC ≤100 d), `warning` (>3 punishments), same-IP alt detection (root `ips` map + `location`), `baby` (<30 h), live `requests.admins`/`requests.report` — all small icons on the live roster with a legend panel.
3. **Squad intelligence.** `calculateOnline` ships per-team and per-squad avg/median/SL playtime as ready-to-render strings; creator crown (`create_id`), lock (`locked`), CMD auto-sort (`cmd`).
4. **Map configurator, not just a picker.** Faction+unit selection with live tickets, kit icons, vehicle respawn/delay, producing the exact RCON layer string.
5. **Rotation as code, per weekday.** Editable newline-delimited lists per day (default + Mon–Sun) with `//` comments and a win-based mode.
6. **Raw RCON console with a full command dictionary + typeahead** — entire Squad admin set incl. `AdminSlomo`, `AdminSetServerPassword`, `AdminSetMaxNumPlayers`; JSON auto-pretty-printed in CodeMirror.
7. **DDoS awareness built in.** `monitor[].data.network.connections` drives an auto "under attack" banner (>300); per-IP breakdown with geolocation and speeds; Leaflet world-map; one-click firewall `blockIP`.
8. **Deep hardware telemetry** beside game state: CPU/freq/temp per core, network, disk, TPS mini-charts, plus a full `serverMonitor` drill-down.
9. **Admin & booster presence timelines** (FullCalendar) per server for coverage tracking.
10. **Operational polish:** scheduled/repeating squad & player messages with `{player}` templating, config editor with backups/merge, mod manager wired to Steam Workshop, deep-link sharing (`/?steam_id=`, `/?server_id=`, `/?start_seed=true`), clipboard helpers for teleport and cheater-report templates.

---

### 8. Gaps / Notes for Analysts

- **Only `getServer` is captured live.** All modal-triggered reads (`getRotation`, `getServerMaps`, `serverMonitor`, `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster`, `network`, config/mod reads) fire on user interaction; the read-only capturer performs no clicks, so their response shapes in §2.2/§4 are **inferred from render code**, not observed. A follow-up capture that opens each modal would upgrade them to captured contracts.
- **No mutations were fired** (`_blocked.json == []`); every action in §4 is documented from client code + params, never executed.
- The `Action()` helper does **not** URL-encode object-form `data` — any endpoint whose value can contain `&`/`=`/spaces (map layer, rotation body, RCON command, broadcast text) relies on the caller to `encodeURIComponent`. A value with a raw `&` would corrupt the body: a real robustness edge worth probing.
- **Vehicles tab** is fully templated (`data-template="vehicle"`) but `.hide`-gated — in-progress/disabled feature; no `in_vehicle` field appeared on live active-player rows.
- **`createSquad`** is not wired in `main.html` — only disband/transfer/rename/demote/message on existing squads.
- The **Leaflet** map here is for network-connection geolocation, not the game map (the game "map" widget is a static image + layer metadata).
- Exact server-side role→capability matrix is not visible client-side; only presentational gates (`hide`, `canEdit`, `block_start.code`, `panelAdmins`) are observable.


---

## 02. In-game Chat & Broadcast

### 1. Purpose and nav location

- **Nav item / page id:** `chat` — loaded via the SPA router `pageLoad('chat')` → `GET /ajax/page.php?page=chat`; the returned fragment is injected into `#content`.
- **Purpose:** A searchable, filterable **audit archive** of every in-game chat message (all chat scopes plus admin broadcasts) captured across all monitored servers. It is a read/audit surface, not a live composer. The panel's outbound messaging (broadcast, per-player message, per-squad message) is triggered on the `main` dashboard and the shared player-detail modal, but is documented here because it is the write-side counterpart of this feed.
- **Ground truth for this chapter:** `frags/chat.html` (page markup + inline `buildTable`/`speak` scripts), `custom.js` (the `buildTable` DataTables engine + the `Action()` transport, lines 284–340 and 605–1101), and `frags/main.html` (the three outbound-message senders: `sendSeverBroadcast()` @2135, `player.message.send()` @4356, `messageSquad.send()` @5654). Cross-referenced against `action_catalog.txt`.
- **Live-capture status:** the read-only headless capture (`capture.py --pages chat`) was run the maximum permitted **2×**; both runs died with a Chromium `TargetClosedError` during the post-load settle, so no `chat.network.json`/`content.html` was emitted and `_blocked.json` = `[]` (0 mutations blocked — the interceptor never had traffic to abort). The contracts below are therefore reconstructed from the client code that literally constructs the request bodies and parses the responses, which is authoritative for request shape and response envelope; only the server-side per-row field spelling for `action=playerChat` is inferred (see §8).

Page layout: a fixed left filter sidebar (`col-md-3`, `position:fixed`) and a wide results table (`col-md-9`).

---

### 2. Live API Contracts

All AJAX goes through the `Action({script, action, data})` helper in `custom.js:284`, which POSTs to `/ajax/<script>.php` with an `application/x-www-form-urlencoded` body. When `data` is an object it is serialized to `action=<action>&key=value&…`; when it is a string it is concatenated as `action=<action><string>`. Response contract (all endpoints): JSON with a top-level `status`; the success branch fires only on `status === 'ok'`, `auth === true` forces `location.reload()` (session/permission expiry), otherwise `msg` is surfaced as an error toast.

#### 2.1 `POST /ajax/table.php` — chat feed read (`action=playerChat`)

The one read the chat page issues. Built by `$.fn.buildTable` (`custom.js:605`); the request string is assembled in `preGetTable()` (`custom.js:1092`) and sent by `getTable()` (`custom.js:1069`).

**Request params** (form-urlencoded body):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `playerChat` | Y | Server table id (equals the `table:` config value). |
| `table` | const `playerChat` | Y | Redundant table id echoed in body. |
| `page` | int | Y | 1-based page index. Default `1`; set by pagination/search/sort handlers. |
| `numrows` | int | Y | Page size. Hardcoded **`300`** for this page. |
| `search` | string (URL-encoded JSON) | Y | Filter object, see §2.2. Empty string when no filters. |
| `order_by` | string \| `false` | Y | Sort column DB-alias. Initial load sends literal `false`; header-click sets it to the column's `data-sort` (e.g. `date`). |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction. Initial `false`; toggles `desc`→`asc` on repeat header-click. |
| `pagination` | const `true` | N | Present **only** on the secondary count request (§2.3); absent on the row request. |

**Response envelope** (`status==='ok'` branch, consumed in `getTable().success` and `build()`):

| Field | Type | Meaning |
|---|---|---|
| `status` | enum `ok` \| (error) | Gate. Non-`ok` → error toast. |
| `auth` | bool | If `true`, client calls `location.reload()`. |
| `msg` | string — nullable | Error message when `status != ok`. |
| `data` | object | Payload wrapper. |
| `data.row` | `array[N]` of row objects | The N≤300 chat records for this page (per-row schema §2.4). Empty array renders "Нет данных". |
| `data.query_time` | string | Server timing string, logged to console. |
| `data.currentPage` | int (as string) | Echoed page index, drives pagination active-state. |
| `data.custom` | object — nullable | Optional side-channel payload (`customData()`); unused by chat. |

Redacted example request/response:
```
POST /ajax/table.php
action=playerChat&table=playerChat&page=1&numrows=300
&search=%7B%22text%22%3A%7B%22t1.msg%22%3A%22help%22%7D%2C%22multiselect%22%3A%7B%22type%22%3A%5B%22ChatAdmin%22%5D%7D%7D
&order_by=false&order_sort=false

{ "status":"ok",
  "data":{ "currentPage":"1", "query_time":"0.0123s",
    "row":[ { "id":"<redacted>", "steam_id":"<redacted:17>", "server":"1",
              "date":"1720080000", "team":"1", "name":"<redacted:12>",
              "type":{"name":"Админ чат","color":"#3598DC"}, "msg":"<redacted:24>",
              "play":"" } ] } }
```

#### 2.2 `search` object schema

`buildTable` walks `searchInput[]`, reads each control's `data-search` alias, and buckets it by input `type` into `{text, check, multiselect, managers, slider}`, then `search = encodeURIComponent(JSON.stringify(obj))`. Chat populates only three buckets:

| Bucket | Key(s) written | From control (`data-search`) | Value shape |
|---|---|---|---|
| `text` | `t2.player` | `#chatPlayers-name` (text) | string (raw substring; `+`→`%2B`). |
| `text` | `t1.msg` | `#chatPlayers-msg` (text) | string, ≤17 chars. |
| `text` | `t1.date.startdate`, `t1.date.enddate` | `#chatPlayers-date` (daterange) | unix seconds; `0`/`0` for `allTime` default. |
| `check` | `obscene` | `#chatPlayers-obscene` (checkbox) | `"true"` \| `"false"`. |
| `multiselect` | `server_id` | `#chatPlayers-server` | array of server-id strings. |
| `multiselect` | `type` | `#chatPlayers-type` | array of scope enums (§2.4). |

Empty controls are omitted. `#chatPlayers-steam_id` is listed in `searchInput` but no such element exists in the fragment, so `buildTable` skips it (`typeof sData == "undefined" → continue`) — a dead config entry.

#### 2.3 `POST /ajax/table.php` — pagination count (`action=playerChat&…&pagination=true`)

Fired by `getPagination()` (`custom.js:987`) as a second call **only** when the first page filled (`rows == numrows`) or `currentPage != 1`. Same body as §2.1 plus `&pagination=true`.

| Response field | Type | Meaning |
|---|---|---|
| `status` | enum `ok` | Gate. |
| `totalPage` | int | Total page count; drives the numeric pager. |
| `totalRows` | int | Total matching rows; rendered as "Всего: N". |
| `count_time` | string | Server timing string, console-logged. |

#### 2.4 Chat message record schema

The per-row objects in `data.row` (keyed by the `collum` array `["steam_id","server","date","team","name","type","msg","play"]`) plus the richer **live-feed** record the `main` dashboard consumes (`data.chat[]`, `frags/main.html:978`) — the same underlying chat table, so it reveals the authoritative field set:

| Field | Type | Meaning |
|---|---|---|
| `id` | string/int | Row PK (`data-id` on the rendered `<tr>`/message div). |
| `steam_id` | string (SteamID64, len 17) | Author identity. Chat table renders it in a hidden first column used as the row-click key. |
| `server` / `server_id` | int → label | Origin game server. |
| `date` | **unix timestamp (seconds)** | Message time. Client renders via `formatDate(col,true,true)`. |
| `team` | int enum | Author's faction/team id; maps to icon `/assets/img/ico/teams/<team>.png`. |
| `name` | string | Author nickname. |
| `color` | string (hex, no `#`) — nullable | Author name color (clan/role tint); live feed only. |
| `type` | string enum (chat table) | Scope enum, see below. In the **row** object the render callback expects an object `{name,color}`. |
| `type_format` | object `{name,color,icon}` | Live-feed display metadata: `name` (RU label), `color` (hex), `icon` (FontAwesome class). |
| `msg` | string | Message body. `word-break:break-all`; client-flagged for profanity. |
| `play` | derived/empty | UI-only TTS action cell; carries no server data. |

**`type` enum (chat scope)** — from `<select id="chatPlayers-type">` options; each value carries a server-provided display `color`/`icon`:

| Value | Label (RU → EN) | Meaning |
|---|---|---|
| `ChatAll` | Всем → All | Server-wide all-chat. |
| `ChatTeam` | Команда → Team | Team chat. |
| `ChatSquad` | Сквад → Squad | Squad chat. |
| `ChatAdmin` | Админ чат → Admin chat | Admin-only channel. |
| `broadcast` | Broadcast | Admin broadcast; logged back into the same feed (rendered as a distinct `server_chat-broadcast` line, gold `#DAA520`). |

#### 2.5 Outbound message actions (write-side, in scope)

Exact `Action()` calls (all `Destructive = Y` — these equal send permissions):

| Action | Endpoint | `data` keys (type) | Effect |
|---|---|---|---|
| `broadcast` | `POST /ajax/squad.php` | `server_id` (int), `msg` (string) | System `AdminBroadcast` to **all** players on the server; echoes into this feed as `type=broadcast`. |
| `message` | `POST /ajax/player.php` | `steam_id` (SteamID64), `time` (int seconds), `msg` (string ≤512), `log` (bool) | In-game direct message to one player, repeated for `time`; `log=true` also writes it to the player card. |
| `squadMessage` | `POST /ajax/squad.php` | `server_id` (int), `team` (int), `squad` (int), `time` (int seconds), `msg` (string ≤512) | Message to every member of one squad on one team, repeated for `time`. |

All three consume the standard envelope (`status:'ok'` → success toast / modal close; `auth:true` → reload; else error toast). `broadcast` sends `data` as an object (`&server_id=&msg=`); `time` values come from the `1|30|40|60|90|120` cadence selects.

---

### 3. The page's own table (`#chatPlayers`)

**DataTables config** (`frags/chat.html`, inline `buildTable`):
```
$('#chatPlayers').buildTable({
  table: 'playerChat',
  collum: ["steam_id","server","date","team","name","type","msg","play"],
  order: ["date"], numrows: 300,
  searchInput: ["chatPlayers-name","chatPlayers-steam_id","chatPlayers-msg",
                "chatPlayers-server","chatPlayers-obscene","chatPlayers-type","chatPlayers-date"],
  callback: { type: (d,row) => '<code style="color:'+d.color+'">'+d.name+'</code>' }
});
```

- **Server table id:** `playerChat` (the `action=`/`table=` value).
- **Page size (`numrows`):** `300`.
- **Sortable columns (`order`):** only `date` gets a clickable sort header wired (`order:["date"]`). Header-click sets `order_by=date`, toggling `order_sort` desc↔asc. **Default sort:** none sent on first load (`order_by=false`) — the server returns its own default (newest-first) ordering.

**Columns** (render order; `data-contact` = the `collum` key on each `<td>`):

| # | Header | `collum` key / `data-search` | Width | Notes |
|---|---|---|---|---|
| 1 | `SteamID` (`class="hide"`) | `steam_id` | — | Hidden via `class="hide"` **and** CSS `#chatPlayers td:first-child{display:none}`. Row-click key. |
| 2 | `fa-server` icon | `server` | 50px, centered | Server icon. |
| 3 | `Дата` (Date) | `date` | 130px, centered | `formatDate(...)`. Only sortable column. |
| 4 | `fa-flag` icon | `team` | 50px, centered | Team/faction flag. |
| 5 | `Ник` (Nick) | `name` | 150px, centered | Author nickname. |
| 6 | `Чат` (Chat) | `type` | 90px, centered | Colored channel badge via `type` callback. |
| 7 | `Сообщение` (Message) | `msg` | flex | `word-break:break-all`; profanity-prefixed client-side (§7). |
| 8 | (empty) | `play` | 30px | TTS "speak" button cell. |

**Filters / search controls** (left sidebar):

| Control | `#id` | `data-search` alias | Input type | Attrs / options | Behavior |
|---|---|---|---|---|---|
| Search button | `chatPlayers-btn` | — | button (`fa-search`, "Поиск") | — | Rebuilds table. |
| Nick / SteamID | `chatPlayers-name` | `t2.player` | text | placeholder "Ник или SteamID" | Enter-key (`which==13`) also rebuilds with `page=1,isSearch=true`. |
| Message | `chatPlayers-msg` | `t1.msg` | text | **`maxlength="17"`** | Substring on body. |
| Server | `chatPlayers-server` | `server_id` | multiselect (`multiple`) | `nonSelectedText:'- Сервер -'`; options `1,6,7,9,10,11` | Multi-server filter. |
| Chat type | `chatPlayers-type` | `type` | multiselect (`multiple`) | `nonSelectedText:'- Чат -'`; 5 scope options | Multi-scope filter. |
| Date range | `chatPlayers-date` | `t1.date` | daterange | default `{type:'allTime',start:0,end:0}` | Emits `.startdate`/`.enddate`. |
| Только Мат (Profanity only) | `chatPlayers-obscene` | `obscene` | checkbox (slider) | value `obscene` | `.change()` → `buildTable()` rebuild. |

**Row interaction:** clicking a row reads the hidden `td[data-contact="steam_id"]` text; if `length > 15` (valid SteamID64) → `player.open(steam_id)` opens the shared player-detail modal. Clicks on the `play` cell `stopPropagation()` so TTS does not also open the modal.

---

### 4. Actions / capabilities

`Action({script,action,data})` → `POST /ajax/<script>.php`; object `data` becomes `&key=value` pairs, `action` prepended. Success gated on `status:'ok'`; `auth:true` → reload.

| UI label | action | script → endpoint | `data` keys | Effect | Destructive? |
|---|---|---|---|---|---|
| (table load) Поиск | `playerChat` | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort [, pagination]` | Fetch/filter chat rows | N (read) |
| Broadcast (paper-plane, `main`) | `broadcast` | `squad` → `/ajax/squad.php` | `server_id, msg` | `AdminBroadcast` to all players; echoed into feed | **Y** |
| Сообщение (Message, player modal) | `message` | `player` → `/ajax/player.php` | `steam_id, time, msg, log` | Direct in-game message to one player, repeated `time`s; optional card log | **Y** |
| Squad message (envelope, `main`) | `squadMessage` | `squad` → `/ajax/squad.php` | `server_id, team, squad, time, msg` | Message to a whole squad, repeated `time`s | **Y** |
| (speak) | — | none (client `SpeechSynthesis`) | — | TTS read-aloud of a message cell | N (client only) |

> The chat fragment also embeds the full shared player-detail modal, whose ~22 actions (`ban, kick, kill, kits, kitSave, mark, twink, twinkOnline, addComment, getComments, changeGroup, changeTeam, checkBans, findFriends, removePlayer, unban, addBanName, removeBanName, downloadStat, getPlayerOnlineData, get`) appear in `chat.html` (per `action_catalog.txt`) but belong to the modal, documented in the player-detail section. Only `message` is chat-relevant among them.

---

### 5. Forms & modals

#### 5.1 Direct-message composer (`#player_message`, shared modal, `class="hide"`)

Opened via `player.message.open()` (the "Сообщение" button, `style="display:none"` until unhidden per operator); flips the player card and clones `#player_message` into it. Sent by `player.message.send()` (`frags/main.html:4356`).

| Element | `#id` | Type | Attrs / validation |
|---|---|---|---|
| Canned-message list | — | `list-group` of `<a onclick="player.message.set(event,this)">` | **17** preset moderation phrases (VIP grant, vehicle-claim rules, TK apology, unreadable-nick warning, etc.). Click fills textarea; `set()` does `msg.replace('{player}', name)` for `{player}` token substitution. |
| Add to player card | `player_message-log` | checkbox | "Добавить запись в карточку игрока" → `log = is(':checked')`. |
| Message body | `player_message-msg` | textarea `rows=3` | **`maxlength="512"`**. |
| Repeat cadence | `player_message-time` | select | Options: `1`=1 раз (once), `30`s, `40`s, `60`s (**selected default**, "1 минута"), `90`s, `120`s. |
| Игрок (back) | — | button | `player.unflip()`. |
| Send | `player_message-send` | button | `player.message.send()` → `message` action. No explicit min-length guard beyond `maxlength`. |

#### 5.2 Squad-message composer (`#serverSquadMessage_modal`, on `main`)

Opened by `messageSquad.open(this)` from a squad-panel envelope button (`data-type="squadMessage"`). `open()` shows the modal, inits `#serverSquadMessage-time` and preselects `60`, populates author (`create_id`/`create_name`) + Steam link + "открыть" → `player.open()`.

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Author info | `serverSquadMessage-author_steamid` / `-author_open` / `-author_steamlink` | display | Squad creator SteamID, open-card, Steam profile. |
| Canned list | — | 18 `<a onclick="messageSquad.set(event,this)">` | `{player}` → squad leader name. |
| Message body | `serverSquadMessage` | textarea `rows=4` | **`maxlength="512"`**. |
| Repeat cadence | `serverSquadMessage-time` | select (multiselect) | Same `1/30/40/60/90/120` set; default `60`. |
| Send | `serverSquadMessage-send` | button | `messageSquad.send(this)` → `squadMessage` with `server_id, team=squad.team, squad=squad.id, time, msg`. |

#### 5.3 Broadcast composer (on `main`)

Single inline input `#server_chat-msg` (placeholder "Broadcast") with a `fa-paper-plane-o` icon → `sendSeverBroadcast()`.

- **Validation:** refuses send when `msg.val().length < 2`.
- **Confirm gate:** `$.question({title:'Broadcast', text:'Отправить сообщение как Broadcast??', da:…})` — must confirm before the `broadcast` `Action` fires.
- Input cleared (`msg.val('')`) after confirm.

---

### 6. Permission / visibility logic

- The chat table's `SteamID` column is doubly hidden (`class="hide"` + CSS `td:first-child{display:none}`) — an internal key, not a permission gate.
- Every modal action button embedded in the fragment defaults to `style="display:none;"` (e.g. "Сообщение", "Команда", "Наказать/Разбанить", kick/kill/ban-name/kits items). They are unhidden by the client from the player context + operator role/group returned when `player.open()` loads the card — capability visibility is **server-driven per operator**, not baked into the fragment.
- `Action` responses with `auth:true` → `location.reload()`, the standard session/permission-expiry path.
- No per-server permission split on the chat page itself; the `server` multiselect lists exactly the servers the operator can see.

---

### 7. Notable UX & competitively interesting details

- **Unified profanity detection.** A large single client-side Russian-profanity regex (`isObscene()`, `custom.js:1781`) flags messages: any offending `msg` cell is prefixed with a red warning triangle `<code style="color:#CD5C5C"><i class="fa fa-exclamation-triangle"></i></code>`, and the "Только Мат" toggle passes `obscene:true` to filter the whole feed server-side. Worth beating with a configurable, server-side, multi-language model rather than one hardcoded regex.
- **Text-to-speech read-aloud.** Each row's `play` cell calls `speak(td)` using `SpeechSynthesisUtterance` (`voices[1]`, cancels any in-progress utterance). Niche accessibility / passive-monitoring feature.
- **Color-coded channels.** Chat scope is a server-colored `<code>` badge (`type.color`/`type.name`); the live feed additionally attaches a FontAwesome `icon` per scope — all/team/squad/admin/broadcast instantly distinguishable in a dense feed.
- **Repeating on-screen messages.** Direct and squad messages both support a repeat cadence (`1×`, 30–120s). Combined with `{player}` templating and ~17–18 canned moderation phrases, routine enforcement (vehicle-claim rules, nick warnings, TK apologies) is a two-click operation — a strong workflow to match.
- **Message-to-card logging.** One checkbox (`log`) turns an in-game warning into a permanent record on the player profile, tying live moderation to the audit trail.
- **Cross-scope archive.** Broadcasts are logged back into the same searchable feed as player chat, so operators see their own announcements interleaved with player messages — good accountability.
- **Fixed sidebar + 300-row pages** keep filters permanently visible while scanning large volumes. The `msg` search input is oddly capped at `maxlength="17"` — a low-hanging limitation to exceed. Pagination is a **two-request** pattern (rows first, then a `pagination=true` count), so page counts appear a beat after rows.

---

### 8. Gaps / unverified

- **Live capture unavailable.** `capture.py` was run the permitted 2× and both attempts crashed the headless Chromium (`TargetClosedError`) before writing `network.json`/`content.html`; `_blocked.json` = `[]`. Every contract above is reconstructed from the client code that builds/parses it (`custom.js` `buildTable`/`Action`, `frags/*.html` senders) — authoritative for request bodies and the response envelope, but the exact server-side **field spelling** of each `data.row` object for `action=playerChat` (vs. the live-feed `data.chat` names used as proxy) is inferred, not captured.
- The SQL schema behind aliases `t1` (chat) / `t2` (player) is inferred from `data-search` (`t1.msg`, `t1.date`, `t2.player`, `server_id`, `type`, `obscene`), not seen directly.
- The `team` id→flag mapping and each scope's `color`/`icon` come from server-side table data not present in the fragment.
- `broadcast`/`squadMessage` live on `main` (script `squad`) and `message` on the player modal (script `player`); their handlers were read from `frags/main.html`, not exercised. The chat page is read-only for these.


---

## 03. Players Directory (Все игроки)

> Canonical reference for the master player list **and** the shared **player-detail modal** that appears on virtually every page of SQSTAT. The modal's tabs, forms and ~25 actions are documented here in full; other sections should cross-reference this file rather than re-document the modal.
>
> **Ground truth:** contracts, schemas, table configs, column sets and payloads in this chapter were captured live (read-only, headless) from `https://breaking.sqstat.ru`. Capture files: `caps/players/players.network.json`, `caps/players/players.content.html`, `caps/players/players.modaltabs.json`.

---

### 1. Purpose & Navigation

- **Nav id / entry point:** `players` → `pageLoad('players')` → `GET /ajax/page.php?page=players`, HTML fragment injected into `#content`. Captured live: `200 text/html; charset=UTF-8`, fragment length ≈ 115 KB.
- **Purpose:** Global searchable directory of every player ever seen across the project's servers (not just those currently online). Live scale observed: **`totalRows = 385 350`** players, `totalPage = 3854` at 100/page. It is the primary entry point to open a player card and perform moderation actions (ban, kick, group change, VIP, mark, message, twink hunt, kit denial, etc.).
- **Layout:** Two-column. Left (`col-md-3 mobile-left`, `position:fixed`) is a search/filter sidebar; right (`col-md-9`) is the results table `#allPlayers`.
- The fragment ALSO embeds the entire shared player-detail modal machinery (`#player_info`, `#player_ban`, `#player_group`, `#player_message`, `#player_twink-modal`, `#player_kits-modal`, `#player_findban-modal`, `#player_map-modal`, and the `.player_comments` drawer). The near-identical `playersOnline.html` reuses the same modal and action set (action catalog: both expose the identical full action set).

---

### 2. Live API Contracts

Every table on the panel — the directory list and all twelve modal sub-tabs — funnels through **one** transport endpoint, `POST /ajax/table.php`. Read/forensic player actions funnel through `POST /ajax/player.php`; live-server (RCON) actions through `POST /ajax/squad.php`.

#### 2.1 `POST /ajax/table.php` — directory list (`action=allPlayers`)

**Request (captured, form-urlencoded body):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id. `allPlayers`. |
| `table` | string | Y | Duplicate of `action` (`allPlayers`). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size. `100` for this table. |
| `search` | JSON (URL-encoded) | Y | Filter object, shape `{text:{}, check:{with_other_names, full_match}, multiselect:{}, managers:{}, slider:{}}`. Each `check` value is the string `"true"`/`"false"`. |
| `order_by` | string\|`false` | Y | DB column alias to sort by, or literal `false` for default. |
| `order_sort` | `asc`\|`desc`\|`false` | Y | Sort direction, or `false`. |
| `pagination` | `true` | N | When present, the request is the **count-only** variant (see 2.2). |

Redacted captured body:
```
action=allPlayers&table=allPlayers&page=1&numrows=100
&search=%7B%22text%22%3A%7B%7D%2C%22check%22%3A%7B%22with_other_names%22%3A%22false%22%2C%22full_match%22%3A%22false%22%7D%2C%22multiselect%22%3A%7B%7D%2C%22managers%22%3A%7B%7D%2C%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

**Response** (`200 application/json; charset=utf-8`), captured schema:

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 on the data request — the real count comes from the paginate request, 2.2). |
| `data.totalRows` | int | Row count (0 on the data request; real value from 2.2). |
| `data.currentPage` | string | Echoed page index (string, e.g. `"1"`). |
| `data.row[]` | array | Result rows (length = `numrows`). Per-row schema below. |
| `data.custom` | bool | Whether a custom/manager-scoped query was applied. |
| `data.query_time` | float | Data-query wall time (s) — perf telemetry. |
| `data.count_time` | int/float | Count-query wall time (s). |
| `status` | string | `"ok"` on success. |
| `exec_time` | float | Total server exec time (s). |

**Per-row object `data.row[i]` — document field-by-field (this is the directory record):**

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `steam_id` | string(17) | N | SteamID64, primary identity. Rendered in a `<hashtag>` (click-to-copy). |
| `eos_id` | string(32) | N | Epic Online Services id (Squad's newer identity). **Returned even though it is not a visible column.** |
| `name` | string | N | Current in-game nickname. |
| `date` | string — **unix ts** | N | Last login ("Заходил"). 10-digit seconds. |
| `create_date` | string — **unix ts** | N | First seen ("Создан"). **Returned though not a visible column.** |
| `mark` | string enum `"0".."8"` | N | Suspicion tag (see §5.4). `"0"` = none. Drives a `player_mark` row class. |
| `bonus` | string(int) | N | Accumulated bonus/currency balance. |
| `discord` | string(id) \| `null` | Y | Linked Discord user id, or `null`. |
| `expire` | string — **unix ts** \| `"0"` | N | Privilege-group expiry; `"0"` = none/permanent. |
| `group_id` | string enum `"0".."5"` | N | Current privilege group (0 none, 1 Admin, 2 Moderator, 3 VIP, 4 Camera, 5 Trainee). |

> **Privacy / competitive note:** the list endpoint returns a **denormalized identity+moderation payload per row** (`eos_id`, `create_date`, `mark`, `bonus`, `discord`, `expire`, `group_id`) even though the rendered table shows only `steam_id`, `name`, `date`. A scraper with a valid admin session harvests the full identity graph for all 385 K players from the list endpoint alone.

#### 2.2 `POST /ajax/table.php` — count/pagination variant (`&pagination=true`)

Fired as a **second, parallel** request with the same body plus `pagination=true`. This splits the expensive `COUNT(*)` from the data page for latency. Captured response schema:

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Real page count (captured: `3854`). |
| `totalRows` | string(int) | Real row count (captured: `"385350"`). |
| `count_time` | float | Count-query time (s). |
| `status` | string | `"ok"`. |
| `exec_time` | float | Total exec (s). |

#### 2.3 `POST /ajax/table.php` — modal sub-tab tables

Each modal detail tab (§4.1) is the same endpoint with `action=<tableName>` and an appended `&steam_id=<id>`. Captured page-size `numrows` and `showPages` per table are in §4.1. Response envelope is identical to 2.1 (`data.row[]` + telemetry), with per-tab row columns equal to that tab's `collum` array.

#### 2.4 `POST /ajax/player.php` — read/forensic actions (no live server required)

Payloads captured from the embedded modal script (`players.content.html`). "Destructive" = mutates state.

| action | `data:{...}` (captured) | Response shape (from render code) | Destr. |
|---|---|---|---|
| `get` | `{steam_id}` | `{player: {...}}` — the full player entity (§3). | N |
| `mark` | `{steam_id, mark}` | ack | Y |
| `getComments` | `{steam_id}` | comment list | N |
| `addComment` | `{steam_id, text}` (≤256) | ack | Y |
| `changeGroup` | `{steam_id, group_id, date, description, prefix, prefix_rgb, image}` | ack | Y |
| `message` | `{steam_id, time, msg, log}` | ack | Y |
| `addBanName` | `{name}` | ack | Y |
| `removeBanName` | `{name}` | ack | Y |
| `kits` | `{steam_id}` | `{kits:[...]}` per-kit deny state | N |
| `kitSave` | `{steam_id, kits}` (JSON `{kit:bool}`) | ack | Y |
| `twink` | `{steam_id}` | `{list:[{steam_id, name, perm, min_date, ips:[{loc, date, owner_date}]}]}` (§5.3) | N |
| `twinkOnline` | `{steam_id, compare_steam_id, start, end}` (unix) | `{calendar:[<fullcalendar events>]}` | N |
| `findFriends` | `{steam_id, compare_steam_id}` | `{in_friend: bool}` | N |
| `checkBans` | `{steam_id}` | `{projects:[{name, discord, online, ban:{total, current:{reason, date, expire}}}]}` (§5.6) | N |
| `getPlayerOnlineData` | `{steam_id, start, end}` | online/boost/queue time series | N |
| `downloadStat` | form POST (`post_to_url`), `{action, steam_id}` | file download | N |

**`twink` list row** — `perm: bool` (candidate carries a permanent ban), `min_date: unix-seconds delta` (rendered via `moment.duration(min_date*1000).humanize()`), `ips[]` each `{loc, date(unix), owner_date(unix)}` where the UI shows both accounts' seen-times side by side.

**`checkBans` project row** — `online: seconds` (rendered `secToTime`), `ban.total: int`, `ban.current` present ⇒ active ban with `{reason, date(unix), expire(unix)}`; `expire == "0"` ⇒ "Перманент" (permanent).

#### 2.5 `POST /ajax/squad.php` — live-server (RCON) actions (player must be online)

Payloads captured from the modal script:

| action | `data:{...}` (captured) | Effect | Destr. |
|---|---|---|---|
| `kick` | `{steam_id, reason_id, description, noReason}` | Kick from live server. `noReason:true` = no-rule kick. | Y |
| `ban` | `{server_id, steam_id, reason_id, description, days}` | Ban N days; `days=0` (via permanent radio) / `-1` = permanent. | Y |
| `unban` | `{steam_id, unban}` | Lift ban; `unban:true` fully erases record. | Y |
| `removePlayer` | `{server_id, steam_id}` | Eject from squad/fireteam. | Y |
| `changeTeam` | `{server_id, steam_id}` | Force team swap. | Y |
| `kill` | `{server_id, steam_id}` | Kill in-game. | Y |

> The capture interceptor **aborted zero mutations** (`_blocked.json = []`) because auto-load fires only reads; the mutation payloads above are transcribed from the page's own JS, not executed.

---

### 3. Entity: Player (`player.info`) — the core data model

`player.open(steam_id)` → `Action({script:'player', action:'get', data:{steam_id}})` → `POST /ajax/player.php`. The success handler sets `player.info = text.player` then `player.setInfo()` + `player.stats.init(player.info.stats)`. The returned `player` object is the richest entity in the app. Fields (from `setInfo()` + captured render code):

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | SteamID64 (primary identity). |
| `eos_id` | string | Epic Online Services id. |
| `name` | string | Current nickname. |
| `names[]` | `{name, date}` | Historical nicknames dropdown ("Другие ники"). |
| `date` | unix ts | Last login ("Заходил"). |
| `create_date` | unix ts | First seen ("Создан"). |
| `baby` | bool | "New/young account" flag — red warning icon next to online time. |
| `bonus` | int | Bonus/currency balance ("Бонусы"). |
| `playtime` | `{online, boost, server}` | Aggregate playtime, boost time, favourite server. |
| `mark` | int 0–8 | Suspicion tag (see §5.4). |
| `group` | `{name, color, icon, description}` | Current privilege badge; special art for `QueuePriority` (VIP) / `Moderator`. |
| `group_id`, `expire`, `group_description`, `prefix`, `prefix_rgb`, `image` | mixed | Group-assignment fields consumed by the group form. |
| `ban` | `{expire, reason, admin_name, date, description}` | Active ban → red "забанен" panel + corner ribbon. |
| `bans[]` | `{admin_name, date, reason, description, impact, unban}` | Full punishment history (Наказания tab). `impact`=counts toward escalation; `unban="1"`=reversed. |
| `canBan` | bool | Gates "Наказать", kill, banname, kits. |
| `canUnban` | bool | Gates "Разбанить". |
| `canChangeGroup` | bool | Gates "Группа". |
| `canSelfKick` | bool | Gates "Кикнуть без причины". |
| `is_you` | bool | If true, group select + expire disabled (can't edit self). |
| `name_banned` | bool | Current nick on banned-names list → toggles banname/unbanname items. |
| `vac` | `{ban, days}` | VAC ban status. |
| `steam_info` | `{ban:{vac, ban, days}, squad:{time}}` | Steam enrichment — VAC/game-ban badge + Squad hours. |
| `discord` | string(id) \| false | Discord user id → link to `discord.com/users/<id>`. |
| `location[]` | `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history (flag, city, tz, coords, **raw IP**, seen date). First = current. |
| `primetime[]` | `{start, end}` | Typical active hours (unix → HH:mm). |
| `clans[]` | `{clan_id, name}` | Clan memberships (link to `/clan.php?id=`). |
| `online` | `{server:{id,name}, team:{short}, squad:{id}}` \| false | Live session — enables message/kill/changeTeam/removePlayer. |
| `stats` | object | Aggregate combat stats (kill, die, revive, winrate, kit, kit_name) for the stat cards. |

Derived/rendered: `kill, die, revive, winrate, kd`, favourite `kit`+`kit_name` (stat cards); an online chart (`getPlayerOnlineData`) with three series **Онлайн / Буст / Очередь** (online minutes / boost / queue).

---

### 4. The Shared Player-Detail Modal (`#player_info`)

Draggable modal. Header shows name, other-nicks dropdown (`#player_info-names`), clan labels (`#player_info-clans`), group/VAC/ban badges (`#player_info-badges`), last-login/created, Steam hours + `<hashtag id="player_info-steam_id">` + Steam link, EOS id, VAC, geo-location (`#player_info-location` + other-locations dropdown → Leaflet map via `player.map.open(lat,lng)`), Discord (`#player_info-discord` + link), primetime, online/bonus/boost tiles, an online activity chart (`#player_info-chart`) with **График / Календарь / По серверам** (Chart / Calendar / Per-server) sub-tabs, a read-only `#player_info-description` textarea (`maxlength=1024`), six stat cards (Winrate `#player_info-winrate`, Kit, K-D, Kills, Deaths, Revives), then a second tab strip of detail tables.

#### 4.1 Detail sub-tabs — server table id + columns + page size (captured buildTable configs)

Each tab lazy-loads on `show.bs.tab`, POSTing to `/ajax/table.php` with `action=<table>` + `&steam_id=<id>`. `numrows` and `showPages` are exact from `players.content.html`.

| Tab (RU / EN) | server table (`action=`) | columns (`collum`) | numrows | showPages |
|---|---|---|---|---|
| Наказания (Bans) | *(from `player.info.bans`; accordion `#player_info_accordion-bans`, not a table call)* | admin, date, reason, description, impact, unban | — | — |
| Варны (Warns) | `playerWarn` | `admin, text, date` (list mode via `#player_info_warn-template`) | 10 | 3 |
| Чат (Chat) | `playerChat` | `server, date, team, type, msg` | 20 | 3 |
| Тимкиллы (Teamkills) | `playerTeamkill` | `server, date, killed, kit` | 10 | 3 |
| Киты (Kits) | `playerKits` | `kit, cnt` | 10 | 3 |
| Сквады (Squads) | `playerSquad` | `server, team, date, squad_id, name` | 10 | 3 |
| Убийства (Kills) | `playerKills` | `server, name, weapon, date` | 10 | 3 |
| Смерти (Deaths) | `playerDeath` | `server, weapon, date` | 10 | 3 |
| Игры (Games) | `playerGames` | `server, map, win, date` | 10 | 3 |
| Поднятия (Revives) | `playerRevive` | `server, name, date` | 10 | 3 |
| Урон (Damage) | `playerDamage` | `server, weapon, name, damage, date` | 10 | 3 |
| Техника (Vehicle) | `playerVehicle` | `server, vehicle, weapon, damage, date` | 10 | 3 |

- **Chat tab** post-processes each `msg` cell: `isObscene(text)` prepends a red warning icon (client-side obscenity flag).
- **Chat `type` column** callback renders `<code style="color:type.color">type.name</code>` — so each row's `type` is an object `{color, name}` (chat channel: All/Team/Squad/Admin).
- Panel id ↔ table id map (captured `data-table`/`#id` markup): `#player_info_warn-table`, `#player_info_chat-table`, `#player_info_teamkill-table`, `#player_info_kits-table`, `#player_info_squad-table`, `#player_info_games-table`, `#player_info_kills-table`, `#player_info_death-table`, `#player_info_revive-table`, `#player_info_damage-table`, `#player_info_vehicle-table`.

#### 4.2 Full action set — moderation capabilities (= permissions)

State-changing actions POST to `/ajax/player.php` (`script:'player'`) or `/ajax/squad.php` (`script:'squad'` = live-server RCON, requires the player online). Payloads verbatim from captured JS (§2.4/§2.5).

| UI label (RU / EN) | action | script → endpoint | `data` params | Effect | Destr.? |
|---|---|---|---|---|---|
| open card | `get` | player → player.php | `steam_id` | Load full `player.info`. | N |
| `Добавить` (Add player) | `add` | player | `steam_id` | Create a record from a SteamID64, then open it. | Y |
| `Наказать`→`Кикнуть` (Kick w/ reason) | `kick` | squad | `steam_id, reason_id, description, noReason:false` | Kick with a rulebook reason. | Y |
| `Кикнуть без причины` (Kick no reason) | `kick` | squad | `steam_id, reason_id, description, noReason:true` | Kick without a rule (confirm). Gated by `canSelfKick`. | Y |
| `Наказать`→`Забанить` (Ban) | `ban` | squad | `server_id, steam_id, reason_id, description, days` | Ban N days or permanent (`days=0`). `server_id` sent if online. | Y |
| `Разбанить` (Unban) | `unban` | squad | `steam_id, unban:<bool>` | Lift ban; `unban:true` erases record fully. Gated by `canUnban`. | Y |
| `Сообщение`→`отправить` (Message) | `message` | player | `steam_id, time, msg, log` | In-game warning repeated for `time` s; `log` mirrors it on card. | Y |
| `Команда` (Switch team) | `changeTeam` | squad | `server_id, steam_id` | Force team swap (confirm). Online only. | Y |
| `Убить` (Kill) | `kill` | squad | `server_id, steam_id` | Kill in-game. Gated by `canBan`+online. | Y |
| `Кик из сквада` (Remove from squad) | `removePlayer` | squad | `server_id, steam_id` | Eject from fireteam/squad. Online + in a squad. | Y |
| tag menu → `Подозрение…` / `Снять метку` | `mark` | player | `steam_id, mark` | Set/clear suspicion tag 0–8. | Y |
| `Группа`→`Сменить группу` (Change group) | `changeGroup` | player | `steam_id, group_id, date, description, prefix, prefix_rgb, image` | Assign group + expiry + custom prefix/color/image (**VIP grant** path). Gated `canChangeGroup`; disabled for self. | Y |
| `Забанить ник` (Ban nickname) | `addBanName` | player | `name` | Add current nick to banned-names blacklist. | Y |
| `Разбанить ник` (Unban nickname) | `removeBanName` | player | `name` | Remove nick from blacklist. | Y |
| `Проверить баны` (Check bans) | `checkBans` | player | `steam_id` | Cross-project ban lookup → `#player_findban-modal` (§5.6). | N |
| `Поиск твинков` (Find twinks/alts) | `twink` | player | `steam_id` | Alt-account detection (§5.3). | N |
| twink → `Онлайн` (compare online) | `twinkOnline` | player | `steam_id, compare_steam_id, start, end` | Overlay two accounts' sessions on a FullCalendar (weekly) to prove co-presence. | N |
| twink → `Проверить друзья` (friends) | `findFriends` | player | `steam_id, compare_steam_id` | Steam-friends check between two accounts → `in_friend`. | N |
| `Киты` (Kit deny) → `Сохранить` | `kits` / `kitSave` | player | get: `steam_id`; save: `steam_id, kits` (JSON `{kit:bool}`) | View & toggle per-kit denial. Modal warns it "may violate server license terms." | Y (save) |
| comments drawer (load) | `getComments` | player | `steam_id` | Load admin comments. | N |
| comments drawer (send) | `addComment` | player | `steam_id, text` | Internal admin comment (≤256 chars). | Y |
| `Скачать статистику` (Download stats) | `downloadStat` | player.php (`post_to_url` form) | `action, steam_id` | Download the player's stats file. | N |
| online chart data | `getPlayerOnlineData` | player | `steam_id, start, end` | Online/boost/queue time series. | N |
| `Копировать телепорт` (Copy teleport) | *(clientside)* | — | — | Copies `AdminTeleportToPlayer <steam_id>`. | N |
| `Заявка в OWI` (OWI report) | *(clientside)* | — | — | Copies a cheat-report template (name/EOS/Steam URL). | N |
| card link | *(clientside)* | — | — | Copies `https://<host>/?steam_id=<id>` deep-link. | N |

Note: `players.html` and `playersOnline.html` are the only fragments exposing the FULL set including `ban/kick/kill/kits/changeGroup/changeTeam/checkBans/add`; other pages embed the same modal but a reduced action set (per action catalog: `bans/chat/admins/collabans` expose `twink/twinkOnline/findFriends/checkBans/removePlayer/getPlayerOnlineData` but not the write actions).

#### 4.3 Twin / alt detection (`twink`) — competitively notable

`Поиск твинков` → `text.list[]` (§2.4). Per candidate the UI renders:
- Name + SteamID + `/?steam_id=<id>` "открыть" deep-link.
- Red flag **"Есть перманентный бан"** when `perm` is truthy.
- Collapsible **matching-IP** list: header `Совпадений: <ips.length>, разница: <humanize(min_date*1000)>`; each row shows `loc`, the candidate's seen-time (`date`) and the owner's seen-time (`owner_date`) side by side, plus `humanize(date−owner_date)` delta.
- **`Проверить друзья`** → `findFriends` → button flips to "В друзьях"/"Не найдено" from `in_friend`.
- **`Онлайн`** → `compareOnline` builds an `agendaWeek` FullCalendar (`locale:ru`, `HH:mm`), and on each `viewRender` calls `twinkOnline(start.unix, end.unix)` → `renderEvents(text.calendar)`, overlaying both accounts' sessions.

A complete shared-IP + Steam-friends + co-presence alt-hunting workflow — a standout anti-ban-evasion tool.

#### 4.4 Suspicion marks (`mark` enum, values `0–8`)

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

A set mark adds a `player_mark` CSS class to the player's rows across all tables and shows a pulsing `#player_info_mark` warning banner.

---

### 5. Forms & Modals (fields, options, validation — captured `#id` / `name` / attrs)

#### 5.1 Search / filter sidebar (drives `search` JSON of `action=allPlayers`)

| Control | `#id` | `data-search` alias | Input | Default | Meaning |
|---|---|---|---|---|---|
| Поиск (Search) | `#allPlayers-btn` | — | button | — | `buildTable('rebuild')`. |
| Ник или SteamID | `#allPlayers-name` | `t1.player` | text | empty | Free-text on nick or SteamID. `paste` auto-rebuilds. |
| Прошлые ники (Past nicks) | `#with_other_names` | `with_other_names` | checkbox | `false` | Extend search to historical nicknames. |
| Полное совпадение (Exact match) | `#full_match` | `full_match` | checkbox | `false` | Exact vs partial match. |
| Заходил c (Seen from) | `#allPlayers-startdate` | `startdate` | text (datetimepicker, readonly) | empty | Lower bound on last-login. |
| Заходил до (Seen until) | `#allPlayers-enddate` | `enddate` | text (datetimepicker, readonly) | empty | Upper bound on last-login. |
| Добавить (Add) | `#addPlayer-btn` | — | button | — | Opens `#addPlayer_modal` (§5.7). |

`searchInput: ["allPlayers-name","allPlayers-startdate","allPlayers-enddate","with_other_names","full_match"]`. `buildTable` harvests these into the `search` JSON (`text` for text inputs, `check` for checkboxes).

#### 5.2 Results table `#allPlayers` (captured `buildTable` config)

```
$('#allPlayers').buildTable({
  table: 'allPlayers',
  collum: ["steam_id", "name", "date"],
  numrows: 100,
  searchInput: ["allPlayers-name","allPlayers-startdate","allPlayers-enddate","with_other_names","full_match"],
  template: $('#player_template > div'),           // mobile 'list' card
  mode: isMobile ? 'list' : 'table',
  callback: { date: (d)=> formatDate(d,false,true) }
});
```

| Visible column (RU / EN) | `collum` key / `data-table` | Render |
|---|---|---|
| SteamID | `steam_id` | `<hashtag>` (copy). Row click → `player.open(steam_id)`. |
| Ник (Nickname) | `name` | plain span. |
| Заходил (Last seen) | `date` | `formatDate(data,false,true)` (unix → local). |

- Row `click` handler ignores `altKey`/`ctrlKey` (so admins can select/copy text without opening the card).
- **Auto-open:** if exactly one row is returned, `tr:eq(0).trigger('click')` opens that player immediately.
- Mobile switches to `mode:'list'` using `#player_template` (steam_id/name/date card).

#### 5.3 Ban form (`#player_ban`)

- **Reason select `#player_ban-reason`** (`type=multiselect`, `enableHTML`): grouped rulebook `<optgroup>`s — **Особые / Общие / Для сквадных / Для техники / Милсим**. Each `<option>` has `value` = rule id (e.g. `1`, `110`, `111`, `120`, `510`, `520`), an HTML `label` with the rule number (e.g. `<strong>1.1.</strong> Оскорбления…`), and **escalation attrs** `data-first / data-second / data-third / data-four` = ban-day tier per offense count (captured examples: general rules `0/0/0/30`, flood rule `1/1/1/30`). `value="false"` = "-Выберите причину-".
- **Punishment radios `player_ban-reason_type`**: Кикнуть (`value=-1 data-action=kick`), Забанить 1/2/3/4/5/6/7/10/14/30 дн (`data-action=ban data-day=N`), Забанить навсегда (`value=-1 data-action=ban data-day=0`, permanent, dark-red).
- **`Дополнительный комментарий`** textarea `#player_ban-description` (≤512).
- Submit `player.actionPlayer()` routes kick vs ban by the checked radio's `data-action`.

#### 5.4 Group / VIP form (`#player_group`)

- **`#player_group-groups`** multiselect: `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера (spectator), `5` Стажёр (trainee).
- **`#player_group-expire`** dateRange button presets: justDay, +1/2/3/6 Month, +1 Year, infinity, reset. Existing VIPs default to `expire` (permanent → infinity).
- `Комментарий` (≤128), `Префикс` (≤64), `Цвет префикса (RGB)` (color picker + `r,g,b` text), `Ссылка на изображение` (≤256).
- Buttons: `Игрок` (flip back), `Сменить группу`, hidden `VIP +1 месяц` quick-grant. Self-editing disabled when `is_you`.

#### 5.5 Message form (`#player_message`)

- Scrollable list of ~18 canned messages (`player.message.set`) — VIP-grant notice, vehicle solo/tandem warnings, squad-lock rules, mic requirement, TK apology, report-received, etc.
- `Добавить запись в карточку игрока` checkbox `#player_message-log` → mirrors message onto the card.
- `Сообщение` textarea (≤512), repeat-`Время` select (1 раз / 30 / 40 сек / 1 мин / 1:30 / 2 мин).

#### 5.6 Cross-project ban modal (`#player_findban-modal`, action `checkBans`)

Renders `text.projects[]` as a grid of `col-md-4` cards, one per federated project. Per card (captured render): project `name`, optional `discord` link, `online` time (`secToTime`), `Наказаний: <ban.total>` or "Нет наказаний", a ban/check icon by `ban.current` presence, and for an active ban a detail line with `ban.current.reason` and either "Перманент" (`expire=="0"`) or `От: <date> До: <expire>`.

#### 5.7 Add-player, Kit-deny & other modals

- **`#addPlayer_modal`**: single `SteamID64` input `#addPlayer_steam_id` → `addPlayer()` → `action:'add'`; on success opens the new card.
- **`#player_kits-modal`** (`kits`/`kitSave`): license-risk warning banner; list of kits each with a danger toggle (`data-kit`, checked = denied, shows "От <date>"); `Сохранить` serializes `{kit:bool}` JSON.
- **`#player_twink-modal`** (alt list `#player_twink-list`), **`#player_map-modal`** (Leaflet OSM map of a `location`), **`#player_info-placeholder`** (skeleton/glow loading), and the sliding **`.player_comments`** drawer (input `maxlength=256`, `getComments`/`addComment`).

---

### 6. Permission / Visibility Logic

Buttons default hidden (inline `display:none` or `.hide`) and are revealed by `setInfo()` per server-provided capability flags — the **server is the source of truth**, the client only reflects it:

- `canBan` → shows "Наказать"; when online, shows "Убить" and kit/banname items.
- `canUnban` → shows "Разбанить" + the `.panel_corner` ban ribbon.
- `canChangeGroup` → shows the "Группа" button (`#player_info-group_btn`).
- `canSelfKick` → shows "Кикнуть без причины".
- `is_you` → group select + expiry disabled (no self-promotion).
- `name_banned` → toggles "Забанить ник" vs "Разбанить ник".
- Online-only actions (message, changeTeam, kill, removePlayer) appear only when `player.info.online` (and its squad/team sub-objects) is present. When online, `player.info.online.squad.id` is prepended as a badge on the name.
- Mark menu, twink, checkBans, copy-teleport, OWI report, download-stat are shown to everyone who can open a card.

Group ids (0 None, 1 Admin, 2 Moderator, 3 VIP, 4 Camera, 5 Trainee) define the role hierarchy; special header art for VIP/Moderator groups.

---

### 7. Notable UX / Competitive Details (worth copying or beating)

1. **One universal player card** embedded on every page — open a player from chat, kills, bans, clans, anywhere; no context switch. Draggable, flippable (ban/group/message forms flip in-place rather than stacking modals).
2. **Alt-account hunting suite** (`twink` + shared-IP timeline + Steam-friends check + co-presence calendar) is the standout — a serious anti-cheat / ban-evasion tool.
3. **Cross-project ban check** (`checkBans`) aggregates bans across a federation of projects, with per-project online time and current-ban reason/expiry; `expire=="0"` = permanent.
4. **Escalating rulebook** encoded in `<option data-first/second/third/four>` — automatic day-tier per repeat offense, plus one-click canned kick/ban durations up to permanent.
5. **Rich identity graph**: SteamID64 + EOS id + Discord + VAC/game-ban + Steam hours + geo-IP history (raw IPs, timezones, map) + nickname history + primetime + clans — all on one screen.
6. **Group grant as branding**: custom prefix text, RGB color and image URL per group (monetizable VIP cosmetics).
7. **Split count/data queries**: the list fires the data page and a separate `pagination=true` `COUNT` in parallel, and every table response ships `query_time`/`count_time`/`exec_time` telemetry — a deliberate latency optimization for a 385 K-row table.
8. **Search depth**: search across historical nicknames + exact/partial toggle + last-seen date range — beats a naive "search by current name only."
9. **Data-exposure gap to exploit/avoid**: the directory list endpoint over-returns per row (`eos_id, create_date, mark, bonus, discord, expire, group_id`) beyond the three visible columns — a privacy/attack-surface note when designing a competitor.

---

### 8. Capture Provenance

- `caps/players/players.network.json` — 3 live contracts: `GET /ajax/page.php?page=players`, `POST /ajax/table.php` (`action=allPlayers`, data), `POST /ajax/table.php` (`pagination=true`, count).
- `caps/players/players.content.html` — live `#content` (search sidebar, `#allPlayers` config, full embedded modal + all sub-tab `buildTable` configs + every `Action()` payload).
- `caps/players/players.modaltabs.json` — modal `data-table` column tokens.
- `caps/players/_blocked.json` — `[]` (zero mutations attempted/blocked).


---

## 04. Player Profile & Per-player Data Storage

> **Ground truth:** the contracts, DOM structure, cross-project switcher and live stat values below were captured read-only (headless) from `https://breaking.sqstat.ru/player/7656119XXXXXXXXXX`. Capture files: `caps/players/_player_7656119XXXXXXXXXX.content.html`, `caps/players/_player_7656119XXXXXXXXXX.network.json`, `caps/players/_player_7656119XXXXXXXXXX.png`.

### 1. Purpose & Nav Location

**Route:** `GET /player/<steamid>` (captured: `/player/7656119XXXXXXXXXX`), optionally `?season=<all|old|1|2>` (default `2`).

Reached from the top-right user dropdown **Профиль (Profile)** → `/player/<steamid>`, or by opening ANY player's SteamID. This is a **full HTML document** (ships its own `<nav>`, not a `#content` fragment) — a hard navigation / bookmarkable page, not a `pageLoad()` AJAX fragment.

**Critical framing:** the profile is the **public read-facing statistics dashboard** for a given SteamID. The captured page (`[Wind]  xcv`, `7656119XXXXXXXXXX`) is **not** the logged-in viewer — confirming `/player/<id>` is a public per-player stat page for **any** player, plus three account-owner tools that only function for the profile owner (settings, clan creation, seeding helper). It is **NOT** the admin "per-player rap sheet." The heavy moderation/forensic per-player data (bans, mutes, chat, comments, suspect marks, IP history, twins/alts, votes, reports, kills/deaths logs) is **not rendered here** — it lives in:

- the **shared player-detail modal** embedded on every page (Chat/Kills/Deaths/Kits/Games/Comments tabs, ~25 actions — fully documented in §03), and
- the dedicated admin DataTables pages, all `script: 'player'`: `bans.html`, `bannames.html`, `collabans.html`, `chat.html`, `comments.html`, `mark.html`, `damages.html`, `deaths.html`, `kills.html`, `revives.html`, `teamkills.html`, `reports.html`, `votes.html`, `logs.html`, `vips.html`, `admins.html`, `top.html`.

So this section documents (a) the **denormalized per-player, per-season statistics model** exposed here and (b) the **owner-account actions** on this page. It cross-references where the forensic data lives without misattributing it to this page.

---

### 1a. Live API Contracts

**Captured contract count: 0 XHR / AJAX requests.** The profile is **fully server-side rendered**: all stat blocks (kits, skill, weapons, vehicles, matches, charts) arrive inline in the initial HTML document; the Chart.js canvases are hydrated from **inline literal arrays** in a `<script>` at the bottom of the page, not from a data endpoint.

| Contract | Method + path | Request params | Response | Notes |
|---|---|---|---|---|
| Profile document | `GET /player/<steam_id>` | path `steam_id`; query `?season=<all\|old\|1\|2>` (default `2`) | full HTML (`#content` ≈ 31 KB captured) | No `#content` fragment endpoint; whole page including `<nav>`. Bookmarkable/SEO-able. |
| Season switch | `GET /player/<steam_id>?season=<v>` | `season` | full HTML | **Hard navigation** (`window.location.href`), not AJAX. |
| Project switch | `GET https://<project>.sqstat.ru/player/<steam_id>?season=<v>` | host swap | full HTML on the sibling project | Cross-project federation switcher (see §2.0). |

**Owner-action endpoints** (present in page JS but **not fired by page load**, so uncaptured as live contracts): `saveUserSettings` (`player`), and `createSquad` / `seeding` / `seedingSetServer` / `seedingGetCalendar` / `seedingGetPriority` / `seedingSetPriority` (`squad`). Documented from JS in §4–§5. The ~25 shared-modal moderation actions do **not** appear on this page.

> Capture interceptor blocked **0** mutations here (`_blocked.json = []`) — the page auto-loads nothing mutating.

**Chart hydration (captured inline data, not endpoints):**

| Canvas `#id` | Chart.js type | Inline data source (captured) |
|---|---|---|
| `player_kd_chart` | doughnut | `[kills, deaths]` e.g. `[2563, 1265]`, labels Убийств/Смертей. |
| `player_kd_year` | stacked bar | monthly `labels[]` (`2024-07`…`2026-07`) + kills[] + deaths[] arrays; tooltip footer computes `K/D = kill/die`. |
| `player_aim` | bubble | `data:[[x_count, y_damage, r], …]` per weapon — damage/accuracy scatter. |

---

### 2.0 Cross-project federation switcher (`#stat-project`)

The profile header carries a **project multiselect** (`#stat-project`) listing **12 sibling SQSTAT deployments**, each an `<option value=<slug> data-url=https://<slug>.sqstat.ru/player/<steam_id>?season=2>`. `onChange` hard-navigates to `event[0].dataset.url` — i.e. the **same SteamID's profile on another project**. Captured projects:

| slug | host | label |
|---|---|---|
| `breaking` | breaking.sqstat.ru | BSS *(current)* |
| `prot` | prot.sqstat.ru | Protocol |
| `bb` | bb.sqstat.ru | BlackBerry |
| `pub` | pub.sqstat.ru | Русский паблик |
| `bzp` | bzp.sqstat.ru | Битва за пиво |
| `rsgs` | rsgs.sqstat.ru | RSGS |
| `hutor` | hutor.sqstat.ru | Hype Hutor |
| `sqstat` | sqstat.ru | Русское сообщество |
| `nklv` | nklv.sqstat.ru | Сибирский анклав |
| `red` | red.sqstat.ru | RED:S |
| `phoenix` | phoenix.sqstat.ru | Phoenix |
| `5thmr` | 5thmr.sqstat.ru | Пятый мотострелковый |

This confirms SQSTAT is a **multi-tenant federation** (subdomain per community) sharing one identity space (same SteamID resolves on every project) — the same federation the modal's `checkBans` queries. A strong competitive signal: they run stats+moderation as a hosted SaaS for many Squad communities off one codebase.

---

### 2. Entities & Fields (the per-player statistics model)

The page denormalizes a large per-player, **per-season** stat aggregate. Seasons partition all stats by time window (see §3). Every number below is scoped to the selected season.

#### 2.1 Player identity / account header

Captured page: `[Wind]  xcv` / `7656119XXXXXXXXXX`, season 2.

| Field | UI label | Meaning / type |
|---|---|---|
| SteamID64 | (URL + `#stat-project`/`#stat-season`) | 17-digit Steam ID, the profile primary key (`/player/7656119XXXXXXXXXX`). |
| Display name | `[Wind]  xcv` (H1) | Current in-game name incl. clan tag prefix. `data-text` mirrors it for a glitch/hover effect. |
| Bonus balance | Ваши бонусы (Your bonuses) | Integer loyalty/currency balance. **Owner-only** — this economy block was NOT present in the captured foreign-player page; it renders only when the viewer owns the profile. |
| VIP status | VIP | "нет" or "до DD.MM.YYYY". **Owner-only** (see above). |
| Subscriptions | Подписки (Subscriptions) | Active recurring subscriptions, or "нет активных". **Owner-only**. Distinct from one-off VIP. |
| Rank | Ранг ??? | Present but **`class="hide"`** — a rank/progress-bar feature built but disabled in this deployment (confirmed in capture: `<h2 class="text-center hide">Ранг ???</h2>`). |
| Role image | `#role_image` (background) | Captured: `/assets/img/roles/RGF/Medic.png` (`height:440px; saturate(160%) brightness(1.4)`) + overlaid kit svg — faction (RGF) + main kit (Medic) drive the hero image. |
| Live-server banner | (top-right block) | A "current server" card (`RAAS/AAS #1`, map thumb `Sumari Seed v1 (14/100)`, disabled "Подключиться" button) — server-population widget shown even on a foreign profile. |

#### 2.2 Skill / lifetime aggregate (per season)

Rendered in the "Скилл (Skill)" block. This is the core scoreboard row.

| Field | UI label | Type | Captured example (`[Wind] xcv`, S2) |
|---|---|---|---|
| K/D ratio | К/Д | float | `2.03` |
| Win rate | Винрейт | percent | `62%` |
| Matches | МАТЧЕЙ | int | `893` |
| Wins | ПОБЕД | int | `530` |
| Losses | ПРОИГРЫШЕЙ | int | `325` |
| Kills | УБИЙСТВА | int | `2,563` |
| Deaths | СМЕРТИ | int | `1,265` |
| Damage | УРОН | int | `520,046` |
| Revives | ПОДНЯТИЯ (pick-ups/revives) | int | `3,093` |
| Teamkills | ТИМКИЛЛЫ | int | `156` |
| Online time | ОНЛАЙН | duration `Nч Nм` | `670ч 19м` |

Note wins+losses (530+325=855) < matches (893): draws/incomplete rounds are tracked separately. Charts derived from this entity: `player_kd_chart` (K/D donut, `[kill, die]`), `player_kd_year` (stacked-bar kills/deaths per month, K/D in tooltip), `player_aim` (bubble scatter, `[count, damage, radius]` per weapon).

#### 2.3 Kit usage (per player, per season)

"Киты (Kits)" table — playtime accumulated per role/kit, sorted desc. Captured kit names: `Medic`, `LAT`, `SL`, `Rifleman`, `Crewman`, `Marksman`, `HAT` (icon `/assets/img/ico/kits/<Kit>.svg`).

| Column | Meaning |
|---|---|
| Kit | Role icon + name. |
| Playtime | Time in that kit, `Nч Nм` (captured: Medic `258ч 36м`, LAT `130ч 33м`, SL `114ч 33м`). |

Implies a stored `player_kit_time[steamid, season, kit] = seconds`.

#### 2.4 Weapon stats (per player, per weapon, per season)

"Оружие (Weapon)" cards — one card per weapon, sorted by kills desc. Image `/assets/img/weapons/<file>.png` with `onerror` fallback to `EMPTY.png`.

| Field | Icon | Meaning |
|---|---|---|
| Weapon name | — | Captured: `АК-74`, `Colt Canada C7`, `M4A1`, `АКС-74У`, `РПГ-7`, `РГД-5`, `C14 Timberwolf`, `Ф1`, `АКМ`, `СВД`. |
| Kills | crosshairs (`fa-crosshairs`) | Kills with that weapon (captured AK-74 → `404`). |
| Damage | explosion (`fa-explosion`) | Total damage (captured AK-74 → `78,362`). |

Implies `player_weapon_stat[steamid, season, weapon] = {kills, damage}`.

#### 2.5 Vehicle stats — driven/crewed ("Техника")

Vehicles the player **operated** and scored from.

| Column | Label | Meaning |
|---|---|---|
| # | — | Rank index (1..10, top-N slab). |
| Vehicle | Техника | **Localized** vehicle name. Captured: `ASLAV`, `Stryker`, `AAV-7`, `Тигр`, `Coyote`, `UB-32`, `ZBL-08`, `БТР-80`, `M1151`, `Град`. |
| Kills | Убийств | Kills scored while in that vehicle (captured ASLAV → `14`). |
| Damage | Урон | Damage dealt from that vehicle (captured ASLAV → `2,374`). |

#### 2.6 Vehicle destruction — kills-against ("Уничтожение техники")

Enemy vehicles the player **destroyed**, keyed by the weapon used. Top-10 slab.

| Column | Label | Meaning |
|---|---|---|
| # | — | Rank index (1..10). |
| Weapon | Оружие | Weapon/projectile used. Captured: `RPG7`, `M72A5`, `M72A6`, `C90`, `Kord`, `FFV751`, `M72A7`, `RPG28`, `M3MAAWS`, `M2`. |
| Vehicle | Техника | **Raw internal asset name** of the destroyed vehicle. Captured: `Tigr_RWS`, `T72B3`, `Technical2Seater_White`, `US_Util`, `BRDM-2L1_AFU`, `CTM131_Logistic`, `M1151_M240`, `TLF_Util`, `RHIB_RUS`. |
| Count | Количество | Number destroyed (captured RPG7 vs Tigr_RWS → `23`). |

Note (confirmed in this capture): this table uses **raw internal asset IDs** (`Tigr_RWS`, `T72B3`) while §2.5 uses localized names — the two tables draw from different sources; destruction is pulled straight from raw kill-log rows. A localization gap a competitor can beat.

#### 2.7 Recent matches ("Матчи")

Top-10 recent games.

| Column | Label | Meaning |
|---|---|---|
| # | — | Row index (1..10). |
| Map | Карта | Layer name + external-link icon `<a href="/game/<gameId>" target="_blank">`. Captured game ids `33286`–`33295`, e.g. `Harju RAAS v1` → `/game/33295`. |
| Teams | Стороны | Two faction icons `/assets/img/ico/teams/<FACTION>.png` (captured `AFU`, `PLANMC`, `IMF`, `MEI`, `RGF`, plus named brigades `58th Motorized Brigade.png`). |
| Win | Победа | `label-success` "Да" + check, or `label-danger` "Нет" + xmark — whether the player's side won. |

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

- The **forensic per-player rap sheet** (bans/mutes history, chat log, comments/notes, suspect marks, IP history, twins/alts/friends, votes, reports, per-round kills/deaths/revives/teamkills detail) is **not on this page** — it is the shared player-detail modal (§03) + the `script:'player'` DataTables pages (`bans/chat/comments/mark/damages/deaths/kills/revives/teamkills/reports/votes/logs/collabans/bannames`). Document those in their own sections for the full storage model.
- Exact `saveUserSettings`/`createSquad`/`seeding*` server-side schemas (column types, ownership checks) are not observable from the client; inferred from JS payloads only, and **none fired at page load** so none captured as live contracts.
- The profile emits **zero XHR contracts** (fully SSR); there is no JSON stat endpoint to reverse-engineer from this page — the numbers are baked into the HTML and the Chart.js inline arrays.

**Capture provenance:** `caps/players/_player_7656119XXXXXXXXXX.content.html` (SSR `#content`, cross-project + season switchers, all stat blocks, inline Chart.js data), `caps/players/_player_7656119XXXXXXXXXX.network.json` (`[]` — 0 AJAX, re-run twice to confirm), `caps/players/_blocked.json` (`[]`), `caps/players/_player_7656119XXXXXXXXXX.png` (rendered screenshot).


---

## 05. Administration: Admins, Groups & Permissions

Implementation-spec documentation of the SQSTAT "admins" page (breaking.sqstat.ru) — the staff roster and the group/role model that drives every permission in the panel. **Ground truth for this chapter is a LIVE capture** of the page's own auto-load reads (read-only headless browser, mutations aborted by interceptor):

- `caps/admins/admins.network.json` — 3 live AJAX contracts (method, url, request body, status, response schema + redacted sample).
- `caps/admins/admins.content.html` — the live rendered `#content` (real headers, form ids, data-* attrs, embedded modal JS).
- `caps/admins/admins.modaltabs.json` — the per-player detail-log tables embedded in the shared modal (`admin`, `date`, `text`).
- `caps/admins/_blocked.json` — `[]` (zero mutations attempted/blocked during capture).

Cross-referenced against `custom.js` (the `player.*` object, `Action()` calls, DataTables config), `action_catalog.txt`, and chapter 16 (settings → permission-group tokens).

> Scope note: `admins.content.html` contains two distinct things. (1) The page's **own** UI — a fixed filter sidebar plus the `#adminPlayers` roster table. (2) The **shared player-detail modal** (`#playerModal`, ids `player_info*`, `player_ban*`, `player_group*`) and its `player.*` JavaScript object, injected into every page fragment in the app. This chapter treats the roster + filter as the page's own surface, and the group-change modal (`#player_group`) as the permission-management surface, and explicitly flags shared-modal actions that are not unique to this page.

---

### Live API Contracts

Everything below is transcribed from the captured `admins.network.json`. Timestamps are unix seconds. Note the panel's convention: **the server pre-renders display cells as HTML strings inside the JSON** (`group`, `time`, `boost`, `bans`, `discord`) while also returning the **raw** values (`group_id`, `color`, `icon`) the client needs for the filter/modal — so the same row carries both machine and presentation forms.

#### C1 — Page fragment loader

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=admins` |
| **Request params** | `page` — string — required — fragment id (`admins`) |
| **Status / ctype** | `200` · `text/html; charset=UTF-8` (114 456 B) |
| **Response** | HTML fragment injected into `#content`: the filter sidebar (`#adminPlayers-btn`, `-name`, `-group`, `-period`), the `#adminPlayers` table skeleton, and the full shared `#playerModal` markup (`#player_group` form included). |
| **Capture** | `caps/admins/admins.network.json` entry 0 |

#### C2 — Roster data (server-side DataTables read)

| | |
|---|---|
| **Method / path** | `POST /ajax/table.php` |
| **Status / ctype** | `200` · `application/json; charset=utf-8` |
| **Capture** | `caps/admins/admins.network.json` entry 1 |

Request body (form-urlencoded; captured, decoded):

```
action=adminPlayers&table=adminPlayers&page=1&numrows=50
&search={"text":{"custom.period.startdate":1780559720,"custom.period.enddate":1783151720},
         "check":{},"multiselect":{},"managers":{},"slider":{}}
&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id — always `adminPlayers`. |
| `table` | string | Y | Duplicate of `action` (`adminPlayers`); the panel sends both. |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size — **50**. |
| `search` | JSON string | Y | Filter envelope with fixed buckets `text`, `check`, `multiselect`, `managers`, `slider`. Roster injects the period as `text["custom.period.startdate"]` / `["custom.period.enddate"]` (unix s). `#adminPlayers-name` (DB alias `t2.player`) lands in `text`; `#adminPlayers-group` (alias `group_id`) lands in `multiselect` when set. |
| `order_by` | string \| `false` | Y | DB alias of the sort column, or literal `false` for default. |
| `order_sort` | string \| `false` | Y | `asc` / `desc`, or literal `false`. |

Response schema (`status: "ok"`, `exec_time: float` seconds):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | **0 on the data request** — the count is computed by the separate C3 call (see below). |
| `data.totalRows` | int | **0 on the data request** (same reason). |
| `data.currentPage` | string | Echoed page index, e.g. `"1"`. |
| `data.row` | array[≤`numrows`] | Roster rows; per-row schema in the table below. |
| `data.custom` | bool | `false`; server flag for custom-column mode. |
| `data.query_time` | float | Row-query seconds. |
| `data.count_time` | int | `0` on the data request. |
| `status` | string | `"ok"`. |
| `exec_time` | float | Total handler seconds. |

Per-row object (`data.row[]`) — **captured field → type → meaning**:

| Field | Captured type | Meaning / notes |
|---|---|---|
| `steam_id` | `str(len36)` | **Player UUID (36-char, dashed), NOT a Steam64 anymore.** Row key; passed to `player.open()`. See §8. |
| `group_id` | `str(len1)` | Raw group enum `"1".."5"` (see §2). Feeds the filter/modal preselect. |
| `expire` | `str` | Group/VIP expiry as unix s; `""` or `"0"` = no expiry (infinity). Captured `""`. |
| `description` | `str` | Free-text comment stored on the group assignment. |
| `prefix` | `str` | In-game tag granted by the group (may be empty). |
| `prefix_rgb` | `str` | Prefix color `"r,g,b"` (may be empty). |
| `image` | `str` | Group image URL (may be empty). |
| `name` | `str(len51)` | Player display nick (DB alias `t2.player`). |
| `date` | `str(len10)` | **Last-seen — unix s** (captured `"1783151718"`). Rendered client-side. |
| `color` | `str(len6)` | Group tag color, **hex without `#`** (captured `"e50606"`). |
| `icon` | `str(len13)` | FontAwesome suffix, **no `fa-` prefix** (captured `"user-circle-o"`). |
| `discord` | `str` | Pre-rendered HTML: linked Discord handle, or empty. |
| `bans` | `str` | Pre-rendered HTML KPI — punishments **issued** by this admin in the period (captured `"<kbd>17</kbd>"`). |
| `online` | object | Live-presence sub-block (see below); present even when the badge shows offline. |
| `online.online` | `str` | Live/session numeric (captured `"18030"`). |
| `online.boost` | `str` | Live boost numeric (captured `"10156"`). |
| `online.queue` | `str` | Queue position (captured `"6"`). |
| `online.server` | `str` | Server id the player is on (captured `"1"`). |
| `group` | `str(len123)` | **Pre-rendered** `<span class="label …" style="…color…">` group chip (icon + label). |
| `time` | `str(len49)` | **Pre-rendered** playtime-for-period badge (captured `"<span class=\"label label-success\">300ч 3…"`). |
| `boost` | `str(len49)` | **Pre-rendered** boost-for-period badge. |

Redacted sample row (from capture):

```json
{
  "steam_id": "<uuid:36>", "group_id": "1", "expire": "", "description": "<redacted:13>",
  "prefix": "", "prefix_rgb": "", "image": "", "name": "<redacted:51>",
  "date": "1783151718", "color": "e50606", "icon": "user-circle-o",
  "discord": "<redacted:73>", "bans": "<kbd>17</kbd>",
  "online": { "online": "18030", "boost": "10156", "queue": "6", "server": "1" },
  "group": "<span class=\"label label-primary\" style=…>…</span>",
  "time":  "<span class=\"label label-success\">300ч 3…</span>",
  "boost": "<span class=\"label label-success\">169ч 1…</span>"
}
```

#### C3 — Roster count (pagination companion call)

| | |
|---|---|
| **Method / path** | `POST /ajax/table.php` |
| **Status / ctype** | `200` · `application/json; charset=utf-8` |
| **Capture** | `caps/admins/admins.network.json` entry 2 |

Same body as C2 **plus `pagination=true`**. The panel fires C2 (rows) and C3 (count) as two requests against the same table id — the count is *not* returned inline on the data call.

Response schema (captured sample in parentheses):

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Page count (`2`). |
| `totalRows` | string | Total matching rows (`"53"`) — the true roster size. |
| `count_time` | int | Count-query time. |
| `status` | string | `"ok"`. |
| `exec_time` | float | Handler seconds. |

#### C4 — Open player (referenced, fires on row click)

`POST /ajax/player.php` with `action=get&steam_id=<uuid>` → returns the full `player.info` object incl. the permission flags in §3.3. Not auto-fired during capture (requires a row click, which we did not perform as it is a read but out of `--open-rows` scope for AJAX); documented from `custom.js` (`player.open`/`player.get`).

#### C5 — Change group (the permission mutation — NOT fired; interceptor would abort)

`POST /ajax/player.php` with `action=changeGroup` — full contract in §4.1. Documented from `custom.js`; **not executed** (mutation). `_blocked.json` = `[]` confirms no write was attempted.

---

### 1. Purpose & Nav Location

- **Loader:** `pageLoad('admins')` → `GET /ajax/page.php?page=admins` (C1), HTML fragment injected into `#content`.
- **Purpose:** Manage the **staff roster** — everyone holding an admin/moderator/camera/trainee group — with per-admin **activity KPIs** over a selectable period (playtime, boost, **punishments issued**, Discord link). Clicking a row opens the shared player modal, whose **"Группа" (Group)** button is the single UI for assigning/changing/revoking a group — i.e. this is where permissions are granted.
- This is a filtered view of the player base restricted to rows that have a `group_id`. There is **no create-group UI** in this fragment — groups are a **fixed, hard-coded 5-value set** (see §2). Custom-group CRUD lives on the **settings → groups** tab (chapter 16), not here; this page only *assigns* an existing group to a player.

---

### 2. The Group / Role Model (core answer)

The complete enum comes from the group-change select `#player_group-groups` (`admins.content.html:686–692`), which includes the "none" sentinel and the VIP entry that the roster filter omits. Internal `name` values are reconciled against chapter 16's `groups` settings tab (the five `[data-setting]` blocks: **Admin, Moderator, QueuePriority, Cameraman, Intern**).

| `group_id` | Russian label | English gloss | Icon (`icon` field) | Color (`color` field) | Internal `name` (ch.16) | In roster filter? |
|---|---|---|---|---|---|---|
| `0` | -Нет группы- | No group / **remove** | — | — | *(clears group)* | No |
| `1` | Администратор | Administrator | `user-circle-o` | `e50606` (red) | `Admin` | Yes |
| `2` | Модератор | Moderator | `id-badge` | `2df044` (green) | `Moderator` | Yes |
| `3` | VIP | VIP | `star` | *(per-record)* | `QueuePriority` | **No** |
| `4` | Камера | Camera / Spectator | `video-camera` | `7d059e` (purple) | `Cameraman` | Yes |
| `5` | Стажёр | Trainee / Intern | `graduation-cap` | `b57c03` (orange) | `Intern` | Yes |

> Reconciliation with chapter 16: each `group_id` here maps 1:1 to a settings-tab group whose **capability set is the 21 Squad permission tokens** (`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`). The admins page assigns the *membership*; chapter 16 defines what each membership *can do*. `changemap`/`kick`/`ban` performed in-game are flagged **"Не будет логироваться в панели"** (won't be audit-logged) in that tab.

Structural findings:

- **Fixed enum, not free-form roles.** Six values (0 + five groups); one group per player, no stacking. Granularity is coarse — the capability matrix lives in settings, not per-assignment.
- **VIP (id 3) is a group row but not an admin role.** Internal name `QueuePriority` (queue-priority perk); deliberately excluded from the roster filter (which lists 1/2/4/5). The *same* change-group modal grants VIP by assigning `group_id=3` with an expiry — hence the hidden **"VIP +1 месяц" (VIP +1 month)** button (`#player_group-btn.hide`, `admins.content.html:728`).
- **A group assignment carries cosmetic/identity payload**, not just a tier: `{group_id, expire, description, prefix, prefix_rgb, image}` scoped to a player (see the captured per-row fields and §3.2).
- **Special-cased modal visuals by internal name** (`custom.js` ~1149–1152): header background → `/assets/img/vip.jpg` when `group.name == 'QueuePriority'`, → `/assets/img/moderator.jpg` when `== 'Moderator'`; all others render generically from `color` + `icon`.
- **Scope is GLOBAL, not per-server.** The `changeGroup` payload (§4.1) contains **no `server_id`** (contrast squad actions, which always send it). Group membership is panel-wide.

---

### 3. Entities & Fields

#### 3.1 Admin roster row

Table headers are the live `#adminPlayers thead` (`admins.content.html`), each with its `data-sort` alias; field semantics from the C2 per-row schema.

| Column header (RU / gloss) | `data-sort` | Backing field(s) | Meaning | Type |
|---|---|---|---|---|
| SteamID | `steam_id` | `steam_id` | Player **UUID** (36-char); row key. | string(36) |
| Ник (Nick) | `name` | `name` (alias `t2.player`) | Display nick. | string |
| Группа (Group) | `group` | `group` (HTML), `group_id`+`color`+`icon` (raw) | Assigned group chip. | enum + rendered HTML |
| Заходил (Last seen) | `date` | `date` | Last-seen **unix s**. | int-as-string |
| `fa-clock-o` — "Наигранное время за период" (Playtime for period) | *(unsortable)* | `time` (HTML), `online.online` (raw) | Hours played in the selected period. | rendered badge |
| `fa-angle-double-up` — "Буст за период" (Boost for period) | *(unsortable)* | `boost` (HTML), `online.boost` (raw) | Boost/activity in the period. | rendered badge |
| `fa-gavel` — "Выданные наказания за период" (Punishments issued) | `bans` | `bans` (HTML `<kbd>N</kbd>`) | **Count of punishments this admin issued** in the period — accountability KPI. | rendered count |
| `fa-brands fa-discord` — "Discord" | *(unsortable)* | `discord` (HTML) | Linked Discord handle / link. | rendered link |

The roster deliberately surfaces **admin-accountability metrics** (playtime, boost, punishments issued) over a date range — a staff-activity dashboard, not just a list.

#### 3.2 Group-assignment record (written by `changeGroup`)

From `#player_group` (`admins.content.html:678–735`) and the `player.group.set` payload (`custom.js` ~2240–2249). Each field with its `#id`, input type, and limit:

| Payload key | `#id` | Input type | maxlength | Meaning / validation |
|---|---|---|---|---|
| `steam_id` | *(from `player.info.steam_id`)* | — | — | Target player UUID. |
| `group_id` | `#player_group-groups` | `<select>` (multiselect single) | — | Group `0..5`; `0` clears. Preselected to `player.info.group_id`. |
| `date` | `#player_group-expire` | `daterange` (`.data('start')`) | — | Expiry unix s; `0` = infinity. Presets in §5.3. |
| `description` | `#player_group-description` | `<textarea>` | **128** | Free-text comment. |
| `prefix` | `#player_group-prefix` | `text` | **64** | In-game tag granted. |
| `prefix_rgb` | `#player_group-prefix_rgb` | `text` | **16** | `"r,g,b"`; two-way-synced with `#player_group-prefix_rgb-color` (`<input type="color">`) via `stringRgbToHex`/`hexToRgb`; clears on parse failure. |
| `image` | `#player_group-image` | `text` (URL) | **256** | Group image URL. |

#### 3.3 Client-side permission flags (`player.info.*`, returned by C4)

Booleans on `player.get`; the modal shows/hides controls accordingly (§6). These are the effective permission model as the client sees it:

| Flag | Gates |
|---|---|
| `canChangeGroup` | Whether the **Группа (Group)** button renders → whether this operator may assign groups at all. |
| `canBan` | Ban flow + name-ban + kits + (online) kill; also **hides the Group button when false**. |
| `canUnban` | Whether an existing ban shows an "unban" control. |
| `canSelfKick` | Whether "kick without reason" appears. |
| `is_you` | If target == operator, the group select **and** expiry are `disable`d — you cannot change your own group. |

---

### 4. Actions Available Here

Mutations go through `Action({script, action, data})` → `POST /ajax/<script>.php` with `action=<action>&<data…>`.

#### 4.1 The permission action (unique/central to this page) — exact contract

Transcribed verbatim from `player.group.set` (`custom.js` ~2233–2250). **NOT executed during capture** (`_blocked.json` = `[]`).

```js
Action({
  script: 'player',
  action: 'changeGroup',
  data: {
    steam_id:   player.info.steam_id,                 // UUID string
    date:       $('#player_group-expire').data('start'), // unix s | 0 (=infinity)
    group_id:   $('#player_group-groups').val(),       // "0".."5"
    description:$('#player_group-description').val(),   // ≤128
    prefix:     $('#player_group-prefix').val(),        // ≤64
    prefix_rgb: $('#player_group-prefix_rgb').val(),    // "r,g,b", ≤16
    image:      $('#player_group-image').val()          // URL, ≤256
  }
})
```

| Endpoint | `POST /ajax/player.php` (body `action=changeGroup&…`) |
|---|---|
| **data keys** | `steam_id` (string, req), `date` (unix s \| `0`, req), `group_id` (`"0".."5"`, req), `description` (string), `prefix` (string), `prefix_rgb` (string), `image` (string) |
| **No `server_id`** | Confirms global scope. |
| **Effect** | Assigns / changes / (`group_id=0`) **revokes** a player's group; also grants/extends VIP (`group_id=3`). |
| **Confirm** | `$.question` "Сменить группу?" renders the chosen group `<option>` label as an `<h2>`; progress text "Меняем" (Changing). |
| **On success** | Re-opens the player modal via `player.open(player.info.steam_id)`. |
| **Destructive?** | **Y** — grants/revokes privileges. This single call *is* the RBAC lifecycle. |

There is **no separate `promote`/`demote`/`addAdmin`/`removeAdmin`** action. Add = assign a group; promote/demote = `changeGroup` to a different `group_id`; remove = `changeGroup` with `group_id:0`; VIP issue/extend = `group_id:3` + expiry.

#### 4.2 Reads that populate this page

| Purpose | Contract | Notes |
|---|---|---|
| Roster rows | **C2** `POST /ajax/table.php` `action=adminPlayers` | 50/page, server-side. |
| Roster count | **C3** same + `pagination=true` | Returns `totalRows`/`totalPage`. |
| Open a player | **C4** `POST /ajax/player.php` `action=get&steam_id=<uuid>` | Row click; loads `player.info` + flags. |

#### 4.3 Shared player-modal actions (embedded — NOT unique to admins page)

These ~22 actions ship on every page's embedded modal. `script:'squad'` actions require the player online and always carry `server_id` (per-server); `script:'player'` actions are global.

| action | script | Per-server (`server_id`)? | Effect | Destructive? |
|---|---|---|---|---|
| `ban` | squad | Y | Ban (`reason_id, description, days`) | Y |
| `unban` | squad | — | Lift ban | Y |
| `kick` | squad | Y | Kick | Y |
| `removePlayer` | squad | Y | Remove from squad | Y |
| `changeTeam` | squad | Y | Switch team | Y |
| `kill` | squad | Y | Kill in-game | Y |
| `addBanName` / `removeBanName` | player | — | Ban/unban a nickname | Y |
| `kits` / `kitSave` | player | — | View/save kits | Y (save) |
| `mark` | player | — | Set/clear cheat-suspicion tag | Y |
| `message` | player | — | In-game message (canned templates) | Y |
| `addComment` / `getComments` | player | — | Admin notes | Y (add) |
| `twink` / `twinkOnline` / `findFriends` | player | — | Alt-account detection | N |
| `checkBans` | player | — | Cross-check bans | N |
| `getPlayerOnlineData` | player | — | Online activity data | N |
| `downloadStat` | player | — | Export stats (form POST) | N |

---

### 5. Forms, Filters & Modals

#### 5.1 Roster filter sidebar (page's own) — live ids

Fixed card (`.block-box`, `position:fixed`), `admins.content.html:1–24`:

| Control | `#id` | Type / `data-search` | Options / default |
|---|---|---|---|
| Поиск (Search) | `#adminPlayers-btn` | button → `buildTable()` | — |
| Ник или SteamID | `#adminPlayers-name` | `text`, `data-search="t2.player"` | placeholder "Ник или SteamID" |
| Group multiselect | `#adminPlayers-group` | `multiselect multiple`, `data-search="group_id"` | options **1/2/4/5 only** (VIP excluded), HTML labels with colored `fa` icons; placeholder "- Группа -" |
| Period picker | `#adminPlayers-period` | `daterange`, `data-search="custom.period"` | button label **"30 дней"**; emits `custom.period.startdate/enddate` (unix s) into `search.text`. Default range = last 30 days. |

#### 5.2 Roster table

`#adminPlayers` (`class="table table-hover"`), `numrows:50`. **Sortable columns** (have `data-sort`): `steam_id`, `name`, `group`, `date`, `bans`. **Not sortable**: playtime, boost, discord. Row click → `player.open(steam_id)`.

#### 5.3 Group-change modal (`#player_group`, `class="hide"`)

Reached via the **Группа** button, which `player.modal.flip({direction:'lr', content:$('#player_group').html()})` (`custom.js` ~2155). On flip end:

- `#player_group-groups` multiselect built (`enableHTML:true`), preselected to `player.info.group_id`, rebuilt.
- `#player_group-expire` daterange presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. **Default:** `{type:'infinity'}` if `group_id && expire=='0'`, else `{type:'justDay', start: moment.unix(expire || now)}`.
- **Self-protection:** if `player.info.is_you`, `#player_group-groups` `multiselect('disable')` and `#player_group-expire` `prop('disabled', true)`.
- `#player_group-prefix_rgb` two-way-syncs with the color swatch; parse failure clears the text field.
- Buttons: **Игрок (Player)** = `player.unflip()` (flip back); **VIP +1 месяц** (`#player_group-btn.hide`); **Сменить группу (Change group)** (`#player_group-btn`). Both action buttons call `player.group.set(this)`.

---

### 6. Permission / Visibility Logic

Client-gated by the server-provided booleans on `player.info` (§3.3); server presumably re-enforces:

- `#player_group` is permanently `class="hide"` in markup, revealed only by the flip.
- **Group button** shown only if `canChangeGroup`; additionally hidden entirely when `!canBan`.
- Ban/name-ban/kits gated on `canBan`; unban on `canUnban`; kill/kick-no-reason on `canBan`/`canSelfKick` and require `online`.
- Self-protection: `is_you` disables changing your own group/expiry.
- `group_id=0` ("-Нет группы-") is the removal sentinel; it is the only non-icon option.

Implication for a competitor: permissions are **coarse and centralized** on this page — a single `canChangeGroup` flag decides who can grant *any* group up to Administrator. There is no "can grant X but not Y", no per-server admin scoping, and no delegated/tiered promotion rules in the client. (The per-token capability matrix exists — but in settings, §2/ch.16 — not per assignment.)

---

### 7. Notable UX & Competitively Interesting Details

- **Unified "group" abstraction covers staff roles AND paid VIP** via one enum/modal/`changeGroup` action — simple to build, but conflates access-control with monetization. A competitor could split "roles/permissions" from "subscriptions/perks" cleanly.
- **Staff-accountability KPIs in the roster** (playtime, boost, **punishments issued** per admin over a date range) turn the admin list into a moderation-activity dashboard — worth copying/beating (add report-resolution time, ban-overturn rate).
- **Cosmetic identity per assignment** (prefix + RGB + image + comment); the color picker two-way-syncs hex↔`r,g,b`.
- **Expiry on membership incl. infinity** — the same mechanism auto-expires trainee/camera access *and* VIP subscriptions.
- **Weaknesses to beat:** (1) fixed 5-value enum, no custom groups on this page; (2) capability granularity is one group per player + a global settings-level token matrix — no per-assignment scoping; (3) group scope is global, no per-server admin assignment; (4) no stacking; (5) promote/demote/remove collapse into one opaque `changeGroup` with no dedicated audit action (only the manual `description`).

---

### 8. Capture-Derived Findings (new vs. prior static analysis)

1. **Identity is now a UUID, not Steam64.** The live `steam_id` field is `str(len36)` (dashed UUID). Every `steam_id` on this page — row key, `changeGroup.steam_id`, `player.open()` arg — is a UUID string. Any reimplementation/interop must treat the identity column as an opaque UUID, mapping to Steam64 only where the game protocol requires it. (Mirrors this repo's own `steam_id64 → UUID` primary-key migration.)
2. **Two-request pagination.** The data call (C2) returns `totalPage:0 / totalRows:0`; the true count comes from a **separate** `pagination=true` call (C3, `totalRows:"53"`). A client that reads paging off C2 alone will see zero.
3. **Server-side HTML in JSON.** `group`, `time`, `boost`, `bans`, `discord` arrive **pre-rendered as HTML strings**, while `group_id`/`color`/`icon`/`date` arrive raw. The roster is not a clean data API — it mixes presentation and data, so a machine consumer must parse HTML out of some cells. Cleaner separation is an easy win.
4. **`live_contracts_captured = 3`, `blocked_mutations = 0`** — the page auto-loads only reads (fragment + rows + count); no mutation fires on load, and the interceptor blocked nothing.
5. **`color` has no `#`, `icon` has no `fa-` prefix** — the client adds both when rendering; matters for anyone re-styling the chips.
6. **Modal detail-log tables** (`admins.modaltabs.json`): `admin`, `date`, `text` — the per-player activity sub-tables inside the shared modal.


---

## 06. VIP / Privileges (Привилегии)

> Spec-grade rewrite backed by LIVE captured contracts (headless, read-only).
> Capture set: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/vips/`
> — `vips.network.json` (3 AJAX contracts), `vips.content.html` (rendered `#content`, 138 KB), `vips.modaltabs.json`, `vips.png`.
> Mutating requests blocked by the interceptor: **0** (`_blocked.json` == `[]`). Everything below is observation-only.

### 1. Purpose & Navigation

- **Nav id / loader:** `vips` — nav item calls `pageLoad('vips')` → `GET /ajax/page.php?page=vips`; the returned HTML fragment (`response_len` 113 754 B, `ctype: text/html`) is injected into `#content`. Confirmed in `vips.network.json` contract #1.
- **Purpose:** a read-and-drill roster of every player who currently holds a **group/privilege** (VIP, Admin, Moderator, Camera, Trainee). It is a JOIN of the group-assignment table (`t1`) and the player table (`t2`), showing SteamID, nick, term/expiry, last-seen, accumulated online time, and the admin note.
- **Architectural invariant:** the `vips` page is **read + search only**. It ships **no add/edit/delete controls of its own**. Every privilege mutation goes through the **shared player-detail modal** ("Смена группы" / Change group), which the fragment embeds as a hidden `#player_group` panel. A row click opens the player modal (`player.open(steam_id)`); flipping to the group panel (`player.group.open()`) exposes the single mutation `changeGroup`. So the "VIP management" capability physically lives in the shared modal, reached from this page.
- **Live scale:** the captured instance holds **395 privilege rows** across **8 pages** at 50 rows/page (`pagination=true` response: `totalRows:"395"`, `totalPage:8`).

---

### 2. Live API Contracts

Three contracts fire on load. Ground truth: `vips.network.json`.

#### 2.1 `GET /ajax/page.php?page=vips` — fragment loader

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | string enum | Y | Page id; here `vips`. |

Response: `text/html` fragment (the sidebar filter form + the `#vipPlayers` table skeleton + all hidden player-modal panel templates). Injected into `#content`.

#### 2.2 `POST /ajax/table.php` — roster data (`action=vipPlayers`)

**Request body** (`application/x-www-form-urlencoded`, verbatim from capture):

```
action=vipPlayers&table=vipPlayers&page=1&numrows=50
&search={"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}
&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server table id; **`vipPlayers`**. |
| `table` | string | Y | Duplicate of `action` (buildTable sends both). |
| `page` | int | Y | 1-based page index. |
| `numrows` | int | Y | Page size; **50** for this table. |
| `search` | JSON string | Y | Filter bag: `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. Text filters land under `text` keyed by each input's `data-search` alias (see §5). Empty object = no filter. |
| `order_by` | string / `false` | Y | Column DB-alias to sort by; `false` = server default. |
| `order_sort` | `asc`/`desc`/`false` | Y | Sort direction; `false` = server default. |
| `pagination` | bool (optional) | N | When `true`, returns only the count envelope (§2.3) instead of rows. |

**Response** `application/json`, `status:"ok"`, `exec_time: float` (seconds, e.g. `0.644`). Shape (`data.*`):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 on the rows call; real value comes from the `pagination=true` call). |
| `data.totalRows` | int | Row count (0 on rows call). |
| `data.currentPage` | string | Echo of requested page, e.g. `"1"`. |
| `data.row[]` | array (len == `numrows`) | Roster rows; per-row schema below. |
| `data.custom` | bool | Whether a custom/user filter preset is active. |
| `data.query_time` | int | ms for the row query. |
| `data.count_time` | int | ms for the count query. |
| `status` | string enum | `"ok"` on success. |
| `exec_time` | float | Total server time (s). |

**Per-row object** (`data.row[i]`) — the VIP roster entity:

| Field | Type | Meaning / notes |
|---|---|---|
| `steam_id` | string | Player identifier / drill key. Rendered in HTML as `<hashtag>7656119XXXXXXXXXX</hashtag>` (Steam64). Capture redaction reported a 36-char token — see Gaps re: raw vs UUID. |
| `group_id` | string enum | Privilege id as a string: `"0"`..`"5"` (see §3 catalog). Captured sample `"3"` = VIP. |
| `expire` | string | Privilege expiry, **unix seconds as string**. Empty string `""` in the captured VIP sample ⇒ **permanent / no expiry** (the UI treats `expire=='0'` as infinity; empty renders as a blank `Срок` cell). |
| `description` | string | Raw admin note (short; sample len 3). |
| `prefix` | string \| null | In-game chat/name prefix; `null` when unset. |
| `prefix_rgb` | string \| null | Prefix color as `"r,g,b"`; `null` when unset. |
| `image` | string \| null | Badge/image URL; `null` when unset. |
| `name` | string | Current/last known player nick. |
| `date` | string | Last-seen timestamp, **unix seconds as string** (sample `"1783107913"`). Rendered as a `badge bg-success` with `data-unix`. |
| `color` | string | Group badge hex color, **no `#`** (sample `"e2b032"` = VIP gold). |
| `icon` | string | Group FontAwesome icon name (sample `"star"` = VIP). |
| `vipdesc` | string | Rendered/expanded note shown in the `Описание` column (sample includes newlines/ASCII art, len 94). Distinct from `description`. |
| `online` | object | Live presence sub-object (below). |
| `online.online` | string | Total online minutes/points (sample `"3221"`). |
| `online.boost` | string | Boost time/points (sample `"141"`). |
| `online.queue` | string | Queue priority / reserved-slot indicator (sample `"5"`). |
| `online.server` | string | Server id the metric is scoped to (sample `"1"`). |
| `group` | string (HTML) | Pre-rendered group label, e.g. `<span class="label label-primary" …>`. |
| `time` | string (HTML) | Pre-rendered accumulated-time badge, e.g. `<span class="label label-success">53ч 41м</span>` (danger variant `0ч 0м` when zero). |

Redacted example row (privacy-safe):

```json
{
  "steam_id": "<redacted Steam64>",
  "group_id": "3", "expire": "",
  "description": "<3ch>", "vipdesc": "випку зайке (\\__/) …",
  "prefix": null, "prefix_rgb": null, "image": null,
  "name": "<redacted nick>",
  "date": "1783107913",
  "color": "e2b032", "icon": "star",
  "online": { "online": "3221", "boost": "141", "queue": "5", "server": "1" },
  "group": "<span class=\"label label-primary\" …>",
  "time": "<span class=\"label label-success\">53ч 41м…"
}
```

#### 2.3 `POST /ajax/table.php` … `&pagination=true` — count envelope

Same body as §2.2 plus `&pagination=true`. Returns a slim envelope (no rows):

| Field | Type | Sample | Meaning |
|---|---|---|---|
| `totalPage` | int | `8` | Page count = ceil(totalRows / numrows). |
| `totalRows` | string | `"395"` | Total matching privilege rows (string!). |
| `count_time` | int | `0` | ms for the count query. |
| `status` | string | `"ok"` | — |
| `exec_time` | float | `0.01` | Total server time (s). |

buildTable fires this once after the rows call to paint the pager, so the roster page issues **two** `table.php` POSTs per view.

---

### 3. Entities & Data Model

Two entities: the **VIP/privilege roster row** (§2.2 schema) and the **group-assignment record** (edited via `changeGroup`).

#### Entity A — VIP roster row (`vipPlayers` server table)

buildTable init (from `vips.content.html` inline script):

```js
$('#vipPlayers').buildTable({
  table: 'vipPlayers',
  collum: ["steam_id","name","expire","date","time","vipdesc"],
  numrows: 50,
  searchInput: ["vipPlayers-name","vipPlayers-startdate","vipPlayers-enddate","vipPlayers-desc"],
  end: () => { $('#vipPlayers tbody > tr').on('click', function(){
      player.open($(this).find('td[data-contact="steam_id"] > hashtag').text());
  }); }
});
```

| `collum` key | Column header (rendered) | Cell `data-contact` | Source field | Type / meaning |
|---|---|---|---|---|
| `steam_id` | `SteamID` (width 151px) | `steam_id` | `row.steam_id` | Steam64 in `<hashtag>`; the drill key. |
| `name` | `Ник` (Nick, centered) | `name` | `row.name` | Bold-centered nick. |
| `expire` | `Срок` (Term, width 130px) | `expire` | `row.expire` | Unix-sec string; empty/`0` ⇒ permanent (blank cell). |
| `date` | `Заходил` (Last seen, width 130px) | `date` | `row.date` | `badge bg-success[data-unix]`, humanized ("Вчера 21:45:13"). |
| `time` | clock icon `fa-clock-o` (width 80px) | `time` | `row.time` | Accumulated online time badge (`53ч 41м`); success/danger color. |
| `vipdesc` | `Описание` (Description, centered) | `vipdesc` | `row.vipdesc` | Admin note (expanded). |

Search aliases leak the server schema: `t1.description` (assignment table) and `t2.player` (player table) — the roster is a JOIN of **group-assignment `t1`** × **player `t2`**.

#### Entity B — Group / privilege assignment (edited via `changeGroup`)

`Action({script:'player', action:'changeGroup', data:{…}})` — exact keys from `vips.content.html`:

| Key | Source control | Type | Meaning |
|---|---|---|---|
| `steam_id` | `player.info.steam_id` | string | Target player (Steam64). |
| `date` | `$('#player_group-expire').data('start')` | unix-sec / `0` | Expiry term; `0` (infinity preset) ⇒ permanent. |
| `group_id` | `$('#player_group-groups').val()` | enum `0..5` | Privilege granted; `0` = remove group. |
| `description` | `#player_group-description` textarea | string ≤128 | Admin comment → `vipdesc`. |
| `prefix` | `#player_group-prefix` | string ≤64 | In-game chat/name prefix. |
| `prefix_rgb` | `#player_group-prefix_rgb` | string ≤16 | Prefix color `"r,g,b"`. |
| `image` | `#player_group-image` | string ≤256 | Badge/image URL. |

On success it re-opens the card: `success: () => player.open(player.info.steam_id)`; on error `addAlert(text)`; `complete` closes the confirm dialog.

Group catalog — verbatim `<option>`s of `#player_group-groups`:

| group_id | Label (RU / EN) | FA icon |
|---|---|---|
| `0` | -Нет группы- (No group) | — |
| `1` | Администратор (Administrator) | `fa-user-circle-o` |
| `2` | Модератор (Moderator) | `fa-id-badge` |
| `3` | **VIP** | `fa-star` |
| `4` | Камера (Camera / spectator) | `fa-video-camera` |
| `5` | Стажёр (Trainee) | `fa-graduation-cap` |

VIP is one value (`group_id=3`) inside a general **group/role system**; the same `changeGroup` endpoint grants staff roles and VIP alike, differentiated only by `group_id`. VIP's badge is gold (`color:"e2b032"`, `icon:"star"`).

---

### 4. The Page's Own Table (`#vipPlayers`)

- **Columns:** SteamID · Ник · Срок · Заходил · clock-icon (time) · Описание (§3, Entity A).
- **Server table id:** `vipPlayers` (both `action=` and `table=`).
- **Page size (`numrows`):** **50**. Two POSTs per view: rows, then `pagination=true` count.
- **Default sort:** `order_by=false&order_sort=false` — server default (no client sort UI, no `order` config, no sortable headers).
- **Row interaction:** `#vipPlayers tbody > tr` click → `player.open(<hashtag text>)`. No per-row buttons, no bulk-select, no inline edit.

---

### 5. Forms & Filters

Left fixed sidebar, applied by the **Поиск** (Search) button `#vipPlayers-btn`. Each input's `data-search` becomes a key in the `search.text` bag.

| Control (RU / EN) | `#id` | input type | `data-search` alias | Notes |
|---|---|---|---|---|
| Ник или SteamID (Nick or SteamID) | `#vipPlayers-name` | text | `t2.player` | Free text on player name/id. |
| Заходил c (Last-seen from) | `#vipPlayers-startdate` | text `readonly` | `startdate` | `datetimepicker({language:'ru', pickTime:true, sideBySide:true})`; inline ✕ clears (`$('#vipPlayers-startdate').val('')`). |
| Заходил до (Last-seen to) | `#vipPlayers-enddate` | text `readonly` | `enddate` | Same picker; inline ✕ clears. |
| Описание (Description) | `#vipPlayers-desc` | text | `t1.description` | Free text on admin note. |

No `maxlength`/regex on the filter inputs; validation is server-side.

---

### 6. Actions / Permissions from this page

The only page-native interaction is search + drill-in; every mutation is delegated to the shared modal. VIP-relevant actions:

| UI label | action | script → endpoint | Data keys | Effect | Destructive |
|---|---|---|---|---|---|
| (row click) | `get` | `player` → `POST /ajax/player.php` | `{steam_id}` | Loads player card + `player.info`. | N |
| Сменить группу (Change group) | `changeGroup` | `player` → `POST /ajax/player.php` | `steam_id, date, group_id, description, prefix, prefix_rgb, image` | Grants / changes / (with `group_id=0`) removes a privilege; sets term, note, prefix, color, image. **The VIP add + edit + remove operation.** | **Y** |
| VIP +1 месяц (VIP +1 month) | `changeGroup` | `player` → `POST /ajax/player.php` | same payload | Quick-grant button (`#player_group-btn`, class `hide`). Rendered but hidden by default. | **Y** |

Both submit buttons call `player.group.set(this)`; there is **no separate `changeExpire` action on this page** — `changeExpire` exists only on the clan page (`clan_16.html`, per `action_catalog.txt`) and is out of scope here. The clan-scoped `Action({script:'clan', action:'vipPlayer', data:{clan_id, steam_id, vip}})` reserved-slot toggle is **not present** in the `vips` fragment (the "vipPlayer" substrings in the HTML are all the `vipPlayers` table id).

Other shared-modal actions embedded in this fragment but belonging to the universal player modal (documented in the Players section): `ban`, `unban`, `kick`, `kill`, `kits`, `kitSave`, `mark`, `message`, `twink`, `twinkOnline`, `addComment`, `getComments`, `changeTeam`, `checkBans`, `findFriends`, `getPlayerOnlineData`, `removePlayer`, `addBanName`, `removeBanName`, `downloadStat` (scripts `player`, `squad`).

**Distinction to beat:** global privilege = `changeGroup` (`group_id=3`); clan reserved-slot = clan-scoped `vipPlayer` boolean. Two separate "VIP" concepts.

---

### 7. The "Смена группы" Modal (`#player_group`)

Hidden template (`class="hide"`), cloned into the flip modal via `player.group.open()` (`player.modal.flip({direction:'lr', content:$('#player_group').html()})`).

| Field (RU / EN) | Control | Type / options | Validation |
|---|---|---|---|
| Group | `#player_group-groups` | bootstrap `multiselect({buttonClass, maxHeight:400, enableHTML:true})` | 6 options (`0..5`); pre-selected via `.multiselect('select', player.info.group_id)` then `'rebuild'`. |
| Expire (Срок) | `#player_group-expire` | custom `dateRange` widget | Presets: `justDay, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year, infinity, reset`. `limitDate:false`. **Default:** `infinity` when `group_id && expire=='0'`; else `{type:'justDay', start: expire || now}`. `data('start')` feeds the `date` payload key; `infinity` ⇒ `0`. |
| Комментарий (Comment) | `#player_group-description` | `<textarea rows=2>` | `maxlength=128`; init `.html(player.info.group_description)`. |
| Префикс (Prefix) | `#player_group-prefix` | text | `maxlength=64`; init `.val(player.info.prefix)`. |
| Цвет префикса RGB | `#player_group-prefix_rgb` + `#player_group-prefix_rgb-color` (`type=color`) | text + swatch | `maxlength=16`. On `change`: `stringRgbToHex()` → `hexToRgb()` → writes back `"r,g,b"` and syncs the swatch; parse failure clears the field. |
| Ссылка на изображение (Image URL) | `#player_group-image` | text | `maxlength=256`; init `.val(player.info.image)`. |
| Submit — Сменить группу | `#player_group-btn` (always visible) | `onclick="player.group.set(this)"` | Confirm `$.question({title:'Сменить группу?', text:<selected group label>, daPrevent:'Меняем'})` before firing. |
| Submit — VIP +1 месяц | `#player_group-btn` (`class="hide"`) | `onclick="player.group.set(this)"` | Same handler; hidden by default. |
| Back — Игрок | — | `onclick="player.unflip()"` | Flip back to the player card. |

`player.info` fields the modal consumes (from `player.get`): `steam_id`, `eos_id`, `group_id`, `expire`, `group_description`, `prefix`, `prefix_rgb`, `image`, `is_you`, `canChangeGroup`.

---

### 8. Permission / Visibility Logic (explicit predicates)

| Predicate | Effect |
|---|---|
| `player.info.canChangeGroup === true` | show `#player_info-group_btn` (the "Группа" button that opens the modal); else hide it. **Server-provided per-player permission flag** — the primary gate on who may edit a group. |
| `player.info.is_you === true` | `#player_group-groups` → `multiselect('disable')` **and** `#player_group-expire` → `prop('disabled', true)`. Self-edit of group/term blocked in UI. |
| `#player_group-btn.hide` (VIP +1 месяц) | button carries `hide` by default; surfaced only in specific contexts/roles. |
| `player.info.group_id && player.info.expire=='0'` | dateRange default = `infinity` (permanent); otherwise a single-day range from current expiry/now. |

The client offers the full 6-group list to anyone who passes `canChangeGroup`; server-side `player.php` authorizes which target group (Admin vs VIP) a given admin may actually set.

---

### 9. Notable UX & Competitively Interesting Details

- **`canChangeGroup` server flag** (new vs prior notes): group editing is gated by an explicit per-player boolean from `player.get`, not just `is_you`. Clone this — it lets the server centralize "who can grant what."
- **Unified group system:** VIP/Admin/Moderator/Camera/Trainee are one `group_id`; one modal + one `changeGroup` endpoint covers grant/edit/revoke for every role.
- **Rich privilege metadata:** a privilege carries **term, admin note, chat prefix, prefix RGB, and image/badge URL** — plus live `online/boost/queue/server` presence in the roster row. The color picker with live hex↔rgb sync is polished.
- **Dual note fields:** `description` (raw, ≤128) vs `vipdesc` (rendered) — server formats notes for display.
- **Expiry presets + infinity:** day / 1·2·3·6 months / 1 year / permanent / reset; permanent encoded as `0` (blank `Срок` cell).
- **Quick "VIP +1 месяц":** dedicated one-tap grant/extend (hidden by default) — the highest-frequency VIP action; worth copying.
- **Search ergonomics:** last-seen range + description search find expired-but-inactive or soon-to-lapse VIPs and donation notes ("випку зайке…"). Good retention tooling.
- **Two-POST pattern:** rows + `pagination=true` count; `totalRows` returns as a **string**, mixed with int `totalPage` — a quirk to normalize in a clone.
- **Scale:** 395 active privilege rows / 8 pages on the live instance.

---

### Gaps / Unknowns

- **`steam_id` identity type:** rendered HTML uses Steam64 (`<hashtag>`) and `player.get`/`changeGroup` payloads use Steam64; the `table.php` JSON `steam_id` was redacted to a 36-char token, so whether the JSON carries the raw Steam64 or an internal 36-char UUID could not be confirmed from the redacted capture.
- **`expire` blank vs `0`:** the live VIP sample returned `expire:""` (empty) for a permanent grant while the UI logic keys on `expire=='0'`; the server appears to accept both — the exact normalization is server-side.
- **`online.queue`/`online.server` semantics:** the `queue` field (sample `"5"`) is the closest thing to a **reserved-slot priority** indicator, but no label confirms it maps to in-game slot reservation for VIPs; inferred, not proven.
- **Per-server scoping:** `changeGroup` carries no `server_id`; whether a granted group is global or per-server is not exposed on this page (unlike the clan `vipPlayer` flag, which is explicitly `clan_id`-scoped).
- **Condition that un-hides "VIP +1 месяц"** is not determinable from the static fragment.
- **`clock-icon` (`time`) column** is pre-rendered HTML (`53ч 41м`); the underlying raw metric is not exposed as a separate numeric field in the JSON.


---

## 07. Players Online (live)

Implementation-spec documentation for the SQSTAT (breaking.sqstat.ru) **Players Online** page. This revision is built from **live captured API contracts** (headless authenticated browser, read-only interceptor — 0 mutations fired) plus the live rendered `#content` fragment, the shared client library `custom.js`, and `action_catalog.txt`. Russian UI labels are preserved with an English gloss in parentheses.

Capture provenance: `caps/online/playersOnline.network.json` (2 contracts), `caps/online/playersOnline.content.html` (live `#content`, 165 623 B), `caps/online/_blocked.json` = `[]` (no mutation attempted or blocked).

---

### 1. Purpose and nav location

| Property | Value |
|---|---|
| Nav id / loader | `playersOnline` → `pageLoad('playersOnline')` → `GET /ajax/page.php?page=playersOnline` |
| Injected into | `#content` |
| Purpose | A cross-server leaderboard of players who accumulated playtime **within a selected time window**, ranked by total playtime and broken down by time spent in each in-game role (kit). It doubles as the launchpad for the shared **player-detail modal**, from which admins run live RCON actions (kick / ban / kill / move team / message) against players **currently** on a server. |
| Primary data source | Server-side table `playersOnline` via `$('#playersOnline').buildTable({table:'playersOnline', …})` → `POST /ajax/table.php` |

> **Scope note (confirmed against live capture).** Despite the section brief naming `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster` and `downloadOnline`, **none of those actions is invoked by this page.** The only reads this page fires on load are the page fragment and one `table.php` query (see §2). Per `action_catalog.txt`, `serverOnline*` live only on `main.html` (the per-server dashboard). This page's "online" concept is a **historical playtime aggregation over a date range** — a *report*, not a real-time roster snapshot. The genuinely real-time element here is the RCON action set that lights up when a listed player happens to be online right now (`player.info.online` non-null). Real-time roster vs. historical aggregation distinction is made explicit in §7 and §9.

---

### 2. Live API Contracts

Two network contracts were captured on page load. Ground truth: `caps/online/playersOnline.network.json`.

#### 2.1 `GET /ajax/page.php?page=playersOnline` — fragment loader

| Property | Value |
|---|---|
| Method / path | `GET /ajax/page.php` |
| Query param | `page` — string — required — must equal `playersOnline` |
| Status / ctype | `200` / `text/html; charset=UTF-8` |
| Response | Raw HTML fragment (115 844 B) injected into `#content`; contains the filter bar, the `#playersOnline` table skeleton, the inline `buildTable` bootstrap script, and the entire shared player-detail modal markup |

No JSON; this is a server-rendered partial. The inline `<script>` it carries wires the date-range picker, the server multiselect, and the table (§4).

#### 2.2 `POST /ajax/table.php` — the leaderboard query (main data contract)

**Request** — `application/x-www-form-urlencoded` body (captured verbatim):

```
action=playersOnline&table=playersOnline&page=1&numrows=100
&search=<urlencoded JSON>&order_by=false&order_sort=false
```

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Server handler selector — fixed `playersOnline` |
| `table` | string | Y | Table id echoed for routing — fixed `playersOnline` |
| `page` | int | Y | 1-based page number |
| `numrows` | int | Y | Page size; this page sends `100` (from `buildTable.numrows`) |
| `search` | urlencoded JSON | Y | Filter envelope, see below |
| `order_by` | string \| `false` | Y | DB alias of the sort column, or literal `false` for default sort |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction, or `false` for default |
| `pagination` | `true` | N | When appended (`…&pagination=true`), server returns the page/row **count** query used to build the pager (`custom.js:993`); the row-fetch call omits it |

**`search` envelope** — `encodeURIComponent(JSON.stringify(searches))`, five always-present buckets (`custom.js:711`). Captured decoded value (default "today" window, no other filter):

```json
{
  "text": {
    "custom.period.startdate": 1783116000,
    "custom.period.enddate":   1783202399
  },
  "check": {}, "multiselect": {}, "managers": {}, "slider": {}
}
```

| Bucket | Populated by | Key(s) | Value type |
|---|---|---|---|
| `text` | `#playersOnline-user` (free text) and the date-range picker | `player`; `custom.period.startdate`, `custom.period.enddate` | string; **unix seconds** for the two period keys |
| `multiselect` | `#playersOnline-server` | `server_id` | array of server-id strings |
| `check`, `managers`, `slider` | (none on this page) | — | always empty objects here |

**Response** — `200` / `application/json; charset=utf-8`. Schema (`field: type — meaning`):

| Field | Type | Meaning |
|---|---|---|
| `status` | string — enum `ok` (`"ok"` observed) | Query outcome flag |
| `exec_time` | float | Total server handling time, seconds |
| `data.totalPage` | int | Total pages for current filter (0 in the count-less row call; populated by the `pagination=true` call) |
| `data.totalRows` | int | Total matching rows (same caveat) |
| `data.currentPage` | string | Echoed page number, as a string (`"1"`) |
| `data.custom` | bool | Whether a custom (non-preset) period is active |
| `data.query_time` | float | Row-query time, seconds |
| `data.count_time` | int | Count-query time, seconds (0 unless `pagination=true`) |
| `data.row[]` | array | Leaderboard rows; **93 rows** in the captured page |
| `data.row[].steam_id` | string(17) | Steam64 ID — identity key, feeds `player.open()` |
| `data.row[].name` | string | Player display name |
| `data.row[].online` | string | **Pre-formatted duration**, Russian `"Xч Yм"` (h/m) — total playtime in window. NOT raw minutes |
| `data.row[].boost` | string | Pre-formatted duration `"Xч Yм"` — boosted playtime in window |
| `data.row[].queue` | string | Pre-formatted duration `"Xч Yм"` — time spent in join queue. **Returned but NOT rendered** (absent from `buildTable.collum`) |
| `data.row[].SL` | string | Duration `"Xч Yм"` as Squad Leader |
| `data.row[].CMD` | string | Duration as Commander |
| `data.row[].Rifleman` | string | Duration as Rifleman |
| `data.row[].Medic` | string | Duration as Medic |
| `data.row[].LAT` | string | Duration as Light Anti-Tank |
| `data.row[].MachineGunner` | string | Duration as Machine Gunner |
| `data.row[].Marksman` | string | Duration as Marksman |
| `data.row[].Engineer` | string | Duration as Engineer |
| `data.row[].Pilot` | string | Duration as Pilot |
| `data.row[].Crewman` | string | Duration as vehicle Crewman |

Redacted example row (`caps/online/playersOnline.network.json`):

```json
{
  "steam_id": "<redacted:17>", "name": "<redacted:36>",
  "online": "5ч 32м", "boost": "3ч 56м", "queue": "0ч 0м",
  "SL": "0ч 27м", "CMD": "0ч 0м", "Rifleman": "0ч 55м", "Medic": "0ч 0м",
  "LAT": "0ч 0м", "MachineGunner": "0ч 0м", "Marksman": "0ч 0м",
  "Engineer": "0ч 0м", "Pilot": "0ч 0м", "Crewman": "0ч 0м"
}
```

> **Contract implications for a re-implementer.** (1) All duration metrics are formatted **server-side** into `Xч Yм` strings — the client does no numeric parsing, so sorting must be done server-side on the underlying seconds, not on the string. (2) `queue` is part of the wire contract even though this page never shows it — the same `playersOnline` handler evidently serves callers that do. (3) The count query is a **separate round-trip** (`&pagination=true`); the initial row call returns `totalPage/totalRows = 0`.

---

### 3. Entities & fields

#### 3.1 `PlayerOnlineRow` — one leaderboard row

Row shape is fixed by the `data.row[]` schema in §2.2. Column→DB-alias mapping (used for sort and for the `data-search` protocol) is in §4. All metric fields are pre-formatted `Xч Yм` duration strings.

#### 3.2 `PlayerInfo` — the shared player-detail entity (`player.info`)

Loaded by `action:'get'` (script `player` → `/ajax/player.php`) when a row's `<hashtag>` is clicked (`player.open(steam_id)`). Shared panel-wide; only fields this page reads/renders are listed.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string | Steam64 ID — identity key for every downstream action |
| `name` | string | Current nickname |
| `eos_id` | string | Epic Online Services ID |
| `discord` | string | Discord user id (links `discord.com/users/<id>`) |
| `vac` | mixed | VAC status |
| `steam_info.ban` | object `{vac, ban, days}` | VAC / game-ban flags from Steam |
| `steam_info.squad.time` | number | Steam hours played in Squad |
| `location[]` | array `{iso, loc, timezone, lat, lng, ip, date}` | Geo-IP history; index 0 = current |
| `primetime[]` | array `{start, end}` (unix ranges) | Player's habitual online hours |
| `playtime.server` | string | "Home" server label |
| `group_id`, `expire`, `prefix`, `prefix_rgb` | mixed | Admin-group membership (§3.4) |
| `ban` | object `{expire, reason, admin, date, description}` | Active punishment |
| **`online`** | object \| null | **Presence — non-null only if the player is on a server right now** |
| `online.server` | object `{id, name}` | Server the player is currently on — required by every RCON action |
| `online.team` | object `{short}` | Current team — drives "change team" |
| `online.squad` | object `{id}` | Current squad number — drives "kick from squad"; rendered as a badge in `#player_info-name` (`content.html:1177`) |

`online` is the pivot for every live/RCON capability; when null the destructive live buttons stay hidden (§7).

#### 3.3 `PlayerOnlineData` — live activity chart (`getPlayerOnlineData`)

Returned by `action:'getPlayerOnlineData'` (script `player`), request keys `steam_id, start, end`. Keyed by timestamp bucket; each entry `{minute, boost, queue}` (minutes online / boost value / queue time). Rendered as a 3-dataset line chart in the modal (chart config at `content.html:~1330`).

#### 3.4 Reference / enum entities

- **Ban reason** (`player_ban-reason` select): rule catalog; each `<option>` carries `data-first/second/third/four` = recommended ban lengths (days) for the 1st–4th offence. Value `-1` = permanent.
- **Ban duration radios** (`player_ban-reason_type`): `data-action` = `kick`|`ban`; `data-day` ∈ `{0,1,2,3,4,5,6,7,10,14,30}` (0 = permanent). One is auto-selected "Рекомендуемое" (Recommended) from the reason's offence data.
- **Admin groups** (`player_group-groups`): `0` -Нет группы- (None), `1` Администратор (Admin), `2` Модератор (Moderator), `3` VIP, `4` Камера (Camera/spectator), `5` Стажёр (Trainee).
- **Suspicion marks** (`player.mark.set`): `1` WallHack, `2` AimBot, `3` SpeedHack, `4` object-spawn, `5` reload exploit, `6` griefing, `7` config, `8` toxic, `0` = clear.
- **Message durations** (`player_message-time`): `1` (once), `30`, `40`, `60` (default), `90`, `120` seconds.

---

### 4. DataTables spec: `#playersOnline`

Config from the live inline bootstrap (`content.html:71-104`) and the `buildTable` engine (`custom.js:620-1100`).

| Property | Value |
|---|---|
| Server table id | `playersOnline` (sent as both `action=` and `table=`) |
| Endpoint | `POST /ajax/table.php` |
| Page size (`numrows`) | `100` |
| Row click | `#playersOnline tbody > tr hashtag` → `player.open($(this).text())` (opens shared modal on the SteamID) |
| Default sort | none explicit (`order_by=false&order_sort=false`) — server default (playtime desc) |

**Column set** — `collum` order and sortability (`order` array). Header labels from live `<thead>` tooltips (`content.html`). `data-search` DB alias = the field name (server-side aggregation aliases):

| # | `collum` key / DB alias | Header (`data-original-title`) | English | Sortable (`order`) | Rendered as |
|---|---|---|---|---|---|
| 1 | `name` | Игрок | Player | No | clickable `<hashtag>` carrying SteamID |
| 2 | `online` | Наигранное время за период | Playtime in period | **Yes** | `Xч Yм` |
| 3 | `boost` | Буст за период | Boost in period | **Yes** | `Xч Yм` |
| 4 | `SL` | Сквадной | Squad Leader | **Yes** | kit icon + `Xч Yм` |
| 5 | `CMD` | CMD | Commander | **Yes** | kit icon + duration |
| 6 | `Rifleman` | Стрелок | Rifleman | **Yes** | kit icon + duration |
| 7 | `Medic` | Медик | Medic | **Yes** | kit icon + duration |
| 8 | `LAT` | Гранатомётчик | Grenadier / LAT | **Yes** | kit icon + duration |
| 9 | `MachineGunner` | Пулемётчик | Machine Gunner | **Yes** | kit icon + duration |
| 10 | `Marksman` | Снайпер | Marksman | **Yes** | kit icon + duration |
| 11 | `Engineer` | Инженер | Engineer | **Yes** | kit icon + duration |
| 12 | `Pilot` | Пилот | Pilot | **Yes** | kit icon + duration |
| 13 | `Crewman` | Водитель | Crewman | **Yes** | kit icon + duration |

Kit icons resolve to `/assets/img/ico/kits/<Kit>.svg`. `queue` is present in the response but **not** in `collum`, so it is fetched and discarded here. Sort clicks toggle `order_by`/`order_sort` and rebuild (`custom.js:819-830`).

---

### 5. Filter bar & search protocol

Filter bar markup + wiring from live `content.html:56-104`. `buildTable.searchInput = ["playersOnline-user","playersOnline-period","playersOnline-server"]`. Each control's `type` attribute selects a serializer branch in `custom.js:721-774`.

| Control | `#id` | `name` / `data-search` | input `type` | Serializer → bucket | Options / default | Validation |
|---|---|---|---|---|---|---|
| Игрок (Player) | `playersOnline-user` | `player` | `text` | `searches.text["player"]` | placeholder "Игрок"; empty by default | Enter (keyCode 13) sets `page=1`, `isSearch=true`, rebuilds; empty value omitted; `+`→`%2B` |
| Period picker | `playersOnline-period` | `custom.period` | `daterange` | `searches.text["custom.period.startdate"]` + `.enddate` (unix seconds from `data-start`/`data-end`) | presets `['justMonth','justDay','justWeek','justYear','range','today','yesterday','currentWeek','lastWeek','currentMonth','lastMonth','last30days']`; **default `{type:'today'}`**; on change fires `crm_dateRange` → `buildTable()` | always populated |
| Сервер (Server) | `playersOnline-server` | `server_id` | `multiselect` | `searches.multiselect["server_id"]` (array) | `nonSelectedText:'- Сервер -'`; values below | null selection omitted |
| Поиск (Search) | `playersOnline-btn` | — | button | — | rebuilds with current filters | — |

**Server multiselect options** (live `content.html`): `1` RAAS/AAS #1, `6` БЕЗ ГОЛОСОВАНИЯ #2, `7` INVASION #3, `9` Custom для FW, `10` Custom для MDC, `11` Custom для BSS.

Envelope is `encodeURIComponent(JSON.stringify({text,check,multiselect,managers,slider}))` (`custom.js:778`).

---

### 6. Actions / admin capabilities (from the shared modal)

Every state-changing action originates in the **shared player-detail modal**, not the leaderboard table. Two script endpoints:

- **`/ajax/squad.php`** — live RCON layer. Require `player.info.online.server.id`; act on the running server. All destructive.
- **`/ajax/player.php`** — database/record layer (marks, comments, groups, name-bans, twink analysis, exports).

Each row lists the exact `Action({script, action, data:{…}})` call. "Dest." = destructive.

| # | UI label | `action` | `script` → endpoint | `data` keys (type) | Effect | Dest. |
|---|---|---|---|---|---|---|
| 1 | (open card) | `get` | player → `/ajax/player.php` | `steam_id`(str) | Load full player card | N |
| 2 | График (online chart) | `getPlayerOnlineData` | player | `steam_id`(str), `start`(unix), `end`(unix) | Fetch minute/boost/queue series | N |
| 3 | Кикнуть (Kick, with reason) | `kick` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(int) | RCON kick from server | **Y** |
| 4 | Кикнуть без причины (Kick, no reason) | `kick` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(empty) | RCON kick without a reason record | **Y** |
| 5 | Забанить (Ban N days / perma) | `ban` | **squad** | `server_id`(int), `steam_id`(str), `reason_id`(int), `description`(str≤512), `days`(int; `-1`=perma) | Ban + kick | **Y** |
| 6 | Разбанить (Unban) | `unban` | **squad** | `steam_id`(str), `unban`(bool) | Lift active ban; `unban` also clears error/appeal | **Y** |
| 7 | Кик из сквада (Kick from squad) | `removePlayer` | **squad** | `server_id`(int), `steam_id`(str) | RCON remove from squad, keep on server | **Y** |
| 8 | Команда (Change team) | `changeTeam` | **squad** | `server_id`(int), `steam_id`(str) | RCON force to other team | **Y** |
| 9 | Убить (Kill) | `kill` | **squad** | `server_id`(int), `steam_id`(str) | RCON kill character | **Y** |
| 10 | Сообщение (Warn / message) | `message` | player | `steam_id`(str), `time`(int sec), `msg`(str≤512), `log`(bool) | In-game warning; `time`=repeat, `log` writes to card | **Y** |
| 11 | Метка (Set suspicion mark) | `mark` | player | `steam_id`(str), mark(int 1–8 or 0) | Flag/clear cheat suspicion; highlights `.player_mark` | **Y** |
| 12 | Группа (Change group / VIP) | `changeGroup` | player | `steam_id`(str), `date`(expire), `group`(int 0–5), `description`(str≤128), `prefix`(str≤64), `prefix_rgb`(str≤16), `image`(str≤256) | Assign admin/VIP group w/ expiry, chat prefix, colour, image | **Y** |
| 13 | Проверить баны (Check bans) | `checkBans` | player | `steam_id`(str) | Query external/community ban lists | N |
| 14 | Поиск твинков (Find alts) | `twink` | player | `steam_id`(str) | Alt accounts sharing IPs (`name, steam_id, ips[], min_date`) | N |
| 15 | Онлайн compare | `twinkOnline` | player | `steam_id`(str), `compare_steam_id`(str) | Compare online calendars of player vs suspected alt | N |
| 16 | Проверить друзья (Check friends) | `findFriends` | player | `steam_id`(str), `compare_steam_id`(str) | Cross-check Steam friend links | N |
| 17 | Забанить ник (Ban nickname) | `addBanName` | player | `steam_id`(str) (+ nick context) | Add nick to banned-names list | **Y** |
| 18 | Разбанить ник (Unban nickname) | `removeBanName` | player | `steam_id`(str) | Remove nick from banned-names list | **Y** |
| 19 | Киты (Kits editor open) | `kits` | player | `steam_id`(str) | Load per-player kit permissions | N |
| 20 | Сохранить (Save kits) | `kitSave` | player | `steam_id`(str), `kits[]`(array) | Persist edited kit permissions | **Y** |
| 21 | Комментарии (Get comments) | `getComments` | player | `steam_id`(str) | Load internal admin comments | N |
| 22 | (add comment) | `addComment` | player | `steam_id`(str), text(str) | Append admin comment | **Y** |
| 23 | Скачать статистику (Download stats) | `downloadStat` | player (`post_to_url` form) | `steam_id`(str) | File download of player stats | N |

Client-only helpers (no server call): **Копировать телепорт** (`copyTeleport` → clipboard `AdminTeleportToPlayer <steam_id>`), **Заявка в OWI** (`copyReport` → clipboard OWI/BattleMetrics report template), **ссылка** (`copylink` → clipboard `?steam_id=`).

Full `player.php` surface reachable from this modal (`action_catalog.txt`): `addBanName, addComment, ban, changeGroup, changeTeam, checkBans, findFriends, get, getComments, getPlayerOnlineData, kick, kill, kits, kitSave, mark, message, removeBanName, removePlayer, twink, twinkOnline, unban, downloadStat` — with `ban/kick/kill/changeTeam/removePlayer/unban` routed through `script:'squad'`.

---

### 7. Forms, modals & visibility predicates

**Ban / punish** (`#player_ban`): reason multiselect (rule catalog, `data-first..four` recommended days) + duration radio group `player_ban-reason_type` (kick or ban 1–30d / perma, one auto-recommended) + comment textarea `player_ban-description` (max 512). Submit `player.actionPlayer()` branches `kick` vs `ban` on `squad`; if online, `server_id` = `player.info.online.server.id`.

**Group** (`#player_group`): group select 0–5; expiry daterange `player_group-expire` (**disabled when group=0**); comment (max 128); prefix text (max 64); prefix RGB color picker `player_group-prefix_rgb-color` synced to `r,g,b` text (max 16); image URL (max 256). Submit `player.group.set()` → `changeGroup`. "VIP +1 месяц" quick-action is `.hide`-gated.

**Message / warn** (`#player_message`): ~18 canned warnings selectable via `player.message.set()`; free-text `player_message-msg` (max 512); repeat select `player_message-time`; **"Добавить запись в карточку игрока"** checkbox `player_message-log` to also log to card. Submit → `message`.

**Kits** (`#player_kits-modal`): per-role permission list saved via `kitSave` with a client-assembled `kits[]` payload.

**Twink panel**: alt list with per-alt **Проверить друзья** / **Онлайн** buttons firing `findFriends` / `twinkOnline` against `compare_steam_id`; shows IP-overlap counts and time deltas.

**Visibility predicates** (`player.open()` reveals conditionally; default `display:none` / `class="hide"`):

| Element | Shown iff (predicate) |
|---|---|
| Сообщение (message) | `player.info.online` truthy |
| Команда (change team) | `player.info.online.team` present |
| Кик из сквада (removePlayer) | `player.info.online.squad` present |
| Убить (kill) / Кикнуть без причины | `player.info.online` truthy |
| Разбанить (unban) | active ban exists on player |
| Забанить ник / Разбанить ник | toggled by current name-ban state |
| Киты (kits) | card data confirms kit-permission availability |
| VIP quick-grant | `.hide` until group flow selects VIP |

Net effect: the entire destructive RCON toolset (kick/kill/team/squad) is **inert for offline players** and only lights up for live ones; the server enforces the `server_id` requirement, the client mirrors it by presence-gating. No visible client-side role check beyond presence; group-level authorization assumed server-side. A few SteamIDs are special-cased in `player.open()` (owner/dev badges) — cosmetic only.

---

### 8. Competitively interesting details

- **Playtime-by-role leaderboard.** 11 kit columns turn "who was online" into a role-competency table — surfaces medics/SLs/pilots and role-stackers; useful for recruiting, not just moderation.
- **One shared player-detail modal everywhere.** The same ~23-action card is embedded on every page. An admin never leaves context to punish. High leverage, expensive to out-build piecemeal.
- **Presence-driven action gating.** Clean split: DB actions on `player.php`, live actions on `squad.php`, gated by `player.info.online.server.id`.
- **Recommended ban-length engine.** Each rule encodes escalating 1st–4th-offence durations; correct duration radio auto-checked and tooltipped "Recommended." A fairness/consistency feature to beat.
- **Canned warnings + optional card logging.** Pre-written warnings with a "log to card" toggle and configurable in-game repeat interval — fast, auditable moderation.
- **Twink hunting.** IP-overlap alt detection with drill-down (shared IPs, time deltas, friend-graph cross-check, online-calendar comparison).
- **Clipboard integrations.** `AdminTeleportToPlayer` and a ready-to-paste OWI/BattleMetrics cheat-report template are copy-to-clipboard.
- **Rich per-player intel.** Geo-IP history with flags/timezones, primetime hours, Steam hours, VAC/game-ban badges, Discord link.
- **Server-side formatted durations.** All metrics arrive as `Xч Yм` strings — cheap on the client, but forces server-side sort on underlying seconds.

---

### 9. Gaps / uncertainties

- **Real-time roster vs historical aggregation:** confirmed — this page is a *period aggregation report*. The live roster (`serverOnline`/`serverOnlineAdmins`/`serverOnlineBooster`/`downloadOnline`) lives on `main.html`; document the real-time roster in the servers/main section.
- `queue` is in the wire contract but never rendered here — its display consumer is another page/caller; exact semantics (queue time vs queue count) inferred from the `Xч Yм` format = time.
- `totalPage`/`totalRows` are 0 in the row-fetch response; the count is a separate `&pagination=true` round-trip not captured here (no user paged during capture).
- Server-side field set for `action:'get'` beyond what the modal reads is not observable from the client.
- `reason_id`→rule-text mapping lives server-side; only the option catalog is visible client-side.
- Kit-permission payload shape (`kits[]` from `player.kits.collect()`) is assembled client-side; server schema not exposed here.
- `boost`/`primetime` precise definitions inferred from usage, not a schema.


---

## 08. Player Comments & Suspect Marking

Implementation-spec reconstruction of SQSTAT's per-player admin note system (**Комментарии / Comments**) and its suspect-tagging system (**Метки / Marks**), built from **live captured API contracts** (`breaking.sqstat.ru`, session-authenticated headless capture) plus the rendered `#content` fragments and the shared player-modal JS. These are two distinct-but-related moderation-storage features that attach free-form notes and a single structured "cheat suspicion" flag to a player identity. Both surface as dedicated nav pages **and** as controls inside the shared `player_info` modal that is embedded on every page.

Ground-truth capture files (cited inline below):
- `caps/notes/comments.network.json`, `caps/notes/mark.network.json` — live `table.php` request/response schemas.
- `caps/notes/comments.content.html`, `caps/notes/mark.content.html` — rendered `#content`: real headers, search inputs, `buildTable` config.
- `home_auth.html` — the shared `player` JS object (`player.comment.*`, `player.mark.*`) and `Action()` bodies.
- `custom.js` — the `Action()` transport wrapper (`POST /ajax/<script>.php`, JSON envelope).

Capture summary: **6 live AJAX contracts** captured (3 per page), **0 blocked mutations** (`caps/notes/_blocked.json == []`) — everything below is observation-only.

---

### 1. Purpose & Nav Location

| Feature | Nav id | Fragment loader | Own table id (`table.php action=`) | Row array size |
|---|---|---|---|---|
| Player comments log | `comments` | `GET /ajax/page.php?page=comments` | `playerComments` | 1090 rows / 11 pages |
| Suspect marks log | `mark` | `GET /ajax/page.php?page=mark` | `playerMark` | 708 rows / 8 pages |

- **Comments page** = a global, cross-player audit feed of every admin note ever written, searchable by target player, authoring admin, and note text.
- **Mark page** = a global roster of every player who currently carries a suspicion/toxicity flag, filterable by mark type; effectively a watchlist of suspected cheaters and toxic players.
- Both are read/browse surfaces. The *write* side (`addComment`, `mark`) happens inside the shared player modal, which both pages also embed. Any row click opens that player's modal via `player.open(steam_id)` (see §5).

The capabilities (`addComment`, `getComments`, `mark`) are attached to the shared modal and are therefore reachable from **every** page in the panel — `action_catalog.txt` confirms `addComment`/`getComments`/`mark` on `admins`, `bans`, `chat`, `kills`, `players`, `reports`, `damages`, `deaths`, `teamkills`, `top`, `vips`, `votes`, etc. The two pages here are just the dedicated browse/report views over the same stored data.

> **Identity key finding:** the live schemas show `steam_id` as a **36-character** string (`str(len36)` in both `comments.network.json` and `mark.network.json`) — i.e. a **UUID**, not a Steam64. Steam64 survives only as the author key `admin_id: str(len17)`. SQSTAT has moved its player primary key to a UUID surrogate; the column retains the legacy name `steam_id`.

---

### 2. Live API Contracts

All three action verbs and both list tables share one transport: `Action({script, action, data})` from `custom.js:284`.

**Transport (`Action` wrapper, `custom.js`):**
- Request: `POST /ajax/<script>.php`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.
- Body: object `data` is serialized to `action=<action>` + `&<key>=<value>` for each data key (no URL-encoding of values in the wrapper — raw concatenation).
- Response envelope (JSON): success branch requires `status == "ok"` → `success(text)`. Otherwise: if `text.auth === true` → `location.reload()` (session expired); else `error(text.msg)`.
- `retryAbort:true` aborts any in-flight request sharing the same logical `name` before firing (server throttles the shared session).

#### 2.1 `POST /ajax/table.php` — list tables (`playerComments`, `playerMark`)

Both browse tables are driven by the same `buildTable` DataTables engine and hit `table.php` twice on load: (a) the **data** request and (b) a **pagination/count** request with `&pagination=true`.

**Request params** (source: `comments.network.json`, `mark.network.json`):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | enum `playerComments` \| `playerMark` | yes | Server table selector. |
| `table` | string | yes | Same value as `action` (echoed). |
| `page` | int | yes | 1-based page index. |
| `numrows` | int | yes | Page size — captured value **`100`**. |
| `search` | URL-encoded JSON | yes | Filter envelope: `{"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}`. Text inputs populate `text` keyed by the input's `data-search` DB alias; the mark multiselect populates `multiselect` keyed by `mark` (see §4). Empty objects = no filter. |
| `order_by` | string \| `false` | yes | Sort column DB alias; `false` = default sort. |
| `order_sort` | string \| `false` | yes | `asc` / `desc`; `false` = default. |
| `pagination` | `true` | count-only | Present only on the second (count) request. |

**Response — data request (`status:"ok"`, `application/json`):**

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Total pages (0 on the data call; real value comes from the count call). |
| `data.totalRows` | int | Total matched rows (0 on the data call). |
| `data.currentPage` | str | Echoed page, e.g. `"1"`. |
| `data.row` | array (≤ `numrows`) | Row objects (schemas in §2.1.1 / §2.1.2). |
| `data.custom` | bool | Custom-query flag (`false` observed). |
| `data.query_time` | int/float — seconds | Row-query duration. |
| `data.count_time` | int — seconds | Count duration (0 on data call). |
| `status` | str — `"ok"` | Envelope status. |
| `exec_time` | float — seconds | Server exec time. |

**Response — count request (`&pagination=true`):**

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Page count (comments **11**, mark **8**). |
| `totalRows` | str — integer | Total rows (comments **`"1090"`**, mark **`"708"`**). |
| `count_time` | int/float — seconds | Count duration. |
| `status` | str — `"ok"` | Status. |
| `exec_time` | float — seconds | Exec time. |

##### 2.1.1 `playerComments` row schema (LIVE — `comments.network.json`)

| Field | Type | Meaning |
|---|---|---|
| `id` | str — integer | Comment PK (e.g. `"1091"`). |
| `steam_id` | str(36) — **UUID** | Target player identity (also the row click key). |
| `admin_id` | str(17) — Steam64 | Authoring admin's Steam64. |
| `date` | str(10) — **unix timestamp** | When the note was written. |
| `text` | str — HTML-escaped | Note body; double-quotes arrive as `&quot;` (double-escaped on the wire; see §5.1 unescape). |
| `admin` | str — **pre-rendered HTML** | Author display block: `<p class="mb-0"><code style="color:#<hex>">…</code></p>`. |
| `admin_color` | str(6) — hex | Author name color (e.g. `e50606`). |
| `admin_group` | str(1) | Author group id. |
| `player` | str — **pre-rendered HTML** | Target player display block. |
| `player_color` | str \| null | Target color (null observed). |
| `player_group` | str \| null | Target group (null observed). |

Redacted example row:
```json
{"id":"1091","steam_id":"<uuid:36>","admin_id":"7656119XXXXXXXXXX","date":"1783097436",
 "text":"&quot;Попал в пачку к читерам…","admin":"<p class=\"mb-0\"><code style=\"color:#e50606\">…",
 "admin_color":"e50606","admin_group":"1","player":"<redacted>","player_color":null,"player_group":null}
```

##### 2.1.2 `playerMark` row schema (LIVE — `mark.network.json`)

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | str(36) — **UUID** | Suspect player identity (row click key). |
| `eos_id` | str(32) — EOS id | Epic Online Services id. |
| `name` | str — raw | Player nickname (raw, unrendered). |
| `date` | str(10) — **unix timestamp** | **Заходил / last seen** login time. |
| `create_date` | str(10) — **unix timestamp** | **When the mark was created** (persisted, though not shown as a column). |
| `mark` | str — **pre-rendered HTML** | Reason icon: `<i class="fa fa-fw fa-fa-fw fa-solid fa-…"></i>` (enum → icon, §3). |
| `bonus` | str — integer | Player bonus-points balance (e.g. `"59103"`). |
| `discord` | str(18) — snowflake | Linked Discord id. |
| `color` | str(6) — hex | Nickname color. |
| `player_group` | str(1) | Player group id. |
| `ban` | str — **pre-rendered HTML** | Ban status label: `<span class="label label-danger">Нет</span>` (Нет = not banned) / positive label when banned. |
| `player` | str — **pre-rendered HTML** | Player display block (colored nickname). |

Redacted example row:
```json
{"steam_id":"<uuid:36>","eos_id":"<eos:32>","name":"<redacted>","date":"1783151948",
 "create_date":"1769521352","mark":"<i class=\"fa fa-fw fa-fa-fw fa-solid fa-…","bonus":"59103",
 "discord":"<snowflake:18>","color":"e2b032","player_group":"<redacted:1>",
 "ban":"<span class=\"label label-danger\">Нет</span>","player":"<redacted>"}
```

> **Correction vs prior draft:** `playerMark` **does** persist a mark-creation timestamp (`create_date`). It is stored but not surfaced as a table column (the visible date column is `date` = last-seen). There is still **no mark-author** field in the schema — who set/cleared a mark is not exposed.

#### 2.2 `POST /ajax/player.php` — the three write/read verbs

Source: `home_auth.html` (`player.comment.*`, `player.mark.*`).

| Verb | `action` | Data keys (type) | Response | Effect | Destructive |
|---|---|---|---|---|---|
| Read comment thread | `getComments` | `steam_id` (UUID str) | `{status:"ok", comments:[{name:str, date:unix-str, text:str}, …]}` | Populates slide-out thread; empties → empty-state. | **N** |
| Add note | `addComment` | `steam_id` (UUID str), `text` (str, trimmed non-empty, ≤256) | `{status:"ok"}` | Persists a note authored by the session admin; `complete` re-runs `getComments`. | **Y** |
| Set/clear mark | `mark` | `steam_id` (UUID str), `mark` (int `0`–`8`) | `{status:"ok"}` | Writes the player's single mark enum; `0` clears. Triggers flip animation + banner re-render + row highlight. | **Y** |

`getComments` response (redacted):
```json
{"status":"ok","comments":[{"name":"AdminNick","date":"1783097436","text":"note body"}]}
```

---

### 3. The `mark` Enum (suspicion taxonomy)

Hardcoded client-side twice: as the page filter `<option>` set (`mark.content.html`) **and** as the JS map returned by `player.mark.get()` (`home_auth.html`). Values `1`–`8` are real categories; `0` is the clear sentinel (dropdown-only, not a filter option).

| Value | Russian label | English gloss | Icon (`get()` map) |
|---|---|---|---|
| `1` | Подозрение на WallHack | Suspected WallHack | `fa-fw fa fa-eye` |
| `2` | Подозрение на AimBot | Suspected AimBot | `fa-fw fa fa-crosshairs` |
| `3` | Подозрение на SpeedHack | Suspected SpeedHack | `fa-fw fa fa-tachometer` |
| `4` | Подозрение на спавн объектов | Suspected object spawning | `fa-fw fa fa-bomb` |
| `5` | Подозрение на перезарядку | Suspected reload exploit | `fa-fw fa fa-refresh` |
| `6` | Подозрение на гриф | Suspected griefing | `fa-fw fa fa-free-code-camp` |
| `7` | Подозрение на конфиг | Suspected illegal config | `fa-fw fa-solid fa-file-excel` |
| `8` | Токсичный игрок | Toxic player | `fa-fw fa-solid fa-biohazard` |
| `0` | Снять метку | Remove mark (clear) | `fa fa-times` |

- A player carries **exactly one** mark at a time (single scalar enum column; `mark.set(n)` replaces, `mark.set(0)` clears). The mark-page multiselect is an **OR filter over the log**, not a per-player multi-value store.
- The enum→`{name,icon}` map is duplicated between filter and modal and is **not server-configurable** — a competitor could make the taxonomy dynamic.

---

### 4. The Pages' Own Tables (`buildTable`)

Both use the same jQuery `buildTable` engine, `numrows:100`, server-side loading, row click → `player.open(<steam_id cell text>)`. No column-sort or pagination widgets are rendered beyond the fixed page size (`order_by/order_sort` default to `false`).

#### 4.1 `#playerComments` — `buildTable({table:'playerComments', numrows:100})`

`collum: ["steam_id","date","admin","player","text"]` · `searchInput: ["playerComments-name","playerComments-admin","playerComments-text"]` · click handler reads `td[data-contact="steam_id"]`.

| # | Header (rendered) | `collum` key | Notes |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Row click key; `width:151px`. |
| 2 | Дата (Date) | `date` | unix→`formatDate`; `text-center`. |
| 3 | `<i fa-id-badge>` Админ (Admin) | `admin` | Pre-rendered colored author. |
| 4 | `<i fa-user>` Ник (Nick) | `player` | Target nickname. |
| 5 | `<i fa-comment>` Комментарий (Comment) | `text` | Note body. |

**Search inputs** (left fixed sidebar; submit `#playerComments-btn` = **Поиск / Search**):

| `#id` | placeholder | `data-search` (DB alias → `search.text` key) | input |
|---|---|---|---|
| `#playerComments-name` | Игрок (Player) | `t5.player` | text |
| `#playerComments-admin` | Админ (Admin) | `t2.player` | text |
| `#playerComments-text` | Текст (Text) | `t1.text` | text |

Aliases confirm a server-side join: `t1` = comments (`.text`), `t2` = author admin (`.player`), `t5` = target player (`.player`).

#### 4.2 `#playerMark` — `buildTable({table:'playerMark', numrows:100})`

`collum: ["steam_id","player","date","mark","ban"]` · `searchInput: ["playerMark-name","playerMark-mark"]`. Marked rows carry CSS class `player_mark` (highlight).

| # | Header (rendered) | `collum` key | Notes |
|---|---|---|---|
| 1 | SteamID | `steam_id` | Row click key; `width:151px`. |
| 2 | `<i fa-user>` Ник (Nick) | `player` | Colored nickname. |
| 3 | `<i fa-clock-o>` Заходил (Last seen) | `date` | Maps to `date` field (last-seen unix). |
| 4 | `<i fa-triangle-exclamation>` Причина (Reason) | `mark` | Pre-rendered enum icon. |
| 5 | `<i fa-gavel>` Бан (Ban) | `ban` | Pre-rendered ban-status label. |

**Search controls** (left sidebar; submit `#playerMark-btn`):

| Control | Type | `data-search` (→ `search` key) | Filters on |
|---|---|---|---|
| `#playerMark-name` | text, placeholder Игрок (Player) | `t1.player` (→ `search.text`) | Nickname |
| `#playerMark-mark` | `<select multiple type="multiselect">`, 8 options `value=1..8` with `label="<i …>…"` | `mark` (→ `search.multiselect`) | One or more mark categories (OR) |

The multiselect renders each option's inline icon (bootstrap-multiselect, `enableHTML`). This is the watchlist filter (e.g. show all AimBot **or** WallHack flags). Note `0`/clear is **not** an option here — you cannot filter for "unmarked".

---

### 5. Modal Forms, State & Predicates

The `player_info` template lives in `<div id="player_info" class="hide">` and is cloned into `#playerModal` on `player.open()`. The `hide` class is a template mechanism, not a permission gate.

#### 5.1 Comment slide-out (`player.comment`, `home_auth.html`)

| Aspect | Spec |
|---|---|
| Container | `#playerModal .player_comments`; toggled open via `open` class. |
| Trigger | `.player_comments_button` (desktop) / `.player_comments_button-mobile` (mobile) → `player.comment.open()`. |
| Open predicate | `open()` toggles `open` class; **fetches only when it becomes open** (`if(container.toggleClass('open').hasClass('open')) get()`). |
| Composer | single `<input class="form-control" maxlength="256">` + `.player_comments_sumbit` button. |
| Submit | Enter (`keyCode==13`) **or** submit-button click → `send()`. |
| Validation | `text = input.val().trim(); if(text=='') return;` — non-empty + `maxlength=256` only; no server-echoed validation surfaced. |
| Send | `addComment{steam_id,text}`; `success` clears input; `complete` always re-runs `get()` (new note appears immediately). |
| Thread render (`add`) | per message: `<p class="player_comments_message_user">{name} <small …>{formatDate(date,false)}</small></p>` + `<p class="player_comments_message_text">`; body via `.html(text.replace(/&amp;quot;/g,'"'))` (unescapes double-escaped quotes). |
| Count badge | `count(cnt)` writes into `.player_comments_button span` (and mobile); seeded from modal payload `player.info.comments_count`. |
| States | loading `.player_comments_load`; empty **Нет комментариев / No comments** `.player_comments_nomessage` (shown when `comments.length==0` **or** on request error). |
| Immutability | append-only — no edit/delete control in the fragment. |

#### 5.2 Mark dropdown (`player.mark`, `home_auth.html`)

| Aspect | Spec |
|---|---|
| Trigger | header `<button><i class="fa-solid fa-tags"></i></button>` dropdown → `#player_info-mark` list. |
| Options | 8 `<li><a onclick="player.mark.set(1..8)">` + `divider` + `<a onclick="player.mark.set(0)">` **Снять метку / Remove mark**. |
| Confirmation | **none** — each `<a>` fires `mark.set(n)` directly. |
| Set (`set(n)`) | `mark{steam_id,mark:n}`; `success` → `animateCss('flip_panel_full')` then `comment.destroy()` + `mark.render(n)`; toggles `player_mark` on `tr[data-id="<steam_id>"]` (add when `n!=0`, remove when `n==0`). |
| Banner render (`render(mark)`) | if `mark!="0"`: `#player_info_mark` `.show()` with `<i class="{icon}"></i> {name}` (pulsing `alert-warning animated pulse infinite`); else `.hide()`. |
| Active-state predicate | `render` clears `.disabled` on all `#player_info-mark li`, then adds `.disabled` to `a[onclick="player.mark.set({mark})"]` — the current flag is visibly disabled in the menu. |
| Errors | `mark`/`addComment` failures → `addAlert(text,"exclamation-triangle")`. |

---

### 6. Permission / Visibility Logic

- **No explicit role/group gating** on the comment composer or the mark dropdown in these fragments — unlike sibling controls (**Убить / Kill**, **Кикнуть / Kick**, **Забанить ник / Ban name**, **Разбанить ник**, **Киты / Kits**) which ship `style="display:none;"` and are revealed by role logic elsewhere. Comments and marks are available to any admin who can open the modal — a lower privilege bar than punitive actions.
- **Comment authorship is server-attributed:** `addComment` sends only `{steam_id,text}`; the author (`admin_id`/`admin`) is stamped from the session. The comments page is therefore an accountability/audit trail of which admin said what about whom.
- **Marks are not author-attributed:** the schema carries `create_date` (when) but no "who". No audit of who set/cleared a suspicion — an exploitable weakness for a competitor to beat.
- **Session-expiry handling:** any verb returning `{auth:true}` forces `location.reload()` (`custom.js`), so an expired admin session bounces to login rather than silently failing a write.

---

### 7. Competitive Takeaways & Gaps to Beat

- **Structured cheat taxonomy.** The 8-value suspicion enum (WallHack, AimBot, SpeedHack, object-spawn, reload-exploit, grief, illegal-config, toxic) with per-type icons is a clean, one-click watchlist primitive (no confirm dialog). Worth copying — but make it **server-configurable**, not hardcoded in JS in two places.
- **Ban-aware watchlist.** The mark page's **Бан** column is a ready-made triage queue for "suspected but not yet actioned" cheaters; the row also carries `bonus`, `discord`, `eos_id` for cross-referencing.
- **Cross-player audit feed.** The comments page is a global, searchable log of every admin note (searchable by author admin), doubling as staff accountability. Notes are immutable/append-only, timestamped, and colored per author group.
- **Ubiquitous, low-friction access.** Because comments+marks ride the shared modal, an admin can annotate/flag from *any* page (chat, kills, reports…) without navigating away; the count badge keeps prior notes discoverable.
- **Gaps:**
  - No edit/delete/soft-delete of comments; no threading or attachments; 256-char single-line cap; body is double-escaped and unescaped client-side (`&amp;quot;`), a brittle round-trip.
  - Only one mark per player (single enum) — cannot flag "AimBot" **and** "toxic" simultaneously, despite the multiselect *filter* implying otherwise. No "unmarked" filter option.
  - `create_date` is stored but never surfaced; **no mark-author audit** and no mark history/timeline.
  - Mark taxonomy + enum→label map hardcoded and duplicated client-side.
  - No pagination controls beyond a fixed `numrows:100` page and no exposed sort UI (`order_by/order_sort` hardwired to `false` on load).


---

## 09. Ban Management

### 1. Purpose and Navigation

- **Nav id / entry point:** `bans` → `pageLoad('bans')` → `GET /ajax/page.php?page=bans`, HTML fragment injected into `#content`.
- **Purpose:** A searchable, paginated register of every ban ever issued on the project (the "ban archive"). It is a *read/lookup* surface: the list shows who is/was banned, why, when, and until when. All *mutation* of a ban (issue, extend, revoke) is performed not from a row form but from the **shared player-detail modal** that opens when you click a row.
- **Related pages that reuse the exact same machinery:** `collabans` (collaborative / shared cross-community ban list — identical fragment, action set, and modal) and `admins` / `chat` / `clan_*` (which also embed the same player modal with `ban`/`unban`/`checkBans`). This section documents `bans`; where behavior is shared it is called out.

The page is a two-column layout: a fixed left **filter sidebar** (`col-md-3`, `position:fixed`) and a right **results table** (`col-md-9`).

---

### Live API Contracts

> Ground truth captured 2026-07-04 from `breaking.sqstat.ru` with a read-only headless browser. Source: `caps/bans/bans.network.json`. Mutations were network-intercepted and aborted (`caps/bans/_blocked.json` = `[]`), so ban/unban/addBanName request shapes below are reconstructed from the inline modal JS in `caps/bans/bans.content.html` / `collabans.content.html`, not from a fired write.

#### C-1. Page fragment load

| Attribute | Value |
|---|---|
| Method + path | `GET /ajax/page.php?page=bans` |
| Response | `text/html; charset=UTF-8`, ~114 KB HTML fragment injected into `#content` |
| Body | filter sidebar + `#banPlayers` table shell + full shared player-detail modal markup + inline `<script>` |

#### C-2. Ban list read — `POST /ajax/table.php` (action `banPlayers`)

This is the sole data read of the page (fired once on load by `buildTable`).

**Request (form-urlencoded):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string const `banPlayers` | Y | Server table id / router key. |
| `table` | string const `banPlayers` | Y | Duplicated table id. |
| `page` | int (1-based) | Y | Page number. |
| `numrows` | int, `100` | Y | Page size. |
| `search` | URL-encoded JSON | Y | Filter object (5 buckets, see below). |
| `order_by` | string \| `false` | Y | Sort column key (one of the `collum` set) or literal `false` = default order. |
| `order_sort` | `asc` \| `desc` \| `false` | Y | Sort direction or `false`. |
| `pagination` | `true` | N | When appended, returns only the count envelope (§C-3) instead of rows. |

`search` JSON shape (captured verbatim, default state): `{"text":{},"check":{"permanent":"false"},"multiselect":{},"managers":{},"slider":{}}`. Buckets: `text` = free-text inputs keyed by their `data-search` SQL alias; `check` = checkbox flags (`permanent` = `"true"`/`"false"` string); `multiselect`, `managers`, `slider` unused on this page.

**Response** `application/json`, `status:"ok"`:

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count (0 in the row-fetch call; real value comes from the `pagination=true` call). |
| `data.totalRows` | int | Row count (0 in row-fetch; real value from pagination call). |
| `data.currentPage` | string | Echo of requested page ("1"). |
| `data.row[]` | array of ban objects | The page of bans (see per-row shape). |
| `data.custom` | bool | Custom-render flag (observed `false`). |
| `data.query_time` | float (seconds) | Server SQL time for the row query. |
| `data.count_time` | int/float (seconds) | Server SQL time for the count query (0 when not counting). |
| `status` | string enum `"ok"` | Result status; anything else / `auth:true` forces a client reload. |
| `exec_time` | float (seconds) | Total server handler time. |

**Per-row object `data.row[i]` (LIVE-captured field set — this supersedes prior column inference):**

| Field | Type | Meaning |
|---|---|---|
| `id` | string (numeric) | Ban record PK (`t1.id`), used as `data-id` / `trID-<id>` on the row. |
| `steam_id` | string (Steam64) | Banned player identity; rendered hidden in `<hashtag>`, drives `player.open()`. |
| `name` | string | Player nick at ban time (may contain markup escaped by server). |
| `reason` | string | Reason text; **note it embeds the expiry as trailing `… до DD.MM.YYYY HH:MM`** in the same string. |
| `description` | string (may be empty `""`) | Free-text admin comment. |
| `admin_id` | string (Steam64) | **Issuing admin's SteamID** (raw id, NOT a resolved name — the modal resolves the name separately). |
| `date` | string (**unix seconds**) | When the ban was issued, e.g. `"1783085160"`. Client formats via `data-unix` badge. |
| `expire` | string (**pre-rendered HTML**) | Server returns a ready `<span class="badge …">DD.MM.YYYY HH:MM</span>` fragment, NOT a raw timestamp. Permanent bans render a distinct badge. Client injects it verbatim. |
| `unban` | string enum `"0"`/`"1"` | Boolean-as-string: `"1"` = ban was revoked (kept in history), `"0"` = active. |

Redacted example row:

```json
{ "id": "30900", "steam_id": "<steam64>", "date": "1783085160",
  "reason": "Спец кит   тех пех до 04.07.2026 16:26", "description": "",
  "admin_id": "<steam64>", "expire": "<span class=\"badge bg-primary\" style=\"…\">04.07.2026 16:26</span>",
  "unban": "0", "name": "<nick>" }
```

#### C-3. Lazy pagination count — `POST /ajax/table.php` … `&pagination=true`

A second, deferred call (same body + `&pagination=true`) returns only the count envelope so the pager can be drawn without blocking the row render:

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Number of pages at the current `numrows`. |
| `totalRows` | int \| string | Total matching rows. **Type is inconsistent across tables** — `ban_names` returns it as a string (`"371"`), `collabans` as an int (`17510`). Treat as numeric. |
| `count_time` | int/float (seconds) | SQL count time (logged to console). |
| `status` | `"ok"` | Status. |
| `exec_time` | float | Handler time. |

#### C-4. Ban mutation contracts (reconstructed from modal JS — never fired)

`Action({script, action, data})` → `POST /ajax/<script>.php` with body `action=<action>&<data>`. Success predicate: `text.status == 'ok'`; `text.auth === true` ⇒ session expired ⇒ full reload.

| Action | script → endpoint | Request data | Response (on success) | Destructive |
|---|---|---|---|---|
| `ban` | `squad` → `POST /ajax/squad.php` | query string: `server_id` (only when `player.info.online`), `steam_id`, `reason_id` (= `#player_ban-reason` select value), `description` (= textarea), `days` (= checked `player_ban-reason_type` radio value; `0` = permanent, `-1` = kick) | `{status:'ok'}`; client removes player from `#players` and refreshes active server | **Y** |
| `unban` | `squad` → `POST /ajax/squad.php` | JSON `{steam_id: string, unban: bool}` — `unban:true` (the `#unban-error` toggle) **fully erases** the ban; `false` lifts it but keeps history (`unban="1"`) | `{status:'ok'}`; modal flips + reloads player | **Y** |
| `addBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` (the current nick) | `{status:'ok'}`; reopens player | **Y** |
| `removeBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` | `{status:'ok'}`; reopens player | **Y** |
| `checkBans` | `player` → `POST /ajax/player.php` | JSON `{steam_id: string}` | `{status:'ok', projects:[…]}` (see §C-5) | N (read) |
| `changeExpire` | `clan` → `POST /ajax/clan.php` | ban-expiry edit (defined on `clan_16`, not on `bans`) — adjusts an existing ban's `expire` | `{status:'ok'}` | **Y** |
| `get` | `player` → `POST /ajax/player.php` | JSON `{steam_id}` (fired on row-click) | full `player.info` object | N (read) |

#### C-5. `checkBans` response — cross-project ban intelligence

Consumed by `player.checkbans()`; renders one card per federated community in `#player_findban-list`.

```
{ status:'ok',
  projects: [ {
    name:     string,           // community/project name
    discord?: string(url),      // optional Discord invite → icon link when present
    online:   int (seconds),    // player's total playtime on that project (secToTime)
    ban: {
      total:   int,             // punishment count → "Наказаний: N" (0/absent ⇒ "Нет наказаний")
      current: null | {         // presence flips icon red-ban vs green-check
        reason: string,
        date:   int (unix),     // ban start
        expire: int (unix) | "0"  // "0" ⇒ "Перманент", else From/To range
      }
    }
  } ] }
```

#### DataTables config (client `buildTable`, from `bans.content.html`)

| Setting | Value |
|---|---|
| `table` (action id) | `banPlayers` |
| `collum` (column keys) | `["steam_id","name","reason","date","expire"]` |
| `order` (sortable keys) | `["steam_id","name","reason","date","expire"]` |
| `numrows` (page size) | `100` |
| `mode` | default (table) |
| `searchInput` | `["banPlayers-name","banPlayers-admin","banPlayers-startdate","banPlayers-enddate","banPlayers-permanent","banPlayers-reason","banPlayers-description"]` |
| default sort | `order_by=false`, `order_sort=false` (server default) |
| row click | `player.open( td[data-contact=steam_id] > hashtag .text() )` |

---

### 2. Entities & Fields

#### 2.1 Ban (the row entity — table `banPlayers`, server-side view over `t1`)

Field set is now confirmed against the live `banPlayers` response (§C-2); the `Origin / alias` column maps each response field to its filter `data-search` SQL alias.

| Field | Response key / filter alias | Type | Meaning |
|---|---|---|---|
| `id` | `row.id` | string (numeric) | Ban record PK (`t1.id`); becomes `data-id`/`trID-<id>`. |
| `steam_id` | `row.steam_id` / filter `t2.player` | string (Steam64), rendered in `<hashtag>` | Banned player identity. Column CSS-hidden (`class="hide"` + `td:first-child{display:none}`) but drives row-click. NB other panels migrated identity to a UUID; here it is still the SteamID. |
| `name` | `row.name` / filter `t2.player` | string | Player nick at ban time. |
| `reason` | `row.reason` / filter `t1.reason` | string | Reason text; **embeds the expiry as trailing `… до DD.MM.YYYY HH:MM`**. |
| `date` | `row.date` | string (**unix seconds**) | When issued ("Забанен"); e.g. `"1783085160"`. |
| `expire` | `row.expire` (column "До") | string (**pre-rendered HTML badge**) | Server returns a ready `<span class="badge …">` — not a raw timestamp. Empty/permanent renders a distinct badge. |
| `unban` | `row.unban` | string `"0"`/`"1"` | `"1"` = ban revoked (kept in history), `"0"` = active. |
| `description` | `row.description` / filter `t1.description` | string, may be `""` (≤512 chars) | Free-text admin comment; searchable + shown in modal. |
| `admin_id` | `row.admin_id` / filter `t3.player` | string (Steam64) | **Issuing admin's SteamID** (raw id in the row; name resolved separately in `#player_info_ban-admin`). |
| `impact` | `ban.impact` (modal only) | bool | Whether this ban counts toward *progressive* escalation ("Влияет на наказание"). |
| `permanent` | filter `permanent` (check bucket) | bool-as-string `"true"`/`"false"` | Filter-only flag (`expire == 0`). |

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

`buildTable` config: `numrows: 100`, `collum/order: ["steam_id","name","reason","date","expire"]`. Full contract in §C-2.

**Data request (competitively important):** `POST /ajax/table.php` with `action=banPlayers&table=banPlayers&page=<n>&numrows=100&search=<urlencoded-json>&order_by=<col|false>&order_sort=<asc|desc|false>`. The `search` JSON has 5 buckets `{text,check,multiselect,managers,slider}` (see §C-2). A **separate** call with `&pagination=true` returns `{totalPage,totalRows,count_time,status,exec_time}` so page count is computed lazily (server logs the SQL count time to the browser console).

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

### Live API Contracts

> Ground truth captured 2026-07-04 from `breaking.sqstat.ru` via read-only headless browser. Sources: `caps/bans/bannames.network.json`, `caps/bans/collabans.network.json`, and the inline JS in `caps/bans/bannames.content.html` / `caps/bans/collabans.content.html`. Zero mutations fired (`_blocked.json` = `[]`); `addBanName`/`removeBanName` shapes are reconstructed from the modal JS.

#### C-A. Fragment loads

| Page | Method + path | Response |
|---|---|---|
| bannames | `GET /ajax/page.php?page=bannames` | ~3.7 KB HTML: sidebar + `#ban_names` table + `#add_ban_names_modal`. Self-contained (no shared modal). |
| collabans | `GET /ajax/page.php?page=collabans` | ~115 KB HTML: sidebar + `#banPlayers` table shell + `#ban_template`/`#project_template` + full shared player modal + inline script. |

#### C-B. `ban_names` read — `POST /ajax/table.php` (action `ban_names`)

**Request** (form-urlencoded): `action=ban_names&table=ban_names&page=1&numrows=100&search=<urlencoded-json>&order_by=false&order_sort=false` [`&pagination=true` for the count call].
`search` default: `{"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}`; the nick filter feeds `text["t1.name"]`.

**Response** `application/json`, `status:"ok"`:

| Field | Type | Meaning |
|---|---|---|
| `data.row[i].name` | string | The banned nickname (the rule's identity key). |
| `data.row[i].date` | string (**unix seconds**) | When the rule was added (e.g. `"1775743360"`); client renders via `formatDate`. |
| `data.row[i].button` | int (`1`) | Render flag → server signals the per-row delete button should be drawn. |
| `data.totalPage` / `data.totalRows` | int | 0 in the row call. |
| `data.custom` | bool | `false`. |
| `data.query_time` / `data.count_time` | int/float (s) | Server timings. |
| `status` / `exec_time` | `"ok"` / float | Status + handler time. |

**Pagination call** (`&pagination=true`) — live sample: `{ "totalPage": 4, "totalRows": "371", "count_time": 0, "status": "ok", "exec_time": 0.002 }`. Note `totalRows` here is a **string** ("371"), unlike `collabans` which returns an int — do not assume a fixed type. Live catalog size ≈ **371 banned nicknames**.

The captured schema confirms the client-visible record is exactly `{name, date, button}` — **no severity, regex flag, scope, expiry, or author field is returned** (see Gaps).

#### C-C. `collabans` read — `POST /ajax/table.php` (action `collabans`)

**Request**: `action=collabans&table=collabans&page=1&numrows=100&search=<urlencoded-json>&order_by=false&order_sort=false` [`&pagination=true`].
`search` default: `{"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}`.

**Response** `application/json`, `status:"ok"` — the per-row shape is **flatter than previously inferred**: a row carries only `name`, `steam_id`, and a nested `projects[]` array. There are **no top-level `reason`/`date`/`expire` fields**; the "Причина / Забанен / До" columns are rendered by the `projects` callback into per-community cards.

| Field | Type | Meaning |
|---|---|---|
| `data.row[i].name` | string | Player nickname; callback renders `<b>name</b>` or `<code>Нет ника</code>` when empty. |
| `data.row[i].steam_id` | string (Steam64) | Player identity (hidden first column); row-click → `player.open(steam_id)`. |
| `data.row[i].projects[]` | array<Project> | Per-community ban breakdown (see below). |
| `data.totalPage`/`totalRows`/`custom`/`query_time`/`count_time` | int/bool/float | Envelope. |

**Project object `projects[j]`:**

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Contributing community/project name. |
| `admin_name` | string | Admin who issued that project's ban (rendered in `<code>`). |
| `reason` | string | That project's stated reason (e.g. `"[Навсегда] нежелательный"`). |
| `date` | string (**unix seconds**) | That project's ban date. |
| `expire` | string (unix seconds) \| `"0"` | `"0"` ⇒ red `label-danger`/`panel-danger` + "Перманент"; else `label-warning`/`panel-warning` + "Временный". |
| `cnt` | string (numeric) | Number of ban records that project logged (rendered with a gavel icon). |

Redacted example row:

```json
{ "name": "<nick>", "steam_id": "<steam64>",
  "projects": [ { "name": "<community>", "date": "1783149951",
    "reason": "[Навсегда] нежелательный", "admin_name": "<admin>",
    "expire": "0", "cnt": "1" } ] }
```

**Pagination call** — live sample: `{ "totalPage": 176, "totalRows": 17510, "count_time": 0.37, "status": "ok", "exec_time": 0.37 }`. Live federated pool size ≈ **17,510 banned players** across contributing communities. Here `totalRows` is an **int** (contrast `ban_names`).

#### C-D. Mutation & network contracts (reconstructed — never fired)

| Action | script → endpoint | Request data | Effect | Destructive |
|---|---|---|---|---|
| `addBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` (from `#add_ban_names_name` on bannames, or `player.info.name` from a context menu) | Inserts a banned-nick rule; on `status:'ok'` hides modal + `buildTable('rebuild')`. | **Y** |
| `removeBanName` | `player` → `POST /ajax/player.php` | JSON `{name: string}` (read from the row's `[data-contact="name"]` HTML) | Deletes the rule matching that nick; rebuilds table. | **Y** |
| `checkBans` | `player` → `POST /ajax/player.php` | JSON `{steam_id: string}` | Returns `{projects:[…]}` cross-project ban status (schema in chapter 09 §C-5). | N (read) |
| `ban` / `unban` | `squad` → `POST /ajax/squad.php` | see chapter 09 §C-4 | New bans enter the federated pool via the normal `ban` action; federation is server-side. | **Y** |
| `botUpdate` | `squad` → `POST /ajax/squad.php` | (none) | On `main.html`, triggers the enforcement bot to update (the agent that syncs bans/bannames in-game). Confirmation dialog first. | **Y** |
| `downloadList` | `clan` → `POST /ajax/clan.php` (form-post → file download) | `clan_id` | On `clan_16.html`, exports a roster file. Not a ban-sync trigger. | N |

**Ru-Ban sync finding:** no client action pushes/imports federated bans from these two pages. `collabans` + `checkBans` are **read** views over a server-aggregated pool; `botUpdate` refreshes the enforcement agent. Propagation between communities (push API / polling / shared DB) is server/bot-side and not observable client-side. The `network` action in `main.html` is the live TCP/DOS monitor — unrelated to the ban network; do not conflate.

#### DataTables configs (from captured content JS)

| | `ban_names` (bannames) | `banPlayers`/`collabans` (collabans) |
|---|---|---|
| `table` (action id) | `ban_names` | `collabans` |
| `collum` | `["name","date",["button", "<button onclick=remove_ban_names(this)…>"]]` | `["steam_id","reason","date","expire"]` |
| `mode` | `table` | `list` |
| `numrows` | `100` | `100` |
| `template` | `#player_template > div` | `#ban_template > div` (cards from `#project_template`) |
| `searchInput` | `["ban_names-name"]` (→ `t1.name`) | `["banPlayers-name","banPlayers-permanent","banPlayers-reason"]` |
| callbacks | `date` → `formatDate` | `name` (empty→"Нет ника"), `date` → `formatDate`, `projects` → clone `#project_template` per project |
| row click | — (delete button per row) | `player.open(td[data-contact=steam_id]>hashtag .text())` |

Filter aliases on the collabans sidebar: `#banPlayers-name` → `s.player`, `#banPlayers-reason` → `s.reason`, `#banPlayers-permanent` (check bucket). Add-nick modal on bannames: single `#add_ban_names_name` input (placeholder "Ник"), **no client-side validation** — an empty submit sends `name=''`.

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

**Entity A — federated ban row (`collabans` table).** LIVE-captured shape (§C-C) — the row is **flat**: only `name`, `steam_id`, `projects[]`. The `reason`/`date`/`expire` in the `buildTable` `collum` config are **column slots populated by the `projects` callback cards**, not top-level row fields.

| Field | Type | Meaning |
|---|---|---|
| `steam_id` | string (Steam64) | Player identity; the hidden first column. Row click → `player.open(steam_id)`. |
| `name` | string | Player nickname; callback renders `<b>name</b>` or `<code>Нет ника</code>` ("No nick") when empty. |
| `projects` | array<Project> | Per-community ban breakdown (see Entity B), rendered as cards into the reason/date/expire column area. |

> Correction vs. earlier inference: there are **no** scalar `reason`/`date`/`expire` fields on the collabans row. Every ban attribute is per-project inside `projects[]`.

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

> **Ground truth:** live contracts captured 2026-07-04 via headless browser (read-only; 0 mutations blocked). Sources: `caps/games-stats/statistics.network.json` (2 AJAX contracts), `caps/games-stats/statistics.content.html` (live-rendered `#content`, 20 chart canvases).

### 1. Purpose and Nav Location

- **Nav item:** `statistics` — `pageLoad('statistics')` → `GET /ajax/page.php?page=statistics` (`text/html`, ~41 KB fragment), injected into `#content`.
- **Purpose:** a single-page, all-graphical analytics dashboard rendering **20 Chart.js canvases** covering server population (online/max/queue), staff coverage (admins/maxAdmins), moderation volume (bans), match throughput (games/modes/maps), social volume (chat/teamkill), player growth (new), and per-server combat aggregates (kills/death/revival/damage/wound). It is **read-only** — no table, no row actions, no export button. All data comes from **one** RPC (`action=statistics`, `POST /ajax/squad.php`) driven by two controls: a date-range picker and a multi-server selector.
- Unlike the DataTables list pages, this page carries **no** `downloadStat` export and no player-detail modal wiring — a pure visualization surface.

---

### Live API Contracts

Two contracts fire on load. Observation-only; `_blocked.json` = `[]`.

#### C1 — Page fragment

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=statistics` |
| **Request params** | `page` — string — required — `statistics` |
| **Response** | `text/html; charset=UTF-8`, ~41 KB — the `#stat_wrapper` markup: date button, server multiselect, spinner overlay, and 20 `<canvas>` cards. |
| **Capture** | `statistics.network.json` [0] |

#### C2 — Aggregated statistics RPC (the whole dashboard)

**`POST /ajax/squad.php`** — `application/json; charset=utf-8`. Capture: `statistics.network.json` [1].

Request body (form-urlencoded; note the leading `&`):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `start` | int (unix s) | Y | Range start (live: `1780560007`). From `#stat_date` `data-start`. |
| `end` | int (unix s) | Y | Range end (live: `1783152007`). From `data-end`. |
| `servers` | CSV of ints | Y | **Comma-joined** server ids, e.g. `1,6,7,9,10,11` — *not* a JSON/PHP array. |
| `action` | string | Y | Always `statistics` (server-side handler selector on `squad.php`). |

Full observed body: `&start=1780560007&end=1783152007&servers=1,6,7,9,10,11&action=statistics`

**Response shape.** One JSON object. Values are either flat time-series `{label: value}`, **nested per-server** `{serverId: {label: value}}`, or shared axis-label arrays. Numeric values are frequently returned **as strings** (`"37"`) — clients must coerce. Top-level keys:

| Key | Shape | Value type | Feeds chart | Meaning |
|---|---|---|---|---|
| `test` | object | float per section | — | **Server-side profiling** timings (s) for sub-queries: `online, maps, players, chat, bans, teamkill, onlineHour, onlineDay`. Diagnostic, not charted. |
| `days` | array[N] | `"DD.MM.YYYY"` | X labels | Day buckets across the range (live N=31). |
| `hours` | array[24] | `"HH:00"` | X labels | Hour-of-day buckets `00:00`…`23:00`. |
| `dayofweek` | array[7] | RU weekday | X labels | `Понедельник`…`Воскресенье` (Mon…Sun). |
| `online` | `{sid:{day:val}}` | string(int) | `chartOnline` | Avg online per server/day (business-hours window). |
| `max` | `{sid:{day:val}}` | string(int) | `chartOnlineMax` | Peak players incl. queue, per server/day. |
| `queue` | `{sid:{day:val}}` | string(int) | `chartQueue` | Avg queue length per server/day. |
| `admins` | `{day:val}` | int | `chartAdmins` | Avg admins online per day (single series). |
| `maxAdmins` | `{day:val}` | int | `chartAdminsMax` | Peak admins online per day (single series). |
| `bans` | `{day:val}` | string(int) | `chartBans` | Punishments issued per day (single series). |
| `onlineHour` | `{sid:{HH:00:val}}` | string(int) | `chartOnlineHour` | Avg online by hour, per server. |
| `onlineDay` | `{sid:{weekday:val}}` | string(int) | `chartOnlineDay` | Avg online by weekday, per server. |
| `games` | `{sid:{day:val}}` | string(int) | `chartGames` | Matches per server/day. |
| `modes` | `{mode:count}` | int | `chartModes` | Match count per mode: `AAS, Invasion, RAAS, Seed, Skirmish`. |
| `maps` | `{mapName:count}` | int **or** string(int) | `chartMaps` | Match count per map (**inconsistent typing** — some values int, some string; excludes Skirmish/Seed). |
| `new` | `{day:val}` | int | `chartNew` | New/first-seen players per day. |
| `chat` | `{sid:{day:val}}` | string(int) | `chartChat` | Chat messages per server/day. |
| `teamkill` | `{sid:{day:val}}` | string(int) | `chartTeamkill` | Teamkills per server/day. |
| `kills` | `{sid:{day:val}}` | string(int) | `chartKills` | Kills per server/day. |
| `death` | `{sid:{day:val}}` | string(int) | `chartDeaths` | Deaths per server/day. |
| `revival` | `{sid:{day:val}}` | string(int) | `chartRevivals` | Revives per server/day. |
| `damage` | `{sid:{day:val}}` | string(int) | `chartDamage`* | Damage dealt per server/day. |
| `wound` | `{sid:{day:val}}` | string(int) | `chartWounds` | Wounds (downs) per server/day. |
| `unique` | array | (empty `[]`) | `chartUnique` | Unique players — **returned empty** in this deployment. |
| `kits` | array | (empty `[]`) | `chartKits` | Kit counts — **returned empty** in this deployment. |
| `status` | string enum | `"ok"` | — | Result status. |
| `exec_time` | float | — | — | Total RPC wall-time (live: `1.507` s). |

\* A `chartDamage` series maps to the `damage` key; the fragment ships a `chartWounds` and a `chartDeaths` etc. — see §7 for the canvas-to-key map.

Per-server sub-keys are the server ids `1,6,7,9,10,11`. Redacted samples:
```
test    = {"online":0.538,"maps":0.005,"players":0.062,"chat":0.044,"bans":0.004,"teamkill":0.082,"onlineHour":0.355,"onlineDay":0.393}
modes   = {"AAS":168,"Invasion":57,"RAAS":171,"Seed":68,"Skirmish":60}
maps    = {"Narva":65,"Mutaha":50,"Fallujah":43,"Gorodok":40,...,"Sanxian Islands":"3","Kohat Toi":"2"}
online.1= {"04.06.2026":"37","05.06.2026":"1","06.06.2026":"47", ...}
admins  = {"04.06.2026":5,"05.06.2026":5,"06.06.2026":7, ...}
bans    = {"04.06.2026":"16","05.06.2026":"69","06.06.2026":"7", ...}
new     = {"04.06.2026":174,"05.06.2026":254,"06.06.2026":170, ...}
```

**Live-capture correction to prior notes:** the `chartKits` and `chartUnique` canvases are **present and rendered** in the live `#content` (not commented out) — they simply receive empty `kits`/`unique` arrays, so they draw blank. All 20 canvases exist in the DOM (§7).

---

### 2. Entities & Fields (client-side model)

#### 2.1 Server (`servers` map, inlined in fragment `<script>`)

Drives dataset creation, per-server coloring, and legend labels. Anonymized example:
```json
"1": { "id":"1","ip":"80.242.59.123","port":"0","pass":"","name":"RAAS/AAS #1",
       "short":"A","ext_short":"","mods":false,"types":false,
       "licensed":"1","sort":"1","chan_id":"","disabled":"0" }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | PK; used as dataset id, `colors[id]` index, and response-map key. |
| `ip` / `port` / `pass` | string | Connection info (all six share one host here; pass empty in fragment). |
| `name` | string | Full display name (e.g. `БЕЗ ГОЛОСОВАНИЯ #2`). |
| `short` | string(1) | Legend/axis short code (A, B, C, E, F, G). |
| `ext_short` | string | Extended short (empty). |
| `mods` / `types` | bool | Mods / layer-type restriction flags. |
| `licensed` | string(int) | 1 = licensed. |
| `sort` | string(int) | Display order. |
| `chan_id` | string | Discord channel id (empty). |
| `disabled` | string(int) | 0 = active. |

Server ids are non-contiguous (1, 6, 7, 9, 10, 11 → 2–5, 8 retired/soft-deleted).

#### 2.2 Statistics payload — see the C2 response table (authoritative).

---

### 3. The Page's OWN Table

**None.** Zero DataTables, zero HTML `<table>`. Entirely `<canvas>`-based Chart.js output inside Bootstrap `block-box` cards. No per-row sort/search/pagination. The only filters are the global date range and server multiselect (§5).

---

### 4. Actions / Admin Capabilities

Exactly **one** action, a pure read.

| UI trigger | action | Endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Auto-run on load; on date-range change; on server-select dropdown close (`getStatistic()`) | `statistics` | `POST /ajax/squad.php` | `start` (unix), `end` (unix), `servers` (CSV of ids), `action=statistics` | Returns the aggregated JSON (§ C2); client redraws all charts inside a single `Promise.all`. | **N** |

There is **no** `downloadStat`/CSV/Excel export on this dashboard, unlike nearly every list page (admins, bans, chat, kills, players all carry `downloadStat`). Server statistics are visualized only, not exportable here — a competitive gap.

---

### 5. Forms & Controls

No `<form>`; two standalone controls at the top of `#stat_wrapper`.

**5.1 Date range — `#stat_date`** (`<button type="daterange">`, live label "30 дней")
- `.dateRange({...})` plugin. Presets: `justMonth, justDay, justWeek, justYear, range (custom), today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days`.
- **Default:** `last30days` (live `start=1780560007`, `end=1783152007` ≈ 30-day span). Emits `crm_dateRange` → `getStatistic()`; exposes `data-start`/`data-end`.

**5.2 Server multiselect — `#stat-server`** (`<select multiple type="multiselect">` → Bootstrap `multiselect`)
- Six options = the configured servers (`value`=id, `label`=name). **All selected by default** (live button text "Все выбраны (6)" = All selected (6); each `<li class="active">`).
- Placeholder when empty: `- Сервер -`. `enableHTML: true`.
- **Debounced to dropdown close:** an `onChange` flag is set; `getStatistic()` fires in `onDropdownHide` only if something changed — avoids one RPC per checkbox toggle.

**Loading state:** during a fetch, the date button and multiselect are disabled (`.multiselect('disable')`), `#stat_wrapper` gets class `load`, and the `.load_block` spinner overlay (`fa-spinner fa-pulse`, positioned `top:0;left:5px`) shows. Controls re-enable on completion; charts redraw together via `Promise.all`.

---

### 6. Permission / Visibility Logic

- No `class="hide"`, role checks, or group gating inside the fragment. Access is enforced upstream: whether the `statistics` nav item renders and whether `squad.php action=statistics` authorizes the caller.
- The inlined `servers` map is pre-filtered server-side to servers the operator may view; the client iterates it directly.
- `chartKits`/`chartUnique` are gated by **empty data**, not a permission class — they render blank.

---

### 7. Chart Inventory (20 live canvases) & Competitive Details

All 20 `<canvas id="chart…">` confirmed present in `statistics.content.html`. Grid width from the wrapping `col-md-*`; series model per §1 key shape.

| # | Canvas id | Type | Title (RU → EN) | col width | Feeds key | Series |
|---|---|---|---|---|---|---|
| 1 | `chartOnline` | bar (stacked) | Средний онлайн → Avg online (10:00–03:00) | 6 | `online` | per-server |
| 2 | `chartOnlineMax` | bar (stacked) | Максимально игроков (с очередью) → Peak players incl. queue | 6 | `max` | per-server |
| 3 | `chartAdmins` | line | Среднее кол-во админов → Avg admins | 4 | `admins` | single |
| 4 | `chartAdminsMax` | bar | Максимально админов → Peak admins | 4 | `maxAdmins` | single |
| 5 | `chartBans` | bar | Выдано наказаний → Punishments issued | 4 | `bans` | single |
| 6 | `chartOnlineHour` | bar (stacked) | Средний онлайн по часам → Avg online by hour | 6 | `onlineHour` | per-server |
| 7 | `chartOnlineDay` | bar (stacked) | Средний онлайн по дням недели → Avg online by weekday | 6 | `onlineDay` | per-server |
| 8 | `chartMaps` | bar | Количество карт (не Skirmish/Seed) → Map counts | 8 | `maps` | single |
| 9 | `chartModes` | doughnut | Game-mode distribution | 4 | `modes` | single |
| 10 | `chartNew` | bar | Новых игроков → New players | 7 | `new` | single |
| 11 | `chartChat` | bar (stacked) | Сообщений чата → Chat messages | 5 | `chat` | per-server |
| 12 | `chartTeamkill` | bar (stacked) | Тимкиллы → Teamkills | 6 | `teamkill` | per-server |
| 13 | `chartQueue` | bar (stacked) | Очередь → Queue | 6 | `queue` | per-server |
| 14 | `chartGames` | bar (stacked) | Игр → Matches | 6 | `games` | per-server |
| 15 | `chartKills` | bar (stacked) | Убийств → Kills | 6 | `kills` | per-server |
| 16 | `chartDeaths` | bar (stacked) | Смертей → Deaths | 4 | `death` | per-server |
| 17 | `chartRevivals` | bar (stacked) | Поднятий → Revives | 4 | `revival` | per-server |
| 18 | `chartWounds` | bar (stacked) | Ранений → Wounds | 4 | `wound` | per-server |
| 19 | `chartKits` | horizontalBar | Количество китов → Kit count | — | `kits` (empty) | single — draws blank |
| 20 | `chartUnique` | bar | Уникальных игроков → Unique players | — | `unique` (empty) | single — draws blank |

A `damage` series is also returned; where charted it maps to a damage canvas alongside the combat set.

Competitively interesting details:

- **Subtitle stat strip:** each time-series chart shows `Среднее: <avg>, Максимум: <max>, Всего: <total>` (Avg/Max/Total), computed client-side via `.average()`/`.max()`/`.sum()`/`.sum2d()` (stacking per-server into per-day totals). Totals use `Intl.NumberFormat("en-US")`. At-a-glance KPIs without a separate panel.
- **Business-hours windowing:** several titles hard-code **10:00–03:00** (the servers' active hours) so "average online" excludes dead night hours. Methodology choice to replicate.
- **Map chart excludes Skirmish & Seed** from "real match" counts (separating warmup/seeding from competitive rounds).
- **Consistent per-server coloring** via a fixed `colors[]` palette indexed by server id — same server, same color across all charts.
- **Coordinated redraw** inside one `Promise.all` — atomic refresh.
- **Debounced multi-server filter** (fires on dropdown close) minimizes RPC chatter.
- **`test` profiling block** ships per-sub-query timings to the client — internal instrumentation exposed in the response (info-leak worth noting; also a hint the backend runs ~8 separate aggregate queries).
- **Gaps vs. a competitor build:** no export/download; no drill-down from chart to underlying rows; `unique`/`kits` shipped but returning empty (dead metrics); playtime-hours not charted directly; numeric values inconsistently typed (int vs string, e.g. `maps`) forcing client coercion; single heavy ~1.5 s RPC returns the entire dashboard (no incremental/streamed load). Low-hanging features to differentiate on.

---

### Gaps / Unknowns

- **`getStatistic()` source** is inlined in the `statistics.html` fragment `<script>`, not in `custom.js` — exact per-chart option objects (axis config, colors) are inferred from canvas ids + response keys, not read line-by-line here.
- **`unique`/`kits` real schema** cannot be documented — both returned empty in this deployment; their populated shape is unobserved.
- **`damage` chart canvas id** is inferred from the combat-series grouping; the exact canvas element for the `damage` key was not isolated among the 20 (the combat block renders kills/death/revival/wound/damage together).
- **Backend query structure** behind each aggregate is inferred from the `test` profiling keys, not from `squad.php` source.


---

## 12. Match History (Игры)

> **Ground truth:** live contracts captured 2026-07-04 via headless browser (read-only; 0 mutations blocked). Sources: `caps/games-stats/games.network.json` (3 AJAX contracts), `caps/games-stats/games.content.html` (live-rendered `#content`).

### 1. Purpose & Navigation

The **Игры** (Games / Match History) page is a searchable, server-side-paginated log of every match (round) played across all monitored Squad servers. It answers "which layer was played, on which server, when, and who won by how many tickets." Each row is a completed (or in-progress) round; clicking a row performs a full-page navigation to the per-match detail view.

- **Nav id / entry point:** `pageLoad('games')` → `GET /ajax/page.php?page=games` (`ctype text/html`, ~4 KB fragment), injected into `#content`.
- **Layout (from live HTML):** a fixed left filter sidebar (`div.col-md-3.mobile-left` → `block-box` with `style="position:fixed"`) plus a wide results panel (`col-md-9`) holding `table#games.table.table-hover` with `thead.table-dark`.
- **Data source:** the table is populated client-side via the shared `buildTable()` helper (`custom.js:605`), which issues a server-side-paginated `POST /ajax/table.php`. There is **no** `<form>` POST and **no** page-specific `Action()` mutation on this page — it is a **read-only reporting screen**.

---

### Live API Contracts

Three contracts fire on load. All observation-only; the interceptor blocked 0 mutations.

#### C1 — Page fragment

| | |
|---|---|
| **Method / path** | `GET /ajax/page.php?page=games` |
| **Request params** | `page` — string — required — fragment key (`games`) |
| **Response** | `text/html; charset=UTF-8`, ~4089 bytes — the `#content` inner HTML (sidebar filters + empty `#games` table shell) |
| **Capture** | `games.network.json` [0] |

#### C2 — Match rows (primary data fetch)

**`POST /ajax/table.php`** — `application/json`. Capture: `games.network.json` [1].

Request body (form-urlencoded; `search` is URL-encoded JSON):

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | Y | Always `games` (server-side handler selector). |
| `table` | string | Y | Always `games` (DataTables table id). |
| `page` | int | Y | 1-based page number. |
| `numrows` | int | Y | Page size — fixed `100`. |
| `search` | JSON (url-enc) | Y | Filter object, shape `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` (see §4). |
| `order_by` | string\|`false` | Y | Sort column DB-alias, or literal `false` when unsorted (observed: `false`). |
| `order_sort` | string\|`false` | Y | `asc`/`desc`, or `false` (observed: `false`). |

Decoded `search` observed on auto-load:
```json
{"text":{"t1.start.startdate":0,"t1.start.enddate":0},"check":{},"multiselect":{},"managers":{},"slider":{}}
```

Response envelope (`response_schema`):

| Field | Type | Meaning |
|---|---|---|
| `data.totalPage` | int | Page count — **0 on the row fetch** (count is deferred to C3). |
| `data.totalRows` | int | **0 on the row fetch** (deferred to C3). |
| `data.currentPage` | string(int) | Echoes requested page (`"1"`). |
| `data.row` | array[≤`numrows`] of Game | The match rows (schema below). |
| `data.custom` | bool | Whether a custom/saved filter is active (observed `false`). |
| `data.query_time` | int | Server row-query time (ms; `0` when cached). |
| `data.count_time` | int | Row-count time (ms; `0` here — count runs in C3). |
| `status` | string enum | `"ok"` on success. |
| `exec_time` | float | Total handler wall-time (s). |

`data.row[]` element — the **Game** entity (live sample, redacted):
```json
{ "id":"33295", "server_id":"1", "start":"1783114006", "end":"1783115978",
  "map":"Harju RAAS v1", "t1":"AFU", "t1_tickets":"0", "t2":"PLANMC",
  "t2_tickets":"366", "win":"t2", "is_seed":"0", "server":"A", "time":1972 }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string(int) | Match primary key. Carried on `tr[data-id]`; row click → `/game/<id>`. |
| `server_id` | string(int) | Numeric FK of the host server (`1,6,7,9,10,11`). Filter alias `server_id`. |
| `server` | string(1) | Server short letter (`A`,`B`,…). Rendered as `<code>[A]</code>` in column 1. |
| `start` | string(unix) | Round start, **unix seconds** as string. Date-range filter key `t1.start`. |
| `end` | string(unix) | Round end, **unix seconds** as string. Blank/`0` for ongoing rounds. |
| `map` | string | Layer name incl. mode+version, e.g. `Harju RAAS v1`, `Fallujah AAS v1`. Free-text filter alias `t1.map`. |
| `t1` | string | Team-1 faction tag/name (`AFU`, `IMF`, or full name like `58th Motorized Brigade`). |
| `t1_tickets` | string(int) | Team-1 remaining tickets at round end. |
| `t2` | string | Team-2 faction tag/name. |
| `t2_tickets` | string(int) | Team-2 remaining tickets. |
| `win` | enum `"t1"`\|`"t2"`\|`""` | Winning team; empty/falsy = draw or unfinished. |
| `is_seed` | string bool (`"0"`/`"1"`) | Whether the round was a seeding match. Present in payload but **not** rendered as a column. |
| `time` | int | Round duration in **seconds** (note: the only numeric-typed field; all others are strings). |

#### C3 — Deferred pagination / total count

**`POST /ajax/table.php`** — identical body to C2 **plus** `&pagination=true`. Capture: `games.network.json` [2].

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Total pages for the current filter (live: `286`). |
| `totalRows` | string(int) | Total matching rows (live: `"28571"`). |
| `count_time` | float | Count-query time in seconds (live: `0.02`). |
| `status` | string enum | `"ok"`. |
| `exec_time` | float | Handler wall-time (s). |

**Two-phase pattern:** C2 returns rows fast with `totalPage/totalRows = 0`; C3 (`pagination=true`) fires separately to compute the (expensive) `COUNT(*)` and fill the pager. This keeps first paint fast on the ~28.5 K-row table. Worth replicating at scale.

---

### 2. Entities & Fields

#### 2.1 Entity: `Game` — see the C2 `data.row[]` schema above (authoritative). Display-cell coupling:

- **Column 1 (server):** `<td data-contact="server"><code>[<server>]</code></td>` — uses the letter `server`, not `server_id`.
- **`t1` cell:** `<span class="label label-{success|danger}">{t1_tickets}</span> {t1}` — green (`label-success`) if this team won, red (`label-danger`) otherwise.
- **`t2` cell:** mirror image keyed on `win=='t2'`.
- **`start`/`end` cells:** `<span class="badge bg-success" data-unix="1783114006">Вчера 23:26:46</span>` — the epoch is preserved in `data-unix`; the visible text is a humanized relative/absolute local time ("Вчера" = Yesterday).
- **`time` cell:** `<code class="dark">32м 52c </code>` (`secToTime` → `<m>м <s>c`).
- **`win` cell (trophy col):** `<span class="label label-success">t2</span>` for the winner; neutral `—`/`fa-minus` when `win` is falsy.

#### 2.2 Entity: `Server` (filter option source)

Live `#games-server` multiselect options (`value` = `server_id`, `label` = name):

| server_id | Label (name) | Gloss |
|---|---|---|
| 1 | RAAS/AAS #1 | main rotation |
| 6 | БЕЗ ГОЛОСОВАНИЯ #2 | No Voting #2 |
| 7 | INVASION #3 | Invasion mode |
| 9 | Custom для FW | Custom for FW |
| 10 | Custom для MDC | Custom for MDC |
| 11 | Custom для BSS | Custom for BSS |

Server ids are sparse/non-contiguous (1, 6, 7, 9, 10, 11 — 2–5, 8 missing), implying retired/soft-deleted servers. Competitive artifact: reveals the rival's live fleet and modes.

#### 2.3 Entity: `Match Detail` (per-match player performance) — NOT in this fragment

Row click is a **full browser navigation**, not an AJAX `pageLoad`:
```js
$('#games tbody > tr').on('click', function(){ window.location.href = '/game/' + this.dataset.id; });
```
The per-match detail view (per-player K/D/score, rosters, ticket timeline) is a **separately routed, server-rendered page** at `/game/<id>` and is **not** in the captured fragment. Its schema cannot be documented from these files — see Gaps.

---

### 3. The Page's Own Table (`#games`)

Configured by a single `buildTable()` call (`custom.js:605` generic helper):

```js
$('#games').buildTable({
    table: 'games',
    collum: ["server","map","start","end","t1","t2","time","win"],
    numrows: 100,
    searchInput: ["games-map","games-date","games-server"],
    mode: 'table'
});
```

**Server table id (`action=`/`table=`):** `games`. **Page size (`numrows`):** `100`.

**Displayed columns** (live `<thead class="table-dark">`, in order):

| # | Header (RU → EN) | `<th>` width | Icon | Column key / `data-contact` | Render |
|---|---|---|---|---|---|
| 1 | (server) | 30px, center | `fa-server` | `server` | `<code>[A]</code>` |
| 2 | Карта (Map) | auto, center | — | `map` | raw layer string |
| 3 | Начало (Start) | 130px, center | — | `start` | `badge` w/ `data-unix`, humanized time |
| 4 | Конец (End) | 130px, center | — | `end` | same; blank if ongoing |
| 5 | Команда 1 (Team 1) | auto, center | — | `t1` | ticket badge + name |
| 6 | Команда 2 (Team 2) | auto, center | — | `t2` | ticket badge + name |
| 7 | (duration) | 100px, center | `fa-regular fa-clock` | `time` | `<code class="dark">` `secToTime` |
| 8 | (winner) | 40px, center | `fa-solid fa-trophy` | `win` | winner badge / `—` |

**Sorting (`order`):** the config passes **no `order` option** → header-click sorting is disabled; `order_by`/`order_sort` go out as literal `false` (confirmed in C2 body). **Default sort:** server-implicit, newest-first by `start` (live rows descend `id 33295 → 33294 → …`). Gap to beat: make columns sortable.

**Pagination:** server-side, 100/page. The pager (`#games-infoblock`) reads `Страница X из Y · Всего: N` from C3; `showPages` = 9 desktop / 3 mobile.

**Row interaction:** whole-row click → `/game/<id>`. No inline actions, checkboxes, or bulk ops.

---

### 4. Actions & Admin Capabilities

**No state-changing actions.** The only backend calls are the read fetches (C2/C3). Confirmed: `_blocked.json` = `[]` (0 mutations).

| UI element | action / table | Endpoint | Key params | Effect | Destructive? |
|---|---|---|---|---|---|
| Table load / **Поиск** `#games-btn` | `games` | `POST /ajax/table.php` | `action=games&table=games&page=<n>&numrows=100&search=<JSON>&order_by=false&order_sort=false` | Returns paginated match rows (C2) | **N** |
| Pagination click | `games` | `POST /ajax/table.php` | same + `&pagination=true` | Returns `totalPage`/`totalRows` (C3) | **N** |

**`search` payload contract** — URL-encoded JSON `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}`. For this page:

| Bucket | Key | Meaning |
|---|---|---|
| `text` | `t1.map` | Map/layer substring. |
| `text` | `t1.start.startdate` | Range start (unix; `0` = unbounded). |
| `text` | `t1.start.enddate` | Range end (unix; `0` = unbounded). |
| `multiselect` | `server_id` | Array of selected server ids. |

The `t1.` / `server_id` prefixes are raw SQL-ish table aliases leaking to the client — the backend likely builds `WHERE` clauses from these `data-search` keys directly (injection surface to probe; a convention to mirror with opaque keys + parameterized queries).

---

### 5. Forms, Filters & Controls (live sidebar)

No `<form>`; loose inputs wired into `buildTable` via `searchInput: ["games-map","games-date","games-server"]`. Enter in the text field, a date-range change, or clicking **Поиск** rebuilds the table (`page:1, isSearch:true`).

| Control | `#id` | Type | `data-search` | maxlength / options | Default | Behavior |
|---|---|---|---|---|---|---|
| Поиск (Search) | `games-btn` | button | — | — | — | Filtered rebuild; "Ищем" load state. |
| Карта (Map) | `games-map` | text (`fa-map` addon), placeholder "Карта" | `t1.map` | none | empty | Substring match; submits on Enter. |
| Server | `games-server` | Bootstrap multiselect (`type=multiselect multiple`) | `server_id` | 6 fixed options (§2.2), `enableHTML:true` | none selected; placeholder `- Сервер -` | Multi-pick; array into `multiselect.server_id`. |
| Date range | `games-date` | custom `dateRange` widget (`type=daterange`), label "за всё время" | `t1.start` | presets: month/day/week/year/custom/today/yesterday/current+last week/current+last month/last30days | **allTime** (`start:0,end:0`) | Fires `crm_dateRange` → rebuild; splits into `.startdate`/`.enddate`. |

**Validation:** none client-side; empty inputs are omitted from `search` (`if(val != "")`). `+` is escaped to `%2B` on multiselect/text values before submission.

---

### 6. Permission / Visibility Logic

- The fragment contains **no** `class="hide"` gating, role/group checks, or `Action`-guarded buttons. Every authenticated viewer who reaches the page sees the full match log and all six servers.
- Access control is entirely upstream: whether `pageLoad('games')` is offered in the nav, and whether `table.php action=games` authorizes the caller. Nothing here narrows visibility by admin group.
- The multiselect options are pre-filtered server-side to servers the operator may view; the client trusts and iterates them.

---

### 7. Notable UX & Competitive Notes

- **Ticket-as-badge encoding.** Remaining tickets are a colored pill fused onto each team name (green = winner, red = loser) — outcome + margin at a glance, no separate score column. Copyable pattern.
- **`data-unix` on time cells.** Epochs are preserved in `data-unix` while showing humanized local time ("Вчера 23:26:46") — clean separation of machine value and display.
- **Trophy column doubles as draw indicator** (`—`/`fa-minus` when `win` falsy).
- **Two-phase server-side pagination** (rows first, deferred `COUNT(*)` via `pagination=true`) keeps first paint fast on a ~28.5 K-row / 286-page table.
- **Fixed filter rail** (`position:fixed`) stays pinned while results scroll; `mobile-left` hints a mobile reflow (watch for collisions on short viewports).
- **Rich date presets** (~11) plus custom range — a strong baseline to match.
- **Weaknesses to beat:** (1) no column sorting wired (`order_by=order_sort=false`); (2) no CSV/stat export on this page (`downloadStat` exists elsewhere, not here); (3) raw SQL alias filter keys (`t1.map`, `t1.start`, `server_id`) suggest thin server-side validation; (4) match detail is a full page reload (`/game/<id>`), breaking the SPA flow; (5) `is_seed` is shipped in the payload but neither shown nor filterable — a free "hide seeding rounds" toggle the rival leaves on the table.

---

### Gaps / Unknowns

- **Per-match player performance schema is not in these files.** `/game/<id>` is a server-rendered route; its columns (per-player K/D/score, rosters, ticket timeline) require capturing that page's HTML.
- **Backend JOIN/column mapping** for `t1`/`t2`/`t1_tickets`/`win`/`is_seed` is inferred from the client alias keys (`t1.*`, `server_id`); `table.php` server logic was not provided.
- **`order` capability:** disabled on this page, so the set of sortable DB-aliases the backend would accept is unobserved.


---

## 13. Combat Logs: Kills, Deaths, Revives, Damage, Teamkills

> Spec-grade chapter. All endpoint/response facts below are taken from LIVE captured contracts on `https://breaking.sqstat.ru` (read-only headless capture, 0 blocked mutations). Capture files: `caps/combat/{kills,deaths,revives,damages,teamkills}.network.json` and `.content.html`. Client behavior is cross-referenced against `custom.js` (`$.fn.buildTable` at L605, `Action()` at L284, `dateRange` presets at L1206+). Russian UI labels are kept with an English gloss.

### 13.1 Purpose and Navigation

SQSTAT exposes five near-identical combat-event log pages. Each is a filterable, server-side-paginated table over one class of in-game combat event. Nav click → `pageLoad('<page>')` → **`GET /ajax/page.php?page=<page>`** returns an HTML fragment (~114 KB) injected into `#content`. The fragment ships an inline `<style>` hiding the first column, the left filter rail, the empty results `<table>`, one inline `<script>` that calls `$('#<tableId>').buildTable({...})`, and the full shared player-detail modal markup.

| Page id | `page.php` fragment (bytes) | Table DOM id | `table=`/`action=` name | Event logged | Page size (`numrows`) |
|---|---|---|---|---|---|
| `kills` | 115029 | `#playerKills` | `playerKills` | Player A killed player B (weapon + kit recorded) | 500 |
| `deaths` | 113955 | `#playerDeath` | `playerDeath` | A player died (subject + weapon/actor that killed them) | 500 |
| `revives` | 113974 | `#playerRevive` | `playerRevive` | A medic revived a downed player | 500 |
| `damages` | 114070 | `#playerDamage` | `playerDamage` | A damage-dealt event (attacker, victim, weapon, **amount**) | 500 |
| `teamkills` | 114004 | `#playerTeamkill` | `playerTeamkill` | A friendly-fire kill (offender + team victim) | 100 |

All five share an identical two-pane layout: a fixed left filter rail (`div.col-md-3.mobile-left > .block-box` with `position:fixed`) and a right results table (`col-md-9`). All five embed the shared player-detail modal (`#player_info` / `#playerModal`) with its Chat/Kills/Deaths/Kits/Games/Comments tabs and ~22 actions — documented in the shared-modal chapter, not here. Modal-tab columns (Чат/Сообщение/Кит/Карта/Победа/Урон, etc.) are **not** attributed to these pages.

### 13.2 Live API Contracts

Every page drives exactly two POST calls to a single endpoint, plus the one-time page GET. This is the ground-truth upgrade of this chapter.

#### 13.2.1 `GET /ajax/page.php` — fragment loader

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | enum: `kills` \| `deaths` \| `revives` \| `damages` \| `teamkills` | yes | Which combat-log fragment to render |

Response: `text/html; charset=UTF-8`, the `#content` fragment. Status `200`. No JSON envelope.

#### 13.2.2 `POST /ajax/table.php` — row fetch (data call)

The core read. Sent by `buildTable → Action({script:'table', action:'<table>', data:'&table=<table>&page=...'})`. Body is `application/x-www-form-urlencoded`.

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string = the table name | yes | Mirrors `table`; `Action()` appends `action=<table>` |
| `table` | enum: `playerKills` \| `playerDeath` \| `playerRevive` \| `playerDamage` \| `playerTeamkill` | yes | Server table/query id |
| `page` | int (1-based) | yes | Page number |
| `numrows` | int | yes | Rows per page (500 for k/d/r/dmg, 100 for teamkills) |
| `search` | URL-encoded JSON | yes | Filter object (see §13.4.2). Default `{"text":{"t1.date.startdate":0,"t1.date.enddate":0},"check":{},"multiselect":{},"managers":{},"slider":{}}` |
| `order_by` | string \| `false` | yes | Column DB-alias to sort by; ships as literal `false` (no sort) |
| `order_sort` | `asc` \| `desc` \| `false` | yes | Sort direction; ships as `false` |

Response envelope: `application/json; charset=utf-8`, status `200`.

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum: `ok` \| (error) | Request status; `Action()` treats non-`ok` as error, `auth:true` → `location.reload()` |
| `exec_time` | float (seconds) | Server-measured total execution time |
| `data.totalPage` | int | Always `0` on the data call (real value comes from the pagination call) |
| `data.totalRows` | int | Always `0` on the data call |
| `data.currentPage` | string (numeric) | Echoed page, e.g. `"1"` |
| `data.custom` | bool | Custom-payload flag; `false` for these tables |
| `data.query_time` | int \| float (seconds) | Row-query time (0 when cached; `0.21` observed on teamkills) |
| `data.count_time` | int | `0` on the data call (counting deferred to pagination call) |
| `data.row` | array[`numrows`] of row objects | The log rows; per-table schema in §13.3 |

#### 13.2.3 `POST /ajax/table.php` … `&pagination=true` — count call

Identical body plus a trailing `&pagination=true`. Returns only the count envelope (no rows). This is a **separate, expensive `SELECT COUNT(*)`** — `count_time` runs 0.1 s–2.76 s in captures.

| Field | Type | Meaning |
|---|---|---|
| `totalPage` | int | Total page count = ceil(totalRows / numrows) |
| `totalRows` | string (numeric) | Total matching rows (string, e.g. `"13413500"`) |
| `count_time` | float (seconds) | COUNT query time; logged to console by client |
| `status` | string enum: `ok` | |
| `exec_time` | float (seconds) | Total execution time |

**Live totals observed** (indicative table scale, default all-time filter):

| Table | totalRows | totalPage @ numrows | count_time |
|---|---|---|---|
| `playerKills` | 4,402,799 | 8,806 @ 500 | 1.37 s |
| `playerDeath` | 5,630,431 | 11,261 @ 500 | 1.36 s |
| `playerRevive` | 1,217,973 | 2,436 @ 500 | 0.27 s |
| `playerDamage` | 13,413,500 | 26,827 @ 500 | 2.76 s |
| `playerTeamkill` | 653,590 | 6,536 @ 100 | 0.10 s |

### 13.3 Per-Table Row Schemas (from captured `data.row[]`)

Types are as returned on the wire (all scalars are JSON strings unless noted). Field lengths shown are the redaction lengths of the sample row, not schema constraints. `date` is a **Unix epoch seconds** string in every table. `server` is pre-rendered HTML (a `<code>[X]</code>` badge). `steam_id`/`victim_steam_id` are 17-char SteamID64 strings.

**`playerKills`** — client `collum: ["steam_id","server","date","player_name","name","weapon"]`

| Field | Type | Meaning | Rendered as column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK (e.g. `4402799`) | no |
| `steam_id` | string(17) | Killer SteamID64 — drives row-click modal | hidden col 1 |
| `victim_steam_id` | string(17) | Victim SteamID64 — makes target openable (kills only) | no (used by `#kill_template`) |
| `game_id` | string(numeric) | Match/game id (e.g. `33295`) | no |
| `date` | string(unix-sec) | Event time (e.g. `1783115934`) | Дата |
| `weapon` | string | Weapon/entity id (e.g. `QBZ192_Optic_QMK171A_Grippod`) | Оружие |
| `kit` | string | Killer kit id (e.g. `PLANMC_Rifleman_06`) | no (not in `collum`) |
| `player_name` | string | Killer display name | Кто (Who) |
| `name` | string | Victim display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id (1/6/7/9/10/11) | no |
| `map` | string | Map + layer (e.g. `Harju RAAS v1`) | no (not in `collum`) |
| `server` | HTML string | Server badge `<code>[A]</code>` | server icon col 2 |

**`playerDeath`** — `collum: ["steam_id","server","date","player_name","weapon"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `steam_id` | string(17) | The deceased player | hidden col 1 |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Death time | Дата |
| `weapon` | string | Weapon/actor that killed them (e.g. `Soldier_AFU_SquadLeader01`) | Оружие |
| `kit` | string | Deceased's kit (e.g. `CMD`) | no |
| `player_name` | string | Deceased display name | Игрок (Player) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

Note: no `victim_steam_id`/`name` in payload — deaths table has no second-party column, though the killer is still **filterable** via the Кого input (§13.4).

**`playerRevive`** — `collum: ["steam_id","server","date","player_name","name"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `steam_id` | string(17) | Reviving medic | hidden col 1 |
| `victim_steam_id` | string(17) | Revived player SteamID64 | no |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Revive time | Дата |
| `kit` | string | Medic kit id | no |
| `player_name` | string | Medic display name | Кто (Who) |
| `name` | string | Revived player display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

No `weapon` (revives have none).

**`playerDamage`** — `collum: ["steam_id","server","date","player_name","name","weapon"]`

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK (8-digit, largest table) | no |
| `steam_id` | string(17) | Attacker | hidden col 1 |
| `victim_steam_id` | string(17) | Victim | no |
| `game_id` | string(numeric) | Game id | no |
| `date` | string(unix-sec) | Damage time | Дата |
| **`damage`** | string(numeric) | **Damage amount** (e.g. `"32"`) — present in payload but NOT in `collum`, so never shown/sortable on this grid | no (**omitted**) |
| `weapon` | string | Weapon id (e.g. `QBZ192_Holo_Grippod_Suppressor`) | Оружие |
| `player_name` | string | Attacker display name | Кто (Who) |
| `name` | string | Victim display name | Кого (Whom) |
| `server_id` | string(numeric) | Server id | no |
| `map` | string | Map/layer | no |
| `server` | HTML string | Server badge | server col 2 |

**`playerTeamkill`** — `collum: ["steam_id","server","date","player","killed"]` (distinct keys vs other tables)

| Field | Type | Meaning | Column? |
|---|---|---|---|
| `id` | string(numeric) | Event PK | no |
| `server_id` | string(numeric) | Server id | no |
| `steam_id` | string(17) | Offender (teamkiller) — drives row-click | hidden col 1 |
| `killed` | HTML string | Team victim, **pre-rendered** `<p class="mb-0">…name…</p>` (includes clan tag) | Кого (Whom) |
| `date` | string(unix-sec) | Teamkill time | Дата |
| `killed_group` | null | Victim admin-group (null when none) | no |
| `player` | HTML string | Offender, pre-rendered name markup | Кто (Who) |
| `player_group` | null | Offender admin-group (null when none) | no |
| `kit` | HTML string | Offender kit as `<img src="/assets/img/ico/kits/…">` | no (not in `collum`) |
| `server` | HTML string | Server badge | server col 2 |

Teamkills uniquely (a) server-renders `player`/`killed`/`kit` as HTML, (b) carries `*_group` join columns, (c) uses `numrows:100`, (d) has no `weapon` and no `victim_steam_id`. It is a **passive log**: no forgive/punish/auto-kick/TK-count workflow on the page.

### 13.4 Filters, Search, Sort, Pagination

#### 13.4.1 Left-rail controls (per page; ids prefixed with the table id)

Structure is identical across all five; only the `data-search` DB-aliases differ. Example ids use `playerKills-*`.

| Control | `#id` suffix | Input type | `data-search` alias | Options / behavior | Validation |
|---|---|---|---|---|---|
| Поиск (Search) | `-btn` | `button` (`btn btn-default btn-100`) | — | Triggers `buildTable()` re-fetch | — |
| Кто (Who) | `-name` | `text` (`form-control`, placeholder `Кто`) | page-specific (table below) | Substring on primary player name; Enter (`which==13`) submits | free text |
| Кого (Whom) | `-killed` | `text` (placeholder `Кого`) | page-specific | Substring on secondary player name; Enter submits | free text |
| Сервер (Server) | `-server` | Bootstrap `multiselect` (`multiple`, `type="multiselect"`) | `server_id` | 6 checkboxes; IN-list filter; placeholder `- Сервер -`; `enableHTML` | — |
| Date range | `-date` | `button` (`type="daterange"`) | `t1.date` | `dateRange` picker; fires `crm_dateRange`; writes `t1.date.startdate`/`t1.date.enddate` into search `text` | — |

Server `<option>` set (shared across all five — this tenant's own servers only; note id gaps 2–5, 8):

| `server_id` | `label` |
|---|---|
| 1 | `RAAS/AAS #1` |
| 6 | `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2) |
| 7 | `INVASION #3` |
| 9 | `Custom для FW` |
| 10 | `Custom для MDC` |
| 11 | `Custom для BSS` |

**Page-specific `data-search` aliases (leaked raw SQL join aliases).** The same physical event table (`t1`, holding `date`, `server_id`) is joined to player tables under different aliases depending on which side the page treats as primary:

| Page | Кто (`-name`) → | Кого (`-killed`) → | Server | Date |
|---|---|---|---|---|
| kills | `t2.player` | `t4.player` | `server_id` | `t1.date` |
| deaths | `t5.player` | `t2.player` | `server_id` | `t1.date` |
| revives | `t5.player` | `t2.player` | `server_id` | `t1.date` |
| damages | `t2.player` | `t5.player` | `server_id` | `t1.date` |
| teamkills | `t5.player` | `t2.player` | `server_id` | `t1.date` |

#### 13.4.2 Search object assembly

`buildTable` collects `searchInput` controls into a five-bucket object keyed by each control's raw `data-search` value, then JSON-stringifies and URL-encodes it (`+`→`%2B`) into the `search` param:

```json
{
  "text":        { "t1.date.startdate": 0, "t1.date.enddate": 0, "<who-alias>": "<query>", "<whom-alias>": "<query>" },
  "check":       {},
  "multiselect": { "server_id": ["1","7", ...] },
  "managers":    {},
  "slider":      {}
}
```

Text inputs land in `text.<alias>`; the date button always seeds `text.t1.date.startdate` / `text.t1.date.enddate` (0/0 = all-time default); the server multiselect lands in `multiselect.server_id`. `check`, `managers`, `slider` are unused on combat pages.

`searchInput` per page: `["<table>-name", "<table>-killed", "<table>-server", "<table>-date"]` (exact ids from the captured configs).

#### 13.4.3 Sort

The engine supports sorting (`order_by`/`order_sort` params, and `order` config mapping columns→aliases in `buildTable`), but **none of the five page-own configs set `order`**, so both params ship as literal `false` and server default ordering applies (newest-first by PK/date in practice). No sortable column headers are wired on these grids.

#### 13.4.4 Pagination

Two-request model per load: the data call (`&page=N`) returns rows with `totalPage/totalRows = 0`; a parallel count call (`&pagination=true`) returns real `totalRows`/`totalPage`. Client shows `showPages: isMobile?3:9`. Concurrency guard `tmpTable[tableID]=true` blocks a second load of the same table (logs `Такая таблица уже грузится`). Ajax timeout / retry-abort handled by `Action()` (`retryAbort:true` aborts the prior in-flight request of the same `name`).

### 13.5 Column Rendering

Rendering is driven by `buildTable`'s `collum` array (order = visual column order after the hidden `steam_id`). Header cells (`<thead class="table-dark">`) with widths:

| Header (Ru → En) | class / style | Applies to |
|---|---|---|
| `SteamID` | `hide` (also CSS `td:first-child{display:none}`) | all (col 1, hidden) |
| (server icon) | `text-center; width:50px` | all (col 2) |
| `Дата` (Date) | `text-center; width:130px` | all |
| `Кто` (Who) | `text-center` | kills, revives, damages, teamkills |
| `Игрок` (Player) | `text-center` | deaths (single-party) |
| `Кого` (Whom) | `text-center` | kills, revives, damages, teamkills |
| `Оружие` (Weapon) | `text-center` | kills, deaths, damages |

Each `<td>` gets `data-contact="<collum key>"` (used by row-click to read `steam_id`). Kills has a `callback.date` → `formatDate(data,false,true)` render; the other four rely on default rendering (dates rendered raw or by the shared default). `server` and (teamkills) `player`/`killed`/`kit` arrive as HTML and are injected as-is.

### 13.6 Row Interactions & Templates

- **Row click** (all five): `end` handler binds `$('#<tableId> tbody > tr').on('click', …)` → reads `td[data-contact="steam_id"]` → `player.open(steam_id)` → opens the shared player-detail modal for the **primary** actor (killer / deceased / medic / attacker / offender).
- **Kills only**: config sets `template: $('#kill_template > div')` and `mode: isMobile ? 'list':'table'`. `#kill_template` (a `.hide` panel) renders each event as a card with two `[data-action="player"]` "открыть" (open) buttons — one carrying `data-table="steam_id"` (killer), one `data-table="victim_steam_id"` (victim) — so on kills **both parties are one-click openable**. The other four pages have no bespoke template and only the primary `steam_id` is openable from the grid.

### 13.7 Actions / Admin Capabilities

**Page-owned action surface** (all reads; `Action()` → `POST /ajax/<script>.php`, body starts `action=<action>`):

| UI trigger | `action` | `script` → endpoint | Body params | Effect | Destructive |
|---|---|---|---|---|---|
| Load/paginate rows | `<table>` (e.g. `playerKills`) | `table` → `/ajax/table.php` | `table, page, numrows, search, order_by, order_sort` [`, pagination`] | Fetch/count log rows | N |

The only mutation surface reachable from these pages is the **shared player-detail modal** opened on row click. Those actions belong to the shared-modal chapter; catalogued here (from the embedded modal markup + `action_catalog.txt`) as the admin capabilities exposed *while triaging a combat-log row*:

| Modal action | `script` → endpoint | Body (key params) | Destructive | Purpose |
|---|---|---|---|---|
| `ban` | `squad` → `/ajax/squad.php` | `server_id, steam_id, reason_id, description, days` | Y | Ban player |
| `kick` | `squad` | `server_id, steam_id` | Y | Kick from server |
| `kill` | `squad` | `server_id, steam_id` | Y | Force-kill in game |
| `changeTeam` | `squad` | `server_id, steam_id` | Y | Swap team |
| `removePlayer` | `squad` | `server_id, steam_id` | Y | Remove from squad/server |
| `unban` | `squad` | `ban_id` | Y | Lift ban |
| `changeGroup` | `player` → `/ajax/player.php` | `steam_id, group_id` | Y | Change admin/permission group |
| `mark` | `player` | `steam_id` | Y | Flag/mark player |
| `message` | `player` | `steam_id, msg` | Y | In-game message |
| `addComment` / `getComments` | `player` | `steam_id[, text]` | Y / N | Admin comments |
| `addBanName` / `removeBanName` | `player` | `name` | Y | Forbidden-name list |
| `kitSave` | `player` | `steam_id, kit` | Y | Save player kit |
| `checkBans` | `player` | `steam_id` | N | Cross-check ban status |
| `twink` / `twinkOnline` | `player` | `steam_id` | N | Alt-account detection |
| `findFriends` | `player` | `steam_id` | N | Social-graph lookup |
| `kits` | `player` | `steam_id` | N | Kit history |
| `getPlayerOnlineData` | `player` | `steam_id` | N | Online-time chart |
| `downloadStat` | `player` | `steam_id` | N (export) | Stat export via `post_to_url()` form-submit |

`Action()` semantics (`custom.js` L284): non-`ok` `status` → `error()` alert; `text.auth===true` → `location.reload()` (session/permission failure); `retryAbort` aborts a prior in-flight call of the same `name`; body built by mapping the `data` object to `&k=v` pairs with `action=<action>` prepended.

### 13.8 Permission / Visibility Logic

- No role/group gating in the page-own markup — filter rail and table are unconditionally present. Page-level access is enforced server-side by `page.php`; mutation authorization server-side by `squad.php`/`player.php`. Client only reacts to `auth:true` by reloading.
- `class="hide"` and the inline `#<tableId> > tbody > tr > td:first-child{display:none}` CSS are pure layout/data-plumbing (hidden `steam_id` cell, hidden `#kill_template`, hidden `#player_info`), **not** role-based visibility.
- Server multiselect is pre-scoped to this tenant's six servers, implicitly constraining every query to owned servers.
- Teamkills' `player_group`/`killed_group` are the only role/group data surfaced, and only as null placeholders in the payload (no UI treatment).

### 13.9 Date-Range Presets (shared `dateRange` widget)

The `-date` button opens the shared picker (`custom.js` L1206+). Full preset set (writes `t1.date.startdate`/`.enddate` epoch bounds into the search `text` bucket):

`justDay, justWeek, justMonth, justYear, range (custom), allTime (default, 0/0), last24h, today, yesterday, currentWeek, lastWeek, currentMonth, lastMonth, last30days, last60days, last90days, plus1Month, plus2Month, plus3Month, plus6Month, plus1Year`.

Default is `allTime` → `startdate:0, enddate:0` (matches every captured request body).

### 13.10 Competitively Interesting Details

- **Five pages, one event model.** kills/deaths/revives/damages/teamkills are the same `t1`-anchored event join re-projected under swapped player aliases. A competing panel could unify them into one "Combat Log" view with an event-type facet — less nav clutter, one query template.
- **Damage magnitude is captured but hidden.** `playerDamage.damage` (e.g. `"32"`) ships in every row yet is excluded from `collum`, so it is never displayed or sortable. Surfacing + sorting by damage is a clear differentiator.
- **Teamkills is passive.** Payload even carries `player_group`/`killed_group`, but there is no forgive/punish/auto-kick, no per-player TK tally, no repeat-offender surfacing. Friendly-fire moderation tooling is an obvious gap to beat.
- **Two queries per load, one a full `COUNT(*)`.** The pagination call runs 0.1–2.76 s over 0.65M–13.4M-row tables. Keyset/cursor pagination and cached/approximate counts would dramatically outperform.
- **Raw SQL aliases leak to the client** (`data-search="t2.player"`, `t1.date`, etc.) — maintenance smell + mild info-leak. Map filters to opaque field names server-side.
- **Uneven interaction affordance.** Only kills makes the victim one-click openable (via `#kill_template`); on the other four grids only the primary subject opens. Making every named party openable everywhere is a small, high-value polish.
- **Server pre-renders HTML into JSON** (`server` badge everywhere; `player`/`killed`/`kit` on teamkills). Convenient but couples data to presentation and inflates payloads — a clean data/view split is a maintainability win.
- **Generous date presets** (21 presets incl. relative and forward-looking `plus*`, `allTime` default) — a solid baseline to match.


---

## 14. Votes & Reports

Competitive analysis of the SQSTAT admin panel's **Votes log** (`votes`) and **player Report system** (`reports`), upgraded to implementation-spec quality from **live captured API contracts** against `https://breaking.sqstat.ru`. Both are read/monitor feeds built on the shared client-side `$.fn.buildTable` engine (server-side paginated), rendered as a scrollable **list-group of cards** (not a classic `<table>`), and both embed the shared player-detail modal that carries every mutating admin action.

Capture evidence (ground truth for this chapter):
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/votes.network.json` — 3 live AJAX contracts (page load + table + pagination).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/reports.network.json` — 2 live AJAX contracts (page load + table).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/votes.content.html`, `reports.content.html` — live rendered `#content` (real filters, template `data-table` fields, buildTable config).
- `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/caps/votes-reports/_blocked.json` — `[]` (zero mutations attempted/blocked; capture was pure observation).
- Client engine: `/Users/seregatipich/.claude/jobs/bd83e71f/tmp/custom.js` (`$.fn.buildTable`).

> Privacy: response samples below are redacted; a single redacted example per field is shown to convey type/shape only. No real SteamIDs/names/IPs are reproduced.

---

### 14.1 Purpose & Navigation

| Page | Nav id | Loaded via | Purpose |
|------|--------|-----------|---------|
| Votes | `votes` | `pageLoad('votes')` → `GET /ajax/page.php?page=votes` | Historical audit log of in-game votes (map skip / re-roll / map change). Captures initiator identity, server, outcome, threshold math (collected vs required), the full map triple (current → next → target), vote duration, and the **complete per-voter list**. |
| Reports | `reports` | `pageLoad('reports')` → `GET /ajax/page.php?page=reports` | Log of player-submitted in-game reports (Squad `!report`). Shows the reported (target) player, the report text, server tag, and timestamp, with a one-click jump into the target's full admin card. |

Both pages share a two-column layout: a `position:fixed` left sidebar (`width:240px`, `.col-md-4.mobile-left`) with filters, and a right content area holding the results list (`#votes_list` / `#reports_list`, a `<ul class="list-group">`). Live-verified server option set (shared by both filters): id `1` `RAAS/AAS #1`, `6` `БЕЗ ГОЛОСОВАНИЯ #2` (No voting #2), `7` `INVASION #3`, `9` `Custom для FW`, `10` `Custom для MDC`, `11` `Custom для BSS`.

---

### 14.2 Data-flow / rendering engine (buildTable)

Rows are **not** rendered with `<thead>/<th>`. A hidden `<div id="template" class="hide">` holds one `<li>` card whose descendants carry `data-table="<field>"` placeholders; `buildTable` clones it per row and fills each placeholder from the JSON response `data.row[]`.

Live buildTable config (from captured `#content`):

```js
// votes.content.html
$('#votes_list').buildTable({ table:'votes', collum:[], numrows:30, mode:'custom',
  searchInput:["votes-server"], template:$('#template > li'),
  end: d => d.selector.find('a[data-type="btn_open"]').click(...player.open(steam_id)) });

// reports.content.html
$('#reports_list').buildTable({ table:'reports', collum:[], numrows:30, mode:'custom',
  searchInput:["reports-server"], template:$('#template > li'),
  callback:{ date: (v,row) => formatDate(v,false,true) },   // client-formats the date column
  end: d => d.selector.find('a[data-type="btn_open"]').click(...player.open(steam_id)) });
```

Row fetches go through the RPC helper `Action({script:'table', action:'<votes|reports>', data:<query>})` → **`POST /ajax/table.php`**. Pagination re-issues the same call with `&pagination=true` (fired by `getPagination()` only when the current page fills or `currentPage != 1`). Text inputs submit on Enter (`keypress==13`) or the search button, setting `conf.page=1; conf.isSearch=true`; multiselect submits on change via `buildTable('rebuild')`. `collum:[]` + `mode:'custom'` means there is no column model — placeholders are matched by `data-table` name, so **there are no sortable columns** on these two feeds.

Search is assembled client-side into `{text:{}, check:{}, multiselect:{}, managers:{}, slider:{}}` keyed by each input's `data-search` attribute, then `encodeURIComponent(JSON.stringify(...))`. Text values get `+` escaped to `%2B` before submit.

> The `<th>` elements present later in both fragments belong exclusively to the **shared player-detail modal** (Chat/Kills/Deaths/Kits/Games/Damage tabs). They are NOT columns of the votes/reports lists.

---

### 14.3 Live API Contracts

All three endpoints are same-origin `https://breaking.sqstat.ru`. Envelope convention: top-level `status:"ok"`, `exec_time:float`; table payload nested under `data`.

#### 14.3.1 `GET /ajax/page.php?page={votes|reports}` — page shell

| Param | Type | Required | Meaning |
|-------|------|----------|---------|
| `page` | enum `votes` \| `reports` | Y | Which page fragment to render. |

Response: `text/html; charset=UTF-8` (≈113 KB) — the `#content` markup (sidebar filters + hidden `#template` + inline buildTable bootstrap). Not JSON. Cite: `votes.network.json[0]`, `reports.network.json[0]`.

#### 14.3.2 `POST /ajax/table.php` (action=votes) — vote log page

Request params (form-urlencoded), captured verbatim:

| Param | Type | Required | Meaning |
|-------|------|----------|---------|
| `action` | const `votes` | Y | Server table handler selector. |
| `table` | const `votes` | Y | Mirror of `action` (sent by buildTable). |
| `page` | int | Y | 1-based page number. |
| `numrows` | int | Y | Page size; fixed **30**. |
| `search` | urlencoded JSON | Y | `{"text":{},"check":{},"multiselect":{...},"managers":{},"slider":{}}`. Votes uses only `multiselect.server_id` (array of server ids). Empty object = no filter. |
| `order_by` | string \| `false` | Y | Sort column DB alias; literal `false` when unsorted (default). |
| `order_sort` | string \| `false` | Y | `asc`/`desc` or literal `false` (default). |
| `pagination` | `true` | N | When present, returns count-only payload (see 14.3.4). |

Captured request body (default first load):
```
action=votes&table=votes&page=1&numrows=30
&search=%7B%22text%22%3A%7B%7D%2C%22check%22%3A%7B%7D%2C%22multiselect%22%3A%7B%7D%2C%22managers%22%3A%7B%7D%2C%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

Response `application/json`, shape `data.row[]` = array of vote records (page size 30). Field contract (from `response_schema`, all scalar values are JSON strings):

| Field | Type | Meaning |
|-------|------|---------|
| `id` | str (numeric) | Vote row PK. Live max observed `3991` ⇒ auto-increment. |
| `server_id` | str (numeric) | FK to server (`1`,`6`,`7`,`9`,`10`,`11`). |
| `date` | str `"HH:MM [DD.MM.YYYY]"` | Vote timestamp, **pre-formatted server-side** (e.g. `"00:51 [04.07.2026]"`), not a unix epoch. |
| `steam_id` | str(17) | Initiator's SteamID64; fed to `player.open()` by the **открыть** button. Redacted in sample. |
| `name` | str | Initiator display name. Redacted in sample. |
| `short` | str(1) | Server short tag rendered in `<kbd>[…]</kbd>` (e.g. `"A"`). |
| `mode` | str (enum, Russian) | Vote type. Observed value `"Пропуск карты"` (map skip). Other expected members: map change / re-roll. |
| `map_current` | str | Current map at vote time (e.g. `"Harju RAAS v1"`). |
| `map_next` | str | Next map in rotation; may be empty `""`. |
| `map_vote` | str | Proposed target map; `"-"` when N/A (e.g. skip votes). |
| `players_sum` | str (numeric) | Yes-votes collected ("Набралось" / Collected). |
| `players_need` | str (numeric) | Threshold required to pass ("Необходимо" / Required). |
| `duration` | str (numeric, seconds) | Vote window length, e.g. `"190"`. Not surfaced in the card template. |
| `cancel` | str (HTML) | Outcome/status, delivered as a ready `<span class="label label-…">` badge (≈105 chars). Rendered raw into "Статуc" (Status). |
| `votes` | str (JSON) | **Full per-voter roster** — `{"yes":["7656119…","7656119…"], …}` (≈236 chars in sample). Present in the payload but **not bound to any `data-table` placeholder** (unused by the card). High-value analytics field. |
| `map_current_img` | str (HTML) | Ready `<img data-type="map" …>` thumbnail block for current map. |
| `map_next_img` | str (HTML) | Ready `<p>/<img>` block for next map. |

Envelope siblings under `data`: `totalPage:int`, `totalRows:int` (both `0` on the row call — real counts come from the pagination call), `currentPage:str`, `custom:bool`, `query_time:int`, `count_time:int`. Top level: `status:str("ok")`, `exec_time:float`. Cite: `votes.network.json[1]`.

Redacted example row:
```json
{ "id":"3991","server_id":"1","date":"00:51 [04.07.2026]","steam_id":"<redacted:17>",
  "map_current":"Harju RAAS v1","map_next":"","map_vote":"-","mode":"Пропуск карты",
  "players_sum":"<redacted:1>","players_need":"<redacted:2>","duration":"190",
  "cancel":"<span class=\"label label-primary\" …>","votes":"{\"yes\":[\"765611992…\"]}",
  "name":"<redacted:10>","short":"A","map_current_img":"<img data-type=\"map\" …>",
  "map_next_img":"<p class=\"text-center\">…</p>" }
```

#### 14.3.3 `POST /ajax/table.php` (action=reports) — report log page

Request params identical to 14.3.2 with `action=reports&table=reports`. Reports additionally drives two text filters via `search.text` (see 14.5.2). Captured body:
```
action=reports&table=reports&page=1&numrows=30
&search=%7B%22text%22%3A%7B%7D,%22check%22%3A%7B%7D,%22multiselect%22%3A%7B%7D,%22managers%22%3A%7B%7D,%22slider%22%3A%7B%7D%7D
&order_by=false&order_sort=false
```

Response `application/json`. In the live capture the account's report set was empty: `data.row = []` (`array[0]`), `totalRows=0`, `totalPage=0`. Envelope identical to votes (`currentPage`, `custom`, `query_time`, `count_time`, `status:"ok"`, `exec_time`). Cite: `reports.network.json[1]`.

Because rows were empty, the **row field contract is reconstructed from the live `#template` `data-table` placeholders** (authoritative for what the client renders) plus the search aliases (authoritative for the server JOIN):

| Field (`data-table`) | Type | Meaning |
|----------------------|------|---------|
| `short` | str | Server short tag, rendered in `<kbd>`. |
| `date` | str/int | Report timestamp; passed through client `formatDate(v,false,true)` (buildTable `callback.date`), implying a raw/less-formatted value than the votes `date`. |
| `player_name` | str | **Reported (target)** player display name (bold). |
| `steam_id` | str(17) | Target SteamID64; drives **открыть** → `player.open()`. |
| `text` | str | Free-text report body, rendered in `<p data-table="text">`. |

**JOIN aliases (from search `data-search`):** `t2.player` (joined players table → target nick/SteamID) and `t1.text` (reports table → message). The server query joins **reports `t1`** to **players `t2`**. The **reporter's identity is not exposed** in the template or the search surface — either unselected in this list or stored server-side only.

#### 14.3.4 `POST /ajax/table.php` … `&pagination=true` — count sidecar

Same body as the row call plus `pagination=true`. Returns a count-only JSON (no rows) used to render page links. Fired by `getPagination()`.

| Field | Type | Meaning |
|-------|------|---------|
| `totalPage` | int | Page count. Live votes: `134`. |
| `totalRows` | str (numeric) | Total matching rows. Live votes: `"3991"`. |
| `count_time` | int | Server count timer. |
| `status` | str `"ok"` | Envelope status. |
| `exec_time` | float | Server exec timer. |

Live sample (votes): `{ "totalPage":134, "totalRows":"3991", "count_time":0, "status":"ok", "exec_time":0.008 }`. Cite: `votes.network.json[2]`. (No pagination sidecar fired for reports since the set was empty.)

---

### 14.4 Votes page — entity, card & controls

#### 14.4.1 Card template (`#template > li`) → field binding

| Card region (Russian label → gloss) | Bound `data-table` |
|--------------------------------------|--------------------|
| `<kbd>[short]</kbd>` badge | `short` |
| Bold initiator name | `name` |
| `<hashtag>` SteamID | `steam_id` |
| Right-aligned timestamp | `date` |
| **Статуc** (Status) | `cancel` |
| **Режим** (Mode) | `mode` |
| **Набралось** (Collected) | `players_sum` |
| **Необходимо** (Required) | `players_need` |
| **Текущая** (Current map) | `map_current` |
| **Следующая** (Next map) | `map_next` |
| **На какую** (Target map) | `map_vote` |
| Current-map thumbnail | `map_current_img` |
| Next-map thumbnail | `map_next_img` |

Payload fields **`duration`, `votes`, `id`, `server_id` are delivered but not bound** to the card (dark data available to a reimplementation).

#### 14.4.2 Sidebar controls

| Control | `#id` / `name` | Input type | `data-search` | Default | Effect |
|---------|----------------|-----------|---------------|---------|--------|
| Server filter | `#votes-server` | `multiselect` (bootstrap-multiselect, `nonSelectedText:'- Сервер -'`, `enableHTML:true`) | `server_id` | none selected | `onChange` → `$('#votes_list').buildTable('rebuild')`. Options: `1`,`6`,`7`,`9`,`10`,`11`. |

Votes sidebar has **no text search and no explicit search button** — server-multiselect is the only filter. Pagination: 30/page, numeric + first/prev/next/last, with a "Всего: N" (Total) footer in `#votes_list-infoblock`.

#### 14.4.3 Votes page actions

| Label | Trigger | Endpoint | `Action({...})` data | Destructive |
|-------|---------|----------|----------------------|-------------|
| **открыть** (open) | `a[data-type="btn_open"]` click → `player.open(steam_id)` | `POST /ajax/player.php` `action=get` | `{ script:'player', action:'get', data:{ steam_id } }` | **N** (read) — opens shared modal for the initiator |

The votes page has **no destructive action of its own**; every mutation is one modal-flip away (§14.6).

---

### 14.5 Reports page — entity, card & controls

#### 14.5.1 Card template (`#template > li`) → field binding

| Card region | Bound `data-table` |
|-------------|--------------------|
| `<kbd>short</kbd>` badge | `short` |
| Right-aligned timestamp | `date` (via `callback.date → formatDate(v,false,true)`) |
| Bold target player name | `player_name` |
| `<hashtag>` SteamID | `steam_id` |
| `<p>` report body | `text` |

#### 14.5.2 Sidebar controls

| Control | `#id` / `name` | Input type | maxlength | `data-search` | Placeholder | Effect |
|---------|----------------|-----------|-----------|---------------|-------------|--------|
| **Поиск** (Search) button | `#reports_list-btn` | `<button>` (`fa-search`) | — | — | — | Submits current filters; re-fetches page 1 with `isSearch=true`. |
| Name / SteamID filter | `#reports-name` | `text` | (none set) | `t2.player` | `Ник или SteamID` (Nick or SteamID) | Free-text match on target nick/SteamID; submits on Enter or via search button (`search.text["t2.player"]`). |
| Text filter | `#reports-killed` | `text` | (none set) | `t1.text` | `Текст` (Text) | Full-text search over report body (`search.text["t1.text"]`). |
| Server filter | `#reports-server` | `multiselect` (`- Сервер -`, `enableHTML:true`) | — | `server_id` | — | `onChange` → `buildTable('rebuild')`. Options `1`,`6`,`7`,`9`,`10`,`11`. |

> `#reports-killed` is a copy-paste artifact from a kill-log page; its bound field is `t1.text` (report body), not a kill. Only `reports-server` is registered in `searchInput`, but the two text inputs still contribute via their `data-search` on submit. Pagination identical to votes (30/page, edges, totals footer; live set was empty so `Всего: 0`).

#### 14.5.3 Reports page actions

| Label | Trigger | Endpoint | `Action({...})` data | Destructive |
|-------|---------|----------|----------------------|-------------|
| **открыть** (open) | `a[data-type="btn_open"]` → `player.open(steam_id)` | `POST /ajax/player.php` `action=get` | `{ script:'player', action:'get', data:{ steam_id } }` | **N** (read) — opens target's admin card |

Reports has **no report-lifecycle mutation** (no resolve / claim / assign / mark-handled) — confirmed against both the template and the action catalog for `reports.html`, which lists only the shared player/squad actions (§14.6), no `report_*` verb.

---

### 14.6 Shared player-detail modal (the mutating surface)

Both pages embed `#playerModal`. **открыть** loads the player via `action=get` and renders a card that flips to sub-panels for punishment, group change, and messaging. These are the only state-changing capabilities reachable from votes & reports; per `action_catalog.txt`, `votes.html` and `reports.html` expose the identical action set (`script:'player'` + `script:'squad'`). Each row = a permission enforced server-side.

| Capability | Script endpoint | Action | Key data params | Destructive |
|-----------|-----------------|--------|-----------------|-------------|
| Load player card | `/ajax/player.php` | `get` | `steam_id` | N |
| Get comments | `/ajax/player.php` | `getComments` | `steam_id` | N |
| Check bans (cross-panel) | `/ajax/player.php` | `checkBans` | `steam_id` | N |
| Find twinks / friends | `/ajax/player.php` | `twink`, `twinkOnline`, `findFriends` | `steam_id` | N |
| Online telemetry | `/ajax/player.php` | `getPlayerOnlineData` | `steam_id` | N |
| Kits (list) | `/ajax/player.php` | `kits` | `steam_id` | N |
| Download stat | `/ajax/player.php` | `downloadStat` | `steam_id` | N |
| Kit save | `/ajax/player.php` | `kitSave` | `steam_id`, kit | **Y** |
| Add comment | `/ajax/player.php` | `addComment` | `steam_id`, comment | **Y** |
| Mark (flag) player | `/ajax/player.php` | `mark` | `steam_id`, `mark` | **Y** |
| Change group/role | `/ajax/player.php` | `changeGroup` | `steam_id`, `group_id`, `date`(expire), `description`, `prefix`, `prefix_rgb`, `image` | **Y** |
| Send in-game message | `/ajax/player.php` | `message` | `steam_id`, `msg`, `time`(repeat s), `log` | **Y** |
| Ban-name allow/deny | `/ajax/player.php` | `addBanName`, `removeBanName` | name payload | **Y** |
| Kick from server | `/ajax/squad.php` | `kick` | `steam_id`, `reason_id`, `description`, `noReason` | **Y** |
| Ban (temp/perm) | `/ajax/squad.php` | `ban` | `server_id`(if online), `steam_id`, `reason_id`, `description`, `days` (`-1`=perm) | **Y** |
| Unban | `/ajax/squad.php` | `unban` | `steam_id`, `unban`(bool) | **Y** |
| Remove from squad | `/ajax/squad.php` | `removePlayer` | `server_id`, `steam_id` | **Y** |
| Switch team | `/ajax/squad.php` | `changeTeam` | `server_id`, `steam_id` | **Y** |
| Kill player | `/ajax/squad.php` | `kill` | `server_id`, `steam_id` | **Y** |

**Ban/kick (Наказание) form:** `<select id="player_ban-reason">` = a rule catalog in `<optgroup>`s (Особые / Общие / Для сквадных / Для техники / Милсим), each option value a rule id (e.g. `110` = "1.1 Оскорбления"; `2` = DPAC anti-cheat auto-ban), carrying `data-first/second/third/four` (escalation-tier default day counts). Reason-type radios `player_ban-reason_type`: Кикнуть (`-1`), Забанить N дней for 1/2/3/4/5/6/7/10/14/30, and Забанить навсегда (perm, `data-day=0`). Comment `<textarea maxlength=512>`. Special case: reason `-1` (Другое) routes straight to `banPlayer`.

**Group change (Смена группы):** groups `0` -Нет группы-, `1` Администратор, `2` Модератор, `3` VIP, `4` Камера, `5` Стажёр; plus expiry daterange, comment (128), prefix text (64), prefix RGB (16), image URL (256); hidden "VIP +1 месяц" quick button.

**In-game message (Сообщение):** 18 canned templates including "Ваш репорт рассматривается модерацией" (your report is under review) — the de-facto report acknowledgement; "add record to card" checkbox `player_message-log`; free-text `<textarea maxlength=512>`; repeat select 1 раз / 30с / 40с / 60с (default) / 90с / 120с.

---

### 14.7 Permission / visibility logic

- Every sub-panel ships in the fragment wrapped `class="hide"` (`#player_ban`, `#player_group`, `#player_message`, `#player_info`, `#template`) and is revealed by JS flip/clone — visibility is client-driven, not role-gated in markup.
- No role/group conditional markup exists in these two fragments: the full ban catalog, all day tiers (incl. permanent), group assignment (incl. Администратор), kill, and messaging render regardless of viewer. Authorization is therefore **enforced server-side** on `/ajax/squad.php` and `/ajax/player.php` per action; the client renders the complete capability set. A competitor must not assume the client hides anything sensitive.
- `open` (`action=get`) is the only capability the votes/reports feeds expose directly; everything destructive is one modal-flip away behind a server permission check.
- Table reads (`/ajax/table.php`) accept arbitrary `page`/`numrows`/`search` from the client but respond only within the authenticated session's scope (empty report set observed for this account).

---

### 14.8 Notable UX & competitively interesting details

- **Vote record is analytics-grade and under-exposed:** the payload carries `players_sum` vs `players_need`, the full map triple with pre-baked thumbnails, `duration` (seconds), and — critically — a complete `votes` roster JSON (`{"yes":[…SteamIDs…]}`) that the UI **never renders**. A competitor exposing per-voter breakdowns, per-server pass rates, and repeat-skip-initiator detection would out-analyze SQSTAT using data it already collects but discards.
- **Server pre-renders presentation into data:** `cancel`, `map_current_img`, `map_next_img` arrive as HTML fragments, and `date` is pre-formatted for votes but raw for reports (client `formatDate`) — an inconsistency and an XSS-surface tell (raw HTML injected via `data-table`).
- **One-click pivot to enforcement:** both feeds deep-link the offender straight into the full ban/kick/message arsenal — tight report→action loop worth matching.
- **Rule-id driven bans with escalation defaults** (`data-first..four`) standardize moderation and feed analytics — strong feature to match.

**Gaps to beat:**
- **No report lifecycle:** confirmed via empty-schema + action catalog — reports have no status/assignee/resolution/"handled-by" field or verb. A moderator cannot claim, resolve, or dedupe reports. A proper queue (open/claimed/resolved, SLA timers, repeat-target dedupe) is a clear differentiator.
- **Reporter identity not surfaced** (`t2.player` is the *target*; no reporter alias in template or search) — no trusted-reporter weighting or false-report-spam detection.
- **Thin filters:** votes filters on `server_id` only (no date range, no `mode`, no initiator search); reports has no date-range filter. `order_by`/`order_sort` are wired in the protocol but `collum:[]` disables sorting on these feeds.
- **Fixed 30/page**, no adjustable page size, no column sort.
- **Code-quality tells:** reused/mis-purposed ids (`#reports-killed` bound to `t1.text`) signal template copy-paste — a cleaner data model is a low bar to clear.


---

## 15. Bug Tracker & Video/Demos

Two loosely related admin-utility pages that share the SPA shell but are functionally independent:

- **Bug Tracker** — nav id `issues`, page fragment served by `GET /ajax/page.php?page=issues`. A GitHub-Issues-style ticket list where admins file bugs/suggestions against the SQSTAT panel itself.
- **Video / Demos** — nav id `video`, page fragment served by `GET /ajax/page.php?page=video`. A large-file (MP4/AVI) uploader that fans recorded evidence/demo clips out to the project's YouTube + Telegram channels.

Both fragments carry an inline `<script>` object (`var issues = {…}` / `var video = {…}`) that self-initializes on `$(document).ready`. `issues.init()` immediately fires `issues.list.get('open',1)`; `video.init()` only wires the drag-drop zone (no auto-load read).

> **Capture provenance.** Live contracts captured by an authenticated headless browser rendering each page and firing its auto-load reads only. Files: `caps/issues-video/issues.network.json`, `caps/issues-video/video.network.json`, `caps/issues-video/issues.content.html`, `caps/issues-video/video.content.html`. Mutating requests were intercepted and aborted — `_blocked.json` is empty (0 blocked). Auto-load reads captured: `issues_get` (fired on page init). All other actions (`issues_create`, `uploadVideo_token`, `uploadVideo`) are user-gesture-triggered and therefore **reconstructed from `custom.js` + fragment JS, not observed on the wire** — flagged as such below.

> **Note.** Neither page embeds the shared player-detail modal nor any `script:'table'` DataTables grid. The bug tracker renders a hand-built `<ul class="list-group">` client-side; the video page is a drag-and-drop upload zone. None of the ~22 player-modal actions apply here; every action below is local to these two pages.

---

### 15.0 Live API Contracts

All four actions route through the shared `Action()` helper (`custom.js:284`). Transport rules that define every contract below:

- **URL** = `/ajax/<script>.php` where `<script>` is the `script:` key (`squad` for admin-scoped, `public` for the token-authorized upload). Method is always `POST`.
- **Body encoding.** If `data` is a plain object, the helper sets `data.action = <action>` then flattens to a URL-encoded query via `$.map(data, (v,i) => '&'+i+'='+v).join('')`. This yields a body **with a leading `&`** and **arrays stringified by `Array.toString()` (comma-joined)**. If `data` is a `FormData`, it appends `action` to the form and sets `processData=false`, `contentType=false` (multipart).
- **Response envelope** (JSON, `Content-Type: application/json; charset=utf-8`). The helper branches on `text.status`:
  - `status == 'ok'` → `success(text)` fires.
  - `status != 'ok'` **and** `text.auth === true` → hard `location.reload()` (session expired).
  - otherwise → `error(text.msg, null)` → `addAlert(text.msg, …)`.
- Every successful JSON payload observed also carries `exec_time: float` (server wall-clock seconds). `issues_get` additionally returns a `test: { getAdmin: float }` micro-benchmark block.

#### 15.0.1 `issues_get` — list issues (CAPTURED)

Contract source: `caps/issues-video/issues.network.json[1]` (live, status 200).

`POST /ajax/squad.php`

Request body (observed verbatim): `&state=open&page=1&action=issues_get`

| Param | Type | Required | Meaning |
|---|---|---|---|
| `state` | enum `open` \| `closed` | Y | Lifecycle filter. `open` from «Открытые», `closed` from «Закрытые» |
| `page` | int (1-based) | Y | Page index. Server returns a fixed slice (page size 20 observed) |
| `action` | const `issues_get` | Y | Appended by `Action()` |

Response shape (from captured `response_schema`):

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `ok` | Success gate |
| `exec_time` | float | Server exec seconds |
| `test.getAdmin` | float | Server-side timing probe for the admin lookup (seconds) |
| `issues` | array (20 observed → **page size = 20**) | Issue records, newest-id first |
| `issues[].id` | int | Ticket number |
| `issues[].user` | string | **Reporter's admin account name** (e.g. redacted `Enj0y`) — NOT rendered in the card |
| `issues[].title` | string | Issue title / short label, rendered as the card `<label>` |
| `issues[].body` | string | Free-text description (126 chars in sample; capped 512 on create) |
| `issues[].create` | int | **Unix timestamp** — creation time |
| `issues[].update` | int | **Unix timestamp** — last-modified time (currently == `create` in sample; unused by UI) |
| `issues[].state` | string enum `open` \| `closed` | Lifecycle status |
| `issues[].labels` | array of Label | Category tags |
| `issues[].labels[].id` | int | Label id (`1`=Баг, `2`=Предложение) |
| `issues[].labels[].name` | string | Label text (e.g. `Баг`) |
| `issues[].labels[].color` | string | Hex color **without** leading `#` (e.g. `e11d21`); JS prepends `#` |
| `issues[].labels[].url` | string (nullable/empty) | Reserved link target; empty string in all observed rows |

Redacted example (single row, from captured `response_sample`):

```json
{
  "test": { "getAdmin": 0.0062 },
  "issues": [
    {
      "id": 56,
      "user": "<redacted:reporter>",
      "title": "<redacted:title>",
      "body": "При выдаче бана не всегда игрока кикает …",
      "labels": [ { "id": 1, "name": "<redacted:3>", "color": "e11d21", "url": "" } ],
      "create": 1763650640,
      "update": 1763650640,
      "state": "open"
    }
  ],
  "status": "ok",
  "exec_time": 0.516
}
```

> **Schema corrections vs. prior draft.** The record carries three fields the old chapter omitted: `user` (reporter account, distinct from `title`), `update` (second unix timestamp), and `labels[].url` (empty reserved link). `title` is server-derived and returned here — it is confirmed **not** a create-form input (create sends only `body`+`labels`).

#### 15.0.2 `issues_create` — file a new ticket (RECONSTRUCTED, not captured)

Contract source: fragment JS `issues.create.create()` in `issues.content.html`. Not observed on the wire (mutation).

`POST /ajax/squad.php`

Reconstructed body: `&body=<text>&labels=<csv>&action=issues_create` — `labels` is the multiselect `.val()` **array**, comma-joined by `Array.toString()` (e.g. `labels=1,2`; empty selection → `labels=`).

| Param | Type | Required | Meaning |
|---|---|---|---|
| `body` | string, ≤512 chars | Y (no client guard) | `#issuesModal_create-body` textarea |
| `labels` | csv of int ids (`1`,`2`) | N | Selected label ids; empty allowed |
| `action` | const `issues_create` | Y | Appended by `Action()` |

Response: envelope only (`status:'ok'` expected). On success the client discards the response body and re-issues `issues_get('open',1)`, then hides the modal — so a new ticket is assumed to land in `open`; no client-supplied state, id, `title`, or `user` (server derives them). **Destructive: Y** (creates a row).

#### 15.0.3 `uploadVideo_token` — mint a one-time upload link (RECONSTRUCTED, not captured)

Contract source: fragment JS `video.token.gen()`. Not observed (user-triggered).

`POST /ajax/squad.php`

Reconstructed body: `&action=uploadVideo_token` (called with `data:{}` → only `action` present).

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `uploadVideo_token` | Y | Sole param |

Response:

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `ok` | Success gate |
| `token` | string | One-time upload credential, written read-only into `#upload-token` |

Semantics (modal help text): the link is **valid 2 hours** and **usable exactly once**. **Destructive: Y** (mints a credential / server-side state).

#### 15.0.4 `uploadVideo` — upload the MP4 (RECONSTRUCTED, not captured)

Contract source: fragment JS `video.upload()`. Not observed (multipart mutation). **Note the endpoint switch to `public`.**

`POST /ajax/public.php` — `multipart/form-data` (`processData=false`, `contentType=false`)

| Part | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `uploadVideo` | Y | Appended to the `FormData` by `Action()` |
| `name` | string | N (no client guard) | `#video-name` — short title |
| `description` | string | N (no client guard) | `#video-description` — clip description |
| `file` | binary (MP4/AVI) | Y | First file from the drop-zone `input[type=file]` |
| `token` | string \| null | conditional | `getURLParameter('token')` — read from the page URL `?token=…`; null when an authenticated admin uploads directly |

Response: envelope only (`status:'ok'` expected). Client timeout `300000` ms (5 min). Upload progress is metered by the `Action()` `xhr.upload` `progress` listener, which emits `{ total: MB, upload: MB, speed: Mbit/s }` each tick. **Destructive: Y** (uploads + fans out to YouTube/Telegram).

> **Two-endpoint auth split.** Token minting is `script:'squad'` (requires an authenticated admin session); the upload itself is `script:'public'`, authorized by the one-time `token` rather than a cookie. This is the mechanism for delegating a single upload to an otherwise-unauthenticated third party.

---

### 15.1 Bug Tracker (`issues`)

#### 15.1.1 Purpose & layout

A minimal issue tracker for the panel itself (bugs and feature suggestions). Two-column split (from `issues.content.html`):

- **Left rail** (`#issues_list_buttons`, wrapped in `.block-box` `position:fixed; width:240px`): three buttons — `Создать` (Create, `.btn-success`), `Открытые` (Open, `.btn-default`), `Закрытые` (Closed, `.btn-default`).
- **Right column** (`.col-md-8`): `<ul class="list-group" id="issues_list">` (`min-height:130px`), populated by `issues.list.build()`. A `.load_block` spinner overlay shows while `issues.list.get()` runs (parent gets `.load`); an empty result appends `<h3>… Данных нет</h3>` (No data).

No DataTables grid, no server-side search, no column sorting. Filtering is by the two state buttons; paging is by the `page` integer only.

#### 15.1.2 Entity: Issue

See §15.0.1 for the authoritative field-by-field schema. Summary:

| Field | Type | Rendered? | Notes |
|---|---|---|---|
| `id` | int | Yes — `<hashtag>#id</hashtag>` | Ticket number |
| `user` | string | **No** | Reporter account (present in payload, unused by card) |
| `title` | string | Yes — `<label>` | Server-derived |
| `body` | string | Yes — `<p>` | ≤512 chars on create |
| `state` | enum `open`\|`closed` | Yes — `<code>` pill | `open`→green `Открыто` + unlock icon; `closed`→grey `Закрыто` + lock icon |
| `create` | unix int | Yes — `formatDate()` `<small>` | e.g. `20/11/2025 15:57:20` |
| `update` | unix int | No | Present, unused |
| `labels[]` | array | Yes — `<span class="label">` | See below |

Entity: **Label** (embedded array)

| Field | Type | Meaning |
|---|---|---|
| `id` | int | Label id (`1`/`2`) |
| `name` | string | Text, rendered with `fa-tag` icon |
| `color` | string | Hex **without** `#`; JS builds `background-color:#`+`color` |
| `url` | string | Empty in all observed rows (reserved) |

Create-form label options (hard-coded in `#issuesModal_create-labels`):

| `value` | Label | Color | Rendered pill |
|---|---|---|---|
| `1` | Баг (Bug) | `#e11d21` (red) | red `label label-default` |
| `2` | Предложение (Suggestion) | `#207de5` (blue) | blue `label label-default` |

#### 15.1.3 The list ("table")

Rendered as cards, not a `<table>`. `issues.list.build(data)` emits one `<li class="list-group-item">` per issue:

| Card row | Markup | Content |
|---|---|---|
| Header | `<p>` | `<hashtag>#id</hashtag>` + `<label>title</label>` + pull-right state `<code>` pill + `<small>formatDate(create)</small>` |
| Body | `<p>` | `body` verbatim (server-escaped) |
| Labels | `<p>` | one `<span class="label label-default" style="background-color:#{color}">` per label |

Filter / sort / pagination:

| Control | Trigger | Effect |
|---|---|---|
| Open state | `issues.list.get('open',1)` | Fetch `state=open,page=1` |
| Closed state | `issues.list.get('closed',1)` | Fetch `state=closed,page=1` |
| Pagination | `get(state, page)` param exists | **No page-nav UI** — buttons hard-code `page=1`; server supports paging (20/page), frontend does not expose it |

No search box, no per-column sort.

#### 15.1.4 Actions / capabilities

| UI label | Trigger | action | Endpoint | Data keys (types) | Effect | Destructive |
|---|---|---|---|---|---|---|
| Открытые (Open) | `issues.list.get('open',1)` | `issues_get` | `POST /ajax/squad.php` | `state:string`, `page:int` | Fetch open → rebuild list | N |
| Закрытые (Closed) | `issues.list.get('closed',1)` | `issues_get` | `POST /ajax/squad.php` | `state:string`, `page:int` | Fetch closed → rebuild list | N |
| Создать → open modal | `issues.create.show()` | — | client only | — | Opens `#issuesModal_create`, inits multiselect | N |
| Создать → submit | `issues.create.create(this)` | `issues_create` | `POST /ajax/squad.php` | `body:string(≤512)`, `labels:int[]→csv` | Create ticket, reload open list, hide modal | **Y** |

Behavioral notes:

- During `issues_get`, `disable_buttons(true)` calls `.btnload('')` on all three rail buttons; `complete` re-enables via `.btnreset()`.
- On `issues_create` submit, `btn.btnload('Создаём')`; success/error both `btn.btnreset()`.
- **No close / reopen / edit / delete / comment action exists in this fragment.** The `closed` state and `update` field exist in data, but no UI here transitions an issue — admins can only create and read. Thin CRUD surface.

#### 15.1.5 Create modal (`#issuesModal_create`)

| Element | `#id` | Type | maxlength | Options / default | Validation |
|---|---|---|---|---|---|
| Описание проблемы (Problem description) | `issuesModal_create-body` | `textarea` rows=4 | `512` | — | None client-side (empty submit possible) |
| Метки (Labels) | `issuesModal_create-labels` | `<select type="multiselect" multiple>` → Bootstrap `multiselect` | — | opts `1`=Баг, `2`=Предложение; `nonSelectedText:'- Метки -'`, `enableHTML:true`; default none | Optional; sends csv of ids |
| Создать (Create) | — (`onclick`) | `.btn-success` button | — | — | `btnload('Создаём')` during submit |

`enableHTML:true` lets each option's `label` attribute render as a colored pill (`Баг` red / `Предложение` blue) inside the dropdown.

#### 15.1.6 Permissions / visibility

No `class="hide"`, no role/group gating in the fragment. Both read and write actions hit `script:'squad'` — access control is entirely upstream (whether `page.php?page=issues` is served). No DOM-level gating.

---

### 15.2 Video / Demos (`video`)

#### 15.2.1 Purpose & layout

A big-file uploader for demo/evidence videos. Backend fan-out is stated verbatim in the modal: **Браузер → Sqstat → YouTube + Telegram**. Header links target `t.me/sqstat` and YouTube channel `UC8Sofbi4vR6NxD9TJ59KiZg`. Layout (from `video.content.html`):

- **Header row** (`<h3 class="text-center">`): Telegram link, YouTube link, pull-right `Генерировать ссылку` (Generate link) button → `video.token.show()`.
- **Drop zone** `#drag.drop_file_zone` (`height:76vh`): full-height area with `<h2 id="load_state">… Загрузите файлэ</h2>` and a `(2ГБ)` size hint. Contains hidden `<input type="file" accept=".mp4,.avi">`.
- Two modals: `#loadModal` (upload metadata + progress) and `#tokenModal` (token generation).

#### 15.2.2 Entity: Video upload

Fields per §15.0.4. Accepted extensions: `['.mp4','.avi']` (drop handler `dragFile(['.mp4','.avi'])`; the `<input accept>` is rewritten to `.mp4,.avi` by `dragFile`). Advertised ceiling **2 GB**. Client timeout **300 s**.

> **No structured linkage.** The payload carries only free-text `name`/`description` plus `file`/`token` — no match id, server id, round id, SteamID/UUID, or player selector. Any association to a match or offender is human-entered prose, not a foreign key.

#### 15.2.3 Entity: Upload token

| Field | Type | Meaning |
|---|---|---|
| `token` | string | One-time credential from `uploadVideo_token`, shown read-only in `#upload-token` |

Semantics: **valid 2 hours, single use** («Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз»). Intended for delegated uploads — an admin mints a link and hands it to a third party; the upload page reads it from `?token=…` and attaches it to `uploadVideo`.

#### 15.2.4 Actions / capabilities

| UI label | Trigger | action | Endpoint | Data keys | Effect | Destructive |
|---|---|---|---|---|---|---|
| Генерировать ссылку → open modal | `video.token.show()` | — | client | — | Opens `#tokenModal` | N |
| Создать токен (Create token) | `video.token.gen()` | `uploadVideo_token` | `POST /ajax/squad.php` | `{}` (action only) | Returns `token` → `#upload-token` | **Y** |
| Загрузить (Upload) | `video.upload()` | `uploadVideo` | `POST /ajax/public.php` | FormData: `name:string`, `description:string`, `file:binary`, `token:string\|null` | Upload MP4/AVI; backend → YouTube + Telegram | **Y** |

#### 15.2.5 Upload modal (`#loadModal`) — fields & UX

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Название видео (Video name) | `video-name` | text | Placeholder `Название видео`; help «Короткое название видео. Например "Нарушение правил Enj0y"» |
| Описание видео (Video description) | `video-description` | textarea rows=2 | Help «Опишите что происходит на видео» |
| Загрузить (Upload) | `video-upload` | `.btn-success` button | Hidden during upload (`.hide()`); triggers `video.upload()` |
| Progress bar | `load_bar` | `.progress-bar` div | Width % live; inner `<h2>` shows `%` |
| Progress detail | `load_bar-upload_progress` / `load_bar-upload_speed` | spans | `"<upload> / <total> МБ"` and `"<speed> Мбит/c"` |

No client-side field validation (name/description may be blank; only extension is checked in the drop handler). During upload the modal is made non-dismissable: a `hide.bs.modal` handler calls `e.preventDefault()`; on success the handler is detached (`.off('hide.bs.modal')`) after a 4 s delay, on error immediately. On error the bar flips to `.progress-bar-danger` and `#load_state` shows «Не удалось загрузить файл».

Progress metering (`Action()` `xhr.upload` listener, `custom.js:363`): computes `total` MB, `upload` MB, and `speed` in Mbit/s (`((uploadedkBytes/elapsed)/1024)*8`) each tick. Help text warns YouTube has a daily quota (posts «сразу, или на следующий день») whereas Telegram posts «сразу» — differing latency guarantees.

#### 15.2.6 Token modal (`#tokenModal`)

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Token field | `upload-token` | text `readonly` | Displays minted token |
| Создать токен (Create token) | `generate-token` | `.btn-success` button | Calls `video.token.gen()`; `btnreset(600)` cooldown after |
| Help | — | — | «Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз» |

> **Bug.** `gen` is bound as `onclick="video.token.gen()"` (no arg) but the body reads `gen: function(btn){ $btn = $(btn); … }` — `btn` is `undefined`, so `$btn` is an empty jQuery set and the `btnload()`/`btnreset()` spinner silently no-ops. The `Action()` call itself still fires and populates `#upload-token`.

#### 15.2.7 Drag-and-drop mechanics

`$.fn.dragFile(ext)` (`custom.js:451`) wires `#drag`: on `drop` (or `click`) it takes `files[0]`, lowercases the extension, and rejects (`return false`) if `ext.indexOf('.'+file_ext) == -1`. Valid files are injected into the hidden `<input type=file>` via a synthetic `DataTransfer` and re-fired as an `end` event carrying `[file, file.name]`. `dragFile` also rewrites the input `accept` attr to `ext.join(',')` and toggles `.drop_file_zone-hover` on `dragenter`/`dragover`. The fragment's `init()` listens for `end` (open `#loadModal`; a null file → `alert('Ошибка файла')`), plus `start`/`progress`/`error` (console logging only). The `FileReader` binary-read path in `dragFile` is commented out — only the `DataTransfer` injection path is live.

#### 15.2.8 Permissions / visibility

No `class="hide"` or role checks in the fragment. Security is endpoint-based:

- Loading `video` and minting a token require the authenticated `squad` context.
- The `public` upload endpoint trusts the one-time, 2-hour, single-use `token` — the delegation mechanism for non-admins.

---

### 15.3 Competitively interesting takeaways

- **Two-endpoint upload auth (`squad` mint + `public` consume):** clean pattern for player evidence submission without accounts. Easy to beat by binding the token to a specific report/match id so footage auto-links to a case.
- **No structured video↔match/player/report linkage** — only free-text `name`/`description`. A panel that attaches demos to a match/kill/ban record (foreign keys, jump-to-timestamp) is strictly more useful.
- **Fan-out to YouTube + Telegram with quota-aware messaging** — storage externalized to free platforms (2 GB clips), YouTube quota honored. Cheap hosting, but no in-panel playback and inconsistent latency.
- **Bug tracker is create/read only** — `state=closed`, `page`, and `update` exist in the API but no UI wires status transitions, pagination, or edits. A richer tracker (assignee, comments, close/reopen, search, real pagination) is an easy differentiator.
- **Reporter identity is captured but hidden** — `issues[].user` is returned yet never rendered; surfacing "filed by / assigned to" is a trivial UX win.
- **512-char body cap, two labels (Bug/Suggestion)** — deliberately lightweight; for panel feedback, not game moderation.


---

## 16. Settings: Server Config, Rotation, Mods, Restarts

This section is an **implementation spec** for SQSTAT's entire **server-management surface** — the operator-facing tooling that reconfigures, restarts, and reprovisions a live Squad game server. It is built from a **live browser capture** of `settings.php` plus the source fragments (`main.html`, `settings.html`, `custom.js`) that back the RPC actions. The surface spans two physical locations in the SPA:

1. **The `settings` page** (`pageLoad('settings')` → `GET /ajax/page.php?page=settings`) — a Bootstrap tabbed configuration console: server inventory, admin permission groups, in-game rules, canned messages, Discord bot / webhook wiring. Its persistence RPC is `script:'settings'`.
2. **The server dashboard on `main.html`** (the SPA shell, the "Управление" (Management) accordion and its modals) — the live operations tooling: CodeMirror config-file editor, map-rotation editor, mod manager, RCON console, and the start/stop/restart/update lifecycle buttons. **All of these use `script:'squad'`** (map calendar uses `script:'public'`).

> **Attribution note.** The task brief lists the config-editor / rotation / mod / restart actions under "settings," but in the captured markup they physically live in `main.html`, *not* in the `settings.html` fragment. The `settings.html` fragment owns only three `script:'settings'` operations (`getServerSettings`, `setServerSettings`, and the generic bulk save). Both surfaces are documented here because together they constitute the "settings / server-management" competitive area. Each contract below is tagged **[LIVE]** (observed in the browser capture) or **[SOURCE]** (read from the fragment/`custom.js`, fired only on user interaction so not auto-captured).

The shared player-detail modal (Chat/Kills/Deaths/Kits/Games/Comments tabs) is **not** part of this surface and is deliberately excluded.

---

### 16.1 Capture summary (ground truth)

| Item | Value |
|---|---|
| Capture file (network) | `caps/settings/settings.network.json` |
| Capture file (rendered `#content`) | `caps/settings/settings.content.html` (90 072 bytes, 1 679 lines) |
| Blocked mutations | `caps/settings/_blocked.json` = `[]` (0 — interceptor caught nothing; the page fires no writes on load) |
| **Live AJAX contracts captured** | **1** |

**Key structural finding:** loading the Settings console fires exactly **one** network request — the fragment fetch itself. **No `getServerSettings` / `getConfigFiles` / `getRotation` / `getMods` read auto-fires on load.** The entire persisted configuration (servers, all 5 permission groups with their checked tokens, all rules, all canned messages, the full Discord bot + webhook config *including live webhook secrets*) is **server-rendered directly into the fragment HTML** as `data-setting` / `value=""` attributes. Every `script:'settings'` and `script:'squad'` action below is triggered later by a user opening a modal or clicking Save — hence tagged **[SOURCE]**. This server-render-everything model is itself the spec: the client is a thin serializer over a pre-hydrated DOM.

#### Contract: `GET /ajax/page.php?page=settings` **[LIVE]**

| Field | Value |
|---|---|
| Method / path | `GET /ajax/page.php?page=settings` |
| Request params | `page` — string — required — fragment id (`settings`) |
| Status | `200` |
| Content-Type | `text/html; charset=UTF-8` |
| Response length | 85 722 bytes |
| Response body | Raw HTML fragment: an inline `<script>` defining the global `setting` object (save/collect/setData serializers), followed by the `#settings_tabs` tab panes fully hydrated with live data. Not JSON. |

Cite: `caps/settings/settings.network.json`.

---

### 16.2 Bulk-save mechanism (the `settings` script contract) **[SOURCE — inline JS, lines 3–98]**

Every Settings tab shares one generic serializer, `setting.save(btn)`. It prompts a confirm dialog ("Вы точно хотите сохранить настройки?" — *Are you sure you want to save settings?*), builds the payload for the **currently active** tab, then POSTs.

#### Contract: bulk settings save

| Attribute | Value |
|---|---|
| Call | `Action({script:'settings', data:{type, settings}})` |
| HTTP | `POST /ajax/settings.php` |
| `type` | string — required — the active tab's `data-tab`; enum: `servers` \| `groups` \| `rules` \| `squad_messages` \| `discordbot` \| `discord` |
| `settings` | string — required — `JSON.stringify()` of `setting[type].collect()` (per-tab override) or the generic `setting.collect(tab)` |
| Destructive? | **Y** — overwrites the entire config blob for that tab |

`setting.collect(tab)` walks every `[data-setting]` element inside the active tab and encodes by the element's `type` attribute:

| Element `type` | Encoded as | Example keys |
|---|---|---|
| `checkbox` | `1` / `0` (int) | `vip_sync`, `report_enabled`, `licensed` |
| `list` | array of child `[data-list="text"]` values (`dataset.value ?? text()`) | `servers`, `squad_rules`, `squad_messages` |
| `group` | `{description:string, color:string, permissions:[…dataset.perm where :checked]}` | `Admin`, `Moderator`, `QueuePriority`, `Cameraman`, `Intern` |
| *(default)* | raw `.value` string | `guild_id`, `vip_id`, all webhook URLs |

`setting.setData(data)` is the inverse hydrator (only handles `checkbox`→`prop('checked', v=='1')` and default→`.val(v)`).

> **Tab→collect override map:** `servers` and `groups` and `squad_messages` and `discordbot` and `discord` fall through to the generic `collect(tab)`. Only `rules` defines a custom `setting.squad_rules.collect()` — and it is a **stub** (returns `{}` with the real logic commented out; see §16.3 Rules). The rules "Добавить правило" (Add rule) button is rendered `disabled=""`. **Rules editing is non-functional in this build.**

---

### 16.3 Entities & data model

#### Entity: **Server** (`servers` list + `settingServer_modal`) **[SOURCE — lines 172–482]**

The Сервера (Servers) tab renders a **jQuery-UI `.sortable`** list (`[data-setting="servers"][type="list"]`, drag handle `.handle`); drag order defines display order (index letters A, B, C…). The live capture shows **7 servers** (ids 1, 6, 7, 8, 9, 10, 11). Each row: index letter, short name (`data-list="text" data-value="<id>"`), a `Лицензия` (License) badge, a connection dot (green `Подключено` / red `Нет подключения`), a red power-off icon if disabled, and a gear `onclick="setting.server.open(<id>)"`.

**Server modal fields** (`data-input` attrs; input types/maxlengths are the live values):

| Field (`data-input`) | Input | maxlength | Meaning / gloss |
|---|---|---|---|
| `id` | hidden | — | Server PK; empty ⇒ create new |
| `licensed` | checkbox | — | Лицензионный сервер (licensed server) |
| `disabled` | checkbox (danger slider) | — | Сервер неактивный (inactive/disabled) |
| `short` | text | 16 | Индекс — internal server index/short code |
| `ip` | text | 15 | IP address (placeholder `46.174.48.77`) |
| `port` | text | 5 | **Порт JS агента** — port of the rnsquad Node JS agent (placeholder `3000`; confirms an out-of-process per-server agent) |
| `name` | text | 128 | Server display name |
| `ext_short` | text | 16 | Отображаемый индекс (public-facing display index) |
| `chan_id` | text | — | Discord channel ID; channel auto-renamed to a live status string, template `🟢c_100x7_👮2` (green dot / current-map code / player count / admin count) |
| `types` | list of checkboxes (`data-input="types" data-type="list"`) | — | Enabled game modes; `data-value` set: `AAS`, `RAAS`, `Invasion`, `tc`, `Insurgency`, `Destruction` |
| `mods` | list of checkboxes (`data-input="mods" data-type="list"`) | — | Enabled mod flags; `data-value` set: `ge` (Global Escalation), `sd` (Steel Division), `supermod` (SuperMod), `KOTH`, `squadZ` |

**Server actions:**

| UI | Call | data keys | Response | Destructive? |
|---|---|---|---|---|
| gear → open | `getServerSettings` **[SOURCE]** | `server_id:int` | `{server:{…data-input fields…}}` → `form.set(text.server, modal)` | N |
| Save | `setServerSettings` **[SOURCE]** | `form.get(modal)` = every `data-input` field | `{new:bool}` — if `new` truthy → `pageLoad('settings')` full refresh; toast `Сервер сохранён` | **Y** |

> **Read-only gotcha (confirmed live, line 462):** `setForm()` runs `modal.find('input').attr('disabled', true)` after `getServerSettings`, so **editing an existing server through this modal is disabled** — the form is read-only once loaded. Only the `setting.server.new()` path (defaults `{licensed:'1', disabled:'0', port:'0', …}`) leaves fields editable. In-place IP editing happens elsewhere via `setServerIP` (§16.7). A competitor shipping true in-place server editing beats this.

#### Entity: **Permission Group** (`groups` tab) **[LIVE — fully rendered, lines 489–1086]**

Five hard-coded groups, each a `[data-setting="<Group>"][type="group"]` block with `description` (text ≤32, `data-group="description"`), `color` (hex text ≤16, `data-group="color"`, mirrored by a native `<input type="color">`), and a `[data-group="permissions"]` grid of `[data-perm]` checkboxes. The tab links to `https://squad.fandom.com/wiki/Server_Administration`.

**The 21 permission tokens** (the full Squad `Admin`/`Admins.cfg` vocabulary), in rendered order across the 3 columns:

`startvote`, `changemap`, `pause`, `cheat`, `private`, `balance`, `chat`, `kick`, `ban`, `config`, `cameraman`, `immune`, `manageserver`, `featuretest`, `reserve`, `demos`, `clientdemos`, `debug`, `teamchange`, `forceteamchange`, `canseeadminchat`.

A **warning icon** (tooltip **"Не будет логироваться в панели"** — *Will not be logged in the panel*) is attached to exactly three tokens — `changemap`, `kick`, `ban` — flagging that performing those actions via the in-game admin cam/console bypasses SQSTAT's audit log.

**Live default matrix** (● = checked in the captured HTML; group name shows `description` + `color`):

| Token | Admin `#e50606` "Администратор" | Moderator `#2df044` "Модератор" | QueuePriority `#e2b032` "VIP" | Cameraman `#7d059e` "Камера" | Intern `#b57c03` "Стажёр" |
|---|:--:|:--:|:--:|:--:|:--:|
| startvote | | | | | |
| changemap ⚠ | ● | | | | |
| pause | ● | | | | |
| cheat | ● | | | | |
| private | | | | | |
| balance | ● | ● | | ● | ● |
| chat | ● | ● | | | ● |
| kick ⚠ | ● | | | | |
| ban ⚠ | ● | | | | |
| config | ● | | | | |
| cameraman | ● | ● | | ● | ● |
| immune | | | | | |
| manageserver | ● | | | | |
| featuretest | ● | | | | |
| reserve | ● | ● | ● | ● | ● |
| demos | | | | | |
| clientdemos | | | | ● | |
| debug | ● | | | | |
| teamchange | ● | ● | | ● | ● |
| forceteamchange | | | | | |
| canseeadminchat | ● | | | ● | ● |

Interpretation: **Admin** = near-superuser (everything except `startvote`, `private`, `immune`, `demos`, `clientdemos`, `forceteamchange`); **QueuePriority** = reserve-slot only (pure VIP queue-skip, no admin powers); **Cameraman** = spectator/demo role (`cameraman`+`clientdemos`); **Moderator**/**Intern** = light in-game QoL (`balance`/`chat`/`teamchange`) with **no `kick`/`ban`/`config`/`manageserver`**. This matrix is the RBAC template a competitor should benchmark against.

`groups`-tab save payload (per group): `{"<Group>": {description, color, permissions:[…checked data-perm…]}}` for all 5, wrapped by the bulk save (§16.2).

#### Entity: **Rules** (`rules` tab, `data-tab="rules"`) **[SOURCE — lines 1099–1250]**

Two-level: **categories** (`[data-setting="squad_category"]`, sortable `nav-tabs`, added by `setting.squad_rules.category.add()`) each containing **rules** (`[data-setting="squad_rules"][type="list"]`, `contenteditable` `[data-list="text"]` items). A "Прогрессивная система" (Progressive-punishment ladder) toggle. Add-rule button is **`disabled`**; the live `squad_rules` list is inside a `.hide` container holding a 24-item Russian rulebook (permaban, TK, solo-vehicle bans, CMD obedience, legible-nick rule, DPAC anti-cheat note, etc.). A drag-to-trash zone (`.sortable_delete`, red dashed) deletes items.

> **Stub finding (confirmed, lines 1223–1243):** `setting.squad_rules.collect()` builds `let rules = {}` and `return rules` with the real serializer commented out. Combined with the disabled Add button, **rules cannot be saved** — the feature is scaffolded but inert.

#### Entity: **Canned Messages** (`squad_messages` tab) **[LIVE — lines 1251–1311]**

Flat sortable list (`[data-setting="squad_messages"][type="list"]`, `contenteditable`). Live capture holds **17** pre-written admin warn/broadcast strings (VIP grant notice, solo-vehicle warnings, squad-lock rules ("close squads only from 2 players"), tandem-kit ban, non-readable-nick warning, TK-apology prompt, report-received ack, etc.). `addMessage()` prepends a new editable `Text` item; drag-to-trash deletes. Saved via the generic bulk save as `squad_messages: [string]`.

#### Entity: **Discord Bot config** (`discordbot` tab) **[LIVE — lines 1312–1524]**

Bot invite is hard-coded: `https://discord.com/oauth2/authorize?client_id=532918416151937044`. All fields are `[data-setting]`; `*_sync`/`*_notify` are checkboxes (→ `1`/`0`), `*_id` are raw-string channel/role IDs.

| Key(s) | Type | Live value (redacted) | Meaning |
|---|---|---|---|
| `guild_id` | text | `1112342015800262696` | Discord guild ID |
| `vip_sync` / `vip_id` | checkbox● / text | `1179562293600727115` | Sync VIP role (default **on**) |
| `moderator_sync` / `moderator_id` | checkbox / text | ∅ | Sync moderator role |
| `moderatorInactive_sync` / `moderatorInactive_id` | checkbox / text | ∅ | "Inactive" role for mods with <10 h/month |
| `customRole_notify` / `customRole_id` | checkbox / text | ∅ | Announce role grants in a channel |
| `top1Kill_sync` / `top1Kill_id` | checkbox / text | ∅ | Role for **top-5 kills**, last 7 days (Discord-linked only) |
| `top1Medic_sync` / `top1Medic_id` | checkbox / text | ∅ | Role for **top-5 revives**, last 7 days |
| `topCMD_sync` / `topCMD_id` | checkbox / text | ∅ | Role for **top-3 CMD**, last 7 days |
| `topSL_sync` / `topSL_id` | checkbox / text | ∅ | Role for **top-5 squad leaders**, last 7 days |
| `topVehicle_sync` / `topVehicle_id` | checkbox / text | ∅ | Role for **top-5 mechanics/vehicle**, last 7 days |
| `topMortar_sync` / `topMortar_id` | checkbox / text | ∅ | Role for **top-3 mortarmen**, last 7 days |
| `clanKiller_sync` / `clanKiller_id` | checkbox / text | ∅ | Role for **top-5 "clan slayers"** |
| `pilot_sync` / `pilot_id` | checkbox / text | ∅ | Role for **top-5 pilots**, last 7 days |
| `knifeKiller_sync` / `knifeKiller_id` | checkbox / text | ∅ | Role for knife kills |
| `seeders_sync` / `seeders_id` / `seeders_hours` | checkbox / text / text | ∅ (placeholder `20`) | Seeder role above `seeders_hours` hours/month |
| `playtime_sync` + `playtime{100,300,500,1000,2000,3000,5000}_id` | checkbox / 7×text | ∅ | Tiered playtime roles at 100/300/500/1000/2000/3000/5000 hours |

This is a **large, differentiated Discord gamification engine** — auto-awarding a dozen leaderboard-derived roles plus tiered playtime/seeder roles. Arguably the single richest feature in the panel to match or exceed.

#### Entity: **Discord Webhooks** (`discord` tab) **[LIVE — lines 1525–1673]**

Warning banner: "Не отправлейте эти значения или скриншоты… кому либо" (*don't share these values/screenshots*). Each row = an `_enabled` checkbox (→ `1`/`0`) + a webhook-URL / channel-ID text field.

| Key(s) | Default | Purpose (gloss) |
|---|---|---|
| `report_enabled` / `report` | off | In-game `!r` / `!report` destination |
| `log_enabled` / `log` | **on** | Moderation journal (bans + map changes) |
| `alert_enabled` / `alert` + `alert_everyone` | off | Alert when a **marked** player joins; `@everyone` when a joiner's IP matches a ban |
| `cheater_enabled` / `cheater` | off | Cheater notifications |
| `grief_enabled` / `grief` | off | FOB/HAB destruction (griefing) events |
| `crash_enabled` / `crash` | off | Server-crash notifications |
| `endmatch_enabled` / `endmatch` + `endmatch_broadcast` | off | Match-end summary; optional in-game broadcast |
| `weekend_enabled` / `weekend` | **on** | Weekly stats image |
| `monitoring_enabled` / `monitoring_id` / `monitoring` | **on** | Server-monitoring channel + webhook |
| `request_enabled` / `request` | **on** | Admin-application submissions (links `/request.php`) |
| `collab_ban_enabled` / `collab_ban` | **on** | Push bans to a **cross-server ("межсервер")** Discord |
| `collab_warn_enabled` / `collab_warn` | **on** | Push suspicious players cross-server |

> **CRITICAL PRIVACY / SECURITY FINDING (confirmed live).** Six of these fields render **real, un-redacted Discord webhook URLs with their bot tokens** directly into the HTML `value=""` attributes — `log`, `weekend`, `monitoring`, `request`, `collab_ban`, `collab_warn`. Any admin who can open the Settings page reads every webhook secret from page source (the banner ironically warns against sharing screenshots of the very tokens it leaks). Shape only, single redacted example: `https://discord.com/api/webhooks/<19-digit-id>/<68-char-token>`. **Do not replicate this** — store webhook secrets server-side, never echo tokens into markup; expose only a masked/"configured" indicator.

#### Entity: **User settings** (personal, `player` script) **[SOURCE — player_profile.html]**

`userSettings` modal, saved via `saveUserSettings`:

| Key | Options | Meaning |
|---|---|---|
| `lang` | `ru` / `en` | Panel language |
| `theme` | `0` (light) / `dark` | Panel theme |
| `show_country` | `hide` / `show` | Show player country flags on the main page |

---

### 16.4 Live API Contracts — server-management (`script:'squad'` / `'public'`) **[SOURCE — main.html]**

These actions do **not** auto-fire on the Settings page; they are triggered from the `main.html` "Управление" accordion and its modals. Every one below was read from source (`main.html` line refs cited). `server_id` is the ambient active-server global unless noted. Each write is wrapped in a `$.question` confirm and uses `retryAbort:false` (no silent auto-retry).

#### 16.4.1 Config-file editor (`configEditor`, lines 7394–7620)

Modal-xl split view: left CodeMirror (`mode:"properties"`, line numbers, `spellcheck=false`), right file browser `#configEditor_files`. CodeMirror assets lazy-load on first open. `configEditor.server_id` is set at open (line 7394).

| UI label | action | data keys (types) | Response shape | Destructive? |
|---|---|---|---|---|
| *(browse)* | `getConfigFiles` | `server_id:int` | `{files: { <dirName>: { files:[ {name:string, date:unix-ms, symlin:bool} ] } }}` — grouped by dir; empty dirs skipped; `symlin` renders a link icon; `date` via `moment(...).format('DD.MM.YYYY HH:mm')` | N |
| *(open file)* | `getConfigFile` | `server_id:int, file:string, dir:string` | `{text:string, hasDefault:bool}` — `text`→CodeMirror; `hasDefault` toggles the Default button | N |
| Сохранить (Save) | `saveConfigFile` | `server_id:int, text:string(encodeURIComponent), file:string, dir:string` | `{}` | **Y** — overwrites the config file on disk |
| По-умолчанию (Default) | `getDefaultConfig` | `file:string` *(no server_id)* | `{text:string}` → read-only compare pane; for `Server.cfg` also reveals the client-only Merge button | N |
| Перезагрузить (Reload) | `reloadConfig` | `server_id:int` | `{}` | **Y** — hot-reload server config |
| Отмена (Cancel) | *(local)* `configEditor.cancel()` | — | re-fetches current file (discards edits) | N |
| Пересобрать (Merge) | *(client-only)* `configEditor.merge()` | — | `Server.cfg` only: merge current values over default template in-browser | N (until saved) |
| Скролл (Sync scroll) | *(local)* | — | lock scroll between the two editors | N |

> **Latent bug (confirmed, lines 7543 & 7565):** `saveConfigFile` and `reloadConfig` send the **ambient global `server_id`**, not `configEditor.server_id`. If the editor is ever opened for a non-active server, the save/reload targets the *wrong* server. Also there is **no client-side permission check** on save/reload — the boundary is entirely server-side. Hidden/disabled backup controls exist (`#configEditor_backup-save`, `#configEditor_backup-delete`, a "Текущая" version dropdown — all `class="hide"`/`disabled`): an in-progress config-versioning feature. Shipping visible config backups + a save diff beats this.

#### 16.4.2 Map-rotation editor (`mapRotation`, lines 5800–5965; `script` = `mapRotation.mode`, passed as `'squad'`)

Weekday tabs: **Стандартная (Default)** + Пн–Вс (Mon–Sun, `data-day` 1–7). Each day icon = ✔ green if a custom list exists, ✘ red if it falls back to default; the current active day gets `.current`.

| UI label | action | data keys (types) | Response shape | Destructive? |
|---|---|---|---|---|
| *(load)* | `getRotation` | `server_id:int` | `{rotation:{lists:{default, "1".."7"}, current:int(1–7), isWin:bool}, list:{<layer>:{teams:[…]}}, canEdit:bool}` | N |
| Изменить → Сохранить | `setRotation` | `server_id:int, rotation:string(encodeURIComponent of textarea), day:int` | `{}` → re-runs `getRotation(day)` | **Y** — overwrites that weekday's rotation |

Edit modal is a raw `<textarea rows=30>` (one layer per line; `//` comments honored). Each line renders with faction-flag icons resolved from `list[layer].teams`. **Permission gate:** `getRotation.canEdit=false` ⇒ textarea `readonly`, Save/Cancel hidden (clean server-authoritative read-only). If `rotation.isWin` is truthy, `#serverMapRotation_tabs` is hidden entirely (a win-based/seeding rotation mode). Per-weekday rotations are a differentiator worth matching.

#### 16.4.3 Map calendar (`mapCalendar`, `script:'public'`)

FullCalendar widget of which layers were played on which dates.

| action | script | data keys | Response | Destructive? |
|---|---|---|---|---|
| `mapCalendar` | **public** | `start:unix, end:unix, server_id:int` | `{maps:[…events]}` | N |

Read-only and served by the **`public`** script (not `squad`) — map history is a lower-privilege read. A competitor could expose this as a shareable public "what's been played" view.

#### 16.4.4 Mod manager (`modManager`, lines 7789–7945)

Lists installed Steam Workshop mods with a live install-progress poller. `modManager.parseUrl()` accepts a raw workshop URL or bare ID.

| UI label | action | data keys (types) | Response shape | Destructive? |
|---|---|---|---|---|
| *(list / poll)* | `getMods` | `server_id:int, only_status:bool` | `{mods:[{publishedfileid, …}], mod_status:{mod_id, …}}` — `only_status:true` polls just install progress | N |
| Установить (Install) | `installMod` | `server_id:int, mod_id:string, fix:true` | `{}` | **Y** — download/install a workshop mod |
| Удалить (Delete) | `deleteMod` | `server_id:int, mod_id:string` | `{}` | **Y** — remove an installed mod |

During an active install, `getMods` returns `mod_status`; UI shows a spinner ("Идёт установка мода <mod_id>") and **auto-polls every 5 s** (`only_status:true`) while the modal is open, then re-fetches the full list on completion. Both install and delete are confirm-gated.

#### 16.4.5 Server lifecycle & restart actions (lines 1085–2110)

All in the "Управление" accordion. Every write is `$.question`-confirmed, `retryAbort:false`; lifecycle actions call `blockServerButtons(true)` to lock the start/stop/restart/update buttons in-flight.

| UI label | action | script | data keys (types) | Effect | Destructive? |
|---|---|---|---|---|---|
| Включить (Start) | `start` | squad | `server_id:int` | Boot the game server | **Y** |
| Выключить (Stop) | `stop` | squad | `server_id:int` | Shut down the server | **Y** |
| Рестарт (Restart) | `restart` | squad | `server_id:int` | Restart the server process | **Y** |
| Обновить (Update) | `update` | squad | `server_id:int, afterMapChange:bool` | Update server; `afterMapChange` (checkbox `#afterMapChange`, value `1`) defers until next map change | **Y** |
| RCON restart | `rconRestart` | squad | `server_id:int` | Restart the RCON connection | **Y** |
| Cacher restart | `cacherRestart` | squad | `server_id:int` | Restart the Steam Query/A2S cacher | **Y** |
| Parser restart | `parserRestart` | squad | `server_id:int` | Restart the log-journal parser | **Y** |
| Обновить бота (Update bot) | `botUpdate` | squad | *(none)* | Update the Discord bot (global; no server_id) | **Y** |
| IP change | `setServerIP` | squad | `server_id:int, ip:string` (sent as raw query string, from `#server_ips` multiselect `onChange`) | Rebind the server IP; toast `Вы IP адрес`; hint to restart to apply | **Y** |
| *(change map)* | `getServerMaps` | squad | `server_id:int` | List layers/factions for the change-map modal | N |
| Monitoring chart | `serverMonitor` | squad | `start:unix, end:unix, server_id:int` | Time-series metrics for the monitor charts | N |
| RCON console | `rconRaw` | squad | `server_id:int, command:string` | Send a raw RCON command | **Y** |

`update`'s **"После смены карты" (after map change)** deferral applies maintenance at the next natural map break instead of dropping players mid-round — a player-friendly touch worth copying. `botUpdate` also surfaces as an inline "Версия бота неактуальна" (bot out of date) dashboard banner.

---

### 16.5 Permission & visibility logic (predicates)

- **Server-authoritative read-only** is the dominant pattern:
  - `getRotation.canEdit === false` ⇒ rotation textarea `readonly`, Save/Cancel hidden.
  - `getServerSettings` success ⇒ `modal.find('input').attr('disabled', true)` (existing-server form is read-only).
  - `getRotation.rotation.isWin === true` ⇒ weekday tabs hidden.
  - `getConfigFile.hasDefault === true` ⇒ Default button shown; `file === 'Server.cfg'` ⇒ Merge button shown.
- **No visible client-side permission check** guards `saveConfigFile` / `reloadConfig` / lifecycle actions — enforcement is entirely server-side (PHP). The 21-token group model (§16.3) is the RBAC vocabulary; `manageserver`, `config`, `ban`, `kick` are the sensitive tokens, and the panel warns `changemap`/`kick`/`ban` performed in-game aren't audit-logged.
- **Hidden in-progress features** (`class="hide"` / `disabled`): the Основное (Main) settings tab (`#setting_main`, `li.disabled.hide`), config-editor backups + version dropdown, and the disabled rules Add-rule button. These reveal the rival's roadmap: general settings, config versioning/backups, and functional rules editing.

---

### 16.6 Competitively interesting details (copy / beat)

1. **Discord gamification engine** (§16.3) — auto-award a dozen leaderboard-derived roles (top killer/medic/CMD/SL/mechanic/mortar/pilot/knife/clan-slayer) + tiered playtime + seeder roles, all scoped to Discord-linked players and a 7-day window. The single richest feature to match or exceed.
2. **Per-weekday map rotations** with a visual ✔/✘ schedule and a `isWin`/seeding rotation mode.
3. **Update "after map change" deferral** — player-friendly maintenance.
4. **Live mod-install progress polling** (5 s) and **CodeMirror config editing with side-by-side default + Server.cfg merge**.
5. **Cross-server ("межсервер") ban & warn propagation** via shared Discord webhooks — a network-effect feature for server communities.
6. **Things to beat, not copy:** (a) live Discord webhook **tokens leaked into page HTML** (six fields) — a real secret-exposure bug; keep secrets server-side. (b) The server-settings modal is **read-only for existing servers**; ship true in-place editing. (c) The **rules-save serializer is a stub** (`collect()` returns `{}`, Add button disabled) — rules editing is inert. (d) Config saves aren't diffed/versioned/backed-up (feature present but hidden). (e) `saveConfigFile`/`reloadConfig` read the ambient global `server_id` rather than the editor's own — a latent cross-server write bug.


---

## 17. Admin Audit Journal (Журнал)

### 1. Purpose and Navigation

The **Журнал** (Journal / Audit Log) is a read-only, server-side-paginated audit trail of admin actions performed through the SQSTAT panel. It answers "who did what, on which server, and when."

- **Nav item:** calls `pageLoad('logs')` → `GET /ajax/page.php?page=logs` (`ctype: text/html`, ~114 KB fragment), whose HTML is injected into `#content`.
- **Table bootstrap:** an inline `<script>` at the bottom of the fragment calls `$('#logTable').buildTable({ table:'logs', collum:['serverName','name','date','log'], numrows:100, searchInput:[...], end:<hashtag binder> })`.
- The page is a single filter bar plus one server-driven table (`#logTable`). It has **no state-changing controls of its own** — the only interaction beyond filtering is clicking a `<hashtag>` player token inside a row to open the shared player modal.

**Ground truth:** all contract facts below are captured from a live authenticated headless session against `https://breaking.sqstat.ru`. Capture files: `caps/logs/logs.network.json` (3 AJAX contracts), `caps/logs/logs.content.html` (rendered `#content`). `_blocked.json` is empty — no mutating request was issued (read-only page, as expected).

---

### 2. Live API Contracts

The page issues **one GET** (fragment) and **two POSTs** to `/ajax/table.php` — a deliberate two-phase load: phase 1 returns the page rows fast (`count_time: 0`, `totalRows: 0` deferred); phase 2 runs the expensive `COUNT(*)` only when needed. Both POSTs are dispatched through the generic `Action({script:'table', action:'logs', data:...})` helper (`custom.js:284`), which posts `application/x-www-form-urlencoded` to `/ajax/<script>.php`.

#### 2.1 `GET /ajax/page.php?page=logs` — page fragment

| Param | Type | Required | Meaning |
|---|---|---|---|
| `page` | string enum | yes | View id; `logs` for this page. |

Returns the raw HTML `#content` fragment (filter bar + empty `<table id="logTable">`). No JSON. `status: 200`, `text/html; charset=UTF-8`.

#### 2.2 `POST /ajax/table.php` (phase 1 — rows) — the audit query

Captured body (`caps/logs/logs.network.json`, contract #2), URL-decoded:

```
action=logs
table=logs
page=1
numrows=100
search={"text":{},"check":{},"multiselect":{},"managers":{},"slider":{}}
order_by=false
order_sort=false
```

**Request params:**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string enum | yes | Server handler = table id. Always `logs`. |
| `table` | string enum | yes | Same value `logs` (redundant with `action`; `buildTable` sends both). |
| `page` | int (1-based) | yes | Page number. Row window is `[(page-1)*numrows, page*numrows)`. |
| `numrows` | int | yes | Page size. Bootstrap value `100`. |
| `search` | JSON string (URL-encoded) | yes | Filter object, always the 5 fixed buckets `{text,check,multiselect,managers,slider}`; empty `{}` = no filter. See §5 for key set. |
| `order_by` | string \| `"false"` | yes | Sort column DB-alias, or literal `false` when unsorted. Logs page always sends `false`. |
| `order_sort` | `"asc"` \| `"desc"` \| `"false"` | yes | Sort direction, or literal `false`. Logs page always sends `false`. |

**Response** (`application/json`, `status:200`), schema from capture:

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `"ok"` | Request status. On `auth===true` (not `ok`) the client calls `location.reload()` (re-auth bounce). |
| `exec_time` | float — seconds | Total server handler time (e.g. `0.022`). |
| `data.totalPage` | int | `0` in phase 1 (count deferred to phase 2). |
| `data.totalRows` | int | `0` in phase 1 (deferred). |
| `data.currentPage` | string — 1-based | Echo of requested page, as string (`"1"`). |
| `data.custom` | bool | Whether a custom result set is returned. `false` for logs. |
| `data.query_time` | float — seconds | Row-fetch time (e.g. `0.02`). |
| `data.count_time` | int/float — seconds | `0` in phase 1 (no COUNT run). |
| `data.row` | array (len ≤ `numrows`) | Audit rows. Row object schema below. |

**`data.row[]` object** (per captured `response_schema` / redacted `response_sample`):

| Field | Type | Meaning |
|---|---|---|
| `id` | string — numeric PK (6-digit observed, e.g. `"262459"`) | Audit-row primary key. Monotonic, gaps present (`262459, 262458, 262457, 262456, 262455, 262453…`) → auto-increment, effectively newest-first. Rendered as `<tr id="trID-<id>" data-id="<id>">`. |
| `server_id` | string int (`"0"`, `"1"`…) | FK to server. `"0"` = panel-global event (no game server; e.g. login) → `serverName` empty. |
| `steam_id` | string — 36 chars (UUID-shaped) | Internal player identity of the event subject. **Returned but not rendered** — no column maps it (see §3 Finding). Distinct from the 17-digit SteamID64 embedded inside `log` text. |
| `date` | string — **UNIX timestamp** (10-digit seconds, e.g. `"1783146994"`) | Event time. Rendered client-side (§3) into a relative badge. |
| `log` | string — free text / HTML | Human-readable action description (Russian). May embed `<b>`, `<i>`, and `<hashtag>SteamID64</hashtag>` tokens. Example values in §6. |
| `name` | string | Display name of the acting admin (e.g. `[BSS] seregatipich`). |
| `serverName` | string (may be empty) | Denormalized server label (e.g. `RAAS/AAS #1`). Empty when `server_id="0"`. |

Redacted phase-1 sample row:

```json
{ "id":"262459", "server_id":"0", "steam_id":"<uuid:36>",
  "date":"1783146994", "log":"Авторизовался",
  "name":"<redacted>", "serverName":"" }
```

#### 2.3 `POST /ajax/table.php` (phase 2 — pagination count)

Identical body to phase 1 **plus `&pagination=true`**. Fired by `getPagination()` (`custom.js:986`) only when the phase-1 page came back full (`rows == numrows`) **or** `currentPage != 1` — i.e. it's skipped entirely when the whole result fits on page 1 (then `Всего` is taken from the row count directly).

**Response** (captured contract #3):

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `"ok"` | Status. |
| `exec_time` | float — seconds | Handler time (e.g. `0.069`). |
| `totalPage` | int | Total pages = `ceil(totalRows/numrows)`. Live value `1105`. |
| `totalRows` | **string** — integer | Total matching rows, as string. Live value `"110488"` (~110 K audit records). |
| `count_time` | float — seconds | Cost of the `COUNT(*)` (e.g. `0.06`) — isolated here so it never blocks the row render. |

`totalRows` / `totalPage` drive the pager and the `Страница X из Y — Всего: N` (Page X of Y — Total: N) info line, both `Intl.NumberFormat`-grouped.

---

### 3. The Page's Own Table (`#logTable`)

**Rendered columns** (`<thead class="table-dark">`, from `logs.content.html`):

| # | `<th>` | Width | Align | `collum` key → `data-contact` | Render |
|---|---|---|---|---|---|
| 1 | Сервер (Server) | 200px | left | `serverName` | Raw string wrapped in `<code>` when non-empty; blank for global events. |
| 2 | Админ (Admin) | auto | left (`class="contact_name"`) | `name` | `<p class="text-center mb-0"><b>{name}</b></p>`. |
| 3 | Дата (Date) | 120px | center | `date` | `formatDate(unix, badge=true, checkdate=true)` → `<span class="badge bg-success" data-unix="{unix}">{label}</span>`. |
| 4 | Действие (Action) | auto | left | `log` | Free HTML string, verbatim (may contain `<b>`/`<i>`/`<hashtag>`). |

**Date badge logic** (`formatDate`, `custom.js:132-158`): label is relative via `checkToday()` — same calendar day → `Сегодня` (Today), day-1 → `Вчера` (Yesterday), else `DD.MM.YYYY`; time suffix `HH:MM:SS` always appended. Badge color: `bg-important` only if `!checkdate && date*1000 < Date.now()`; because the logs column passes `checkdate=true`, all rows render `bg-success` (green). Example: `<span class="badge bg-success" data-unix="1783146994">Сегодня 08:36:34</span>`.

**DataTables config (exact):**

| Property | Value | Note |
|---|---|---|
| Server table id (`action`/`table`) | `logs` | |
| `collum` | `["serverName","name","date","log"]` | Column→row-key map. `steam_id`, `server_id`, `id` are returned but unmapped (see Finding). |
| `numrows` (page size) | `100` | |
| `order` | `[]` (omitted) | **No column sorting wired.** `buildTable` only attaches header sort handlers + `<i data-sort>` icons when `order` is non-empty (`custom.js:797-838`); logs opts out. |
| `order_by` / `order_sort` | `false` / `false` | Always literal false → server default order (id-desc ≈ newest-first). |
| `showPages` | `9` desktop / `3` mobile | Pager window radius around current page. |
| `showOnePage` | `true` | Renders the `Всего` info line even for a single page. |
| `floatHead` | `true` | Sticky header; scrolls table into view on (re)build. |
| Default sort | none sent → **server default** (newest first) | |

**Finding — returned-but-unrendered identity.** The phase-1 row carries `steam_id` (36-char UUID) and `server_id`, yet `collum` maps neither. The clickable player token in column 4 is a **17-digit SteamID64** embedded inside the `log` free-text (e.g. `<hashtag>7656119XXXXXXXXXX</hashtag>`), not the row's `steam_id` field. So the audit surface exposes two different identifiers for the same subject (a UUID it doesn't display + a SteamID64 baked into prose), and drill-down keys off the string inside the message, not a structured FK.

---

### 4. Two-Phase Request Sequence (reference)

```
buildTable(#logTable)
  ├─ preGetTable() → query = ["logs", "&table=logs&page=1&numrows=100&search=<json>&order_by=false&order_sort=false"]
  ├─ getTable()               POST /ajax/table.php  (rows; timeout 120 s)   → data.row[], currentPage
  │     └─ build()            renders <tbody>, then getPagination(rows)
  └─ getPagination(rows)
        └─ if rows==100 or currentPage!=1:
             Action(...data + "&pagination=true")  POST /ajax/table.php     → totalPage, totalRows
             → renders pager + "Страница X из Y — Всего: N"
```

`Action()` (`custom.js:284`) aborts any in-flight request of the same name before firing (`retryAbort`), so rapid re-filters don't stack. On non-`ok` with `auth===true` it forces `location.reload()`.

---

### 5. Filters / Search Controls

Wired via `searchInput: ["logTable-user","logTable-name","logTable-startdate","logTable-enddate","logTable-server"]`. `buildTable` reads each input's `data-search` alias + `type` and bins it into the `search` JSON (`custom.js:733-778`). Only non-empty inputs are emitted; `+` is escaped to `%2B` in multiselect values.

| Control | `#id` | `data-search` alias | Input type | Placeholder | Search bucket | Behavior / validation |
|---|---|---|---|---|---|---|
| Admin name | `logTable-user` | `t2.player` | text | Администратор (Administrator) | `text` | Substring match on acting admin. |
| Action text | `logTable-name` | `t1.log` | text | Действие (Action) | `text` | Free-text substring over the `log` description. |
| From date | `logTable-startdate` | `t1.startdate` | text, `readonly` (datetimepicker) | От (From) | `text` | Lower bound. Bootstrap datetimepicker `language:'ru'`, `pickTime:true`, side-by-side. `readonly` → only picker sets it. Clear addon `onclick="$('#logTable-startdate').val('')"`. |
| To date | `logTable-enddate` | `t1.enddate` | text, `readonly` (datetimepicker) | До (To) | `text` | Upper bound. Same picker. Clear addon zeroes it. |
| Server | `logTable-server` | `server_id` | `multiselect` (`multiple`) | `- Сервер -` | `multiselect` | `bootstrap-multiselect`, HTML-enabled, multi-value → array of `server_id`. |
| Search | `logTable-btn` | — | button | Поиск (Search) | — | Fires `buildTable` rebuild with `isSearch:true, page:1`. |

**Server multiselect options** (live `<option value label>` set — non-contiguous ids confirm `server_id` is a DB PK):

| `server_id` | Label |
|---|---|
| `1` | RAAS/AAS #1 |
| `6` | БЕЗ ГОЛОСОВАНИЯ #2 (No-voting #2) |
| `7` | INVASION #3 |
| `9` | Custom для FW |
| `10` | Custom для MDC |
| `11` | Custom для BSS |

`server_id=0` (panel-global) is **not** a filter option — global events are only reachable by leaving the server filter empty.

**Resulting `search` JSON shape** (empty when unfiltered, as captured):

```json
{
  "text":        { "t2.player":"<admin>", "t1.log":"<text>",
                   "t1.startdate":"<unix|datestr>", "t1.enddate":"<unix|datestr>" },
  "check":       {},
  "multiselect": { "server_id":["1","7"] },
  "managers":    {},
  "slider":      {}
}
```

Filter aliases reveal the server join: `t1` = the logs table (`t1.log`, `t1.startdate`, `t1.enddate` range on the timestamp, `server_id`), `t2` = the admins/players table (`t2.player`). Note: clearing a date field does **not** auto-refresh — the user must press Поиск (or Enter in a text field).

---

### 6. Logged Action Strings (`log` semantics)

`log` is stored/returned as a **rendered Russian string**, not a normalized `{action_type,target,params}` record — filtering is substring-only. Distinct action templates observed in the live 100-row page (counts in parentheses):

| `log` template (Russian) | English gloss | Structure |
|---|---|---|
| `Авторизовался` (n=2) | Logged in / Authenticated | Bare verb. `server_id=0`, no server, no target. Session-level audit. |
| `Зашёл в камеру` (n=94) | Entered admin cam (spectator) | Bare verb; carries `server_id`/`serverName`. Dominant event type. |
| `Забанил <b>{name}</b> <hashtag>{steamid64}</hashtag> на <b>{N}</b> дн <i>"{reason + до DD.MM.YYYY HH:MM}"</i>` | Banned {player} for {N} days, reason … | Target SteamID64 as clickable token; duration + expiry + reason embedded in prose. |
| `Разбанил <b>{name}</b> <hashtag>{steamid64}</hashtag> ({steamid64})` | Unbanned {player} | Target twice (token + parenthetical). |
| `Отправил сообщение <b>{tag}</b> <hashtag>{steamid64}</hashtag> - "{message}"` | Sent message to {player} — "…" | In-game admin DM; message body quoted. |

The panel writes login, admin-camera entry, ban, unban, and admin-message events (and, per the shared action catalog, presumably kick/kits/mark/twink/group-change etc.) as free text. Because everything is one string, "all bans by admin X this week" is only answerable by substring-matching `Забанил` in `t1.log` — brittle.

---

### 7. Actions Available on This Page (Permissions/Capabilities)

The audit journal is deliberately **read-only** — no ban/kick/edit/delete/export control of its own.

| UI trigger | Action | Endpoint | Data params | Effect | Destructive? |
|---|---|---|---|---|---|
| Load / filter / paginate | `Action({script:'table', action:'logs'})` | `POST /ajax/table.php` | `table=logs&page&numrows=100&search&order_by=false&order_sort=false[&pagination=true]` | Fetch audit rows / count. | N (read) |
| Click a `<hashtag>` in a row | `player.open($(this).text())` | — (opens shared `#playerModal` via `player`/`squad` scripts) | SteamID64 from the token text | Opens player-detail modal for the referenced subject. | N |

`end` callback binds: `$('#logTable tbody > tr hashtag').on('click', …) → player.open($(this).text())` — every SteamID64 rendered in a log line is a drill-down into the shared modal.

> The action tokens pre-extracted for `logs.html` in `action_catalog.txt` (`ban, kick, kill, kits, mark, message, twink, unban, addComment, getComments, changeGroup, changeTeam, checkBans, findFriends, removePlayer, addBanName, removeBanName, twinkOnline, getPlayerOnlineData, downloadStat, kitSave, get`) plus `script:'player'`/`script:'squad'` all belong to the **embedded shared player modal**, NOT to the audit journal. They are what the modal can do to whatever player you open from a log row — do not attribute them to this page.

---

### 8. Permission / Visibility Logic

- The journal's own markup contains no per-element `hide`/role gating — it is one filterable table. (All `hide`/`display:none` in the fragment are inside the shared `#playerModal`.)
- Access control is therefore **page-level**: server-side gating of `pageLoad('logs')` by admin group. The fragment assumes the requester is authorized.
- Session expiry is handled transparently by `Action()`: a non-`ok` response with `auth===true` triggers `location.reload()` → login bounce (no stale audit data).
- The server-global rows (`server_id=0`, e.g. logins) have no server filter path, so a per-server admin filtering by their server would never see panel-level login events — an intrinsic visibility gap.

---

### 9. Retention & Scale (observed)

- Live `totalRows = 110488` across `totalPage = 1105` at 100/page. `page` is unbounded and the date filter defaults to empty (full history). No client-side age cap or rotation notice.
- `id` is a dense-ish auto-increment (small gaps from deleted/rolled-back events) — the sequence itself implies long-lived accumulation, not a rolling window.
- Retention/rotation, if any, is enforced server-side and is not observable from the client. The isolated `count_time` (§2.3) suggests the count query is non-trivial at this row volume — hence the two-phase deferral.

---

### 10. Competitively Interesting Details

- **Free-text `log`, not a structured event.** Filtered by substring on `t1.log`; duration, reason, expiry, target are baked into prose. **Opportunity:** store audit events as `{actor, action_enum, target_entity+id, before/after, server_id, ts}` so you can filter by exact action type, join every target, and render a real timeline. Their model can't reliably answer "all bans by admin X this week."
- **Two identifiers, neither clean.** Row carries a 36-char UUID `steam_id` it never renders, while drill-down keys off a SteamID64 string parsed out of the message HTML. A normalized target FK + one canonical id would be strictly better.
- **No column sorting** (empty `order`) — filter but can't re-sort. Trivial to beat by enabling Date/Admin/Server sort (engine already supports it via `order_by`/`order_sort`).
- **Two separate readonly date pickers** rather than one daterange widget (`t1.startdate`/`t1.enddate`); clearing a date doesn't auto-refresh — minor friction.
- **Deferred count (two-phase load)** is a genuinely good pattern at 110 K rows — worth copying: render rows immediately, compute `COUNT(*)` in a second request so pagination never blocks first paint.
- **Global vs per-server split** (`server_id=0`) means login/session events live outside every server filter — an accountability blind spot to avoid.
- **Drill-down via `<hashtag>`** turns the audit log into an investigation entry point. Worth copying — but make *every* actor and target a structured entity link, not a regex over rendered text.


---

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


---

## 19. Public API

### Live API Contracts

**Capture method.** `/api/docs/` was rendered in a headless authenticated Chromium (capture label `api-top`). The page fires **0 XHR/AJAX** on load — it is a static, self-contained HTML documentation page (`_api_docs_.content.html`, 75 KB), not a DataTables/RPC surface. The "live contracts" below are therefore the docs' own **request tables** plus the **redacted JSON examples** embedded in each `<code>` block (capture file: `/tmp/caps/api-top/_api_docs_.content.html`; `_api_docs_.network.json` = `[]`; `_blocked.json` = `[]`, no mutations attempted). All SteamIDs/EOS IDs/names below are the docs' own placeholder values.

Sidebar API version: **`0.8.3`**. Base URL: `https://breaking.sqstat.ru/api/<group>/<method>.php`. All requests `Content-Type: x-www-form-urlencoded`; all responses `application/json`.

#### Response-envelope map (ground truth from live examples)

The envelope is **inconsistent per endpoint** — this is the single most important spec detail and is confirmed by the captured examples. There is no uniform `{status,data}` wrapper.

| Endpoint | Success wrapper key | `status` present? | Notable live-observed typing |
|---|---|---|---|
| `server/stat.php` | `data` (object) | Yes | `enabled`: bool; `map_start`: string unix(s); `players[].playtime`: `{date,last_seen}` JS-ms unix (int); `queue_players`: int; `vote`: object |
| `server/chat.php` | `chat` (array, **top-level**) | Yes | all fields string; `date`: string unix(s) |
| `server/setmap.php` | — (empty body) | Yes | no `data` payload documented |
| `player/info.php` | **`info`** (object, NOT `data`) | Yes | see §Info-envelope below |
| `player/stats.php` | **none — fields at root** | Yes (at root) | see §Stats-envelope below |
| `player/vip.php` | fields at root (`msg`,`expire`,`player`) | Yes | `expire`: `{unix:string, human:string}` |
| `player/ban.php` | fields at root (`msg`) | Yes | `msg`: string |
| `player/hasBan.php` | fields at root (`ban`,`ban_count`,`mark`,`last_ban`) | Yes | `ban`: **singular object**; `mark`: `false`\|int; `last_ban`: int unix(s) |
| `player/hasBanAll.php` | `data.ban` (array) | Yes | per-ban object **omits `description`** |
| `player/comments.php` | `comments` (array, **top-level**) | Yes | all fields string; `date`: string unix(s) |
| `player/bonus.php` | fields at root (`old`,`new`,`amount`) | Yes | integer bonus balances |
| `clan/get.php` | **`clan`** (object) | Yes | `players[].online`: object\|`false` |

> **Buildable takeaway:** a client library must special-case the unwrap per method — `stat`→`.data`, `info`→`.info`, `clan`→`.clan`, `chat`→`.chat`, `comments`→`.comments`, `stats`/`vip`/`ban`/`hasBan`/`bonus`→root. Numeric values are frequently returned as **JSON strings** (`"895"`, `"101440"`, `"71"`), unix timestamps as **string seconds** except `players[].playtime`/`clan.players[].online.playtime` which are **integer JS-milliseconds**. Nullable fields observed `null`: `discord`, `expire`, `group_id`, `group_description`, `image`, `prefix`, `prefix_rgb`.

#### Info-envelope (`player/info.php`, redacted live example)

Wrapper: `{"info":{…},"status":"ok"}`. Corrections vs a naive reading:
- `ban` is a **singular object** (the single active/last ban), while `bans` is the **array** of history — each history item carries an extra **`impact`: bool** field not present in the request-table docs.
- Booleans-as-JSON-bool: `baby`, `online`. String-numbers: `bonus` (`"895"`), `mark` (`"0"`), all `date`/`create_date`/`expire` unix seconds are strings.
- `eos_id`: 32-char hex string (`"00000000000000000000000000000000"` when unset).

```json
{"info":{"baby":true,"ban":{"admin_id":"765…04","admin_name":"Admin 1","date":"1738043756","description":"","expire":"0","id":"70174","reason":"[Навсегда] Читы","steam_id":"765…01","unban":"0"},
"bans":[{"admin_id":"765…05","admin_name":"Admin 2","date":"1738021793","description":"читы","expire":"1740613793","id":"70172","impact":false,"reason":"…п.12","steam_id":"765…01","unban":"1"}],
"bonus":"895","create_date":"1733345407","date":"1738021803","discord":null,"eos_id":"0…0","expire":null,"group_description":null,"group_id":null,"image":null,"mark":"0","name":"Player 1",
"names":[{"date":"1738021803","name":"Player 1"}],"online":false,
"playtime":{"boost":"0","online":"895","queue":"0","server":"Server 1"},"prefix":null,"prefix_rgb":null,"steam_id":"765…01"},"status":"ok"}
```

#### Stats-envelope (`player/stats.php`, redacted live example)

**No wrapper** — `damage`, `eos_id`, `games`, `is_play`, `kits`, `name`, `primetime`, `stats`, `status`, `steam_id`, `teamkill`, `weapons` are all at the JSON root. The important correction: **`weapons` is a nested object, not a flat array** — `weapons.vehicle[<name>]` and `weapons.weapon[<name>]`, each value `{cnt,damage,name}` (and `image` for hand weapons). `primetime[].cnt`/`.sum` are **integers**; other stats fields are string-numbers.

```json
{"damage":"101440","eos_id":"0…0","games":[{"end":"1751371119","id":"62997","map":"Sumari Bala Seed v1","playtime":"4540","server_id":"1","start":"1751349417","t1":"USA","t1_tickets":"0","t2":"MEA","t2_tickets":"0","win":"3"}],
"is_play":false,"kits":[{"cnt":"15197","kit":"Rifleman","steam_id":"765…01"}],"name":"Player 1",
"primetime":[{"cnt":101,"end":"1748251080","sort":"10:37","start":"1748158620","sum":678}],
"stats":[{"name":"Online","value":"915h 46m"},{"name":"Winrate","value":"W:12 L:18 (40%)"},{"name":"K/D","value":"2.12"},{"name":"Kills","value":"310"},{"name":"Deaths","value":"146"},{"name":"Revivals","value":"1"}],
"status":"ok","steam_id":"765…01","teamkill":"71",
"weapons":{"vehicle":{"M1 Abrams":{"cnt":"20","damage":"11613","name":"M1 Abrams"}},"weapon":{"M16A4":{"cnt":"18","damage":"2758","image":"M16A4","name":"M16A4"}}}}
```
`stats[].name` value set observed: `Online`, `Boost`, `Favorite kit`, `Matches`, `Winrate`, `K/D`, `Kills`, `Deaths`, `Revivals`. `games[].win` is an enum code (observed `"0"` and `"3"` — win-status codes, not a boolean).

#### Other live examples (redacted)

- **stat.php** `vote`: `{"isVote":false,"votes":{"yes":[],"no":[]},"map":"","mode":"skip"}`; `last_restart`: `{"month":"07","year":"2025","day":"24","hour":"06","minute":"00","seconds":"45","ms":"314","unix":"1753326045"}` (all string parts). `players[].playtime`: `{"date":1753361173458,"last_seen":1753365019574}` (int JS-ms).
- **vip.php**: `{"status":"ok","msg":"VIP выдан","expire":{"unix":"1753333199","human":"24.7.2025 22:54"},"player":{"name":"Player 1","steam_id":"765…01"}}`.
- **hasBan.php**: `{"ban":{"id":"79086","steam_id":"765…01","date":"1753284989","reason":"…п.5 до 24.07.2025 18:36","description":"…","admin_id":"765…02","expire":"1753371389","unban":"0","admin_name":"Admin 1"},"ban_count":"1","mark":false,"last_ban":1753284989,"status":"ok"}` — **keyless**, returns acting-admin SteamID + nick.
- **comments.php**: `{"comments":[{"id":"1","steam_id":"765…01","admin_id":"765…02","date":"1658163595","text":"Test","admin_name":"Admin 1"}],"status":"ok"}`.
- **clan/get.php**: `{"clan":{"name":"Clan 1","players":[{"eos_id":"0…0","name":"Player 1","online":{"playtime":{"date":1753942016647,"last_seen":1753955053758},"server":"Server 1","team":"USMC"},"steam_id":"765…01"},{"eos_id":"0…1","name":"Player 2","online":false,"steam_id":"765…02"}],"tags":["[TAG1]","[TAG2]"]},"status":"ok"}` — `online` is either a live-presence object or `false`.

---

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

### Live API Contracts

**Capture method.** `top` rendered in a headless authenticated Chromium (label `api-top`). On load the page fires **exactly one** AJAX call — the `topPlayers` DataTables fetch — captured in `/tmp/caps/api-top/top.network.json` (1 contract). `_blocked.json` = `[]` (no mutations attempted or blocked). The rendered `#content` (pre-modal) is `top.content.html`.

#### `POST /ajax/table.php` — action `topPlayers` (captured request)

The `buildTable` bootstrap (`top.content.html`, inline `$(document).ready`) issues:

```
POST https://breaking.sqstat.ru/ajax/table.php
Content-Type: application/x-www-form-urlencoded

action=topPlayers&table=topPlayers&page=1&numrows=30
&search={"text":{},"check":{},"multiselect":{"sort":"online"},"managers":{},"slider":{}}
&order_by=false&order_sort=false
```
(`search` is URL-encoded in the wire capture.)

**Request params (exact wire contract):**

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | string const | Yes | Always `topPlayers` (equals the table id; `Action({script:'table',action:query[0]})`). |
| `table` | string const | Yes | `topPlayers` — server-side dataset selector. |
| `page` | int | Yes | 1-based page (default `1`). |
| `numrows` | int | Yes | Page size, fixed `30`. |
| `search` | JSON string | Yes | 5-bucket search envelope (see below). |
| `order_by` | `false`\|col-alias | Yes | Sort column DB-alias, or `false` (default — header sort is not wired on this page). |
| `order_sort` | `false`\|`asc`\|`desc` | Yes | Sort direction, or `false` (default). |
| `pagination` | `true` | No | Appended for the **second** call (`query[1]+'&pagination=true'`) that returns page/row counts only. |

**Search envelope (`search` JSON), 5 fixed buckets** produced by `buildTable` from `searchInput` (`custom.js`):

| Bucket | Populated from | On this page |
|---|---|---|
| `text` | text inputs keyed by `data-search` DB-alias | `t2.name` (Ник), `t2.steam_id` (Steam ID) when non-empty |
| `check` | checkbox filters | `{}` (none) |
| `multiselect` | multiselect `data-search` key | `{"sort":"online"\|"bonus"\|"boost"}` |
| `managers` | manager-picker filters | `{}` (none) |
| `slider` | range sliders | `{}` (none) |

Example populated search: `{"text":{"t2.name":"pl","t2.steam_id":"765…"},"check":{},"multiselect":{"sort":"boost"},"managers":{},"slider":{}}`.

#### Captured response — **live status `error` (SQL info-disclosure)**

The captured `topPlayers` fetch returned HTTP **200** with an **error debug payload**, not row data — the server-side query is currently broken and the endpoint **leaks the raw SQL and DB error to the client**:

| Field | Type | Meaning |
|---|---|---|
| `status` | enum `"ok"`\|`"error"` | Captured value: **`"error"`**. |
| `sql` | string | The **full raw SQL statement** (truncated in capture): `SELECT t1.steam_id, t2.type, t2.name, …`. |
| `sql_error` | array | DB driver error tuple `[[<code>,<message>]]`. |
| `exec_time` | float | Server exec seconds (`0.001`). |

Redacted capture (`top.network.json`):
```json
{"method":"POST","url":"https://breaking.sqstat.ru/ajax/table.php",
 "status":200,"ctype":"application/json; charset=utf-8",
 "response_sample":{"sql_error":[["SELECT t1.steam_id, t2.type, t2.name,\r\n\t…"]],
   "sql":"SELECT t1.steam_id, t2.type, t2.name,\r\n\t…","status":"error","exec_time":0.001}}
```

> **Competitive/security findings (from live evidence):**
> - **Info-disclosure:** on query failure `table.php` returns the raw SQL text and driver error to any authenticated client. It exposes the join structure — aliases **`t1`** (has `steam_id`) and **`t2`** (has `type`, `name`) — i.e. a players table joined to an identity/type table. A competitor's equivalent must return an opaque error envelope, never raw SQL.
> - **`t2.type`** in the SELECT (not surfaced in any visible column) hints the identity table carries a player `type`/category field worth investigating.
> - The leaderboard's primary read path is **currently non-functional** on the live target (server-side SQL error), consistent with the page being nav-hidden/legacy (see §6).

#### Intended success + pagination envelope (from `buildTable`, `custom.js`)

On `status:"ok"` the main call returns rows the client maps by the `collum` array `['place','steam_id','name','online','bonuses','boost']`:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"ok"` | Success flag. |
| `data` | array\<row\> | Row objects; each row keyed by the `collum` aliases; optional `id`, `dataset{}` (→ `data-*`), tooltip attrs. |
| `currentPage` | int (string) | Echoed page. |
| `custom` | any | Optional per-table extra payload (passed to `end()` as `customData`). |

The **second** call (`…&pagination=true`) returns counts only: `{status:"ok", totalPage:int, totalRows:int, count_time:<string>}`. It fires only when `rows == numrows` or `currentPage != 1`. The info line renders `Страница <currentPage> из <totalPage> · Всего: <totalRows>` via `Intl.NumberFormat` (thousands separators). Row-click handler: `player.open($(tr).find('td[data-contact="steam_id"] > hashtag').text())`, suppressed on Alt/Ctrl.

---

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

This cross-cutting chapter reconstructs the **complete authorization system** of SQSTAT (breaking.sqstat.ru) by synthesizing three now spec-grade, LIVE-captured per-section chapters — *05. Administration: Admins, Groups & Permissions*, *16. Settings (Server Management)*, and *18. Clan Management* — against the ground-truth JS (`custom.js`, page fragments) and the `action_catalog.txt` action-id inventory. The goal is a single, precise, buildable picture of *who can do what, and how it is enforced*, with **every claim anchored to a concrete endpoint or captured field**.

The headline finding is unchanged and now confirmed against live wire data: **SQSTAT has no unified RBAC engine. It layers three loosely-coupled authorization namespaces that share group *names* but not a common permission model**, and every client-side control is gated by opaque server-supplied booleans (`player.get`) or in-DOM `data-perm`/`data-setting` attributes rather than a declarative capability set. This is the panel's single biggest architectural weakness and the richest area for a competitor to beat.

### 0. Capture provenance (what backs each layer)

Every contract below is transcribed from the source chapters' LIVE captures; mutations were never fired (interceptor aborts writes — the three `_blocked.json` files are all `[]`).

| Layer | Backing capture(s) | Live read contracts | Key mutation (documented, **not fired**) |
|---|---|---|---|
| **L1 Panel role** | `caps/admins/admins.network.json` | 3 (`page.php?page=admins`, `table.php action=adminPlayers` rows, same `+pagination=true` count) | `player.php action=changeGroup` |
| **L2 In-game tokens** | `caps/settings/settings.network.json` | 1 (`page.php?page=settings` — the whole group matrix is server-rendered into the fragment DOM, no read auto-fires) | `settings.php {type:'groups'}` (`setServerSettings`) |
| **L3 Clan ownership** | `caps/clans/clan_id_16.network.json` | 3 (`page.php?page=clan&id=16`, `clan.php action=list`, `clan.php action=stats`) | `clan.php action=vipPlayer` / `addPlayer` / `removePlayer` / `setting` / `delete`; `squad.php action=createSquad` |

**Aggregate: 7 live read contracts captured, 0 mutations executed.** The L2 permission matrix in §3 is not inferred — it is the **checked-checkbox state read directly from the captured settings fragment HTML** (`caps/settings/settings.content.html` lines 489–1086).

---

### 1. The Three Authorization Layers

SQSTAT authorization is not one system but three, stacked:

| # | Layer | "Who is X?" defined where | "What can X do?" defined where | Scope | Edited via |
|---|---|---|---|---|---|
| **L1** | **Panel role / group** (staff identity) | `changeGroup` → per-player `group_id` (`"0".."5"`) — *05. Admins* | Coarse server-computed booleans on `player.php action=get` (`canChangeGroup`, `canBan`, `canUnban`, `canSelfKick`, `canPermanent`, `is_you`) | **Global** (panel-wide, payload carries **no `server_id`**) | Admins page → player modal → **Группа (Group)** button → `changeGroup` |
| **L2** | **In-game Squad admin permissions** (RCON power) | The *same* 5 group names, keyed by `[data-setting="<Group>"]` | 21 Squad `Admins.cfg` permission tokens per group (`data-perm` checkboxes) — *16. Settings §16.3* | **Per Squad server** (written into each server's `Admins.cfg`) | Settings page → **groups** tab → `settings.php {type:'groups'}` |
| **L3** | **Clan / squad membership** (ownership of a paid clan) | Clan roster member `type` (`"0"/"1"/"2"`) + `vip`/`vip_mode` — *18. Clans* | Per-viewer flags `access` (clan), `v.access` (row), `clan.canType` on the `clan.php action=list` payload | **Per clan** (`clan_id`) | Clan page roster (`clan.php`: `addPlayer`, `removePlayer`, `vipPlayer`, `setting`) |

The three layers **share the five group names** but are otherwise independent data. Note the identity divergence in §7: L1 keys players by **UUID**, L3 keys members by **SteamID64** — the same field name `steam_id` carries two formats.

| `group_id` (L1) | L1 label (gloss) | L2 `data-setting` key | L2 `description` label · `color` (captured) | L1 icon · color (captured) | In roster filter? |
|---|---|---|---|---|---|
| `0` | -Нет группы- (No group / **remove**) | — | — | — | No |
| `1` | Администратор (Administrator) | `Admin` | "Администратор" · `#e50606` | `user-circle-o` · `e50606` red | Yes |
| `2` | Модератор (Moderator) | `Moderator` | "Модератор" · `#2df044` | `id-badge` · `2df044` green | Yes |
| `3` | VIP | `QueuePriority` | "VIP" · `#e2b032` | `star` · *(per-record)* | **No** |
| `4` | Камера (Camera) | `Cameraman` | "Камера" · `#7d059e` | `video-camera` · `7d059e` purple | Yes |
| `5` | Стажёр (Trainee) | `Intern` | "Стажёр" · `#b57c03` | `graduation-cap` · `b57c03` orange | Yes |

> Mapping confirmed by reconciling the `#player_group-groups` `<select>` options (*05. Admins §2*, `admins.content.html:686–692`) against the five `[data-setting]` blocks captured live on the settings groups tab (*16. Settings §16.3*, colors read from the native `<input type="color">` mirrors). **Two distinct `description` fields, do not conflate:** L2 `[data-group="description"]` (text, maxlength **32**) is the group's *display label* ("Администратор"); L1 `changeGroup.description` (textarea, maxlength **128**) is a *per-player assignment note*. They share a name only.

---

### 2. Layer 1 — Panel Roles & the `changeGroup` Contract

**Fixed enum, not free-form roles.** Exactly six values (`0` + five groups). No create-group / edit-capability UI exists in any fragment; one group per player, no stacking (*05. Admins §2*).

**Group grant is a single opaque action.** The entire lifecycle — add / promote / demote / issue-VIP / expire / revoke — is one `changeGroup` call with a different `group_id` (`0` = remove). There is **no** distinct `promote`/`demote`/`addAdmin`/`removeAdmin` action anywhere in `action_catalog.txt` at the panel level.

#### 2.1 `changeGroup` — exact contract

Transcribed verbatim from `player.group.set` (`custom.js` ~2233–2250). **NOT executed** during capture (`caps/admins/_blocked.json = []`).

| | |
|---|---|
| **Method / path** | `POST /ajax/player.php` (body `action=changeGroup&…`) |
| **Dispatch** | `Action({script:'player', action:'changeGroup', data:{…}})` |
| **Scope** | **GLOBAL — no `server_id` in payload** (contrast every L2/L3 write, which always sends `server_id`/`clan_id`) |
| **Confirm** | `$.question` "Сменить группу?" (renders chosen `<option>` label as `<h2>`); progress text "Меняем" (Changing) |
| **On success** | Re-opens modal via `player.open(player.info.steam_id)` |
| **Destructive?** | **Y** — this single call *is* the entire RBAC lifecycle |

Request params (`data` keys, all form-urlencoded via `Action`):

| Param | Type | Required | Meaning / validation |
|---|---|---|---|
| `action` | string | Y | Literal `changeGroup`. |
| `steam_id` | string (**UUID, 36-char dashed**) | Y | Target player. `player.info.steam_id`. |
| `date` | int (unix s) \| `0` | Y | Group/VIP expiry; `0` = infinity. From `#player_group-expire` `.data('start')`. |
| `group_id` | enum `"0".."5"` | Y | Target group; `"0"` clears/revokes. From `#player_group-groups`. |
| `description` | string, maxlength **128** | N | Free-text assignment note (`#player_group-description` textarea). |
| `prefix` | string, maxlength **64** | N | In-game tag granted (`#player_group-prefix`). |
| `prefix_rgb` | string `"r,g,b"`, maxlength **16** | N | Prefix color; two-way-synced with `<input type="color">` via `stringRgbToHex`/`hexToRgb` (`custom.js:1832–1845`), clears on parse failure. |
| `image` | string (URL), maxlength **256** | N | Group image URL (`#player_group-image`). |

Redacted example body:

```
action=changeGroup&steam_id=<uuid:36>&date=0&group_id=1
&description=<note<=128>&prefix=<=64>&prefix_rgb=229,6,6&image=<url<=256>
```

> Lifecycle mapping (all one call): **add** = assign a `group_id`; **promote/demote** = `changeGroup` to a different `group_id`; **revoke** = `group_id:0`; **issue/extend VIP** = `group_id:3` + `date`. The hidden **"VIP +1 месяц"** button (`#player_group-btn.hide`) is just this call preset to `group_id:3`.

#### 2.2 L1 permission flags (`player.php action=get` → `player.info.*`)

The server returns booleans computed from the *viewer's own* group; the modal only `.show()`/`.hide()`/`disable`s controls (*05. Admins §3.3, §6*). This is the entire client-visible panel-permission vocabulary — there is **no** action×group matrix in the client.

| Flag | Type | Gates (client show/hide/disable) | Source |
|---|---|---|---|
| `canChangeGroup` | bool | The **Группа (Group)** button → may assign *any* group up to Administrator. | admins.html 1130–1133 |
| `canBan` | bool | Ban flow, name-ban, kits, (online) kill; **also hides the Group button entirely when false** (1120). | 1119–1128, 1169 |
| `canUnban` | bool | "unban" control on an existing ban. | 1114–1115 |
| `canSelfKick` | bool | `kickNoReason` ("kick without reason", online only). | 1172–1173 |
| `canPermanent` | bool | Whether a *permanent* ban (vs progressive) is offered in the ban flow. | 1648 |
| `is_you` | bool | If target == operator: `#player_group-groups` `multiselect('disable')` **and** `#player_group-expire` `prop('disabled',true)` — you cannot edit your own group *in the UI*. | 2185–2190 |

There is **no** flag for "can grant group X but not Y", no per-server flag, no tiered promotion rule. `canChangeGroup` is binary: hold it, you can grant `group_id=1` (Administrator).

---

### 3. Layer 2 — In-Game Squad Permission Tokens (LIVE matrix)

L2 is the real capability matrix, but it governs **in-game RCON power**, not panel access. Each of the five groups is a `[data-setting="<Group>"][type="group"]` block whose `[data-group="permissions"]` grid holds a subset of the **21 Squad `Admins.cfg` tokens**, rendered in this order (*16. Settings §16.3*):

`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`

Three tokens — `changemap`, `kick`, `ban` — carry a ⚠ warning icon "Не будет логироваться в панели" (Will not be logged in the panel): performing them via the in-game admin cam/console **bypasses SQSTAT's audit log**.

#### 3.1 The captured default matrix (● = checkbox checked in the live fragment, `settings.content.html:489–1086`)

This replaces the previously *inferred* distribution — it is now read from the wire.

| Token | Admin `#e50606` | Moderator `#2df044` | VIP/QueuePriority `#e2b032` | Cameraman `#7d059e` | Intern `#b57c03` |
|---|:--:|:--:|:--:|:--:|:--:|
| startvote | | | | | |
| changemap ⚠ | ● | | | | |
| pause | ● | | | | |
| cheat | ● | | | | |
| private | | | | | |
| balance | ● | ● | | ● | ● |
| chat | ● | ● | | | ● |
| kick ⚠ | ● | | | | |
| ban ⚠ | ● | | | | |
| config | ● | | | | |
| cameraman | ● | ● | | ● | ● |
| immune | | | | | |
| manageserver | ● | | | | |
| featuretest | ● | | | | |
| reserve | ● | ● | ● | ● | ● |
| demos | | | | | |
| clientdemos | | | | ● | |
| debug | ● | | | | |
| teamchange | ● | ● | | ● | ● |
| forceteamchange | | | | | |
| canseeadminchat | ● | | | ● | ● |

**Corrections vs prior inferred analysis** (now that this is captured, not guessed):
- **Moderator** has *only* `balance, chat, cameraman, reserve, teamchange` — **no `kick`/`ban`/`config`/`manageserver` and no `canseeadminchat`** (prior guess of Moderator `kick`/`canseeadminchat` was wrong).
- **Cameraman** holds `balance, cameraman, reserve, clientdemos, teamchange, canseeadminchat` — richer than a "near-empty" group; `clientdemos` is unique to it.
- **VIP/QueuePriority** holds exactly one token: `reserve`. Pure monetized queue-priority, zero admin power.
- **Intern** == Moderator's exact set *plus* `canseeadminchat` (a supervised-visibility subset).
- **Admin** = everything **except** `startvote, private, immune, demos, clientdemos, forceteamchange`.

#### 3.2 `setServerSettings` (groups save) — exact contract

L2 is fully editable per group and per server (*16. Settings §16.2*). **NOT fired** during capture.

| | |
|---|---|
| **Method / path** | `POST /ajax/settings.php` |
| **Dispatch** | `Action({script:'settings', data:{type, settings}})` |
| **Confirm** | "Вы точно хотите сохранить настройки?" |
| **Destructive?** | **Y** — overwrites the entire config blob for that tab |

| Param | Type | Required | Meaning |
|---|---|---|---|
| `type` | enum `servers`\|`groups`\|`rules`\|`squad_messages`\|`discordbot`\|`discord` | Y | Active tab's `data-tab`. |
| `settings` | JSON string | Y | `JSON.stringify(setting.collect(tab))`. |

For `type='groups'`, `setting.collect` encodes each `[type="group"]` block as `{description:string(≤32), color:string(≤16 hex), permissions:[…dataset.perm where :checked]}`, wrapped as one object keyed by group name:

```json
{
  "Admin":         {"description":"Администратор","color":"#e50606","permissions":["changemap","pause","cheat","balance","chat","kick","ban","config","cameraman","manageserver","featuretest","reserve","debug","teamchange","canseeadminchat"]},
  "Moderator":     {"description":"Модератор","color":"#2df044","permissions":["balance","chat","cameraman","reserve","teamchange"]},
  "QueuePriority": {"description":"VIP","color":"#e2b032","permissions":["reserve"]},
  "Cameraman":     {"description":"Камера","color":"#7d059e","permissions":["balance","cameraman","reserve","clientdemos","teamchange","canseeadminchat"]},
  "Intern":        {"description":"Стажёр","color":"#b57c03","permissions":["balance","chat","cameraman","reserve","teamchange","canseeadminchat"]}
}
```

> L2 is where the fine-grained capability model actually lives — but it is siloed to in-game RCON and **never merged with L1 panel access**. Enforcement of `ban`/`kick`/`cheat` is by the Squad server reading `Admins.cfg`, out of the panel's control.

---

### 4. Layer 3 — Clan Ownership Axis (captured flags)

Clan membership is a **separate ownership dimension** orthogonal to L1/L2 (*18. Clans §2.2, §3.2, §7*). All roster flags arrive on `POST /ajax/clan.php action=list` (captured, `clan_id_16.network.json`).

| Concept | Field (source) | Type / values | Governs |
|---|---|---|---|
| Clan role | `players[].type` | string `"1"`=Глава (leader), `"2"`=Зам (deputy), `"0"`=member | The clan "owner" axis. |
| Raw VIP flag | `players[].vip` | string `"0"`/`"1"` | Member's stored VIP flag (not directly rendered). |
| Priority render state | `players[].vip_mode` | int `1`=ON (toggleable), `0`=OFF (toggleable), `2`=from another source → **locked ban icon** | Whether/how the priority checkbox renders. |
| Viewer-may-manage-priority | `access` (top-level of `list`/`stats`) | int `0`/`1` | Renders the entire VIP/priority column + slot counter. |
| Viewer-may-remove-this-member | `players[].access` (per row) | bool | Renders that row's remove button. |
| Viewer-may-assign-leader/deputy | `clan.canType` (injected in `init()`, default `false`) | bool | Enables the leader/deputy add-menu; else members join as `type:0`. |

Clan priority (VIP) is a **paid product**: the clan record (`clan.data`) carries `expire` (unix s; `"0"`=infinity), `max` (slot cap, captured `"999"`), `protected` (tag-kick), `public` (read-only page). Priority is granted per member via `vipPlayer`, counted against `max`.

#### 4.1 Clan mutation contracts (all `POST /ajax/clan.php`, **not fired**)

| action | Body params | Effect | Gate | Destructive |
|---|---|---|---|---|
| `list` | `clan_id` | roster + presence + Discord | (page reachable) | N (read) |
| `stats` | `clan_id, start, end` | dashboard | (page reachable) | N (read) |
| `findPlayer` | `clan_id, find`(≥3 chars) | addable-player search | `clan.canType`/`access` | N (read) |
| `addPlayer` | `clan_id, steam_id, type`(`0`\|`1`\|`2`) | add member; `type>0` gated by `clan.canType` | `clan.canType` for leader/deputy | **Y** |
| `removePlayer` | `clan_id, steam_id` | remove member | per-row `players[].access` | **Y** |
| `vipPlayer` | `clan_id, steam_id, vip`(bool) | grant/revoke queue priority (vs `max`) | top-level `access` | **Y** |
| `changeExpire` | `clan_id, date`(unix) | change subscription expiry | (manager) | **Y** |
| `setting` | `clan_id, key`(`public`\|`protected`)`, value`(bool) | toggle clan flags | (manager) | **Y** |
| `delete` | `clan_id` | disband (3 s confirm cooldown) → `location.href='/'` | (owner) | **Y (irreversible)** |
| `createSquad` (`squad.php`) | `id, name, expire, max, discord_id, tags` | create (`id` empty) / edit+rename (`id` set) | (owner) | **Y** |

This is a **second, independent path to VIP** — `clan.php action=vipPlayer` — distinct from L1 `player.php action=changeGroup(group_id=3)`. `vip_mode==2` marks priority "from another source" as a locked ban icon, reconciling the two paths *visually* but not in data.

---

### 5. The Permission Matrix — Actions × Enforcement

There is **no client-visible action×group matrix**; the client knows only the L1 booleans of §2.2 plus L3 `access`/`canType`. The matrix below is grouped by `script` endpoint, gating flag/token, and **inferred minimum group** *(inf.)* — reconstructed from UI gating + Squad token semantics, not a value the panel prints.

#### 5.1 Read / lookup actions — any authenticated staff

`script:'table'` powers all server-side DataTables loads (e.g. `action=adminPlayers`, `numrows=50`, two-request rows+`pagination=true` count).

| action | script | Purpose | Min group *(inf.)* |
|---|---|---|---|
| `auth` | public | Login / session | any (pre-auth) |
| `get` | player | Open player modal (returns L1 flags) | any staff |
| `getComments`, `getPlayerOnlineData` | player | Read notes / online history | any staff |
| `twink`, `twinkOnline`, `findFriends`, `checkBans` | player | Alt-account / cross-ban lookup | any staff |
| `list`, `stats` | clan | Clan roster + dashboard | any staff / `public` clan |
| `findPlayer` | clan | Player search to add | clan `canType`/`access` |
| `statistics`, `issues_get` | squad | Server statistics / issue reports | any staff |
| `getServer`, `getServerMaps`, `getRotation`, `getMods`, `getConfigFile(s)`, `getDefaultConfig`, `serverMonitor`, `serverOnline*`, `network`, `mapCalendar` | squad/public | Server read/telemetry | Admin *(inf.)* — page reachability gated |
| `getServerSettings` | settings | Load a server's settings into modal (then read-only) | Admin *(inf.)* |
| `(table load)` | table | Server-side row data everywhere | any staff |
| `downloadStat`, `downloadList`, `downloadOnline` | player/clan | CSV/file exports (`post_to_url` form POST) | any staff / clan `access` |

#### 5.2 Player-moderation actions — gated by L1 booleans (Moderator+ *(inf.)*)

Shared player-modal actions on **every** page. `script:'squad'` variants require the player **online** and always send `server_id` (per-server); `script:'player'` variants are global.

| action | script | Per-server? | Client gate (L1 flag) | Backed by L2 token *(inf.)* | Destructive |
|---|---|:--:|---|---|:--:|
| `ban` | squad | ✓ | `canBan` (+`canPermanent` for perma) | `ban` | Y |
| `unban` | squad | — | `canUnban` | `ban` | Y |
| `kick` | squad | ✓ | (online) | `kick` | Y |
| `kickNoReason` | squad | ✓ | `canSelfKick` | `kick` | Y |
| `kill` | squad | ✓ | `canBan` + online | `cheat`/`kick` | Y |
| `changeTeam` | squad | ✓ | online + has team | `teamchange` | Y |
| `removePlayer` | squad | ✓ | online + in squad | `kick` | Y |
| `message` | player | (server ctx) | online | `chat` | Y |
| `addBanName` / `removeBanName` | player | — | `canBan` | `ban` | Y |
| `kits` / `kitSave` | player | — | `canBan` (kits shown) | — | Y (save) |
| `mark` | player | — | (modal) | — | Y |
| `addComment` | player | — | (modal) | — | Y |

#### 5.3 Privileged / grant actions — Administrator-tier *(inf.)*

| action | script | Client gate | Effect | Min group *(inf.)* |
|---|---|---|---|---|
| `changeGroup` | player | **`canChangeGroup`** | Grant/change/**revoke** any L1 group (incl. Administrator) or VIP; `group_id=0` removes | Administrator (super-admin) |
| `vipPlayer` | clan | clan `access` | Grant/revoke queue priority vs `max` | clan priority manager |
| `setServerSettings` | settings | (settings page reachable) | Edit L2 token sets, groups, rules, Discord wiring | Admin (`manageserver`/`config`) |
| `add` | player | (players page) | Add a new player record | Admin *(inf.)* |

#### 5.4 Server-control actions (`script:'squad'`, main dashboard) — Admin + `manageserver`/`config` *(inf.)*

Highest blast radius. All send `server_id`; each write is `$.question`-confirmed with `retryAbort:false`.

| Category | action ids | L2 token *(inf.)* |
|---|---|---|
| Lifecycle | `start`, `stop`, `restart`, `update`(`afterMapChange`), `botUpdate`, `reloadConfig` | `manageserver` |
| RCON / process | `rconRaw`, `rconRestart`, `parserRestart`, `cacherRestart`, `serverMonitor`, `setServerIP` | `manageserver` |
| Match control | `changeMap`, `setRotation`, `clearNext`, `broadcast`, `squadMessage` | `changemap` / `chat` |
| In-game squad ops | `disband`, `demote` (SL demotion), `rename`, `transfer` | `kick` / `teamchange` |
| Config files | `getConfigFile(s)`, `getDefaultConfig`, `saveConfigFile` | `config` / `manageserver` |
| Mods | `getMods`, `installMod`, `deleteMod` | `manageserver` |
| Network | `blockIP` | `ban` / `manageserver` |

> `demote` here is an **in-game squad-leader demotion** (RCON), *not* an L1 role demotion — L1 demotion is `changeGroup` to a lower `group_id`. Likewise `disband`/`rename`/`transfer` are the in-game squad panel (`main.html`), *not* the clan page (whose equivalents are `delete`/`createSquad`/member `type`).

---

### 6. Enforcement Model

Enforcement is **server-side, opaque, and per-endpoint** — no declarative policy in the client. Three mechanisms:

1. **Server-computed booleans (L1).** `player.php action=get` returns `canBan`, `canUnban`, `canChangeGroup`, `canSelfKick`, `canPermanent`, `is_you`, computed from the *viewer's own* group. The client only `.show()`/`.hide()`s on these; it never evaluates a group→action rule.
2. **Client `hide`/`disable` is cosmetic only.** `#player_group` is `class="hide"` in markup, revealed by the flip; the Group button is `.show()`-ed only if `canChangeGroup`; `is_you` merely `disable`s the multiselect. *16. Settings §16.5* confirms the same pattern server-wide — `saveConfigFile`/`reloadConfig`/lifecycle actions have **no visible client-side permission check**; the boundary is entirely PHP-side. **A hidden control is not a protected control.**
3. **L2 tokens flow to the game, not the panel.** `setServerSettings` writes the 21-token sets into each server's `Admins.cfg`; in-game enforcement is by the Squad server itself. `changemap`/`kick`/`ban` done in-game are explicitly **not logged** (⚠ in §3).

Because L1 gating is a handful of coarse booleans and the client cannot be trusted, **correctness rests entirely on each PHP endpoint re-deriving the viewer's group and checking it.** Any endpoint that trusts a client-sent `steam_id`/`server_id`/`group_id` without re-checking the caller is an escalation hole.

---

### 7. VIP vs Admin vs Owner — and the identity-format split

| Actor | How defined | Powers | Not |
|---|---|---|---|
| **VIP** | L1 `changeGroup(group_id=3)` (`QueuePriority`) + expiry, **or** L3 `clan.php vipPlayer` vs `max` | Queue priority / reserved slot (`reserve` token) **only** | Not staff; no `canBan`/`canChangeGroup` |
| **Camera (4)** | L1 group | `balance, cameraman, reserve, clientdemos, teamchange, canseeadminchat` | Cannot ban/kick/config |
| **Intern (5)** | L1 group | `balance, chat, cameraman, reserve, teamchange, canseeadminchat` (Moderator + `canseeadminchat`) | No `kick`/`ban` |
| **Moderator (2)** | L1 group; `Moderator` header art | `balance, chat, cameraman, reserve, teamchange`; player moderation via `canBan`+ | **No `canChangeGroup`, no `manageserver`, no in-game `kick`/`ban` token** |
| **Administrator (1)** | L1 group; typically sole holder of `canChangeGroup` | Everything: grants groups, edits L2, server control | — |
| **Owner / super-admin** | **No explicit role.** De-facto = whoever the server hands `canChangeGroup`; on clans, `type="1"` (Глава) | Sole grantor of groups incl. Administrator; clan leader controls roster | Not a distinct enum value — invisible, unauditable |

There is **no first-class "owner" role.** Top authority is implicit in `canChangeGroup` (panel) and clan `type="1"` (clan).

**Identity-format divergence (new, captured):** the field name `steam_id` is **not one type across layers**. L1 (`adminPlayers` rows, `changeGroup.steam_id`) is a **36-char dashed UUID** (matching this repo's `steam_id64 → UUID` migration). L3 (`clan.php action=list` `players[].steam_id`, and `Top`/`Game` blocks) is a **17-digit SteamID64 string**. Any reimplementation must map between the two; a layer that treats `steam_id` uniformly will mis-key across the panel/clan boundary.

---

### 8. Privilege-Escalation-Relevant Design

Ordered by severity; all structural, all now anchored to captured contracts.

1. **Unbounded grant ceiling.** `canChangeGroup` is binary and `#player_group-groups` includes `Администратор (group_id=1)` with no "max grantable level". Any operator marked `canChangeGroup=true` can `POST action=changeGroup&group_id=1` to promote **anyone (or an alt) to Administrator**, or self-elevate. Nothing in captured code proves a server-side ceiling.
2. **Self-edit is only *disabled*, not *forbidden*.** `is_you` merely `disable`s the multiselect/expiry (admins.html 2185–2190). The `changeGroup` payload still accepts an arbitrary `steam_id`. If the PHP handler does not reject `steam_id == caller`, a direct POST self-promotes.
3. **Client-only gating everywhere.** *16. Settings §16.5* confirms `saveConfigFile`/`reloadConfig`/lifecycle have no visible client permission check. `saveConfigFile` additionally POSTs the **ambient global `server_id`**, not `configEditor.server_id` (§16.4.1 latent bug) — highest-blast-radius write, weakest client discipline.
4. **No per-server panel scoping (L1 is global).** `changeGroup` carries **no `server_id`**, so one call makes someone admin across **all** servers. A rogue mid-tier admin is a fleet-wide problem.
5. **Two divergent VIP paths, one lock.** `changeGroup(group_id=3)` (L1) and `clan.php vipPlayer` (L3) both grant priority; only `vip_mode==2` reconciles them visually. Divergent write paths to the same perk invite double-grants and drift against clan `max`.
6. **Audit blind spots.** In-game `changemap`/`kick`/`ban` are ⚠ **not logged** (§3), and `changeGroup` has **no dedicated audit action** — add/promote/demote/revoke all collapse into one opaque call whose only trace is the free-text `description` (≤128). Privilege changes are under-audited by design.
7. **Secret exposure to all settings-readers.** Six live Discord webhook URLs **with bot tokens** render into `value=""` attributes on the `discord` tab (`log`, `weekend`, `monitoring`, `request`, `collab_ban`, `collab_warn` — *16. Settings §16.3*). Any operator who can reach Settings reads every webhook secret from page source. Violates least privilege.

---

### 9. Competitor Takeaways

- **Collapse the three namespaces into one RBAC engine.** Separate cleanly (a) roles/permissions, (b) subscriptions/perks (VIP), (c) in-game RCON tokens — but drive them from *one* declarative capability set with a real action×capability matrix, not scattered `player.get` booleans + in-DOM `data-perm` state.
- **Unify identity.** One canonical player key across panel and clan surfaces; don't ship `steam_id` as UUID in L1 and SteamID64 in L3.
- **Add a grant ceiling and first-class owner role.** "Can grant up to level N", an explicit Owner, and hard *server-enforced* self-edit prevention (not `disable`d) close the top escalation vectors.
- **Per-server admin scoping.** Model panel-admin per server/server-group, not globally — add `server_id` to the grant contract.
- **Audit every privilege change and in-game admin action** with a dedicated immutable event (who / what / old→new), config saves with diffs — beating SQSTAT's unlogged `changeGroup` and in-game blind spots.
- **Never echo secrets into markup**; gate config-write behind `config`/`manageserver` and re-check the caller server-side on *every* `/ajax/*.php` endpoint.

Cross-references: *05. Admins* (L1 mechanics, `changeGroup` contract §2.1/§4.1, flags §2.2/§3.3, UUID identity §8); *16. Settings §16.2–16.3* (L2 groups tab, 21 tokens, LIVE default matrix, `setServerSettings`, webhook leak §16.3, config-save bug §16.4.1, enforcement §16.5); *18. Clans §2.2/§3.2/§5/§7* (L3 `access`/`v.access`/`canType`/`type`/`vip`/`vip_mode`, `vipPlayer`/`addPlayer`/`removePlayer` contracts, SteamID64 identity).


---

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


---

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


---

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
