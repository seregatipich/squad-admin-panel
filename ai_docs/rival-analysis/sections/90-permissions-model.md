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
