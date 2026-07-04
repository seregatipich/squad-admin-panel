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
