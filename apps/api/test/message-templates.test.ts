import { messageTemplates, players, roles } from '@squad/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000004000n;

let h: IntegrationHarness;
let cookie: string;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  cookie = await loginAsOwner(h);
});

afterEach(async () => {
  await h.cleanup();
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

  it('seeds ~15 default phrases (created_by NULL) on first read', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/message-templates',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.created_by).toBeNull();
    }
    const withPlayerToken = rows.filter((r) => String(r.body).includes('{player}'));
    expect(withPlayerToken.length).toBeGreaterThan(0);
    const enTemplates = rows.filter((r) => r.locale === 'en');
    const ruTemplates = rows.filter((r) => r.locale === 'ru');
    expect(enTemplates.length).toBeGreaterThan(0);
    expect(ruTemplates.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second read does not duplicate the defaults', async () => {
    await h.app.inject({ method: 'GET', url: '/api/v1/message-templates', headers: { cookie } });
    const second = await h.app.inject({
      method: 'GET',
      url: '/api/v1/message-templates',
      headers: { cookie },
    });
    const rows = second.json() as unknown[];
    const seeded = await h.db
      .select()
      .from(messageTemplates)
      .where(isNull(messageTemplates.createdBy));
    expect(rows.length).toBe(seeded.length);
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

    await assertAuditRow(h, {
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

  it('returns 403 without role:edit (acceptance #4)', async () => {
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

  it('returns 403 without role:edit', async () => {
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

  it('returns 403 without role:edit', async () => {
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
