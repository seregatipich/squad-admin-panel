import type { DatabaseClient } from '@squad/db';
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { sendRconCommandViaWorker } from './rcon-worker-command.js';
import { parseStoredRoster } from './roster.js';

/**
 * Hardcoded Russian AdminWarn templates sent to a reporter when their report
 * changes state (REPORT-3, #113 — "Уведомить репортёра" / auto-notify on
 * claim/resolve/reject).
 */
export const REPORTER_NOTIFY_TEMPLATES = {
  in_review: 'Ваш репорт принят в работу модерацией.',
  resolved: 'Ваш репорт рассмотрен модерацией. Спасибо!',
} as const;

export type ReporterNotifyTemplate = keyof typeof REPORTER_NOTIFY_TEMPLATES;

export type NotifyReporterOutcome =
  | {
      attempted: false;
      notified: false;
      reason: 'reporter_not_found' | 'reporter_identity_missing' | 'reporter_offline';
    }
  | { attempted: true; notified: true }
  | { attempted: true; notified: false; reason: string };

/**
 * Sends the report-status AdminWarn template to a reporter, if they are
 * currently online on the report's server (checked against the live roster
 * cached by MOD-1 polling). Never throws — every failure mode is reported in
 * the returned outcome so callers can treat notification as best-effort.
 */
export async function notifyReporter(
  db: DatabaseClient,
  redis: Redis,
  opts: {
    serverId: string;
    reporterPlayerId: string;
    template: ReporterNotifyTemplate;
    actorPlayerId: string | null;
  },
): Promise<NotifyReporterOutcome> {
  const [reporter] = await db
    .select({ id: players.id, eosId: players.eosId, steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.id, opts.reporterPlayerId))
    .limit(1);
  if (!reporter) return { attempted: false, notified: false, reason: 'reporter_not_found' };

  const reporterSteamId = reporter.steamId64 != null ? reporter.steamId64.toString() : null;
  const target = reporter.eosId ?? reporterSteamId;
  if (!target) return { attempted: false, notified: false, reason: 'reporter_identity_missing' };

  const stored = parseStoredRoster(await redis.get(`rcon:roster:${opts.serverId}`));
  const online = (stored?.players ?? []).some(
    (entry) =>
      (reporter.eosId && entry.eos_id === reporter.eosId) ||
      (reporterSteamId && entry.steam_id64 === reporterSteamId),
  );
  if (!online) return { attempted: false, notified: false, reason: 'reporter_offline' };

  const outcome = await sendRconCommandViaWorker(redis, {
    serverId: opts.serverId,
    command: 'AdminWarn',
    args: [target, REPORTER_NOTIFY_TEMPLATES[opts.template]],
    actorPlayerId: opts.actorPlayerId,
  });
  if (outcome.attempted && outcome.ok) return { attempted: true, notified: true };
  return {
    attempted: true,
    notified: false,
    reason: outcome.attempted ? outcome.reason : outcome.reason,
  };
}
