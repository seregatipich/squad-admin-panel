import { type DatabaseClient, events, playerNameHistory, playerReports, players } from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ParsedReport } from '../parser/report.js';

export const REPORT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
export const LIVE_BUS_CHANNEL = 'live-bus';

const EOS_FORM = /^[0-9a-f]{32}$/i;
const STEAM_FORM = /^\d{17}$/;

export interface ReportPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface HandleReportParams {
  serverId: string;
  report: ParsedReport;
}

export interface HandleReportResult {
  reportId: string;
  deduped: boolean;
  reporterPlayerId: string | null;
  targetPlayerId: string | null;
}

async function resolveByIdentity(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null },
): Promise<string | null> {
  const filters = [];
  if (identity.eosId) filters.push(eq(players.eosId, identity.eosId));
  if (identity.steamId64) filters.push(eq(players.steamId64, BigInt(identity.steamId64)));
  if (filters.length === 0) return null;
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveByName(db: DatabaseClient, rawName: string): Promise<string | null> {
  const normalized = normalizePlayerName(rawName);
  if (!normalized) return null;
  const direct = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.canonicalNameNormalized, normalized))
    .limit(1);
  if (direct[0]) return direct[0].id;
  const historical = await db
    .select({ id: playerNameHistory.playerId })
    .from(playerNameHistory)
    .where(eq(playerNameHistory.nameNormalized, normalized))
    .orderBy(desc(playerNameHistory.lastSeenAt))
    .limit(1);
  return historical[0]?.id ?? null;
}

async function resolveReporter(db: DatabaseClient, report: ParsedReport): Promise<string | null> {
  const byId = await resolveByIdentity(db, {
    eosId: report.reporterEos,
    steamId64: report.reporterSteam,
  });
  if (byId) return byId;
  return resolveByName(db, report.reporterName);
}

async function resolveTarget(db: DatabaseClient, targetRaw: string): Promise<string | null> {
  if (EOS_FORM.test(targetRaw)) {
    const byEos = await resolveByIdentity(db, { eosId: targetRaw.toLowerCase(), steamId64: null });
    if (byEos) return byEos;
  }
  if (STEAM_FORM.test(targetRaw)) {
    const bySteam = await resolveByIdentity(db, { eosId: null, steamId64: targetRaw });
    if (bySteam) return bySteam;
  }
  return resolveByName(db, targetRaw);
}

async function findPendingDuplicate(
  db: DatabaseClient,
  params: {
    serverId: string;
    reporterPlayerId: string | null;
    targetPlayerId: string | null;
    targetRaw: string;
    since: Date;
  },
): Promise<{ id: string; body: string } | null> {
  if (!params.reporterPlayerId) return null;
  const filters = [
    eq(playerReports.serverId, params.serverId),
    eq(playerReports.status, 'pending'),
    eq(playerReports.source, 'ingame'),
    eq(playerReports.reporterPlayerId, params.reporterPlayerId),
    gte(playerReports.createdAt, params.since),
    params.targetPlayerId
      ? eq(playerReports.targetPlayerId, params.targetPlayerId)
      : and(isNull(playerReports.targetPlayerId), eq(playerReports.targetRaw, params.targetRaw)),
  ];
  const rows = await db
    .select({ id: playerReports.id, body: playerReports.body })
    .from(playerReports)
    .where(and(...filters))
    .orderBy(desc(playerReports.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function writeEvent(
  db: DatabaseClient,
  params: {
    serverId: string;
    reportId: string;
    occurredAt: Date;
    reporterPlayerId: string | null;
    targetPlayerId: string | null;
    report: ParsedReport;
  },
): Promise<void> {
  await db.insert(events).values({
    eventId: uuidv7(),
    serverId: params.serverId,
    occurredAt: params.occurredAt,
    kind: 'player_report',
    version: 1,
    actorKind: 'system',
    actorId: params.reporterPlayerId,
    correlationId: params.reportId,
    payload: {
      report_id: params.reportId,
      reporter_player_id: params.reporterPlayerId,
      target_player_id: params.targetPlayerId,
      target_raw: params.report.targetRaw,
      body: params.report.body,
      channel: params.report.channel,
      source: 'ingame',
    },
  });
}

export async function handleReport(
  db: DatabaseClient,
  redis: ReportPublisher | null,
  { serverId, report }: HandleReportParams,
): Promise<HandleReportResult> {
  const occurredAt = new Date(report.ts);
  const reporterPlayerId = await resolveReporter(db, report);
  const targetPlayerId = await resolveTarget(db, report.targetRaw);

  const duplicate = await findPendingDuplicate(db, {
    serverId,
    reporterPlayerId,
    targetPlayerId,
    targetRaw: report.targetRaw,
    since: new Date(occurredAt.getTime() - REPORT_DEDUP_WINDOW_MS),
  });

  if (duplicate) {
    await db
      .update(playerReports)
      .set({ body: `${duplicate.body}\n${report.body}` })
      .where(eq(playerReports.id, duplicate.id));
    await writeEvent(db, {
      serverId,
      reportId: duplicate.id,
      occurredAt,
      reporterPlayerId,
      targetPlayerId,
      report,
    });
    return { reportId: duplicate.id, deduped: true, reporterPlayerId, targetPlayerId };
  }

  const reportId = uuidv7();
  await db.insert(playerReports).values({
    id: reportId,
    serverId,
    reporterPlayerId,
    targetPlayerId,
    targetRaw: report.targetRaw,
    body: report.body,
    source: 'ingame',
    status: 'pending',
  });

  await writeEvent(db, {
    serverId,
    reportId,
    occurredAt,
    reporterPlayerId,
    targetPlayerId,
    report,
  });

  if (redis) {
    const frame = JSON.stringify({
      type: 'report.created',
      ts: new Date().toISOString(),
      data: {
        report_id: reportId,
        server_id: serverId,
        reporter_player_id: reporterPlayerId,
        target_player_id: targetPlayerId,
        target_raw: report.targetRaw,
        body: report.body,
        source: 'ingame',
        status: 'pending',
      },
    });
    await redis.publish(LIVE_BUS_CHANNEL, frame);
  }

  return { reportId, deduped: false, reporterPlayerId, targetPlayerId };
}
