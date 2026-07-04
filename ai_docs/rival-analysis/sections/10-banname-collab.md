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
