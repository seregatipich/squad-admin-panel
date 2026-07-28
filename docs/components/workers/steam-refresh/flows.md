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
   Missing or failed per-player data leaves that player eligible for retry.

## Disabled mode

An empty `STEAM_API_KEY` skips the database scan and all outbound requests. The
worker still publishes heartbeat status `disabled` and a
`steam_refresh.disabled` diagnostic event.
