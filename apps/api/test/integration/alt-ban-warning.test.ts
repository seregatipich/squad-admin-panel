import {
  alertEvents,
  alertRules,
  auditLog,
  moderationActions,
  playerLinks,
  playerReports,
  players,
  roles,
  servers,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const OWNER_STEAM = testSteamId(965001);
const TARGET_STEAM = testSteamId(965002);
const ALT_STEAM = testSteamId(965003);
const LIMITED_STEAM = testSteamId(965004);

let h: IntegrationHarness;
let ownerId: string;
let targetId: string;
let altId: string;
let serverId: string;

function okOutcome() {
  return {
    attempted: true,
    ok: true,
    requestId: 'alt-warning-test',
    response: 'ok',
    via: 'worker-rcon',
  };
}

async function seedPlayer(steamId64: bigint, name: string, roleId?: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`missing player ${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'alt-warning-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function insertConfirmedAlt(): Promise<void> {
  const [playerAId, playerBId] = [targetId, altId].sort();
  await h.db.insert(playerLinks).values({
    playerAId,
    playerBId,
    linkType: 'alt',
    status: 'confirmed',
    createdBy: ownerId,
  });
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  vi.mocked(sendRconCommandViaWorker).mockReset();
  vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
  ownerId = h.seed.ownerPlayerId;
  targetId = await seedPlayer(TARGET_STEAM, 'Ban target');
  altId = await seedPlayer(ALT_STEAM, 'Confirmed alt');
  serverId = uuidv7();
  await h.db
    .insert(servers)
    .values({ id: serverId, displayName: 'ALT warning server', slug: `alt-warning-${serverId}` });
  await insertConfirmedAlt();
});

afterEach(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
});

describeIfDb('GET /api/v1/players/:id/ban-alt-warning', () => {
  it('returns confirmed alt details to a viewer with player:view_ips', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/ban-alt-warning`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      can_view_ips: true,
      confirmed_count: 1,
      confirmed: [{ player_id: altId, name: 'Confirmed alt', link_type: 'alt' }],
    });
  });

  it('degrades to a count without leaking names without player:view_ips', async () => {
    const roleId = uuidv7();
    await h.db.insert(roles).values({
      id: roleId,
      name: `AltWarningLimited-${roleId}`,
      color: '#3366AA',
      panelAccess: true,
      canViewIps: false,
    });
    await seedPlayer(LIMITED_STEAM, 'Limited viewer', roleId);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/ban-alt-warning`,
      headers: { cookie: await loginAsSteam(LIMITED_STEAM) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ can_view_ips: false, confirmed_count: 1, candidates: [] });
    expect(body.confirmed).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Confirmed alt');
  });
});

describeIfDb('ALT-7 report ban flow', () => {
  it('bans selected confirmed alts, links their ledger context, and raises AUTO-3', async () => {
    const [rule] = await h.db
      .insert(alertRules)
      .values({
        id: uuidv7(),
        name: 'Alt ban evasion',
        type: 'custom',
        config: { eventKind: 'alt.ban_evasion_suspected', severity: 'critical' },
        channels: ['webpush'],
        createdBy: ownerId,
      })
      .returning({ id: alertRules.id });
    const [report] = await h.db
      .insert(playerReports)
      .values({
        serverId,
        reporterPlayerId: ownerId,
        targetPlayerId: targetId,
        body: 'alt warning test',
        source: 'ui',
        status: 'pending',
      })
      .returning({ id: playerReports.id });
    const cookie = await loginAsOwner(h);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${report.id}/actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        action_type: 'ban',
        reason: 'alt test',
        ban_length: '0',
        also_player_ids: [altId],
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledTimes(2);
    expect(sendRconCommandViaWorker).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        command: 'AdminBan',
        args: [String(ALT_STEAM), '0', 'alt test'],
      }),
    );

    const actions = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, report.id));
    expect(actions).toHaveLength(2);
    const primary = actions.find((action) => action.playerId === targetId);
    const altAction = actions.find((action) => action.playerId === altId);
    expect(primary).toBeDefined();
    expect(altAction?.context).toMatchObject({ related_action_id: primary?.id });

    const alerts = await h.db.select().from(alertEvents).where(eq(alertEvents.ruleId, rule.id));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({
      target_player_id: targetId,
      confirmed_alt_ids: [altId],
      trigger: 'admin_ban',
    });

    const auditRows = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, 'player'), eq(auditLog.targetId, altId)));
    expect(
      auditRows.some((row) => (row.context as Record<string, unknown>).related_action_id),
    ).toBe(true);
  });
});
