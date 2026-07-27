// LEAD-7 (#178): seasons CRUD + the season resolution the leaderboards route
// performs when `period=season` arrives without an explicit `period_start`.
//
// The mutating routes are gated on the `can_edit_roles` capability flag (Owner
// short-circuits it), and both of them must land in audit_log with before/after
// snapshots — that is acceptance criterion 5.
import { players, roles, seasons } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(991001);
const EDITOR_STEAM = testSteamId(991002);
const VIEWER_STEAM = testSteamId(991003);
const NO_PANEL_STEAM = testSteamId(991004);

let h: IntegrationHarness;
let ownerCookie: string;
let editorCookie: string;
let viewerCookie: string;
let noPanelCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface SeasonBody {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  finalized: boolean;
}

async function createSeason(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => unknown }> {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/seasons',
    headers: { cookie },
    payload: body,
  });
}

// uuidv7's leading characters encode the timestamp, so slicing it does not
// yield a unique name within a single test run — use a counter instead.
let seasonNameCounter = 0;

function seasonPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seasonNameCounter += 1;
  return {
    name: `Season ${seasonNameCounter}`,
    starts_at: '2026-06-01T00:00:00.000Z',
    ends_at: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SeasonOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const editorRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: editorRoleId,
    name: 'SeasonEditor',
    color: 'sky',
    isSystemRole: false,
    panelAccess: true,
    canEditRoles: true,
  });
  const viewerRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: viewerRoleId,
    name: 'SeasonViewer',
    color: 'neutral',
    isSystemRole: false,
    panelAccess: true,
    canEditRoles: false,
  });
  const noPanelRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: noPanelRoleId,
    name: 'SeasonOutsider',
    color: 'neutral',
    isSystemRole: false,
    panelAccess: false,
    canEditRoles: false,
  });

  await h.db.insert(players).values({
    steamId64: EDITOR_STEAM,
    canonicalName: 'SeasonEditorUser',
    canonicalNameNormalized: 'seasoneditoruser',
    roleId: editorRoleId,
  });
  await h.db.insert(players).values({
    steamId64: VIEWER_STEAM,
    canonicalName: 'SeasonViewerUser',
    canonicalNameNormalized: 'seasonvieweruser',
    roleId: viewerRoleId,
  });
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'SeasonOutsiderUser',
    canonicalNameNormalized: 'seasonoutsideruser',
    roleId: noPanelRoleId,
  });

  editorCookie = await loginAsSteam(EDITOR_STEAM, 'season-editor');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'season-viewer');
  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM, 'season-outsider');
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  await h.db.delete(seasons);
});

describeIfDb('GET /api/v1/seasons', () => {
  it('rejects an anonymous request with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/seasons' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('rejects a session without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/seasons',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists seasons for a panel user without can_edit_roles', async () => {
    await createSeason(ownerCookie, seasonPayload({ name: 'Readable' }));

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/seasons',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: SeasonBody[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: 'Readable',
      status: 'upcoming',
      finalized: false,
    });
    expect(body.items[0]?.starts_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('filters by status', async () => {
    await createSeason(ownerCookie, seasonPayload({ name: 'Up', status: 'upcoming' }));
    await createSeason(ownerCookie, seasonPayload({ name: 'Act', status: 'active' }));

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/seasons?status=active',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: SeasonBody[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe('Act');
  });
});

describeIfDb('POST /api/v1/seasons', () => {
  it('rejects a panel user without can_edit_roles with 403', async () => {
    const res = await createSeason(viewerCookie, seasonPayload());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', required: 'can_edit_roles' });
  });

  it('rejects an anonymous request with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/seasons',
      payload: seasonPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a season for a role holding can_edit_roles', async () => {
    const res = await createSeason(editorCookie, seasonPayload({ name: 'Summer 2026' }));
    expect(res.statusCode).toBe(201);
    const body = res.json() as SeasonBody;
    expect(body).toMatchObject({
      name: 'Summer 2026',
      starts_at: '2026-06-01T00:00:00.000Z',
      ends_at: '2026-08-31T00:00:00.000Z',
      status: 'upcoming',
      finalized: false,
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates a season for the Owner (capability short-circuit)', async () => {
    const res = await createSeason(ownerCookie, seasonPayload({ name: 'OwnerMade' }));
    expect(res.statusCode).toBe(201);
  });

  it('rejects ends_at <= starts_at with 400 invalid_bounds', async () => {
    const res = await createSeason(
      editorCookie,
      seasonPayload({ starts_at: '2026-06-01T00:00:00.000Z', ends_at: '2026-06-01T00:00:00.000Z' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_bounds' });
  });

  it('rejects a second active season with 409 active_season_exists', async () => {
    const first = await createSeason(editorCookie, seasonPayload({ status: 'active' }));
    expect(first.statusCode).toBe(201);

    const second = await createSeason(editorCookie, seasonPayload({ status: 'active' }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'active_season_exists' });
  });

  it('rejects a duplicate name with 409 season_name_taken', async () => {
    await createSeason(editorCookie, seasonPayload({ name: 'Duplicate' }));
    const res = await createSeason(editorCookie, seasonPayload({ name: 'Duplicate' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'season_name_taken' });
  });

  it('refuses to create a season directly in the closed state', async () => {
    const res = await createSeason(editorCookie, seasonPayload({ status: 'closed' }));
    expect(res.statusCode).toBe(400);
  });

  it('writes an audit row with before=null and the created season as after', async () => {
    const res = await createSeason(editorCookie, seasonPayload({ name: 'Audited' }));
    expect(res.statusCode).toBe(201);
    const created = res.json() as SeasonBody;

    const row = await assertAuditRow(h, {
      action: 'season.create',
      resource: 'season',
      targetId: created.id,
    });
    expect(row.beforeSnapshot).toBeNull();
    expect(row.afterSnapshot).toMatchObject({ name: 'Audited', status: 'upcoming' });
  });
});

describeIfDb('PATCH /api/v1/seasons/:id', () => {
  async function makeSeason(overrides: Record<string, unknown> = {}): Promise<SeasonBody> {
    const res = await createSeason(editorCookie, seasonPayload(overrides));
    expect(res.statusCode).toBe(201);
    return res.json() as SeasonBody;
  }

  it('rejects a panel user without can_edit_roles with 403', async () => {
    const season = await makeSeason();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${season.id}`,
      headers: { cookie: viewerCookie },
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown season', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${uuidv7()}`,
      headers: { cookie: editorCookie },
      payload: { name: 'Ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'season_not_found' });
  });

  it('renames a season', async () => {
    const season = await makeSeason({ name: 'Before' });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${season.id}`,
      headers: { cookie: editorCookie },
      payload: { name: 'After' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SeasonBody).name).toBe('After');
  });

  it('promotes a season to active and refuses a second one with 409', async () => {
    const first = await makeSeason({ name: 'First' });
    const second = await makeSeason({ name: 'Second' });

    const promoteFirst = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${first.id}`,
      headers: { cookie: editorCookie },
      payload: { status: 'active' },
    });
    expect(promoteFirst.statusCode).toBe(200);
    expect((promoteFirst.json() as SeasonBody).status).toBe('active');

    const promoteSecond = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${second.id}`,
      headers: { cookie: editorCookie },
      payload: { status: 'active' },
    });
    expect(promoteSecond.statusCode).toBe(409);
    expect(promoteSecond.json()).toEqual({ error: 'active_season_exists' });
  });

  it('rejects an update that would invert the bounds with 400', async () => {
    const season = await makeSeason();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${season.id}`,
      headers: { cookie: editorCookie },
      payload: { ends_at: '2026-01-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_bounds' });
  });

  it('refuses to edit a finalized season with 422 season_finalized', async () => {
    const season = await makeSeason({ name: 'Frozen' });
    await h.db.update(seasons).set({ finalized: true }).where(eq(seasons.id, season.id));

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${season.id}`,
      headers: { cookie: editorCookie },
      payload: { name: 'Thawed' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'season_finalized' });
  });

  it('writes an audit row carrying both the before and the after snapshot', async () => {
    const season = await makeSeason({ name: 'AuditBefore' });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${season.id}`,
      headers: { cookie: editorCookie },
      payload: { name: 'AuditAfter' },
    });
    expect(res.statusCode).toBe(200);

    const row = await assertAuditRow(h, {
      action: 'season.update',
      resource: 'season',
      targetId: season.id,
    });
    expect(row.beforeSnapshot).toMatchObject({ name: 'AuditBefore' });
    expect(row.afterSnapshot).toMatchObject({ name: 'AuditAfter' });
  });
});

describeIfDb('GET /api/v1/leaderboards?period=season', () => {
  it('resolves period_start from the active season when it is omitted', async () => {
    await createSeason(
      editorCookie,
      seasonPayload({
        name: 'Live',
        status: 'active',
        starts_at: '2026-06-10T00:00:00.000Z',
        ends_at: '2026-07-20T00:00:00.000Z',
      }),
    );

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/leaderboards?metric=online&period=season',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      period: string;
      period_start: string;
      season: { name: string; status: string; finalized: boolean } | null;
    };
    expect(body.period).toBe('season');
    expect(body.period_start).toBe('2026-06-10');
    expect(body.season).toMatchObject({ name: 'Live', status: 'active', finalized: false });
  });

  it('returns 400 no_active_season when no season is active', async () => {
    await createSeason(editorCookie, seasonPayload({ name: 'NotStarted' }));

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/leaderboards?metric=online&period=season',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('no_active_season');
  });

  it('honours an explicit period_start and reports that season as metadata', async () => {
    // A season cannot be born closed, so it is created and then closed — which
    // is also the archive path the UI browses.
    const created = await createSeason(
      editorCookie,
      seasonPayload({
        name: 'Archived',
        starts_at: '2026-01-05T00:00:00.000Z',
        ends_at: '2026-03-05T00:00:00.000Z',
      }),
    );
    expect(created.statusCode).toBe(201);
    const closed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/seasons/${(created.json() as SeasonBody).id}`,
      headers: { cookie: editorCookie },
      payload: { status: 'closed' },
    });
    expect(closed.statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/leaderboards?metric=online&period=season&period_start=2026-01-05',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      period_start: string;
      season: { name: string; status: string } | null;
    };
    expect(body.period_start).toBe('2026-01-05');
    expect(body.season).toMatchObject({ name: 'Archived', status: 'closed' });
  });

  it('leaves non-season periods untouched (no season metadata, no DB lookup)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/leaderboards?metric=online&period=alltime',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { period_start: string; season: unknown };
    expect(body.period_start).toBe('1970-01-01');
    expect(body.season ?? null).toBeNull();
  });
});
