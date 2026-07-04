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
