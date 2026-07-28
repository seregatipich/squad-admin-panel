# worker-steam-refresh

`worker-steam-refresh` gradually fills and renews the Steam snapshot stored on
`players`. Each tick:

1. Selects at most 100 players with a SteamID whose `steam_checked_at` is NULL
   or at least seven days old, oldest first.
2. Fetches profiles and bans in requests of at most 100 accounts.
3. Fetches Squad ownership and playtime per account, with at most four requests
   in flight.
4. Saves a player only when profile, ban, and ownership responses are all
   present. An incomplete player remains stale and is retried later.

The process publishes `worker:heartbeat:steam-refresh` and
`steam_refresh.*` diagnostic events. With no `STEAM_API_KEY`, it remains
healthy with heartbeat status `disabled` and sends no Steam requests.

The Steam requests and Redis caches live in `@squad/steam-api`, shared with the
manual player-card refresh route. Cache lifetimes are one hour for profiles,
six hours for bans, and 24 hours for ownership and Squad playtime.
