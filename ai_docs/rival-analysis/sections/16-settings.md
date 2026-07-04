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
