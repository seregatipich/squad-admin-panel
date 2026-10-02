# Data Model

The worker owns no tables. It reads and writes only `players`
([`packages/db/src/schema/players.ts`](../../../../packages/db/src/schema/players.ts)),
added by migration `0094_player_steam_profile.sql`.

## Candidate selection

```sql
SELECT id, steam_id64
FROM players
WHERE steam_id64 IS NOT NULL
  AND (steam_checked_at IS NULL OR steam_checked_at <= <now - 7 days>)
ORDER BY steam_checked_at ASC NULLS FIRST
LIMIT 100
```

The partial index `players_steam_checked_at_idx` on
`(steam_checked_at NULLS FIRST) WHERE steam_id64 IS NOT NULL` serves this scan.

## Columns written on a complete snapshot

One `UPDATE players ... WHERE id = <player id>` per player sets:

| Column | Type | Source |
|---|---|---|
| `avatar_url` | text, nullable | `avatarfull`, NULL when empty |
| `persona_name` | text, nullable | `personaname`, NULL when empty |
| `profile_visibility` | smallint, nullable | `communityvisibilitystate` (1 private, 3 public) |
| `steam_account_created_at` | timestamptz, nullable | `timecreated` converted from epoch seconds; NULL on private profiles |
| `vac_banned` | boolean | `VACBanned` |
| `vac_ban_count` | integer | `NumberOfVACBans` |
| `game_ban_count` | integer | `NumberOfGameBans` |
| `days_since_last_ban` | integer, nullable | `DaysSinceLastBan` when either ban count is above 0, otherwise NULL |
| `owns_squad` | boolean, nullable | NULL when the library is private or hidden |
| `steam_playtime_minutes` | integer, nullable | Squad `playtime_forever`, NULL when unknown |
| `steam_checked_at` | timestamptz | The tick time |

NULL means Steam did not say, never "false" or zero.

## Columns written on an incomplete player

When profile, ban or ownership data is missing for a selected player, only
`steam_checked_at` is set to the tick time. The other columns keep their
previous values.

## Redis

Heartbeat, diagnostics and the three Steam response caches are listed in
[api.md](api.md). The worker stores no durable state in Redis.
