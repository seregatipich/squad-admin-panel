# `chat-ingest` — troubleshooting

## A chat line shows in the live feed but is missing from the archive

**Cause 1 — unknown sender.** `handleChat` archives only when `resolvePlayerId` finds a player. A sender whose EOS/Steam id matches no `players` row (the roster poll has not created the player yet) is published with `player_id: null` and never stored. There is no retry.

**Cause 2 — archive insert failed.** The frame is published before the insert; a failed insert is reported through `onArchiveError`. Both workers log it as a warning: `chat archive insert failed` (log-ingest) or `rcon chat archive insert failed` (rcon).

**Diagnostic**:
```bash
docker compose logs worker-log-ingest --since 10m | grep 'chat archive insert failed'
docker compose logs worker-rcon --since 10m | grep 'rcon chat archive insert failed'
```

## A message that should be flagged is not

- The rule is cached for 5 s per worker process (`ChatFlagDetector` default). A rule created or enabled in the panel can take up to that long to take effect.
- A flag-detection failure archives the line unflagged and logs `chat flag detection failed` / `rcon chat flag detection failed`. Check the database connection and the `chat_flag_rules` table.
- Only `enabled = true` rows load, and the oldest matching rule (by `created_at`, then `id`) wins, so `matched_rule_id` may name an older rule than the one you expected.
- A regex rule that fails `validateChatFlagPattern` in `shared-config`, or a word rule that is empty after trimming, is skipped at compile time without any log line.
- A message from a sender that resolves to no player is never evaluated (detection runs only after a player is resolved).

## A repeat sender is filed under the wrong player, or not found after a roster update

`PlayerIdCache` keeps an id-to-player mapping for 60 s per worker process. Platform ids do not move between players, so a stale entry is only possible if a `players` row was merged or deleted within the TTL. Restarting the worker empties the cache. Misses are never cached, so a newly created player is found on the next line.

## A sender with a Steam or EOS id is not matched even though a player with the same name exists

By design. When the sender carries at least one platform id and no `players` row matches it, `resolvePlayerId` returns `null` and does not try the name; matching by name would file the line under whoever else wears the same normalised name (regression test: `resolvePlayerId name fallback (#1057)`). The name fallback applies only to senders with neither id.

## `handleChat` rejects

The only rejection path is a failed identity query inside `resolvePlayerId` (the publish, flag and insert steps are all guarded by callbacks). Both consumers catch it and log `chat handling failed` (log-ingest, error level) or `rcon chat ingest failed` (rcon, warn level). Check the worker's database connectivity.

## `SyntaxError: Cannot convert ... to a BigInt`

`resolvePlayerId` calls `BigInt(chat.steamId64)`. A producer that passes a non-numeric `steamId64` string makes the call throw, which surfaces as a `handleChat` rejection (see above). Fix the producer's parser so it emits only decimal digit strings or `null`.
