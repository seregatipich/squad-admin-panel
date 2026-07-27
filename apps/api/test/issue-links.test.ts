import type { DatabaseClient } from '@squad/db';
import { auditLog, mediaFiles, moderationActions, players, roles, servers } from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

// ISSUE-3 (#156) owns the reserved block testSteamId(984000)–testSteamId(984999).
let steamCursor = 984000;
function nextSteam(): bigint {
  steamCursor += 1;
  if (steamCursor > 984999) throw new Error('issue-links test exhausted its steam id block');
  return testSteamId(steamCursor);
}

interface LinkView {
  id: string;
  issue_id: string;
  entity_type: string;
  entity_id: string;
  label: string;
  ref: string | null;
  exists: boolean;
  created_by: string | null;
  created_at: string;
}

async function seedRole(
  db: DatabaseClient,
  opts: { canManageIssues?: boolean; panelAccess?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? true,
    canManageIssues: opts.canManageIssues ?? false,
  });
  return id;
}

async function seedPlayer(
  db: DatabaseClient,
  opts: { name?: string; roleId?: string | null } = {},
): Promise<string> {
  const id = uuidv7();
  const name = opts.name ?? `Player-${id.slice(0, 6)}`;
  await db.insert(players).values({
    id,
    steamId64: nextSteam(),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId: opts.roleId ?? null,
  });
  return id;
}

async function seedServer(db: DatabaseClient, displayName: string): Promise<string> {
  const id = uuidv7();
  await db.insert(servers).values({
    id,
    displayName,
    slug: `srv-${id.slice(0, 8)}`,
  });
  return id;
}

async function seedModerationAction(
  db: DatabaseClient,
  playerId: string,
  actionType = 'kick',
): Promise<string> {
  const id = uuidv7();
  await db.insert(moderationActions).values({
    id,
    playerId,
    actionType,
    authorSystemLabel: 'issue-links-test',
    createdAt: new Date('2026-03-04T10:00:00.000Z'),
  });
  return id;
}

async function seedMediaFile(db: DatabaseClient, title: string | null): Promise<string> {
  const id = uuidv7();
  await db.insert(mediaFiles).values({
    id,
    kind: 'external_link',
    originalFilename: 'clip.mp4',
    mimeType: 'text/uri-list',
    sizeBytes: 0,
    sha256: id.replace(/-/g, '').padEnd(64, '0'),
    externalUrl: `https://example.invalid/${id}`,
    title,
  });
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'issue-links-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function createIssue(
  h: IntegrationHarness,
  cookie: string,
  payload: {
    title: string;
    body: string;
    links?: Array<{ entity_type: string; entity_id: string }>;
  },
): Promise<{ id: string; number: number; links?: LinkView[] }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/issues',
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; number: number; links?: LinkView[] };
}

async function addLink(
  h: IntegrationHarness,
  cookie: string,
  issueId: string,
  entityType: string,
  entityId: string,
) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/issues/${issueId}/links`,
    headers: { cookie },
    payload: { entity_type: entityType, entity_id: entityId },
  });
}

async function latestAudit(db: DatabaseClient, action: string, targetId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actionType, action), eq(auditLog.targetId, targetId)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return rows[0] ?? null;
}

describeIfDb('issue links API — attach, detach, expansion (ISSUE-3 #156)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: testSteamId(984000) },
      bridge: makeFakeBridge(),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('rejects an unauthenticated link create with 401', async () => {
    const author = await seedPlayer(h.db);
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'anon link', body: 'b' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/links`,
      payload: { entity_type: 'player', entity_id: author },
    });
    expect(res.statusCode).toBe(401);
  });

  it('links an issue to a player, a server, a moderation action and a media file (AC1)', async () => {
    const author = await seedPlayer(h.db, { name: 'LinkAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'four link types', body: 'b' });

    const offender = await seedPlayer(h.db, { name: 'Offender One' });
    const serverId = await seedServer(h.db, 'Alpha Server');
    const actionId = await seedModerationAction(h.db, offender, 'ban');
    const mediaId = await seedMediaFile(h.db, 'Clip title');

    const cases: Array<[string, string]> = [
      ['player', offender],
      ['server', serverId],
      ['moderation_action', actionId],
      ['media_file', mediaId],
    ];
    for (const [entityType, entityId] of cases) {
      const res = await addLink(h, cookie, issue.id, entityType, entityId);
      expect(res.statusCode, `${entityType} link should be created`).toBe(201);
      const link = res.json() as LinkView;
      expect(link.entity_type).toBe(entityType);
      expect(link.entity_id).toBe(entityId);
      expect(link.issue_id).toBe(issue.id);
      expect(link.created_by).toBe(author);
      expect(link.exists).toBe(true);
    }
  });

  it('rejects a duplicate issue/entity_type/entity_id triple with 409 link_exists (AC1)', async () => {
    const author = await seedPlayer(h.db);
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'dup link', body: 'b' });
    const offender = await seedPlayer(h.db);

    const first = await addLink(h, cookie, issue.id, 'player', offender);
    expect(first.statusCode).toBe(201);
    const second = await addLink(h, cookie, issue.id, 'player', offender);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'link_exists' });
  });

  it('rejects a link to a non-existent entity with 422 unknown_entity (AC1)', async () => {
    const author = await seedPlayer(h.db);
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'ghost link', body: 'b' });

    const res = await addLink(h, cookie, issue.id, 'server', uuidv7());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'unknown_entity' });
  });

  it('returns 404 issue_not_found when the issue does not exist', async () => {
    const author = await seedPlayer(h.db);
    const cookie = await loginAs(h, author);
    const res = await addLink(h, cookie, uuidv7(), 'player', author);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'issue_not_found' });
  });

  it('records issue.link.create in the audit log (AC1)', async () => {
    const author = await seedPlayer(h.db, { name: 'AuditLinkAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'audit link', body: 'b' });
    const serverId = await seedServer(h.db, 'Audited Server');

    const res = await addLink(h, cookie, issue.id, 'server', serverId);
    expect(res.statusCode).toBe(201);

    const row = await latestAudit(h.db, 'issue.link.create', issue.id);
    expect(row).not.toBeNull();
    expect(row?.beforeSnapshot).toBeNull();
    expect((row?.afterSnapshot as { entity_type: string }).entity_type).toBe('server');
    expect((row?.afterSnapshot as { entity_id: string }).entity_id).toBe(serverId);
    expect(row?.actorPlayerId).toBe(author);
  });

  it('expands links with a human label and a clickable ref on GET /issues/:id (AC2)', async () => {
    const author = await seedPlayer(h.db, { name: 'ExpandAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'expand me', body: 'b' });

    const offender = await seedPlayer(h.db, { name: 'Vasya Pupkin' });
    const serverId = await seedServer(h.db, 'Bravo Server');
    const actionId = await seedModerationAction(h.db, offender, 'ban');
    const mediaId = await seedMediaFile(h.db, 'Cheating clip');

    for (const [entityType, entityId] of [
      ['player', offender],
      ['server', serverId],
      ['moderation_action', actionId],
      ['media_file', mediaId],
    ] as Array<[string, string]>) {
      expect((await addLink(h, cookie, issue.id, entityType, entityId)).statusCode).toBe(201);
    }

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { links: LinkView[] };
    const byType = new Map(detail.links.map((link) => [link.entity_type, link]));

    expect(byType.get('player')?.label).toBe('Vasya Pupkin');
    expect(byType.get('player')?.ref).toBe(`/players/${offender}`);
    expect(byType.get('server')?.label).toBe('Bravo Server');
    expect(byType.get('server')?.ref).toBe(`/servers/${serverId}`);
    expect(byType.get('moderation_action')?.label).toBe('ban · 2026-03-04');
    expect(byType.get('moderation_action')?.ref).toBe(`/players/${offender}`);
    expect(byType.get('media_file')?.label).toBe('Cheating clip');
    expect(byType.get('media_file')?.ref).toBe(`/api/v1/media/${mediaId}/stream`);
  });

  it('keeps every pre-existing GET /issues/:id field alongside links', async () => {
    const author = await seedPlayer(h.db, { name: 'ShapeAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'shape check', body: 'body text' });
    expect((await addLink(h, cookie, issue.id, 'player', author)).statusCode).toBe(201);
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/comments`,
      headers: { cookie },
      payload: { body: 'a comment' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    const detail = res.json() as Record<string, unknown>;
    for (const key of [
      'id',
      'number',
      'title',
      'body',
      'state',
      'author_player_id',
      'assignee_player_id',
      'author',
      'assignee',
      'labels',
      'created_at',
      'updated_at',
      'closed_at',
      'comments',
      'links',
    ]) {
      expect(Object.hasOwn(detail, key), `GET /issues/:id must still expose ${key}`).toBe(true);
    }
    expect((detail.comments as unknown[]).length).toBe(1);
  });

  it('degrades a link whose target row is gone to a deleted-object label (AC6)', async () => {
    const author = await seedPlayer(h.db, { name: 'GhostAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'ghost target', body: 'b' });
    const offender = await seedPlayer(h.db, { name: 'ToBeDeleted' });
    const actionId = await seedModerationAction(h.db, offender, 'warn');

    expect((await addLink(h, cookie, issue.id, 'moderation_action', actionId)).statusCode).toBe(
      201,
    );
    await h.db.delete(moderationActions).where(eq(moderationActions.id, actionId));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    const detail = res.json() as { links: LinkView[] };
    expect(detail.links).toHaveLength(1);
    expect(detail.links[0]?.exists).toBe(false);
    expect(detail.links[0]?.label).toBe('Удалённый объект');
    expect(detail.links[0]?.ref).toBeNull();
  });

  it('lets the link author delete their own link (AC3)', async () => {
    const author = await seedPlayer(h.db, { name: 'OwnLinkAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'own link', body: 'b' });
    const serverId = await seedServer(h.db, 'Own Link Server');
    const created = await addLink(h, cookie, issue.id, 'server', serverId);
    const link = created.json() as LinkView;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/issues/${issue.id}/links/${link.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    expect((detail.json() as { links: LinkView[] }).links).toHaveLength(0);
  });

  it('refuses to delete someone else’s link without can_manage_issues (AC3)', async () => {
    const author = await seedPlayer(h.db, { name: 'LinkOwner' });
    const stranger = await seedPlayer(h.db, { name: 'Stranger' });
    const authorCookie = await loginAs(h, author);
    const strangerCookie = await loginAs(h, stranger);
    const issue = await createIssue(h, authorCookie, { title: 'foreign link', body: 'b' });
    const serverId = await seedServer(h.db, 'Foreign Link Server');
    const link = (await addLink(h, authorCookie, issue.id, 'server', serverId)).json() as LinkView;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/issues/${issue.id}/links/${link.id}`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', required: 'can_manage_issues' });
  });

  it('lets a manager with can_manage_issues delete someone else’s link (AC3)', async () => {
    const author = await seedPlayer(h.db, { name: 'ManagedLinkOwner' });
    const managerRoleId = await seedRole(h.db, { canManageIssues: true });
    const manager = await seedPlayer(h.db, { name: 'LinkManager', roleId: managerRoleId });
    const authorCookie = await loginAs(h, author);
    const managerCookie = await loginAs(h, manager);
    const issue = await createIssue(h, authorCookie, { title: 'managed link', body: 'b' });
    const serverId = await seedServer(h.db, 'Managed Link Server');
    const link = (await addLink(h, authorCookie, issue.id, 'server', serverId)).json() as LinkView;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/issues/${issue.id}/links/${link.id}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);

    const row = await latestAudit(h.db, 'issue.link.delete', issue.id);
    expect(row).not.toBeNull();
    expect((row?.beforeSnapshot as { id: string }).id).toBe(link.id);
    expect(row?.afterSnapshot).toBeNull();
    expect(row?.actorPlayerId).toBe(manager);
  });

  it('returns 404 link_not_found for an unknown link id', async () => {
    const author = await seedPlayer(h.db);
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'missing link', body: 'b' });

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/issues/${issue.id}/links/${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'link_not_found' });
  });

  it('cascades links away when the issue row is deleted (AC6)', async () => {
    const author = await seedPlayer(h.db, { name: 'CascadeAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'cascade me', body: 'b' });
    const serverId = await seedServer(h.db, 'Cascade Server');
    expect((await addLink(h, cookie, issue.id, 'server', serverId)).statusCode).toBe(201);

    const before = await h.db.execute(
      sql`SELECT count(*)::int AS n FROM issue_links WHERE issue_id = ${issue.id}`,
    );
    expect((before as unknown as Array<{ n: number }>)[0]?.n).toBe(1);

    await h.db.execute(sql`DELETE FROM issues WHERE id = ${issue.id}`);

    const after = await h.db.execute(
      sql`SELECT count(*)::int AS n FROM issue_links WHERE issue_id = ${issue.id}`,
    );
    expect((after as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });
});

describeIfDb('issue links API — player card and auto-ticket (ISSUE-3 #156)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: testSteamId(984500) },
      bridge: makeFakeBridge(),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('returns the open linked tickets and their counter for a player card (AC4)', async () => {
    const roleId = await seedRole(h.db, { panelAccess: true });
    const viewer = await seedPlayer(h.db, { name: 'CardViewer', roleId });
    const cookie = await loginAs(h, viewer);
    const offender = await seedPlayer(h.db, { name: 'CardOffender' });

    const openIssue = await createIssue(h, cookie, { title: 'still open', body: 'b' });
    const closedIssue = await createIssue(h, cookie, { title: 'already closed', body: 'b' });
    expect((await addLink(h, cookie, openIssue.id, 'player', offender)).statusCode).toBe(201);
    expect((await addLink(h, cookie, closedIssue.id, 'player', offender)).statusCode).toBe(201);

    const managerRoleId = await seedRole(h.db, { canManageIssues: true });
    const manager = await seedPlayer(h.db, { name: 'CardManager', roleId: managerRoleId });
    const managerCookie = await loginAs(h, manager);
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${closedIssue.id}`,
      headers: { cookie: managerCookie },
      payload: { state: 'closed' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${offender}/issues`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      open_count: number;
      items: Array<{ id: string; number: number; title: string; state: string }>;
    };
    expect(body.open_count).toBe(1);
    expect(body.items.map((item) => item.id)).toEqual([openIssue.id]);
    expect(body.items[0]?.title).toBe('still open');
    expect(body.items[0]?.state).toBe('open');
  });

  it('gates the player-card endpoint on panel_access', async () => {
    const offender = await seedPlayer(h.db, { name: 'GatedOffender' });

    const anon = await h.app.inject({ method: 'GET', url: `/api/v1/players/${offender}/issues` });
    expect(anon.statusCode).toBe(401);

    const noPanelRole = await seedRole(h.db, { panelAccess: false });
    const outsider = await seedPlayer(h.db, { name: 'NoPanel', roleId: noPanelRole });
    const outsiderCookie = await loginAs(h, outsider);
    const denied = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${offender}/issues`,
      headers: { cookie: outsiderCookie },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('creates a ticket and its links atomically — auto-ticket from a moderation action (AC5)', async () => {
    const roleId = await seedRole(h.db, { panelAccess: true });
    const moderator = await seedPlayer(h.db, { name: 'AutoTicketMod', roleId });
    const cookie = await loginAs(h, moderator);
    const offender = await seedPlayer(h.db, { name: 'AutoTicketOffender' });
    const actionId = await seedModerationAction(h.db, offender, 'ban');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { cookie },
      payload: {
        title: 'Разобраться с баном AutoTicketOffender',
        body: 'Создано из карточки действия модерации.',
        links: [
          { entity_type: 'moderation_action', entity_id: actionId },
          { entity_type: 'player', entity_id: offender },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; links: LinkView[] };
    expect(created.links).toHaveLength(2);
    expect(new Set(created.links.map((link) => link.entity_type))).toEqual(
      new Set(['moderation_action', 'player']),
    );

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${created.id}`,
      headers: { cookie },
    });
    const links = (detail.json() as { links: LinkView[] }).links;
    expect(links.map((link) => link.entity_id).sort()).toEqual([actionId, offender].sort());

    const card = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${offender}/issues`,
      headers: { cookie },
    });
    expect((card.json() as { open_count: number }).open_count).toBe(1);

    const audit = await latestAudit(h.db, 'issue.create', created.id);
    expect((audit?.afterSnapshot as { links: LinkView[] }).links).toHaveLength(2);
  });

  it('rolls the whole create back when one link target is unknown', async () => {
    const roleId = await seedRole(h.db, { panelAccess: true });
    const moderator = await seedPlayer(h.db, { name: 'RollbackMod', roleId });
    const cookie = await loginAs(h, moderator);
    const offender = await seedPlayer(h.db, { name: 'RollbackOffender' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { cookie },
      payload: {
        title: 'ticket that must not exist',
        body: 'b',
        links: [
          { entity_type: 'player', entity_id: offender },
          { entity_type: 'moderation_action', entity_id: uuidv7() },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'unknown_entity' });

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?q=must not exist',
      headers: { cookie },
    });
    expect((list.json() as { total: number }).total).toBe(0);
  });
});
