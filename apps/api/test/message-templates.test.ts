import { randomUUID } from 'node:crypto';
import {
  type MessageTemplateRow,
  messageTemplates,
  players,
  rolePermissions,
  roles,
} from '@squad/db/schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache, loadUserPermissions } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { auditLogMark, expectAuditRowSince } from './helpers/audit-since.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000004000n;

let h: IntegrationHarness;
let cookie: string;
let ownerRoleId: string;
let auditMark: bigint;
/** The built-in phrases as migrated into this file's database, captured before any case wipes them. */
let migrationSeededDefaults: MessageTemplateRow[];

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing');
  ownerRoleId = ownerRole.id;
  migrationSeededDefaults = await h.db
    .select()
    .from(messageTemplates)
    .where(isNull(messageTemplates.createdBy))
    .orderBy(asc(messageTemplates.sortOrder));
});

beforeEach(async () => {
  // The listing cases assert exactly what they inserted, and demoteToViewer()
  // drops the owner to Viewer: start each case with an empty template table
  // and the seeded owner back on Owner.
  await h.db.delete(messageTemplates);
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  cookie = await loginAsOwner(h);
  auditMark = await auditLogMark(h.db);
});

afterAll(async () => {
  await h?.cleanup();
});

async function demoteToViewer(): Promise<string> {
  const viewerRows = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Viewer'))
    .limit(1);
  const viewerRoleId = viewerRows[0]?.id;
  if (!viewerRoleId || !h.seed.ownerPlayerId) throw new Error('viewer fixture missing');
  await h.db
    .update(players)
    .set({ roleId: viewerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  invalidatePermissionCache(h.seed.ownerPlayerId);
  return await loginAsOwner(h);
}

async function createTemplate(payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/message-templates',
    headers: { cookie },
    payload,
  });
}

describe('GET /api/v1/message-templates', () => {
  it('401 without a session cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/message-templates' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the default phrases seeded by migration 0119 (created_by NULL)', () => {
    expect(migrationSeededDefaults.length).toBeGreaterThanOrEqual(15);
    for (const row of migrationSeededDefaults) {
      expect(row.createdBy).toBeNull();
    }
    expect(migrationSeededDefaults.some((row) => row.body.includes('{player}'))).toBe(true);
    expect(migrationSeededDefaults.some((row) => row.locale === 'en')).toBe(true);
    expect(migrationSeededDefaults.some((row) => row.locale === 'ru')).toBe(true);
  });

  it('is read-only: a GET inserts nothing into an emptied table (#36 finding 42)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/message-templates',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(await h.db.select().from(messageTemplates)).toHaveLength(0);
  });

  it('does not resurrect a deleted default template on the next GET (#36 finding 42)', async () => {
    const [builtIn] = migrationSeededDefaults;
    if (!builtIn) throw new Error('no seeded default template');
    await h.db.insert(messageTemplates).values(migrationSeededDefaults);

    const deleted = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/message-templates/${builtIn.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/message-templates',
      headers: { cookie },
    });
    const ids = (res.json() as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(builtIn.id);
    expect(ids).toHaveLength(migrationSeededDefaults.length - 1);
  });
});

describe('POST /api/v1/message-templates', () => {
  it('creates a template, stamps created_by, and writes an audit row', async () => {
    const res = await createTemplate({
      title: 'Custom warn',
      body: '{player}, follow the rules on {server}.',
      category: 'warn',
      locale: 'en',
      sort_order: 5,
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as Record<string, unknown>;
    expect(created.title).toBe('Custom warn');
    expect(created.is_enabled).toBe(true);
    expect(created.sort_order).toBe(5);
    expect(created.created_by).toBe(h.seed.ownerPlayerId);

    const stored = await h.db
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.id, created.id as string));
    expect(stored).toHaveLength(1);

    await expectAuditRowSince(h.db, auditMark, {
      action: 'message_template.create',
      resource: 'message_template',
    });
  });

  it('rejects a body longer than 512 characters (acceptance #2)', async () => {
    const res = await createTemplate({
      title: 'Too long',
      body: 'x'.repeat(513),
      category: 'info',
      locale: 'en',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a body of exactly 512 characters', async () => {
    const res = await createTemplate({
      title: 'Boundary',
      body: 'y'.repeat(512),
      category: 'info',
      locale: 'en',
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects an unknown category', async () => {
    const res = await createTemplate({
      title: 'Bad category',
      body: 'hello',
      category: 'spam',
      locale: 'en',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 without message_template:manage (acceptance #4)', async () => {
    const viewerCookie = await demoteToViewer();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/message-templates',
      headers: { cookie: viewerCookie },
      payload: { title: 'Nope', body: 'blocked', category: 'other', locale: 'en' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/v1/message-templates/:id', () => {
  it('updates fields, toggles is_enabled, and writes an audit row', async () => {
    const created = (
      await createTemplate({ title: 'Editable', body: 'v1', category: 'info', locale: 'en' })
    ).json() as { id: string };

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/message-templates/${created.id}`,
      headers: { cookie },
      payload: { title: 'Edited', is_enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Record<string, unknown>;
    expect(updated.title).toBe('Edited');
    expect(updated.is_enabled).toBe(false);
    expect(updated.body).toBe('v1');

    await assertAuditRow(h, {
      action: 'message_template.update',
      resource: 'message_template',
      targetId: created.id,
    });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/message-templates/0195b000-0000-7000-8000-0000000000ff',
      headers: { cookie },
      payload: { title: 'ghost' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a body longer than 512 characters', async () => {
    const created = (
      await createTemplate({ title: 'Patchable', body: 'ok', category: 'info', locale: 'en' })
    ).json() as { id: string };
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/message-templates/${created.id}`,
      headers: { cookie },
      payload: { body: 'z'.repeat(513) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 without message_template:manage', async () => {
    const created = (
      await createTemplate({ title: 'Guarded', body: 'ok', category: 'info', locale: 'en' })
    ).json() as { id: string };
    const viewerCookie = await demoteToViewer();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/message-templates/${created.id}`,
      headers: { cookie: viewerCookie },
      payload: { title: 'blocked' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/v1/message-templates/:id', () => {
  it('deletes a template and writes an audit row (acceptance #5)', async () => {
    const created = (
      await createTemplate({ title: 'Delete me', body: 'bye', category: 'other', locale: 'en' })
    ).json() as { id: string };

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/message-templates/${created.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const stored = await h.db
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.id, created.id));
    expect(stored).toHaveLength(0);

    await assertAuditRow(h, {
      action: 'message_template.delete',
      resource: 'message_template',
      targetId: created.id,
    });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/message-templates/0195b000-0000-7000-8000-0000000000fe',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 without message_template:manage', async () => {
    const created = (
      await createTemplate({ title: 'Protected', body: 'ok', category: 'info', locale: 'en' })
    ).json() as { id: string };
    const viewerCookie = await demoteToViewer();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/message-templates/${created.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('message_template:manage (#70)', () => {
  async function playerWithRole(opts: {
    steamId64: bigint;
    canEditRoles: boolean;
    grantTemplates: boolean;
  }): Promise<{ playerId: string; cookie: string }> {
    const [role] = await h.db
      .insert(roles)
      .values({
        id: randomUUID(),
        name: `Tmpl-${opts.steamId64}`,
        color: 'sky',
        isSystemRole: false,
        panelAccess: true,
        canEditRoles: opts.canEditRoles,
      })
      .returning({ id: roles.id });
    if (!role) throw new Error('role insert failed');
    if (opts.grantTemplates) {
      await h.db
        .insert(rolePermissions)
        .values({ roleId: role.id, permissionKey: 'message_template:manage' });
    }
    const [player] = await h.db
      .insert(players)
      .values({
        steamId64: opts.steamId64,
        canonicalName: `tmpl-${opts.steamId64}`,
        canonicalNameNormalized: `tmpl-${opts.steamId64}`,
        roleId: role.id,
      })
      .returning({ id: players.id });
    if (!player) throw new Error('player insert failed');
    invalidatePermissionCache(player.id);
    const { token } = await createSession(h.db, h.redis, {
      playerId: player.id,
      ip: null,
      userAgent: 'message-templates-test',
      ttlMs: 21_600_000,
    });
    return { playerId: player.id, cookie: `__Host-sid=${token}` };
  }

  function post(cookieHeader: string) {
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/message-templates',
      headers: { cookie: cookieHeader },
      payload: { title: 'Granted', body: 'hello', category: 'other', locale: 'en' },
    });
  }

  it('lets a role granted only message_template:manage edit templates without role:edit', async () => {
    const editor = await playerWithRole({
      steamId64: testSteamId(870001),
      canEditRoles: false,
      grantTemplates: true,
    });
    expect((await post(editor.cookie)).statusCode).toBe(201);
    const perms = await loadUserPermissions(h.db, editor.playerId);
    expect(perms.permissions.has('role:edit')).toBe(false);
  });

  it('keeps template editing for role editors and denies other panel roles', async () => {
    const roleEditor = await playerWithRole({
      steamId64: testSteamId(870002),
      canEditRoles: true,
      grantTemplates: false,
    });
    expect((await post(roleEditor.cookie)).statusCode).toBe(201);

    const moderator = await playerWithRole({
      steamId64: testSteamId(870003),
      canEditRoles: false,
      grantTemplates: false,
    });
    expect((await post(moderator.cookie)).statusCode).toBe(403);
  });
});
