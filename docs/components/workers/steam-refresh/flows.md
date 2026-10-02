# Flows

## Refresh sweep

1. The worker computes a cutoff seven days before the current time.
2. PostgreSQL returns up to 100 Steam players ordered by
   `steam_checked_at ASC NULLS FIRST`.
3. `@squad/steam-api` serves cached fields where possible and batches cold
   profile and ban requests.
4. Ownership requests run with concurrency four because Steam accepts one
   account per request.
5. A complete snapshot updates the player and advances `steam_checked_at`.
   A player with missing or failed profile, ban or ownership data counts as
   `failed`: only `steam_checked_at` is advanced (no profile data changes), so
   the player is retried once it is again seven days old.
6. If the shared profile or ban request fails with nothing recovered, the tick
   throws before any write or ownership request, emits `steam_refresh.run_failed`
   and leaves every selected player untouched, so the next tick selects them again.

## Scheduling

One pass runs at startup and then every `STEAM_REFRESH_INTERVAL_MS`. Overlapping
passes are allowed (`overlap: 'allow'`). A failure of the startup pass is logged
and does not stop the worker.

## Disabled mode

An empty `STEAM_API_KEY` skips the database scan and all outbound requests. The
worker still publishes heartbeat status `disabled` and a
`steam_refresh.disabled` diagnostic event.
