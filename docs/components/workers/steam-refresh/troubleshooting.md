# Troubleshooting

## Heartbeat says `disabled`

Set `STEAM_API_KEY` and restart the existing worker service. Do not create a
second worker: the current service begins refreshing on its first tick.

## Players remain stale

Check `steam_refresh.run_partial` and `steam_refresh.run_failed` diagnostics.
A player's profile columns are written only after profile, ban, and ownership
responses are all available. Private libraries are valid ownership responses
and are stored as unknown. A player with a missing or failed response only gets
`steam_checked_at` advanced, so the next attempt waits for the seven-day cutoff;
a failed shared profile or ban request (`run_failed`) changes nothing and is
retried on the next tick.

## Steam quota or latency is high

Profile and ban reads are bounded to 100 accounts per request, and ownership
uses four concurrent requests. Increase `STEAM_REFRESH_INTERVAL_MS` if the
operator key has stricter practical limits.
