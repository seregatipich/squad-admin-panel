# Squad history and creator crowns — design

Status: approved in conversation 2026-09-27, pending written-spec review.

## Goal

Moderation aid: while reviewing a live server, an admin sees at a glance which
players created an in-game squad and then handed it off (grey crown) or
abandoned it while leading (red crown). Every squad creation, squad-leader
change and disband is also persisted so complaints can be investigated later.

Out of scope: rank-and-file joins/leaves, player-card or match-card UI,
aggregate statistics.

## Observability constraints

- Squad creation is observable exactly: Squad sends an unsolicited RCON line
  `<name> (Online IDs: EOS: <eos> steam: <steam>) has created Squad <n> (Squad Name: <name>) on <team faction>`.
  worker-rcon currently drops it (`apps/workers/rcon/src/chat.ts`,
  `supervisor.ts ingestBroadcast`). `ListSquads` also carries the original
  creator (`creator_eos_id`, `creator_steam_id64`, `creator_name`).
- Squad-leader changes and disbands are not reported by RCON, the server log or
  the RNSquadJS sidecar. They are inferred from consecutive roster snapshots,
  which worker-rcon already takes every 2 s (`refreshRoster`: `ListPlayers` +
  `ListSquads`). A change faster than one poll interval (A → B → C) is recorded
  as A → C.

## 1. Detection (apps/workers/rcon)

### Squad identity

Within a match a squad is identified by `(team_id, squad_id, creator_eos_id)`.
The same `(team_id, squad_id)` with a different creator is a new squad, since
Squad reuses squad numbers within a round.

### Tracker

A pure module `squad-tracker.ts` next to `roster.ts`:

```ts
diffSquads(prev: SquadSnapshot | null, next: SquadSnapshot, pendingCreated: SquadCreatedBroadcast[]): {
  events: SquadEvent[];
  state: SquadSnapshot;
}
```

`SquadSnapshot` maps squad identity → `{ teamId, teamName, squadId, name,
creator, leader | null, lastLeader | null }`, built from the `ListSquads` and
`ListPlayers` rows of one roster refresh. `PerServerSupervisor` keeps the
previous snapshot in memory and calls `diffSquads` from `refreshRoster` (and
the 30 s full poll, which reads the same data).

Events:

| Event | Condition | Payload extras |
|---|---|---|
| `squad.created` | identity present in `next`, absent in `prev` | — ; time and creator IDs come from a matching RCON broadcast when one arrived for the same `(team_id, squad_id, creator)`, otherwise the poll time |
| `squad.leader_changed` | leader of the same identity changed from A to B (a leaderless gap between them is bridged via `lastLeader`) | `from`, `to`, `reason`: `passed` (A still in this squad), `left_squad` (A online, other/no squad), `disconnected` (A absent from `ListPlayers`) |
| `squad.disbanded` | identity present in `prev`, absent in `next` | `last_leader`, `creator_was_leader` |

No-false-event rules:

- The first snapshot after worker start, RCON (re)connect, or a match reset is
  a baseline: state is stored, no events.
- Match reset: on a `match.started` / `match.ended` refresh hint, or when every
  squad of a previous snapshot with at least 3 squads vanishes in one refresh
  (map change), the tracker resets without emitting disbands.

### RCON broadcast parser

`parseSquadCreatedBroadcast(line)` in `apps/workers/rcon/src/squad-broadcast.ts`
runs in `ingestBroadcast` before the chat parser and returns
`{ creatorName, creatorEosId, creatorSteamId64, squadId, squadName, teamName, at }`
or `null`. Parsed broadcasts are queued for the next `diffSquads` call and
expire after 10 s.

### Crown rule (current match)

For each creator (keyed by EOS id), over the squads they created this match:

- **grey** — some `squad.leader_changed` with `from = creator` and
  `reason = passed`.
- **red** — some `squad.leader_changed` with `from = creator` and
  `reason ∈ {left_squad, disconnected}`, or `squad.disbanded` with
  `creator_was_leader = true`.
- Red overrides grey. A creator who never gave up leadership has no crown. A
  creator who passed leadership and later got it back keeps grey.

## 2. Storage and API

### Event types (packages/shared-types/src/events.ts)

Add `squad.created`, `squad.leader_changed`, `squad.disbanded` to
`EVENT_TYPES`, with zod payload schemas:

```ts
const squadPlayerRef = z.object({ eos_id: z.string(), steam_id64: z.string().nullable(), name: z.string() });
const squadBase = {
  team_id: z.number().int(), team_name: z.string(),
  squad_id: z.number().int(), squad_name: z.string(),
  creator: squadPlayerRef,
};
// leader_changed: + from, to: squadPlayerRef, reason: z.enum(['passed','left_squad','disconnected'])
// disbanded:      + last_leader: squadPlayerRef.nullable(), creator_was_leader: z.boolean()
```

`actor_kind = 'player'`, `actor_id` = EOS id of the creator (`created`,
`disbanded`) or of `from` (`leader_changed`), so the existing
`events_actor_occurred_idx` serves per-player lookups.

### Persistence

Same path as `emitSeedingTransition`: XADD to `events:server:{id}`
(`MAXLEN ~ 10000`) and INSERT into `events` with `onConflictDoNothing`. No
migration: `events` is already partitioned with 24-month retention. The web
events journal gets Russian labels for the three kinds.

### Crown state (Redis)

Hash `rcon:squad-crowns:{serverId}`: field = creator EOS id, value = JSON

```json
{ "color": "grey" | "red",
  "squads": [{ "squad_name": "Alpha", "team_id": 1, "created_at": "…",
               "handoffs": [{ "to_name": "Ivan", "reason": "passed", "at": "…" }],
               "disbanded_at": null }] }
```

Written by worker-rcon whenever a creator's entry changes; deleted on match
reset; TTL 6 h refreshed on write. Survives worker restarts; the tracker
restarts from a baseline snapshot.

### API

`GET /api/v1/servers/:id/roster` (`server:view`, unchanged) reads the hash in
the same MGET/pipeline as `rcon:roster` and `rcon:squads` and adds to every
player `squad_crown: null | { color: 'grey' | 'red', squads: [...] }` (matched
by `eos_id`). No new routes, no new live-bus frame: the existing `rcon.roster`
frame already triggers a web refetch after every refresh.

### Fix: match_players.squad_name

`loadTeamSquadByPlayer` (`apps/workers/log-ingest/src/match-roster/store.ts`)
reads `rcon.players_polled` rows that are never persisted, so
`match_players.squad_name` is always null. At match close log-ingest instead
reads the last `rcon:roster:{id}` and `rcon:squads:{id}` Redis snapshots and
resolves each player's team and squad name from them. Players who left before
the match closed keep `null`.

## 3. UI (apps/web, live roster only)

`servers/[id]/live-players.tsx`: after the squad-leader star, a small inline
SVG `SquadCrown` component. Grey uses the muted ink token, red the danger
token (both themes). Tooltip and `aria-label` in Russian, one line per squad:

- «Создал отряд "Alpha" в 21:04, передал командование: Ivan (21:10)»
- «Создал отряд "Alpha" в 21:04 и покинул его, будучи командиром (21:12)»

No other UI changes.

## 4. Testing

- `diffSquads` unit tests: creation; each leader-change reason; leaderless gap;
  squad-number reuse; disband; baseline emits nothing; map-change mass vanish
  emits no disbands; broadcast dedupe and timestamp.
- `parseSquadCreatedBroadcast` on the real fixture line and non-matching lines.
- Crown rule: grey, red, red overrides grey, regained leadership stays grey.
- worker-rcon integration: sequence of snapshots through the supervisor
  against isolated Redis + Postgres; asserts `events` rows, crown hash contents,
  reset on `match.started`.
- API: `/servers/:id/roster` through the integration harness with a seeded
  crown hash returns `squad_crown`; without it returns `null`.
- Web: roster row component test for grey/red crown, tooltip text, no crown.
- `squad_name` fix: regression test for match close with Redis snapshots
  (fails before, passes after).

## Delivery

Branch `feature/squad-history` from `dev`, its own GitHub issue, merged into
`dev` together with fix wave 1.
