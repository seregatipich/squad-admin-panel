import { createDatabaseClient, events, playerReports, players, servers } from '@squad/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedReport } from '../src/parser/report.js';
import { parseReportLine } from '../src/parser/report.js';
import { handleReport, LIVE_BUS_CHANNEL } from '../src/report/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the report1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const REPORTER_ID = uuidv7();
const TARGET_ID = uuidv7();
const REPORTER_EOS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_EOS = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(1) };
}

function makeReport(overrides: Partial<ParsedReport> = {}): ParsedReport {
  return {
    ts: new Date().toISOString(),
    channel: 'ChatAll',
    reporterEos: REPORTER_EOS,
    reporterSteam: null,
    reporterName: 'Reporter One',
    targetRaw: 'BadGuy',
    body: 'is team killing at main',
    ...overrides,
  };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Report Test Server',
    slug: `report-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: REPORTER_ID,
      eosId: REPORTER_EOS,
      steamId64: null,
      canonicalName: 'Reporter One',
      canonicalNameNormalized: 'reporter one',
    },
    {
      id: TARGET_ID,
      eosId: TARGET_EOS,
      steamId64: null,
      canonicalName: 'BadGuy',
      canonicalNameNormalized: 'badguy',
    },
  ]);
});

afterAll(async () => {
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerReports).where(eq(playerReports.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, REPORTER_ID));
  await db.delete(players).where(eq(players.id, TARGET_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerReports).where(eq(playerReports.serverId, SERVER_ID));
});

describe('handleReport', () => {
  it('creates a player_reports row with resolved reporter and target uuids', async () => {
    const publisher = makePublisher();
    const result = await handleReport(db, publisher, {
      serverId: SERVER_ID,
      report: makeReport(),
    });

    expect(result.deduped).toBe(false);
    expect(result.reporterPlayerId).toBe(REPORTER_ID);
    expect(result.targetPlayerId).toBe(TARGET_ID);

    const rows = await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(result.reportId);
    expect(row.reporterPlayerId).toBe(REPORTER_ID);
    expect(row.targetPlayerId).toBe(TARGET_ID);
    expect(row.targetRaw).toBe('BadGuy');
    expect(row.body).toBe('is team killing at main');
    expect(row.source).toBe('ingame');
    expect(row.status).toBe('pending');
  });

  it('writes an events row of kind player_report correlated to the report', async () => {
    const result = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport(),
    });

    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'player_report')));
    expect(eventRows).toHaveLength(1);
    const event = eventRows[0];
    expect(event.correlationId).toBe(result.reportId);
    expect(event.actorKind).toBe('system');
    const payload = event.payload as Record<string, unknown>;
    expect(payload.report_id).toBe(result.reportId);
    expect(payload.reporter_player_id).toBe(REPORTER_ID);
    expect(payload.target_player_id).toBe(TARGET_ID);
    expect(payload.source).toBe('ingame');
  });

  it('emits a report.created frame on the live-bus channel for new reports', async () => {
    const publisher = makePublisher();
    const result = await handleReport(db, publisher, {
      serverId: SERVER_ID,
      report: makeReport(),
    });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publisher.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    const frame = JSON.parse(raw as string);
    expect(frame.type).toBe('report.created');
    expect(frame.data.report_id).toBe(result.reportId);
    expect(frame.data.target_player_id).toBe(TARGET_ID);
  });

  it('stores an EOS-only reporter and target (no steam id linkage)', async () => {
    const result = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({ targetRaw: TARGET_EOS, body: 'aimbot on stream' }),
    });

    expect(result.reporterPlayerId).toBe(REPORTER_ID);
    expect(result.targetPlayerId).toBe(TARGET_ID);

    const seeded = await db
      .select({ eosId: players.eosId, steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.id, TARGET_ID));
    expect(seeded[0].eosId).toBe(TARGET_EOS);
    expect(seeded[0].steamId64).toBeNull();
  });

  it('appends to the existing pending row for a repeat within the dedup window', async () => {
    const first = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({ body: 'first line' }),
    });
    const second = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({ body: 'second line' }),
    });

    expect(second.deduped).toBe(true);
    expect(second.reportId).toBe(first.reportId);

    const rows = await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('first line\nsecond line');

    const eventRows = await db.select().from(events).where(eq(events.serverId, SERVER_ID));
    expect(eventRows).toHaveLength(2);
  });

  it('creates a new row when the previous report is older than the dedup window', async () => {
    const first = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({ body: 'stale report' }),
    });
    await db
      .update(playerReports)
      .set({ createdAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(playerReports.id, first.reportId));

    const second = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({ body: 'fresh report' }),
    });

    expect(second.deduped).toBe(false);
    expect(second.reportId).not.toBe(first.reportId);

    const rows = await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID));
    expect(rows).toHaveLength(2);
  });

  it('resolves reporter and target end-to-end from a raw chat log line', async () => {
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: [Online IDs: EOS: ${REPORTER_EOS}] Reporter One : ChatAll : !report BadGuy hacking`;
    const report = parseReportLine(raw) as ParsedReport;
    report.ts = new Date().toISOString();

    const result = await handleReport(db, makePublisher(), { serverId: SERVER_ID, report });
    expect(result.reporterPlayerId).toBe(REPORTER_ID);
    expect(result.targetPlayerId).toBe(TARGET_ID);

    const rows = await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('hacking');
  });

  it('keeps an unresolved reporter and target as null while still storing target_raw', async () => {
    const result = await handleReport(db, makePublisher(), {
      serverId: SERVER_ID,
      report: makeReport({
        reporterEos: 'cccccccccccccccccccccccccccccccc',
        reporterName: 'Ghost',
        targetRaw: 'UnknownGuy',
      }),
    });

    expect(result.reporterPlayerId).toBeNull();
    expect(result.targetPlayerId).toBeNull();

    const rows = await db.select().from(playerReports).where(eq(playerReports.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].reporterPlayerId).toBeNull();
    expect(rows[0].targetPlayerId).toBeNull();
    expect(rows[0].targetRaw).toBe('UnknownGuy');
  });
});
