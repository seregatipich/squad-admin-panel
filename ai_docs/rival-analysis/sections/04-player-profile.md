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
