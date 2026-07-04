import { players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(840001);
const EDITOR_STEAM = testSteamId(840002);
const VIEWER_STEAM = testSteamId(840003);

let h: IntegrationHarness;
let ownerCookie: string;
let editorCookie: string;
let viewerCookie: string;
let suspectPlayerId: string;

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

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'MarkTypeOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const editorRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: editorRoleId,
    name: 'TaxonomyEditor',
    color: 'sky',
    isSystemRole: false,
    panelAccess: true,
    canEditRoles: true,
  });
  const viewerRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: viewerRoleId,
    name: 'TaxonomyViewer',
    color: 'neutral',
    isSystemRole: false,
    panelAccess: true,
    canEditRoles: false,
  });

  await h.db.insert(players).values({
    steamId64: EDITOR_STEAM,
    canonicalName: 'TaxEditor',
    canonicalNameNormalized: 'taxeditor',
    roleId: editorRoleId,
  });
  await h.db.insert(players).values({
    steamId64: VIEWER_STEAM,
    canonicalName: 'TaxViewer',
    canonicalNameNormalized: 'taxviewer',
    roleId: viewerRoleId,
  });

  const [suspect] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(840010),
      canonicalName: 'TaxSuspect',
      canonicalNameNormalized: 'taxsuspect',
    })
    .returning({ id: players.id });
  if (!suspect) throw new Error('failed to seed suspect player');
  suspectPlayerId = suspect.id;

  editorCookie = await loginAsSteam(EDITOR_STEAM, 'mark-types-editor');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'mark-types-viewer');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

async function listTypes(cookie: string, includeInactive = false) {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/mark-types${includeInactive ? '?include_inactive=true' : ''}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Array<{
    id: number;
    slug: string;
    label_ru: string;
    icon: string;
    severity: number;
    is_active: boolean;
    sort_order: number;
  }>;
}

describeIfDb('POST /api/v1/mark-types', () => {
  it('creates a new type that is immediately available in the active dropdown set', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/mark-types',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        slug: 'ghost_peek',
        label_en: 'Ghost Peek',
        label_ru: 'Гост-пик',
        icon: 'radar',
        severity: 4,
      }),
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      id: number;
      slug: string;
      is_active: boolean;
      sort_order: number;
    };
    expect(created.slug).toBe('ghost_peek');
    expect(created.id).toBe(9);
    expect(created.is_active).toBe(true);
    expect(created.sort_order).toBe(9);

    const activeTypes = await listTypes(editorCookie);
    expect(activeTypes.map((t) => t.slug)).toContain('ghost_peek');
  });

  it('writes a mark_type.create audit entry with the actor and after snapshot', async () => {
    const row = await assertAuditRow(h, { action: 'mark_type.create', resource: 'mark_type' });
    expect(row.actorKind).toBe('steam');
    expect(row.beforeSnapshot).toBeNull();
    expect(row.afterSnapshot).toMatchObject({ slug: 'ghost_peek', is_active: true });
  });

  it('rejects a duplicate slug with 409', async () => {
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/v1/mark-types',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        slug: 'ghost_peek',
        label_en: 'Dup',
        label_ru: 'Дубликат',
        icon: 'flag',
        severity: 1,
      }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'slug_already_exists' });
  });

  it('rejects an icon outside the fixed set with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/mark-types',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        slug: 'bad_icon',
        label_en: 'Bad',
        label_ru: 'Плохо',
        icon: 'not-a-real-icon',
        severity: 2,
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a user without role:edit with 403', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/mark-types',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        slug: 'forbidden_type',
        label_en: 'Nope',
        label_ru: 'Нет',
        icon: 'flag',
        severity: 1,
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unauthenticated create with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/mark-types',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        slug: 'anon_type',
        label_en: 'Anon',
        label_ru: 'Аноним',
        icon: 'flag',
        severity: 1,
      }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('PATCH /api/v1/mark-types/:id', () => {
  it('edits label/icon/severity of a seeded type and audits before/after', async () => {
    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/1',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ label_ru: 'Вижу сквозь стены (v2)', icon: 'eye-off', severity: 4 }),
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json() as { label_ru: string; icon: string; severity: number };
    expect(updated.label_ru).toBe('Вижу сквозь стены (v2)');
    expect(updated.icon).toBe('eye-off');
    expect(updated.severity).toBe(4);

    const row = await assertAuditRow(h, {
      action: 'mark_type.update',
      resource: 'mark_type',
      targetId: '1',
    });
    expect(row.beforeSnapshot).toMatchObject({ id: 1, slug: 'wallhack', icon: 'scan-eye' });
    expect(row.afterSnapshot).toMatchObject({ id: 1, icon: 'eye-off', severity: 4 });
  });

  it('deactivating a type removes it from the dropdown but keeps it in include_inactive and history', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${suspectPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 5, comment: 'reload' }),
    });
    expect(created.statusCode).toBe(201);

    const deactivate = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/5',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ is_active: false }),
    });
    expect(deactivate.statusCode).toBe(200);
    expect((deactivate.json() as { is_active: boolean }).is_active).toBe(false);

    const activeTypes = await listTypes(ownerCookie);
    expect(activeTypes.map((t) => t.id)).not.toContain(5);

    const allTypes = await listTypes(ownerCookie, true);
    const deactivated = allTypes.find((t) => t.id === 5);
    expect(deactivated?.is_active).toBe(false);

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${suspectPlayerId}/marks?include_cleared=true`,
      headers: { cookie: ownerCookie },
    });
    expect(history.statusCode).toBe(200);
    const items = (
      history.json() as { items: Array<{ mark_type_id: number; mark_type: { slug: string } }> }
    ).items;
    const stillThere = items.find((m) => m.mark_type_id === 5);
    expect(stillThere?.mark_type.slug).toBe('reload_exploit');
  });

  it('returns 404 for an unknown type id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/9999',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ severity: 2 }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'mark_type_not_found' });
  });

  it('rejects a user without role:edit with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/2',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ severity: 1 }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('PATCH /api/v1/mark-types/reorder', () => {
  it('reorders the active taxonomy and reflects the new sort_order', async () => {
    const before = await listTypes(ownerCookie, true);
    const ids = before.map((t) => t.id);
    const reordered = [...ids].reverse();

    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/reorder',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ ordered_ids: reordered }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: number; sort_order: number }>;
    expect(body.map((t) => t.id)).toEqual(reordered);
    expect(body[0]?.sort_order).toBe(1);

    await assertAuditRow(h, { action: 'mark_type.reorder', resource: 'mark_type' });
  });

  it('rejects a reorder referencing an unknown id with 400', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/reorder',
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ ordered_ids: [1, 2, 999] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_mark_type_id' });
  });

  it('rejects a user without role:edit with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/mark-types/reorder',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ ordered_ids: [1, 2] }),
    });
    expect(res.statusCode).toBe(403);
  });
});
