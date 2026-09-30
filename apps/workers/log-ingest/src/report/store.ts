import { type DatabaseClient, events, playerNameHistory, playerReports, players } from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { type EventEnvelope, playerReportPayload, STREAM_NAME } from '@squad/shared-types';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import type { ParsedReport } from '../parser/report.js';

export const REPORT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
export const LIVE_BUS_CHANNEL = 'live-bus';

// Matches the deterministic-id idempotency scheme used elsewhere in the
// ingestor (e.g. combat/store.ts's COMBAT_EVENT_NAMESPACE): a report row's id
// is derived from the fields that make one `!report` log line unique, so a
// replayed tail (reconnect re-reading the last N lines) resolves to the same
// id instead of reprocessing the line as new input (#63 finding 940).
const REPORT_NAMESPACE = '6a5c9c9e-9e0a-5c1a-9b7b-9b6a2b8e4b7a';

function deterministicReportId(serverId: string, report: ParsedReport): string {
  const key = [
    serverId,
    report.ts,
    report.tick,
    report.reporterEos ?? '',
    report.reporterSteam ?? '',
    report.reporterName,
    report.targetRaw,
    report.body,
  ].join('|');
  return uuidv5(key, REPORT_NAMESPACE);
}

const EOS_FORM = /^[0-9a-f]{32}$/i;
const STEAM_FORM = /^\d{17}$/;

export interface ReportPublisher {
  publish(channel: string, message: string): Promise<unknown>;
  xadd(key: string, ...args: (string | number)[]): Promise<unknown>;
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
): Promise<EventEnvelope> {
  const payload = playerReportPayload.parse({
    report_id: params.reportId,
    reporter_player_id: params.reporterPlayerId,
    reporter_name: params.report.reporterName,
    target_player_id: params.targetPlayerId,
    target_raw: params.report.targetRaw,
    body: params.report.body,
    channel: params.report.channel,
    source: 'ingame',
  });
  const envelope: EventEnvelope = {
    event_id: uuidv7(),
    server_id: params.serverId,
    version: 1,
    type: 'player_report',
    ts: params.occurredAt.toISOString(),
    actor: { kind: 'system', id: params.reporterPlayerId },
    correlation_id: params.reportId,
    payload,
  };
  await db.insert(events).values({
    eventId: envelope.event_id,
    serverId: envelope.server_id,
    occurredAt: new Date(envelope.ts),
    kind: envelope.type,
    version: envelope.version,
    actorKind: envelope.actor?.kind ?? null,
    actorId: envelope.actor?.id ?? null,
    correlationId: envelope.correlation_id,
    payload: envelope.payload,
  });
  return envelope;
}

async function publishEvent(redis: ReportPublisher | null, envelope: EventEnvelope): Promise<void> {
  if (!redis) return;
  await redis.xadd(
    envelope.server_id ? STREAM_NAME.eventsServer(envelope.server_id) : STREAM_NAME.eventsGlobal(),
    'MAXLEN',
    '~',
    '10000',
    '*',
    'envelope',
    JSON.stringify(envelope),
  );
}

export async function handleReport(
  db: DatabaseClient,
  redis: ReportPublisher | null,
  { serverId, report }: HandleReportParams,
): Promise<HandleReportResult> {
  const occurredAt = new Date(report.ts);
  const deterministicId = deterministicReportId(serverId, report);
  const replayed = await db
    .select({
      id: playerReports.id,
      reporterPlayerId: playerReports.reporterPlayerId,
      targetPlayerId: playerReports.targetPlayerId,
    })
    .from(playerReports)
    .where(eq(playerReports.id, deterministicId))
    .limit(1);
  if (replayed[0]) {
    // The exact same log line was already turned into this report row
    // (or its append) in an earlier pass; treat this call as a no-op
    // rather than re-appending the body or creating a duplicate pending
    // report.
    return {
      reportId: replayed[0].id,
      deduped: true,
      reporterPlayerId: replayed[0].reporterPlayerId,
      targetPlayerId: replayed[0].targetPlayerId,
    };
  }

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
    // Appended in SQL against the row's current value, not the JS-side
    // `duplicate.body` snapshot: two concurrent duplicate reports doing a
    // read-then-write string concatenation here could otherwise lose one
    // body to the other's overwrite (#63 finding 941).
    await db
      .update(playerReports)
      .set({ body: sql`${playerReports.body} || ${`\n${report.body}`}` })
      .where(eq(playerReports.id, duplicate.id));
    const envelope = await writeEvent(db, {
      serverId,
      reportId: duplicate.id,
      occurredAt,
      reporterPlayerId,
      targetPlayerId,
      report,
    });
    await publishEvent(redis, envelope);
    return { reportId: duplicate.id, deduped: true, reporterPlayerId, targetPlayerId };
  }

  const reportId = deterministicId;
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

  const envelope = await writeEvent(db, {
    serverId,
    reportId,
    occurredAt,
    reporterPlayerId,
    targetPlayerId,
    report,
  });
  await publishEvent(redis, envelope);

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
