import type { DatabaseClient } from '@squad/db';
import {
  alertEvents,
  alertRules,
  moderationActions,
  playerReports,
  reporterStats,
} from '@squad/db/schema';
import { and, eq, gte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

/** Minimum confirmed reports before a reporter can be marked `trusted`. */
export const TRUSTED_MIN_CONFIRMED = 5;
/** Minimum accuracy (confirmed / resolved share) before a reporter can be marked `trusted`. */
export const TRUSTED_MIN_ACCURACY = 0.6;
/** Rejected-report count within {@link SPAM_WINDOW_DAYS} that flags a reporter as spam. */
export const SPAM_REJECTED_THRESHOLD = 5;
/** Rolling window (days) used to count recent rejected reports for spam detection. */
export const SPAM_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

interface ReporterVerdictInput {
  total: number;
  resolved: number;
  rejected: number;
  confirmed: number;
  recentRejected: number;
  previousSpamFlaggedAt: Date | null;
}

interface ReporterVerdict {
  accuracy: number;
  trusted: boolean;
  spamFlaggedAt: Date | null;
}

/**
 * Pure computation of a reporter's trust verdict from raw report counts.
 * `accuracy` is the confirmed share of resolved reports (0 when nothing has
 * been resolved yet, never divides by zero). `trusted` requires both a
 * confirmed-report volume floor and an accuracy floor. `spamFlaggedAt`
 * transitions null -> now() when recentRejected reaches the threshold, is
 * preserved (not re-stamped) while still at/above threshold, and clears back
 * to null once recentRejected drops below it.
 */
export function computeReporterVerdict(input: ReporterVerdictInput): ReporterVerdict {
  const accuracy = input.resolved > 0 ? input.confirmed / input.resolved : 0;
  const trusted = input.confirmed >= TRUSTED_MIN_CONFIRMED && accuracy >= TRUSTED_MIN_ACCURACY;

  const isSpam = input.recentRejected >= SPAM_REJECTED_THRESHOLD;
  const spamFlaggedAt = isSpam ? (input.previousSpamFlaggedAt ?? new Date()) : null;

  return { accuracy, trusted, spamFlaggedAt };
}

interface CustomAlertRuleConfig {
  eventKind?: string;
  severity?: 'info' | 'warning' | 'critical';
}

const SPAM_ALERT_EVENT_KIND = 'reports.spam_flagged';

/**
 * AUTO-3 style alert for a reporter transitioning into the spam flag: fires
 * only when an enabled `type = 'custom'` alert rule configured with
 * `config.eventKind = 'reports.spam_flagged'` exists (alert_events.rule_id is
 * a NOT NULL FK, so a rule is structurally required) — mirrors
 * apps/workers/ban-sync/src/alerts.ts raiseBanSyncFailureAlert.
 */
async function raiseSpamFlaggedAlert(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  reporterPlayerId: string,
  recentRejected: number,
): Promise<void> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));

  for (const rule of rules) {
    const config = rule.config as CustomAlertRuleConfig;
    if (config.eventKind !== SPAM_ALERT_EVENT_KIND) continue;

    const severity = config.severity ?? 'warning';
    const payload = {
      reporter_player_id: reporterPlayerId,
      recent_rejected: recentRejected,
      window_days: SPAM_WINDOW_DAYS,
      threshold: SPAM_REJECTED_THRESHOLD,
    };
    await db.insert(alertEvents).values({
      id: uuidv7(),
      ruleId: rule.id,
      severity,
      payload,
    });
    await redis.publish(
      'live-bus',
      JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
    );
  }
}

/**
 * Recomputes and upserts `reporter_stats` for one reporter from the current
 * `player_reports`/`moderation_actions` state, and raises the AUTO-3 spam
 * alert on a null -> set transition of `spam_flagged_at`. Called after any
 * report status change (resolve/reject/reopen) and after a moderation action
 * gets linked to (or a report's) reporter changes. No-ops safely when
 * `reporterPlayerId` has no reports (upserts a zeroed row) — callers should
 * still guard against a null reporter (ingame `target_raw` reports) before
 * calling. Best-effort by convention: callers should wrap this in try/catch
 * so a stats failure never fails the moderation request that triggered it.
 */
export async function recomputeReporterStats(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  reporterPlayerId: string,
): Promise<void> {
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) FILTER (WHERE ${playerReports.status} = 'resolved')::int`,
      rejected: sql<number>`count(*) FILTER (WHERE ${playerReports.status} = 'rejected')::int`,
      confirmed: sql<number>`count(*) FILTER (
        WHERE ${playerReports.status} = 'resolved'
          AND EXISTS (
            SELECT 1 FROM ${moderationActions}
            WHERE ${moderationActions.reportId} = ${playerReports.id}
              AND ${moderationActions.revertedAt} IS NULL
          )
      )::int`,
    })
    .from(playerReports)
    .where(eq(playerReports.reporterPlayerId, reporterPlayerId));

  const recentSince = new Date(Date.now() - SPAM_WINDOW_DAYS * DAY_MS);
  const [recent] = await db
    .select({ recentRejected: sql<number>`count(*)::int` })
    .from(playerReports)
    .where(
      and(
        eq(playerReports.reporterPlayerId, reporterPlayerId),
        eq(playerReports.status, 'rejected'),
        gte(playerReports.resolvedAt, recentSince),
      ),
    );

  const [existing] = await db
    .select({ spamFlaggedAt: reporterStats.spamFlaggedAt })
    .from(reporterStats)
    .where(eq(reporterStats.playerId, reporterPlayerId))
    .limit(1);

  const verdict = computeReporterVerdict({
    total: Number(counts?.total ?? 0),
    resolved: Number(counts?.resolved ?? 0),
    rejected: Number(counts?.rejected ?? 0),
    confirmed: Number(counts?.confirmed ?? 0),
    recentRejected: Number(recent?.recentRejected ?? 0),
    previousSpamFlaggedAt: existing?.spamFlaggedAt ?? null,
  });

  await db
    .insert(reporterStats)
    .values({
      playerId: reporterPlayerId,
      totalReports: Number(counts?.total ?? 0),
      resolvedReports: Number(counts?.resolved ?? 0),
      rejectedReports: Number(counts?.rejected ?? 0),
      confirmedReports: Number(counts?.confirmed ?? 0),
      accuracy: verdict.accuracy,
      trusted: verdict.trusted,
      spamFlaggedAt: verdict.spamFlaggedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: reporterStats.playerId,
      set: {
        totalReports: Number(counts?.total ?? 0),
        resolvedReports: Number(counts?.resolved ?? 0),
        rejectedReports: Number(counts?.rejected ?? 0),
        confirmedReports: Number(counts?.confirmed ?? 0),
        accuracy: verdict.accuracy,
        trusted: verdict.trusted,
        spamFlaggedAt: verdict.spamFlaggedAt,
        updatedAt: new Date(),
      },
    });

  const spamJustFlagged = existing?.spamFlaggedAt == null && verdict.spamFlaggedAt != null;
  if (spamJustFlagged) {
    await raiseSpamFlaggedAlert(db, redis, reporterPlayerId, Number(recent?.recentRejected ?? 0));
  }
}
