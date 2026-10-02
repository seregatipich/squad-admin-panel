import { auditLog, clanMembers, clans, players, roles } from '@squad/db/schema';
import { and, desc, eq, gt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { waitForAuditRows } from '../helpers/audit-since.js';
import { withFailingAuditInsert } from '../helpers/row-lock.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

/**
 * Issue #99 — routes that used to write their own audit row (success path
 * only, after the commit) now declare `config.audit` and pass before/after
 * through `req.auditSnapshots`. This suite pins what that changes for a few
 * routes of each shape: a denied attempt, a rejected attempt and a success
 * each write exactly one row, the success row keeps its snapshots, a handler
 * that audits inside its transaction is not audited a second time by the
 * hook, and a failed anonymous request on a public route writes nothing.
 */

const OWNER_STEAM = testSteamId(884001);
const VIEWER_STEAM = testSteamId(884002);
const MEMBER_STEAM = testSteamId(884003);

const SENTINEL_ACTION = 'clan_guard.settings.update';

let h: IntegrationHarness;
let ownerCookie: string;
let viewerCookie: string;
let viewerPlayerId: string;
let memberPlayerId: string;

async function auditMark(): Promise<bigint> {
  const [latest] = await h.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  return latest?.id ?? 0n;
}

/** Rows of one action written after `mark`, once the audit hook of every earlier request is done. */
async function rowsSince(mark: bigint, action: string) {
  // The hook writes after the response is sent and audit writes are serialised
  // on the hash chain, so once a later audited request has its own row, every
  // earlier request's hook has finished. The sentinel is a request no case
  // above sends, so its row cannot be mistaken for a case's.
  const sentinelMark = await auditMark();
  await h.app.inject({
    method: 'PATCH',
    url: '/api/v1/settings/clan-guard',
    headers: { cookie: ownerCookie },
    payload: {},
  });
  await waitForAuditRows(
    h.db,
    and(eq(auditLog.actionType, SENTINEL_ACTION), gt(auditLog.id, sentinelMark)),
  );
  return h.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actionType, action), gt(auditLog.id, mark)))
    .orderBy(auditLog.id);
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const [role] = await h.db
    .insert(roles)
    .values({ id: uuidv7(), name: `audit-viewer-${uuidv7()}`, panelAccess: true })
    .returning({ id: roles.id });
  const [viewer] = await h.db
    .insert(players)
    .values({
      steamId64: VIEWER_STEAM,
      canonicalName: 'AuditViewer',
      canonicalNameNormalized: 'auditviewer',
      roleId: role?.id,
    })
    .returning({ id: players.id });
  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: MEMBER_STEAM,
      canonicalName: 'AuditMember',
      canonicalNameNormalized: 'auditmember',
    })
    .returning({ id: players.id });
  if (!viewer || !member) throw new Error('seed failed');
  viewerPlayerId = viewer.id;
  memberPlayerId = member.id;
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: viewer.id,
    ip: null,
    userAgent: 'audit-declarative-routes-test',
    ttlMs: 21_600_000,
  });
  viewerCookie = `__Host-sid=${token}`;
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

describeIfDb('a denied attempt on a migrated route is audited once, with its actor', () => {
  it('records the 403 of a role without the changemap squad permission', async () => {
    const mark = await auditMark();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${uuidv7()}/seed-schedule`,
      headers: { cookie: viewerCookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: 'Anything' },
    });
    expect(res.statusCode).toBe(403);

    const rows = await rowsSince(mark, 'server.seed_schedule.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: 'steam',
      actorPlayerId: viewerPlayerId,
      targetType: 'seed_schedule',
      statusCode: 403,
      beforeSnapshot: null,
      afterSnapshot: null,
    });
  });

  it('records the 403 of a catalogue-key guard (coplay settings need player:view_ips)', async () => {
    const mark = await auditMark();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie: viewerCookie },
      payload: { min_shared_sessions: 3 },
    });
    expect(res.statusCode).toBe(403);

    const rows = await rowsSince(mark, 'coplay.settings.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorPlayerId: viewerPlayerId, statusCode: 403 });
  });
});

describeIfDb('a rejected attempt on a migrated route is audited once', () => {
  it('records the 404 for an unknown server', async () => {
    const mark = await auditMark();
    const unknownServer = uuidv7();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${unknownServer}/seed-schedule`,
      headers: { cookie: ownerCookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: 'Anything' },
    });
    expect(res.statusCode).toBe(404);

    const rows = await rowsSince(mark, 'server.seed_schedule.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetId: unknownServer,
      statusCode: 404,
      afterSnapshot: null,
    });
  });
});

describeIfDb('a successful mutation keeps its before/after snapshots in one row', () => {
  it('audits a settings update with the singleton before and after', async () => {
    const beforeFirst = await auditMark();
    const first = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie: ownerCookie },
      payload: { min_shared_sessions: 7 },
    });
    expect(first.statusCode).toBe(200);
    // Let the first request's row land, so the mark below separates the two.
    await rowsSince(beforeFirst, 'coplay.settings.update');

    const mark = await auditMark();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie: ownerCookie },
      payload: { min_shared_sessions: 9 },
    });
    expect(res.statusCode).toBe(200);

    const rows = await rowsSince(mark, 'coplay.settings.update');
    // The sentinel of rowsSince writes the same action: the case's own row is first.
    const own = rows[0];
    expect(own).toMatchObject({
      actorPlayerId: h.seed.ownerPlayerId,
      targetType: 'coplay_settings',
      targetId: '1',
      statusCode: 200,
    });
    expect(own?.beforeSnapshot).toMatchObject({ min_shared_sessions: 7 });
    expect(own?.afterSnapshot).toMatchObject({ min_shared_sessions: 9 });
    expect(own?.context).toMatchObject({ method: 'PUT', url: '/api/v1/settings/coplay' });
  });
});

describeIfDb('a handler that audits inside its transaction is not audited twice', () => {
  it('writes one clan.update row for a clan edit, with before/after', async () => {
    const clanId = uuidv7();
    await h.db
      .insert(clans)
      .values({ id: clanId, name: `Аудит${clanId.slice(-8)}`, description: 'до' });
    await h.db.insert(clanMembers).values({
      clanId,
      playerId: memberPlayerId,
      memberRole: 'leader',
      hasPriority: false,
    });

    const mark = await auditMark();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: ownerCookie },
      payload: { description: 'после' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await rowsSince(mark, 'clan.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'clan', targetId: clanId, statusCode: 200 });
    expect(rows[0]?.afterSnapshot).toMatchObject({ description: 'после' });
  });

  it('rolls the change back and answers 500 when that row cannot be written', async () => {
    const clanId = uuidv7();
    await h.db
      .insert(clans)
      .values({ id: clanId, name: `Откат${clanId.slice(-8)}`, description: 'до' });

    const res = await withFailingAuditInsert(h.db, 'clan.update', () =>
      h.app.inject({
        method: 'PATCH',
        url: `/api/v1/clans/${clanId}`,
        headers: { cookie: ownerCookie },
        payload: { description: 'после' },
      }),
    );
    expect(res.statusCode).toBe(500);
    const [row] = await h.db
      .select({ description: clans.description })
      .from(clans)
      .where(eq(clans.id, clanId));
    expect(row?.description).toBe('до');
  });
});

describeIfDb('a failed anonymous request on a public route writes no audit row', () => {
  it('does not record a public upload with an unknown token', async () => {
    const mark = await auditMark();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/public/media?token=not-a-real-token',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rowsSince(mark, 'media.public_upload')).toHaveLength(0);
  });
});
