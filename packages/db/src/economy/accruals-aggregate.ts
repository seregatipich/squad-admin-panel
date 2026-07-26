import type postgres from 'postgres';
import { ACCRUAL_TX_TYPES } from './accrual.js';

/**
 * Rebuild the `player_bonus_accruals` aggregate (ECON-5 #165): the rolling
 * 30-day bonus accrual window per player, backing
 * `GET /api/v1/leaderboards/bonuses?period=30d`.
 *
 * Full recompute in one transaction — DELETE everything, then INSERT…SELECT
 * summing `bonus_transactions.amount` over the accrual (`earn_*`) types with
 * `created_at >= now - interval '30 days'`, grouped per player. Spend/adjust
 * rows never count: the window ranks what was earned, not the balance.
 * Idempotent — rerunning with the same `now` yields identical rows.
 *
 * @param sql postgres.js connection
 * @param now reference clock for the window's upper bound (defaults to the
 *   current time); the window is `[now - 30 days, now]`
 * @returns number of aggregate rows written
 */
export async function recomputeBonusAccruals(
  sql: postgres.Sql,
  now: Date = new Date(),
): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`DELETE FROM player_bonus_accruals`;
    const inserted = await tx`
      INSERT INTO player_bonus_accruals (player_id, accrued_30d, computed_at)
      SELECT player_id, COALESCE(SUM(amount), 0)::int, ${now}::timestamptz
      FROM bonus_transactions
      WHERE type = ANY(${[...ACCRUAL_TX_TYPES]})
        AND created_at >= ${now}::timestamptz - INTERVAL '30 days'
        AND created_at <= ${now}::timestamptz
      GROUP BY player_id
      RETURNING player_id
    `;
    return inserted.length;
  });
}
