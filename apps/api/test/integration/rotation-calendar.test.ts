import { events, matches, players, roles, seedSchedule, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = testSteamId(147000 + (process.pid % 100000));
const SERVER_ID = uuidv7();
const MATCH_ID = uuidv7();
const EVENT_ID = uuidv7();
const SEED_ID = uuidv7();
const KNOWN_LAYER = 'Yehorivka RAAS v11';

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
    reusePublicSchema: true,
  });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Rotation Calendar Server',
    slug: `rotation-calendar-${uuidv7().slice(0, 8)}`,
    timezone: 'UTC',
  });
  await h.db.insert(matches).values({
    id: MATCH_ID,
    serverId: SERVER_ID,
    map: 'Yehorivka',
    layer: KNOWN_LAYER,
    winner: 'team1',
    startedAt: new Date('2026-07-13T10:00:00Z'),
    endedAt: new Date('2026-07-13T11:00:00Z'),
    durationSeconds: 3600,
  });
  await h.db.insert(events).values({
    eventId: EVENT_ID,
    serverId: SERVER_ID,
    occurredAt: new Date('2026-07-13T10:00:00Z'),
    kind: 'match.started',
    payload: { layer: KNOWN_LAYER },
  });
  await h.db.insert(seedSchedule).values({
    id: SEED_ID,
    serverId: SERVER_ID,
    startsAt: new Date('2026-07-14T10:00:00Z'),
    seedLayer: 'Sumari Seed v1',
  });
});

afterAll(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRoleWithoutChangeMap(): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `RotationCalendarNoChange-${roleId.slice(0, 8)}`,
    color: 'blue',
    panelAccess: true,
  });
  await h.db.update(players).set({ roleId }).where(eq(players.steamId64, OWNER_STEAM_ID));
  invalidatePermissionCache(h.seed.ownerPlayerId as string);
  return loginAsOwner(h);
}

describe('ROT-4 rotation calendar API', () => {
  it('returns history from matches and scheduled entries with read permission', async () => {
    const cookie = await loginAsOwner(h);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/rotation-schedule?from=2026-07-13T00:00:00.000Z&to=2026-07-15T00:00:00.000Z`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entries: [],
      history: [{ id: MATCH_ID, map: 'Yehorivka', layer: KNOWN_LAYER }],
      profiles: [],
      can_edit: true,
    });
  });

  it('creates a scheduled layer with a seed-overlap warning and audit row', async () => {
    const cookie = await loginAsOwner(h);
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/rotation-schedule`,
      headers: { cookie },
      payload: {
        scheduled_at: '2026-07-14T10:00:00.000Z',
        layer: KNOWN_LAYER,
        mode: 'set_next',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; warnings: Array<{ type: string }> }>();
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'seed_schedule_overlap' })]),
    );
    await assertAuditRow(h, {
      action: 'server.rotation_schedule.create',
      resource: 'rotation_schedule',
      targetId: body.id,
    });
  });

  it('persists weekly default and weekday profiles and audits the replacement', async () => {
    const cookie = await loginAsOwner(h);
    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/rotation-profiles`,
      headers: { cookie },
      payload: {
        profiles: [
          { name: 'По умолчанию', weekday: null, layers: [KNOWN_LAYER] },
          { name: 'Понедельник', weekday: 1, layers: ['Gorodok RAAS v1'] },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ profiles: Array<{ weekday: number | null; name: string }> }>().profiles,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ weekday: null, name: 'По умолчанию' }),
        expect.objectContaining({ weekday: 1, name: 'Понедельник' }),
      ]),
    );
    await assertAuditRow(h, {
      action: 'server.rotation_profiles.replace',
      resource: 'server',
      targetId: SERVER_ID,
    });
  });

  it('gates writes by changemap while retaining read-only calendar access', async () => {
    const cookie = await asRoleWithoutChangeMap();
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/rotation-schedule`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ can_edit: boolean }>().can_edit).toBe(false);

    const write = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/rotation-schedule`,
      headers: { cookie },
      payload: { scheduled_at: new Date().toISOString(), layer: KNOWN_LAYER },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: 'forbidden', required_squad_permission: 'changemap' });
  });

  it('returns 401 to anonymous calendar reads', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/rotation-schedule`,
    });
    expect(response.statusCode).toBe(401);
  });
});
