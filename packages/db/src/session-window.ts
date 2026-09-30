/**
 * Shared partition-pruning bound for `player_sessions` window queries.
 *
 * `player_sessions` is monthly RANGE-partitioned on `connected_at`, but every
 * hourly recompute (presence, co-play, economy accrual, server daily stats)
 * historically bounded its window with `connected_at < windowEnd AND
 * COALESCE(disconnected_at, now) > windowStart` — an upper bound only. Because
 * `COALESCE(disconnected_at, now) > windowStart` is not sargable, Postgres has
 * to scan every partition ever created instead of pruning to the one or two
 * relevant months, and the cost grows without bound as history accumulates
 * (#1093, #1112, #1323).
 *
 * The fix adds a matching lower bound on `connected_at` itself, which the
 * planner can use for partition pruning: a session can only affect a window
 * if it was still open when the window started, which requires it to have
 * connected no earlier than `windowStart - SESSION_PRUNE_LOOKBACK_SECONDS`
 * *unless it is still open* (`disconnected_at IS NULL`), in which case it must
 * stay eligible no matter how old it is.
 *
 * `RconSupervisor` and `closeServerSessions` close stale sessions promptly on
 * reconnect/restart, so real sessions never stay open anywhere near this long;
 * it exists only to bound worst-case supervisor downtime, not to model a
 * plausible session length.
 */
export const SESSION_PRUNE_LOOKBACK_SECONDS = 2 * 86_400;
