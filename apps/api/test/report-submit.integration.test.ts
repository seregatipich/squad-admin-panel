import { randomUUID } from 'node:crypto';
import { playerReports, players, reportEvidence, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(951001);
const NO_PANEL_STEAM = testSteamId(951002);
const REPORTER_STEAM = testSteamId(951003);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let serverId: string;
let targetId: string;
let reporterId: string;

async function seedPlayer(steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedServer(name: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({ id, displayName: name, slug: `${name}-${id}` });
  return id;
}

async function seedPanelAccessPlayer(steamId64: bigint, name: string): Promise<string> {
  const roleId = uuidv7();
  await h.db
    .insert(roles)
    .values({ id: roleId, name: `PanelAccess-${Date.now()}`, panelAccess: true });
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase(), roleId })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed panel-access player ${name}`);
  return row.id;
}

async function seedNoPanelPlayer(steamId64: bigint): Promise<string> {
  const roleId = uuidv7();
  await h.db
    .insert(roles)
    .values({ id: roleId, name: `NoPanel-${Date.now()}`, panelAccess: false });
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: 'NoPanelReporter',
      canonicalNameNormalized: 'nopanelreporter',
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed no-panel player');
  return row.id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'report-submit-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function createMediaLink(cookie: string, url: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/media/link',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ external_url: url }),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payloadLength = 32): Buffer {
  const payload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) payload[i] = i % 256;
  return Buffer.concat([PNG_SIGNATURE, payload]);
}

function buildMultipartPayload(file: { filename: string; contentType: string; content: Buffer }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----reportEvidenceTest${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadMediaFile(cookie: string): Promise<string> {
  const { body, contentType } = buildMultipartPayload({
    filename: 'evidence.png',
    contentType: 'image/png',
    content: pngBytes(),
  });
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: { cookie, 'content-type': contentType },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  reporterId = await seedPanelAccessPlayer(REPORTER_STEAM, 'ReportSubmitReporter');
  targetId = await seedPlayer(testSteamId(951004), 'ReportSubmitTarget');
  serverId = await seedServer('report-submit-test-server');
  await seedNoPanelPlayer(NO_PANEL_STEAM);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('POST /api/v1/reports', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ server_id: serverId, target_player_id: targetId, body: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel_access', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie: await loginAsSteam(NO_PANEL_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ server_id: serverId, target_player_id: targetId, body: 'x' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a source=ui pending report and returns it in the queue', async () => {
    const cookie = await loginAsOwner(h);
    const before = await h.db.select().from(playerReports);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'Suspicious behaviour on the server',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      source: string;
      status: string;
      reporter_player_id: string | null;
      target_player_id: string | null;
      evidence: unknown[];
      evidence_count: number;
    };
    expect(body.source).toBe('ui');
    expect(body.status).toBe('pending');
    expect(body.reporter_player_id).toBe(h.seed.ownerPlayerId);
    expect(body.target_player_id).toBe(targetId);
    expect(body.evidence).toEqual([]);
    expect(body.evidence_count).toBe(0);

    const after = await h.db.select().from(playerReports);
    expect(after.length).toBe(before.length + 1);

    const listRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?target_player_id=${targetId}&page_size=100`,
      headers: { cookie },
    });
    const listBody = listRes.json() as { items: Array<{ id: string; source: string }> };
    expect(listBody.items.some((r) => r.id === body.id && r.source === 'ui')).toBe(true);

    await assertAuditRow(h, { action: 'report.create', resource: 'report', targetId: body.id });
  });

  it('publishes a report.created live-bus frame with source ui', async () => {
    const received: LiveEvent[] = [];
    const unsub = h.app.liveBus.subscribe((event) => received.push(event));
    try {
      const cookie = await loginAsOwner(h);
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({
          server_id: serverId,
          target_player_id: targetId,
          body: 'Live bus check report',
        }),
      });
      expect(res.statusCode).toBe(201);
      const created = res.json() as { id: string };

      const frame = received.find(
        (e) => e.type === 'report.created' && e.data.report.id === created.id,
      );
      expect(frame).toBeDefined();
      if (frame && frame.type === 'report.created') {
        expect(frame.data.report.source).toBe('ui');
        expect(frame.data.report.status).toBe('pending');
      }
    } finally {
      unsub();
    }
  });

  it('attaches evidence media (link + upload) and returns them on GET /:id and evidence_count on the list', async () => {
    const cookie = await loginAsOwner(h);
    const linkMediaId = await createMediaLink(cookie, 'https://www.youtube.com/watch?v=evidence1');
    const uploadMediaId = await uploadMediaFile(cookie);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'Report with two evidence items',
        evidence_media_ids: [linkMediaId, uploadMediaId],
      }),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; evidence_count: number };
    expect(created.evidence_count).toBe(2);

    const detailRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${created.id}`,
      headers: { cookie },
    });
    const detail = detailRes.json() as {
      evidence: Array<{ id: string; kind: string; external_url: string | null }>;
    };
    expect(detail.evidence).toHaveLength(2);
    const ids = detail.evidence.map((e) => e.id).sort();
    expect(ids).toEqual([linkMediaId, uploadMediaId].sort());
    const linkItem = detail.evidence.find((e) => e.id === linkMediaId);
    expect(linkItem?.kind).toBe('external_link');
    expect(linkItem?.external_url).toBe('https://www.youtube.com/watch?v=evidence1');

    const listRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports?target_player_id=${targetId}&page_size=100`,
      headers: { cookie },
    });
    const listBody = listRes.json() as { items: Array<{ id: string; evidence_count: number }> };
    const listed = listBody.items.find((r) => r.id === created.id);
    expect(listed?.evidence_count).toBe(2);
  });

  it('omits soft-deleted media from evidence but keeps the report', async () => {
    const cookie = await loginAsOwner(h);
    const mediaId = await createMediaLink(cookie, 'https://www.youtube.com/watch?v=evidence2');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'Report whose evidence gets deleted',
        evidence_media_ids: [mediaId],
      }),
    });
    const created = res.json() as { id: string };

    const deleteRes = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode).toBe(200);

    const detailRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${created.id}`,
      headers: { cookie },
    });
    const detail = detailRes.json() as { evidence: unknown[]; status: string };
    expect(detail.evidence).toEqual([]);
    expect(detail.status).toBe('pending');
  });

  it('serves an evidence media stream only to authorized (session-bearing) requests', async () => {
    const cookie = await loginAsOwner(h);
    const mediaId = await uploadMediaFile(cookie);

    const unauth = await h.app.inject({ method: 'GET', url: `/api/v1/media/${mediaId}/stream` });
    expect(unauth.statusCode).toBe(401);

    const authed = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/stream`,
      headers: { cookie },
    });
    expect(authed.statusCode).toBe(200);
  });

  it('rejects an empty/whitespace body', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ server_id: serverId, target_player_id: targetId, body: '   ' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body longer than 2000 characters', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'x'.repeat(2001),
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown server_id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: '00000000-0000-0000-0000-000000000000',
        target_player_id: targetId,
        body: 'unknown server',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('server_not_found');
  });

  it('rejects an unknown target_player_id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: '00000000-0000-0000-0000-000000000000',
        body: 'unknown target',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('target_not_found');
  });

  it('rejects more than 10 evidence ids', async () => {
    const cookie = await loginAsOwner(h);
    const ids = Array.from({ length: 11 }, () => uuidv7());
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'too many attachments',
        evidence_media_ids: ids,
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown evidence media id and inserts no report row', async () => {
    const cookie = await loginAsOwner(h);
    const before = await h.db.select().from(playerReports);
    const unknownMediaId = uuidv7();

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'evidence does not exist',
        evidence_media_ids: [unknownMediaId],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string; id: string }).error).toBe('media_not_found');

    const after = await h.db.select().from(playerReports);
    expect(after.length).toBe(before.length);
  });

  it('rejects a soft-deleted evidence media id and inserts no report row', async () => {
    const cookie = await loginAsOwner(h);
    const mediaId = await createMediaLink(
      cookie,
      'https://www.youtube.com/watch?v=deleted-before-use',
    );
    const deleteRes = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode).toBe(200);

    const before = await h.db.select().from(playerReports);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'evidence was deleted',
        evidence_media_ids: [mediaId],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('media_not_found');

    const after = await h.db.select().from(playerReports);
    expect(after.length).toBe(before.length);
  });

  it('does not insert duplicate report_evidence rows for a repeated evidence id', async () => {
    const cookie = await loginAsOwner(h);
    const mediaId = await createMediaLink(cookie, 'https://www.youtube.com/watch?v=repeated');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'repeated evidence id',
        evidence_media_ids: [mediaId, mediaId],
      }),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; evidence_count: number };
    expect(created.evidence_count).toBe(1);

    const rows = await h.db
      .select()
      .from(reportEvidence)
      .where(eq(reportEvidence.reportId, created.id));
    expect(rows).toHaveLength(1);
  });

  it('reporter_name resolves the currently logged-in player on the reporter side', async () => {
    const cookie = await loginAsSteam(REPORTER_STEAM);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        target_player_id: targetId,
        body: 'reported by a plain panel-access player',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { reporter_player_id: string | null };
    expect(body.reporter_player_id).toBe(reporterId);
  });
});
