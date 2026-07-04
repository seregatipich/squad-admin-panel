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
