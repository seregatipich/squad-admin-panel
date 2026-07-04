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
