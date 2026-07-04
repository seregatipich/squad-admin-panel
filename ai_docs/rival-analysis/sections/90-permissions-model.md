## Permission, Role & Group Model (Synthesis)

This cross-cutting chapter reconstructs the **complete authorization system** of SQSTAT (breaking.sqstat.ru) by synthesizing three per-section chapters — *05. Administration: Admins, Groups & Permissions*, *16. Settings (Server Management)*, and *18. Clan Management* — against the ground-truth JS (`frags/admins.html`, `custom.js`) and the `action_catalog.txt` action-id inventory. The goal is a single, precise picture of *who can do what, and how that is enforced.*

The headline finding: **SQSTAT has no unified RBAC engine. It layers three loosely-coupled authorization namespaces that share group *names* but not a common permission model**, and every client-side control is gated by opaque server-supplied booleans rather than a declarative capability set. This is the panel's single biggest architectural weakness and the richest area for a competitor to beat.

---

### 1. The Three Authorization Layers

SQSTAT authorization is not one system but three, stacked:

| # | Layer | "Who is X?" defined where | "What can X do?" defined where | Scope | Edited via |
|---|---|---|---|---|---|
| **L1** | **Panel role / group** (staff identity) | `changeGroup` → per-player `group_id` (0–5) — *05. Admins* | Coarse server-side booleans returned on `player.get` (`canBan`, `canChangeGroup`, …) | **Global** (panel-wide, no `server_id`) | Admins page → player modal → **Группа (Group)** button |
| **L2** | **In-game Squad admin permissions** (RCON power) | The *same* 5 group names, keyed by `data-setting` | 21 Squad `Admins.cfg` permission tokens per group (`ban`, `kick`, `cheat`, `manageserver`, …) — *16. Settings §3* | **Per Squad server** (written into each server's `Admins.cfg`) | Settings page → **groups** tab → `setServerSettings` |
| **L3** | **Clan / squad membership** (ownership of a paid clan) | Clan roster `type` (0/1/2) + `vip_mode` — *18. Clans* | Per-viewer booleans `access`, `v.access`, `canType` on the clan payload | **Per clan** | Clan page roster (`addPlayer`, `removePlayer`, `vipPlayer`, `setting`) |

The three layers **share the five group names** but are otherwise independent data:

| `group_id` (L1) | L1 Russian label (gloss) | Internal `name` (L1 & L2 key) | L2 settings block `data-setting` | Icon / color |
|---|---|---|---|---|
| `0` | -Нет группы- (No group) | *(clears group)* | — | — |
| `1` | Администратор (Administrator) | *Admin* | `Admin` | `fa-user-circle-o` / `#e50606` red |
| `2` | Модератор (Moderator) | `Moderator` | `Moderator` | `fa-id-badge` / `#2df044` green |
| `3` | VIP | `QueuePriority` | `QueuePriority` | `fa-star` / per-record |
| `4` | Камера (Camera) | *Camera* | `Cameraman` | `fa-video-camera` / `#7d059e` purple |
| `5` | Стажёр (Trainee) | *Trainee* | `Intern` | `fa-graduation-cap` / `#b57c03` orange |

> The mapping is confirmed by matching the `player.info.group.name` branch checks in `admins.html` (`== 'QueuePriority'`, `== 'Moderator'`, lines 1149–1152) to the five `data-setting` blocks enumerated in *16. Settings §3* (`Admin`, `Moderator`, `QueuePriority`, `Cameraman`, `Intern`). The L1 `description` field (e.g. "Администратор") is edited on the L2 groups tab (`data-group="description"`), so the two layers write to the same underlying group row — but L1 controls *panel* access while L2 controls *in-game* power, and neither is derivable from the other in the client.

---

### 2. Layer 1 — Panel Roles & Scope

**Fixed enum, not free-form roles.** Exactly six values (0 + five groups); no create-group / edit-capability UI exists in any fragment. One group per player (no stacking). See *05. Admins §2*.

**Group grant is a single opaque action.** The entire lifecycle — add / promote / demote / expire / revoke — is one `changeGroup` call with a different `group_id` (and `0` = remove). There is **no** distinct `promote`/`demote`/`addAdmin`/`removeAdmin` action at the panel level. Payload (`player.php`, action `changeGroup`, lines 2239–2249):

```
steam_id, date(expire), group_id, description, prefix, prefix_rgb, image
```

**Scope is GLOBAL.** The `changeGroup` payload carries **no `server_id`** — contrast every L2/L3 action which always sends `server_id`/`clan_id`. A panel role therefore applies across all servers at once; there is no per-server panel-admin assignment.

**A "group" carries cosmetic + identity payload, not just a tier:** `{group_id, expire, description, prefix (≤64), prefix_rgb, image (≤256)}` scoped to the player. Expiry (including `0` = infinity) lets trainee/camera access and VIP subscriptions auto-expire through the same mechanism.

#### 2.1 The L1 permission flags (the effective panel-permission model as the client sees it)

The server returns booleans on `player.get`; the modal only shows/hides controls (*05. Admins §3.3, §6*). These are the entire client-visible panel-permission vocabulary:

| Flag | Gates (client show/hide) | Source line |
|---|---|---|
| `canChangeGroup` | The **Группа (Group)** button → whether the operator may assign *any* group (up to Administrator). | admins.html 1130–1133 |
| `canBan` | Ban flow, name-ban, kits, and (online) kill; **also hides the Group button entirely when false** (1120). | 1119–1128, 1169 |
| `canUnban` | The "unban" control on an existing ban. | 1114–1115 |
| `canSelfKick` | The "kick without reason" (`kickNoReason`) control (online only). | 1172–1173 |
| `canPermanent` | Whether the operator may issue a *permanent* ban (vs progressive) in the ban flow. | 1648 |
| `is_you` | If target == operator: the group multiselect **and** expiry are **disabled** — you cannot edit your own group *in the UI*. | 2185–2190 |

There is **no** flag for "can grant group X but not Y", no per-server flag, and no tiered promotion rule. `canChangeGroup` is binary: hold it and you can grant Administrator.

---

### 3. Layer 2 — In-Game Squad Permission Tokens

L2 is the real capability matrix, but it governs **in-game RCON power**, not panel access. Each of the five groups holds a subset of the **21 Squad `Admins.cfg` tokens** (*16. Settings §3*), edited on the settings **groups** tab and written per-server:

`startvote, changemap, pause, cheat, private, balance, chat, kick, ban, config, cameraman, immune, manageserver, featuretest, reserve, demos, clientdemos, debug, teamchange, forceteamchange, canseeadminchat`

Default **Admin** template grants everything **except** `startvote, private, immune, demos, clientdemos, forceteamchange`. Tokens `changemap`, `kick`, `ban` carry a warning icon "Не будет логироваться в панели" (Will not be logged in the panel) — using the in-game admin cam/console for those **bypasses SQSTAT's audit log**.

Inferred default token distribution by group (from the token names + group intent; the panel does not print each group's full set, but the group semantics are unambiguous):

| Token → in-game capability | Admin (1) | Moderator (2) | QueuePriority/VIP (3) | Cameraman (4) | Intern (5) |
|---|:--:|:--:|:--:|:--:|:--:|
| `reserve` (queue priority / reserved slot) | ✓ | ✓ | **✓** | ✓ | ✓ |
| `chat` (see/use admin chat) | ✓ | ✓ | — | — | ✓ |
| `canseeadminchat` | ✓ | ✓ | — | — | ✓ |
| `kick` | ✓ | ✓ | — | — | possibly |
| `ban` | ✓ | ✓ | — | — | — |
| `changemap` | ✓ | ~ | — | — | — |
| `balance` / `teamchange` | ✓ | ~ | — | — | — |
| `forceteamchange` | — (off by default) | — | — | — | — |
| `pause` | ✓ | — | — | — | — |
| `cheat` (admin cheat cmds) | ✓ | — | — | — | — |
| `config` / `manageserver` | ✓ | — | — | — | — |
| `cameraman` (admin cam) | ✓ | ~ | — | **✓** | — |
| `demos` / `clientdemos` | — (off by default) | — | — | — | — |
| `immune` (immune to admin actions) | — (off by default) | — | — | — | — |
| `private` / `startvote` | — (off by default) | — | — | — | — |
| `featuretest` / `debug` | ✓ | — | — | — | — |

Legend: ✓ = expected on, ~ = operator's choice, — = expected off. **VIP's only meaningful token is `reserve`** — it is a monetized queue-priority perk, not staff power. **Cameraman** is a near-empty group whose defining token is `cameraman` (spectator/admin-cam for content creators). **Intern** is a supervised subset of Moderator.

> L2 is fully editable per group and per server via `setServerSettings`, so these are *defaults/intent*, not hard guarantees. The point for a competitor: L2 is where the fine-grained capability model actually lives — but it is siloed to in-game RCON and never merged with L1 panel access.

---

### 4. Layer 3 — Clan Ownership Axis

Clan membership is a **separate ownership dimension** orthogonal to L1/L2 (*18. Clans §2, §6*):

| Clan concept | Field | Values | Governs |
|---|---|---|---|
| Clan role | member `type` | `1` = Глава (leader), `2` = Зам (deputy), `0`/'' = member | Who leads the clan (the clan "owner" axis) |
| Priority state | `vip_mode` | `1` = ON, `0` = OFF, `2` = granted elsewhere (locked) | Whether member holds a queue slot |
| Viewer-may-manage-priority | `text.access` (clan-level) | bool | Renders the entire VIP/priority column |
| Viewer-may-remove-this-member | `v.access` (per-row) | bool | Renders each row's remove button |
| Viewer-may-assign-leader/deputy | `clan.canType` | bool | Enables the leader/deputy add-menu; else members join as type 0 |

Clan priority (VIP) is a **paid product**: clans have an `expire` date and a `max` slot count ("X из 999"), and grant priority per-member via `vipPlayer` counted against the pool. This is a *second, independent path to VIP* — distinct from L1 `changeGroup(group_id=3)`. `vip_mode==2` marks priority "from another source" as a locked ban icon, reconciling the two paths visually but not in data.

---

### 5. The Permission Matrix — Actions × Enforcement

There is **no client-visible action×group matrix**; the client only knows the L1 booleans of §2.1 plus L3 `access`/`canType`. The matrix below is **reconstructed** by grouping every action id from `action_catalog.txt` by its `script` endpoint, its gating flag/token, and the **inferred minimum group** required. "Inferred" columns are marked *(inf.)*; they are the analyst's best reconstruction from UI gating, `hide` logic, and Squad token semantics, not a value the panel prints.

#### 5.1 Read / lookup actions — available to all authenticated staff

Every logged-in operator who can open a page can fire these; no destructive flag gates them. `script:'table'` powers all DataTables loads.

| action | script | Purpose | Min group *(inf.)* |
|---|---|---|---|
| `auth` | public | Login / session | any (pre-auth) |
| `get` | player | Open player modal (returns the L1 flags) | any staff |
| `getComments` | player | Read admin notes | any staff |
| `twink`, `twinkOnline`, `findFriends`, `checkBans` | player | Alt-account / cross-ban lookup | any staff |
| `getPlayerOnlineData` | player | Player online history | any staff |
| `list`, `stats` | clan | Clan roster + dashboard | any staff / public if `public` |
| `findPlayer` | clan | Player search to add | clan `canType`/`access` |
| `statistics` | squad | Server statistics page | any staff |
| `issues_get` | squad | Read issue reports | any staff |
| `getServer`, `getServerMaps`, `getRotation`, `getMods`, `getConfigFile(s)`, `getDefaultConfig`, `serverMonitor`, `serverOnline`, `serverOnlineAdmins`, `serverOnlineBooster`, `network`, `mapCalendar` | squad | Server read/telemetry (dashboard/settings) | Admin *(inf.)* — page reachability gated |
| `getServerSettings` | settings | Load settings tabs (groups, rules, discord) | Admin *(inf.)* |
| `(table load)` | table | Server-side row data everywhere | any staff |
| `downloadStat`, `downloadList`, `downloadOnline` | player/clan | CSV/file exports (form POST) | any staff / clan `access` |

#### 5.2 Player-moderation actions — gated by L1 booleans (Moderator+ *(inf.)*)

These are the shared player-modal actions embedded on **every** page. `script:'squad'` variants require the player **online** and always send `server_id` (per-server); `script:'player'` variants are global.

| action | script | Per-server? | Client gate | Backed by L2 token *(inf.)* | Min group *(inf.)* |
|---|---|:--:|---|---|---|
| `ban` | squad | ✓ | `canBan` (+`canPermanent` for perma) | `ban` | Moderator+ |
| `unban` | squad | — | `canUnban` | `ban` | Moderator+ |
| `kick` | squad | ✓ | (online) | `kick` | Moderator+ |
| `kickNoReason` | squad | ✓ | `canSelfKick` | `kick` | Moderator+ |
| `kill` | squad | ✓ | `canBan` + online | `cheat`/`kick` | Moderator+ |
| `changeTeam` | squad | ✓ | online + has team | `teamchange` | Moderator+ |
| `removePlayer` | squad | ✓ | online + in squad | `kick` | Moderator+ |
| `message` | player | (server ctx) | online | `chat` | Moderator+ |
| `addBanName` / `removeBanName` | player | — | `canBan` | `ban` | Moderator+ |
| `kits` / `kitSave` | player | — | `canBan` (kits shown) | — | Moderator+ |
| `mark` | player | — | (modal) | — | Moderator+ |
| `addComment` | player | — | (modal) | — | any staff |
| `changeExpire` | player | — | (modal) | — | Moderator+ |
| `transfer` | player | — | (modal) | — | Admin *(inf.)* |

#### 5.3 Privileged / grant actions — Administrator-tier *(inf.)*

| action | script | Client gate | Effect | Min group *(inf.)* |
|---|---|---|---|---|
| `changeGroup` | player | **`canChangeGroup`** | Grant/change/**revoke** any L1 group (incl. Administrator) or VIP; `group_id=0` removes | Administrator (super-admin) |
| `vipPlayer` | player / clan | `access` (clan) / `canChangeGroup` | Grant/revoke queue priority | Admin / clan manager |
| `setServerSettings` | settings | (settings page reachable) | Edit L2 token sets, rules, Discord wiring, **groups' permissions** | Admin (`manageserver`/`config`) |
| `add` | player | (players page) | Add a new player record | Admin *(inf.)* |

#### 5.4 Server-control actions (`script:'squad'`, main dashboard) — Administrator + `manageserver`/`config` *(inf.)*

The highest-blast-radius tier. All send `server_id`; reachability is gated by the operator's L1 group and (server-side) L2 `manageserver`/`config` tokens.

| Category | action ids | L2 token *(inf.)* |
|---|---|---|
| Lifecycle | `start`, `stop`, `restart`, `update`, `botUpdate`, `reloadConfig` | `manageserver` |
| RCON / process | `rconRaw`, `rconRestart`, `parserRestart`, `cacherRestart`, `serverMonitor`, `setServerIP` | `manageserver` |
| Match control | `changeMap`, `setRotation`, `getRotation`, `clearNext`, `broadcast`, `squadMessage` | `changemap` / `chat` |
| In-game squad ops | `disband`, `demote` (demote squad leader), `rename`, `transfer` | `kick` / `teamchange` |
| Config files | `getConfigFile(s)`, `getDefaultConfig`, `saveConfigFile` | `config` / `manageserver` |
| Mods | `getMods`, `installMod`, `deleteMod` | `manageserver` |
| Network / bans | `blockIP` | `ban` / `manageserver` |
| Content | `uploadVideo`, `uploadVideo_token`, `issues_create`, `seeding*`, `createSquad`, `saveUserSettings` | mixed / self |

> Note on naming: `demote` here is an **in-game squad-leader demotion** (RCON), *not* an L1 role demotion — L1 demotion is `changeGroup` to a lower `group_id`. Do not conflate them.

#### 5.5 Clan-scope actions (`script:'clan'`) — gated by L3, not L1

| action | Client gate | Min authority |
|---|---|---|
| `addPlayer` | `canType` for leader/deputy; else any manager | clan manager |
| `removePlayer` | per-row `v.access` | clan manager |
| `vipPlayer` | clan `access` | clan priority manager |
| `changeExpire`, `setting`, `delete` | (manager) | clan owner/manager |
| `createSquad` (create/edit) | `script:'squad'` | clan owner |

---

### 6. Enforcement Model

Enforcement is **server-side, opaque, and per-endpoint** — there is no declarative policy in the client. Three complementary mechanisms:

1. **Server-computed booleans (L1).** `player.get` returns `canBan`, `canUnban`, `canChangeGroup`, `canSelfKick`, `canPermanent`, `is_you`, computed from the *viewer's own* group. The client only calls `.show()`/`.hide()` on these; it never evaluates a group→action rule itself.
2. **Client `hide`/`disable` is cosmetic only.** Every gated control is `class="hide"` in markup and revealed by JS (`#player_group` starts `hide`; the Group button is `.show()`-ed only if `canChangeGroup`; `is_you` merely `disable`s the multiselect). *16. Settings §231* confirms the same pattern server-wide: "the action endpoints themselves are not visibly permission-checked client-side — the security boundary is entirely on the PHP side." **A hidden control is not a protected control** — the real gate must be the `/ajax/<script>.php` handler.
3. **L2 tokens flow to the game, not the panel.** `setServerSettings` writes the 21-token sets into each server's `Admins.cfg`; enforcement of in-game `ban`/`kick`/`cheat` is by the Squad server itself, out of the panel's control. The panel warns that `changemap`/`kick`/`ban` done in-game bypass its audit log entirely (*16. Settings §3*).

Because L1 gating is a handful of coarse booleans and the client cannot be trusted, **correctness rests entirely on each PHP endpoint re-deriving the viewer's group and checking it.** Any endpoint that trusts a client-sent `steam_id`/`server_id`/`group_id` without re-checking the caller is an escalation hole.

---

### 7. VIP vs Admin vs Owner Distinctions

| Actor | How defined | Powers | Not |
|---|---|---|---|
| **VIP** | L1 `group_id=3` (`QueuePriority`) with expiry, **or** L3 clan `vipPlayer` against a slot pool | Queue priority / reserved slot (`reserve` token) only | Not staff; no panel moderation, no `canBan`/`canChangeGroup` |
| **Camera** (4) / **Intern** (5) | L1 group | Camera: admin-cam spectator (`cameraman`); Intern: supervised subset of Moderator | Not full moderators; limited L2 tokens |
| **Moderator** (2) | L1 group; `Moderator` header art (`/assets/img/moderator.jpg`) | Player moderation (ban/kick/kill/kits/mark/message) via `canBan`+ | No `canChangeGroup`, no `manageserver` *(inf.)* |
| **Administrator** (1) | L1 group; typically the only holder of `canChangeGroup` | Everything: grants groups, edits L2, server control | — |
| **Owner / super-admin** | **No explicit role.** De-facto = whoever the server hands `canChangeGroup`; on clans, `type=1` (Глава/leader) | Sole grantor of groups incl. Administrator; clan leader controls roster | Not a distinct enum value — invisible, unauditable |

There is **no first-class "owner" role.** Top authority is implicit in the `canChangeGroup` flag (panel) and clan `type=1` (clan). VIP conflates **monetization** with the **access-control** table; L2 conflates **in-game RCON** with the same group names. These conflations are the model's defining smell.

---

### 8. Privilege-Escalation-Relevant Design

Ordered by severity; all are structural, not incidental.

1. **Unbounded grant ceiling.** `canChangeGroup` is binary and the group `<select>` includes `Администратор (1)` with no "max grantable level". Any operator the server marks `canChangeGroup=true` can promote **anyone (or an alt) to Administrator**, or self-elevate. There is no tiered "can grant up to N" rule anywhere in the client — the server must enforce a ceiling, and nothing in the captured code proves it does.
2. **Self-edit is only *disabled*, not *forbidden*.** `is_you` merely `disable`s the multiselect/expiry client-side (admins.html 2185–2190). The `changeGroup` payload still accepts an arbitrary `steam_id`. If the PHP handler does not reject `steam_id == caller`, an operator can POST a self-promotion directly, bypassing the disabled control.
3. **Client-only gating everywhere.** Per *16. Settings §231*, endpoints are not visibly permission-checked client-side. If any `/ajax/*.php` handler trusts client input, the entire `hide`-based model collapses. `saveConfigFile` is called out (*§16 §170*) as blindly POSTing the ambient `server_id` — direct server-config write is the highest-blast-radius action and shows the weakest client discipline.
4. **No per-server panel scoping (L1 is global).** A single `changeGroup` makes someone admin across **all** servers; there is no way to scope panel-admin to one server. A compromised or rogue mid-tier admin is a fleet-wide problem.
5. **Two divergent VIP paths, one lock.** L1 `changeGroup(3)` and L3 clan `vipPlayer` both grant priority; only `vip_mode==2` reconciles them visually. Divergent write paths to the same perk invite double-grants and accounting drift against the clan slot `max`.
6. **Audit blind spots.** In-game `changemap`/`kick`/`ban` are explicitly **not logged** (*§16 §3*), and `changeGroup` has **no dedicated audit action** — promotion/demotion/removal all collapse into one opaque call whose only trace is the free-text `description` (*05. Admins §7*). Privilege changes are therefore under-audited by design.
7. **Secret exposure to all settings-readers.** Live Discord webhook URLs with tokens are rendered into `value=""` attributes (*§16 §137*) — any operator who can reach Settings reads every webhook secret from page source. Violates least privilege for the L2/settings tier.

---

### 9. Competitor Takeaways

- **Collapse the three namespaces into one RBAC engine.** Separate cleanly: (a) roles/permissions, (b) subscriptions/perks (VIP), (c) in-game RCON tokens — but drive them from *one* declarative capability set with a real action×capability matrix, not scattered booleans.
- **Add a grant ceiling and first-class owner role.** "Can grant up to level N", an explicit Owner, and hard self-edit prevention (server-enforced, not `disable`d) close the top escalation vectors.
- **Per-server admin scoping.** Model panel-admin per server/server-group, not globally.
- **Audit every privilege change and in-game admin action** with a dedicated, immutable event (who/what/old→new), including config saves with diffs — beating SQSTAT's unlogged `changeGroup` and in-game-action blind spots.
- **Never echo secrets into markup**; gate config-write behind `config`/`manageserver` and re-check the caller server-side on *every* endpoint.

Cross-references: *05. Administration: Admins, Groups & Permissions* (L1 mechanics, `changeGroup`, flags), *16. Settings (Server Management) §3* (L2 groups tab, 21 tokens, enforcement note §231, webhook leak §137, config-save §170), *18. Clan Management §6* (L3 clan `access`/`canType`/`type`/`vip_mode`).
