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
