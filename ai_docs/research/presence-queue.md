# PRES-4 spike — queue presence mode

Status: deferred (queue mode is not populated by the panel yet)
Scope: `player_sessions.mode = 'queue'` and `player_daily_presence.queue_seconds`
Date: 2026-07-05

## Question

PRES-4 asks for three presence modes on the week-calendar and per-server
breakdown: `online`, `boost`, and `queue`. `online` and `boost` are
determinable from data the panel already owns; `queue` requires knowing that a
player was sitting in the server join queue rather than actually in the match.
This note records what Squad/RCON actually exposes so the queue mode can be
implemented later without re-doing the investigation.

## What the schema already supports

- `player_sessions.mode` is a checked enum `('online','boost','queue')` and
  `player_daily_presence` carries `queue_seconds` alongside `online_seconds`
  and `boost_seconds`. No schema change is needed to light up queue — only a
  producer that opens sessions with `mode = 'queue'`.
- The PRES-4 read API (`GET /players/:id/presence`) and the calendar/per-server
  UI already render `queue` wherever it appears; queue simply stays at zero
  until a producer emits it.

## What Squad exposes (findings)

- **RCON `ListPlayers`** returns only players who have a live player slot. Queued
  clients are not present in that list, so a queue session cannot be opened from
  `ListPlayers` alone.
- **RCON `ShowServerInfo`** returns `PublicQueue`/`ReservedQueue` counts (queue
  *size*), but not the identities of the queued clients. A count is not
  attributable to a `players.id`, so it cannot open a per-player session.
- **Server log lines** (`SquadGame.log`) log the login handshake and the
  connect/`OnNetCleanup` disconnect, but there is no reliable, stable line that
  brackets "entered queue" → "left queue / promoted to a slot" with the player
  identity across Squad versions. The one signal that is attributable — the EOS
  login — already maps to the start of a normal `online` session.

Net: neither RCON nor the logs give a *per-player, identity-resolved, bracketed*
queue interval today. Emitting a `queue` session would require inferring it
(e.g. "seen in a `ShowServerInfo` queue count but not yet in `ListPlayers`"),
which is not attributable to a specific player and would produce fabricated
per-player data.

## Decision

Defer the `queue` mode. Do **not** synthesize queue sessions from queue counts.
The presence pipeline keeps `online`/`boost`; `queue_seconds` stays 0 and the
calendar/legend still carries the queue colour so the mode can appear the moment
a trustworthy producer exists.

## Revisit when

A per-player queue signal becomes available — e.g. a host-bridge / RCON
extension that reports queued client identities (EOS/Steam id) with enter/leave
timestamps, or a Squad log line that brackets a named client's time in queue.
At that point: open `player_sessions` with `mode = 'queue'` on queue-enter,
close on promotion/disconnect, and the existing daily-presence recompute and
PRES-4 surfaces pick it up with no further UI work.
