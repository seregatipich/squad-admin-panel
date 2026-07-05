# COMBAT-1 — Squad combat log-line format (research pin)

**Task:** COMBAT-1 (issue #127, roadmap #57). Capture Squad combat events
(damage / wound / death / revive) from `SquadGame.log` in the log-ingest worker.
Builds on EVT-1 (envelope pipeline) and PLAYER-1 (identity resolution).

**Date:** 2026-07-05 · **Squad reference:** v10.x (same log family validated for
`patterns.ts` against v10.3.1).

## 1. Goal of the pin

Before writing the parser we fix the exact shape of the combat log lines so the
regexes are grounded rather than guessed. Live tailing against a real host is
**env-gated** (no live Squad server in this environment), so the wire format is
pinned here and the regexes are kept as isolated, adjustable constants — exactly
as the existing `report.ts`, `match.ts` and `vote.ts` parsers already disclaim.

## 2. Single verified reference: SquadJS log-parser

The one verified signature reference is the SquadJS log-parser
(`Team-Silver-Sphere/SquadJS`, `squad-server/log-parser/`). Its shipped combat
rules are:

```
player-damaged, player-wounded, player-died, player-revived, deployable-damaged
```

The upstream SquadJS regexes (reconstructed from the shipped rule set) are:

| Rule | Category | Anchor | Key groups |
|---|---|---|---|
| `player-damaged` | `LogSquad` | `Player:<victim> ActualDamage=<n> from <attacker> (Online IDs:… \| Controller ID:…) caused by <weapon>_C` | victimName, damage, attackerName, attacker online IDs, weapon |
| `player-wounded` | `LogSquadTrace` | `[DedicatedServer]ASQSoldier::Wound(): Player:<victim> KillingDamage=<n> from <attacker> (Online IDs:… \| Controller ID:…) caused by <weapon>_C` | victimName, damage, attackerName, attacker online IDs, weapon |
| `player-died` | `LogSquadTrace` | `[DedicatedServer]ASQSoldier::Die(): Player:<victim> KillingDamage=<n> from <attacker> (Online IDs:… \| Controller ID:…) caused by <weapon>_C` | victimName, damage, attackerName, attacker online IDs, weapon |
| `player-revived` | `LogSquad` | `<medic> (Online IDs:…) has revived <revived> (Online IDs:…).` | medic name + IDs, revived name + IDs |
| `deployable-damaged` | `LogSquadTrace` | `[DedicatedServer]ASQDeployable::TakeDamage(): <deployable>_C TakeDamage=<n> from <attacker> caused by <weapon>_C` | deployable, damage, attacker, weapon |

## 3. Concrete line shapes the parser targets

`parseLine` (in `patterns.ts`) already strips the
`[YYYY.MM.DD-HH.MM.SS:mmm][tick]<Category>: [<Verbosity>: ]` prefix and hands the
parsers the trailing `message` plus the `category`. The combat regexes therefore
operate on `message` alone.

### 3.1 Damage (`LogSquad`)

```
Player:VictimName ActualDamage=54.321000 from AttackerName (Online IDs: EOS: 0002aaaa…32hex steam: 76561198000000001 | Controller ID: BP_PlayerController_C_2147481000) caused by BP_Projectile_762x54_C
```

### 3.2 Wound (`LogSquadTrace`)

```
[DedicatedServer]ASQSoldier::Wound(): Player:VictimName KillingDamage=-42.000000 from AttackerName (Online IDs: EOS: 0002aaaa…32hex steam: 76561198000000001 | Controller ID: BP_PlayerController_C_2147481000) caused by BP_AK74_C
```

### 3.3 Death (`LogSquadTrace`)

```
[DedicatedServer]ASQSoldier::Die(): Player:VictimName KillingDamage=-100.000000 from AttackerName (Online IDs: EOS: 0002aaaa…32hex steam: 76561198000000001 | Controller ID: BP_PlayerController_C_2147481000) caused by BP_AK74_C
```

### 3.4 Revive (`LogSquad`)

```
MedicName (Online IDs: EOS: 0002bbbb…32hex steam: 76561198000000002) has revived RevivedName (Online IDs: EOS: 0002cccc…32hex steam: 76561198000000003).
```

## 4. Identity block

The online-identity parenthetical is the same EOS/steam pair the RCON side
(`parse-list-players.ts`) and the report parser already handle, but wrapped in
**parentheses** and optionally trailed by `| Controller ID: …`:

```
(Online IDs: EOS: <32-hex> steam: <17-digit> | Controller ID: <ctrl>)
```

`steam:` and the `| Controller ID:` suffix are optional. The combat identity
regex extracts `EOS` (primary) and `steam` (secondary), tolerating either
trailing shape. EOS is lower-cased to match the `players.eos_id` convention.

## 5. Edge cases pinned by fixtures

- **Suicide** — attacker name equals victim name (self-inflicted). Emitted as a
  normal death/damage with `is_suicide=true`, never `is_teamkill`.
- **Environmental / no attacker** — `from nullptr` (no online-IDs block) or a
  non-human actor. Emitted with `attacker_player_id=null`, `is_teamkill=false`.
- **Deployable damage** — `ASQDeployable::TakeDamage()` lines carry no `Player:`
  anchor and never match the player regexes, so they are ignored (COMBAT-1 scope
  is player-vs-player combat).
- **Bot / nil actors** — attacker name present but no resolvable online IDs and
  not matching a known player: resolves to `null`, does not crash.

## 6. Teamkill detection

Squad combat lines do **not** carry team IDs. Teamkill detection compares the
attacker's and victim's `team_id` from the last RCON poll. The RCON worker
caches that poll in Redis at `rcon:roster:<serverId>` (90 s TTL) with per-player
`eos_id` / `steam_id64` / `name` / `team_id`. The combat store reads that cache,
builds an identity→team index, and sets `is_teamkill=true` when both parties
resolve to the **same** team and are **different** actors. If the roster is
missing (worker restarted mid-round, cache expired) the flag stays `false`.

## 7. Offset recovery / dedup

Re-processing the same log region (worker restart, tail replay) must not
duplicate combat events. Each combat event gets a **deterministic** `event_id`
(`uuidv5` over `server_id | kind | occurred_at | tick | attacker | victim |
weapon | damage`), written to the partitioned `events` table with
`ON CONFLICT (event_id, occurred_at) DO NOTHING`. Identical replays collapse to
the same row.

## 8. What is COMBAT-1 vs later

COMBAT-1 emits **envelope** events (free-text `kind`: `combat_damage`,
`combat_wound`, `combat_death`, `combat_revive`) into the shared `events` table
and resolves attacker/victim to `players.id`. The typed `combat_events` table
(partitioned, kill/death/revive/damage/teamkill projections) is **COMBAT-2** and
is out of scope here.
