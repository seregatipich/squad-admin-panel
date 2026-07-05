# VOTE-1 — Squad built-in vote log-line format (research pin)

**Task:** VOTE-1 (issue #116, roadmap #56). Capture Squad's built-in votes from
`SquadGame.log` in the log-ingest worker.

**Date:** 2026-07-05 · **Squad reference:** v10.x (same log family validated for
`patterns.ts` against v10.3.1).

## 1. Goal of the pin

Before writing the parser we must fix the exact shape of the vote log lines so
the regexes are grounded rather than guessed. This document records what could
be verified from public sources, the conventions we can rely on, and the
concrete line format the parser targets. Live tailing against a real host is
**env-gated** (no live Squad server in this environment), so the wire format is
pinned here and the regexes are kept as isolated, adjustable constants — exactly
as the existing `report.ts` and `match.ts` parsers already disclaim.

## 2. What the sources actually show

Cross-checking the SquadJS log-parser (`Team-Silver-Sphere/SquadJS`,
`squad-server/log-parser/`) the shipped rule set is:

```
admin-broadcast, deployable-damaged, new-game, player-connected,
player-damaged, player-died, player-disconnected, player-join-succeeded,
player-possess, player-revived, player-un-possess, player-wounded,
round-ended, round-tickets, round-winner, server-tick-rate
```

There is **no vote rule in upstream SquadJS.** The popular community vote
plugins (`fantinodavide/squad-js-map-vote`, `nebriv/squad-map-voter`,
Vote-Manager) do **not** read vote state from `SquadGame.log`; they drive votes
over **RCON chat** — players type `!vote` / `1` / `2` in chat and the plugin
counts `ChatMessage` lines. Those chat lines carry the same online-identity
block this codebase already parses in `report.ts`:

```
[Online IDs: EOS: <eos32> steam: <steam17>]
```

Squad's **native** vote subsystem (end-of-round layer/faction voting, the
in-game "vote to skip", and admin-initiated `AdminVote`) does surface to the
server log, but the precise category/verb strings are not published in any
public parser or wiki page reachable here (the Fandom wiki `Voting` page is
paywalled/402 from this environment; GitHub code search for
`LogSquadVoteSystem`, `ServerStartVote`, `LogSquadVoting`, `VoteManager`
returned no Squad-side matches). SQSTAT (the competitor referenced by the task,
§14.3.2/§14.8) demonstrably ingests the full named ballot list from the log, so
the data exists in `SquadGame.log`; the exact tokens are its private finding.

## 3. Conventions we can rely on (verified in-repo)

Every Squad log line follows the prefix already validated in
`apps/workers/log-ingest/src/parser/patterns.ts`:

```
[YYYY.MM.DD-HH.MM.SS:mmm][<tick>]<LogCategory>: [<Verbosity>: ]<message>
```

`parseLine` strips the prefix and yields `{ ts, tick, category, verbosity,
message }`; category matches `Log[A-Za-z0-9_]+`, so a dedicated
`LogSquadVoteSystem` category parses correctly. Player identity blocks in the
`LogSquad` family use the `[Online IDs: EOS: … steam: …]` form (steam optional →
**EOS-only supported**, which the acceptance criteria require).

## 4. Pinned format used by the parser

The vote lifecycle is modelled as three line kinds under the
`LogSquadVoteSystem` category (the message grammar is isolated in
`src/parser/vote.ts` as `VOTE_START` / `VOTE_BALLOT` / `VOTE_END` and is the
single place to adjust once a live capture is available):

**Start** — one line, carries type, initiator identity, current/next/target
layer and the required threshold:

```
[2026.04.23-11.30.20:485][234]LogSquadVoteSystem: Display: Vote started: id=17 type=SkipMap initiator=[Online IDs: EOS: 0002aaaa...] SkipGuy current=Yehorivka_RAAS_v1 next=Narva_AAS_v2 required=25
```

`type` maps to the DB enum: `SkipMap`→`map_skip`, `ChangeLayer`/`MapChange`
→`map_change`, `Admin`/`AdminVote`→`admin`. `next`/`target` are optional and
emit `None` when absent.

**Ballot** — one line per cast (last choice per identity wins):

```
[...]LogSquadVoteSystem: Display: Vote registered: id=17 voter=[Online IDs: EOS: 0002bbbb...] Yes choice=Yes
```

`choice` ∈ `Yes|No` → DB enum `yes|no`.

**End** — one line, carries result and collected/required tally:

```
[...]LogSquadVoteSystem: Display: Vote finished: id=17 result=Passed votes=26/25
```

`result` ∈ `Passed|Failed` → `passed|failed`. `cancelled` is **not** a log verb —
it is produced by the assembler when the server goes down (crash/restart / new
game) with a vote still open, so a mid-vote restart yields a `cancelled` row
instead of a dangling open vote.

## 5. Design consequences

* Parser (`src/parser/vote.ts`) is pure and unit-tested with synthetic
  fixtures: `parseVoteStart`, `parseVoteBallot`, `parseVoteEnd`, and a
  per-server `VoteAssembler` state machine that accumulates the start + ballots
  in memory and emits **one** terminal `record` command on end / server-down.
* Player resolution (initiator + each ballot voter) is done in the store
  (`src/vote/store.ts`) against the DB by EOS/steam identity then by name,
  mirroring `report/store.ts`. EOS-only identities resolve correctly.
* The store writes one `game_votes` row + N `game_vote_ballots` rows, two
  `events` rows (`vote_started` / `vote_ended`), and publishes a `vote.ended`
  frame on the `live-bus` channel.
* Because the row is written only at a terminal state, a restart mid-vote can
  never leave a dangling open row — the assembler forces a `cancelled` close.

## 6. Live validation checklist (env-gated, follow-up)

When a live Squad host is available, capture a real vote sequence and confirm:
the exact category string, the start/ballot/end verbs, whether ballots are
logged individually (SQSTAT proves they are), and the initiator/target token
names. Only the three regex constants in `src/parser/vote.ts` need updating; the
assembler, store, schema, and tests are format-independent.

## Sources

- SquadJS log-parser rules: `Team-Silver-Sphere/SquadJS`
  `squad-server/log-parser/` (no vote rule upstream).
- Community RCON-based vote plugins: `fantinodavide/squad-js-map-vote`,
  `nebriv/squad-map-voter` (chat-driven, not log-driven).
- In-repo verified prefix + identity conventions:
  `apps/workers/log-ingest/src/parser/patterns.ts`,
  `apps/workers/log-ingest/src/parser/report.ts`.
- Squad Fandom wiki `Voting` (referenced; not fetchable from this environment).
