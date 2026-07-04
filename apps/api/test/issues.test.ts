import type { DatabaseClient } from '@squad/db';
import { auditLog, players, roles } from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let steamCounter = 76561198000090000n;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

async function seedRole(
  db: DatabaseClient,
  opts: { canManageIssues?: boolean; panelAccess?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id.slice(0, 8)}`,
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

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'issues-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function createIssue(
  h: IntegrationHarness,
  cookie: string,
  payload: { title: string; body: string; labels?: string[] },
): Promise<{ id: string; number: number; state: string; author_player_id: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/issues',
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; number: number; state: string; author_player_id: string };
}

describeIfDb('issues API — create, RBAC, comments, audit', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: 76561198000088000n },
      bridge: makeFakeBridge(),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('rejects unauthenticated create and list with 401', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/issues' });
    expect(list.statusCode).toBe(401);
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      payload: { title: 'x', body: 'y' },
    });
    expect(create.statusCode).toBe(401);
  });

  it('new issue is authored by the current player and starts in state=open (AC1)', async () => {
    const alice = await seedPlayer(h.db, { name: 'Alice' });
    const cookie = await loginAs(h, alice);
    const created = await createIssue(h, cookie, {
      title: 'Server crashes on Yehorivka',
      body: 'The layer transition kills the container.',
    });
    expect(created.state).toBe('open');
    expect(created.author_player_id).toBe(alice);
    expect(created.number).toBeGreaterThan(0);
  });

  it('rejects unknown label names with 422', async () => {
    const alice = await seedPlayer(h.db);
    const cookie = await loginAs(h, alice);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { cookie },
      payload: { title: 'Has bad label', body: 'body', labels: ['not-a-real-label'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'unknown_labels', unknown: ['not-a-real-label'] });
  });

  it('author without can_manage_issues can close their own issue but not someone else’s (AC3)', async () => {
    const alice = await seedPlayer(h.db, { name: 'AliceOwnClose' });
    const bob = await seedPlayer(h.db, { name: 'BobOwnClose' });
    const aliceCookie = await loginAs(h, alice);
    const bobCookie = await loginAs(h, bob);

    const aliceIssue = await createIssue(h, aliceCookie, { title: 'Alice bug', body: 'mine' });
    const bobIssue = await createIssue(h, bobCookie, { title: 'Bob bug', body: 'his' });

    const closeOwn = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${aliceIssue.id}`,
      headers: { cookie: aliceCookie },
      payload: { state: 'closed' },
    });
    expect(closeOwn.statusCode).toBe(200);
    expect((closeOwn.json() as { state: string; closed_at: string | null }).state).toBe('closed');
    expect((closeOwn.json() as { closed_at: string | null }).closed_at).not.toBeNull();

    const closeOther = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${bobIssue.id}`,
      headers: { cookie: aliceCookie },
      payload: { state: 'closed' },
    });
    expect(closeOther.statusCode).toBe(403);
    expect(closeOther.json()).toMatchObject({ error: 'forbidden', required: 'can_manage_issues' });
  });

  it('a manager with can_manage_issues can close and assign others’ issues', async () => {
    const author = await seedPlayer(h.db, { name: 'AuthorForMgr' });
    const managerRoleId = await seedRole(h.db, { canManageIssues: true });
    const manager = await seedPlayer(h.db, { name: 'Manager', roleId: managerRoleId });
    const authorCookie = await loginAs(h, author);
    const managerCookie = await loginAs(h, manager);

    const issue = await createIssue(h, authorCookie, { title: 'Needs triage', body: 'help' });

    const assign = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie: managerCookie },
      payload: { assignee_player_id: manager, state: 'in_progress' },
    });
    expect(assign.statusCode).toBe(200);
    const body = assign.json() as { assignee_player_id: string | null; state: string };
    expect(body.assignee_player_id).toBe(manager);
    expect(body.state).toBe('in_progress');
  });

  it('author without can_manage_issues cannot assign even their own issue', async () => {
    const alice = await seedPlayer(h.db, { name: 'AliceNoAssign' });
    const other = await seedPlayer(h.db, { name: 'OtherAssignee' });
    const cookie = await loginAs(h, alice);
    const issue = await createIssue(h, cookie, { title: 'Own issue', body: 'mine' });

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
      payload: { assignee_player_id: other },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a comment on an issue and returns it', async () => {
    const alice = await seedPlayer(h.db, { name: 'AliceComment' });
    const cookie = await loginAs(h, alice);
    const issue = await createIssue(h, cookie, { title: 'Discuss', body: 'thread' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/comments`,
      headers: { cookie },
      payload: { body: 'first reply' },
    });
    expect(res.statusCode).toBe(201);
    const comment = res.json() as { author_player_id: string; body: string; issue_id: string };
    expect(comment.author_player_id).toBe(alice);
    expect(comment.body).toBe('first reply');

    const single = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    const detail = single.json() as { comments: Array<{ body: string }> };
    expect(detail.comments.map((c) => c.body)).toContain('first reply');
  });

  it('records before/after snapshots for every mutation in audit_log (AC4)', async () => {
    const alice = await seedPlayer(h.db, { name: 'AliceAudit' });
    const cookie = await loginAs(h, alice);
    const issue = await createIssue(h, cookie, {
      title: 'Audit me',
      body: 'trace',
      labels: ['bug'],
    });

    const createRow = await latestAudit(h.db, 'issue.create', issue.id);
    expect(createRow?.beforeSnapshot).toBeNull();
    expect((createRow?.afterSnapshot as { state: string }).state).toBe('open');
    expect((createRow?.afterSnapshot as { author_player_id: string }).author_player_id).toBe(alice);

    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
      payload: { state: 'closed' },
    });
    const updateRow = await latestAudit(h.db, 'issue.update', issue.id);
    expect((updateRow?.beforeSnapshot as { state: string }).state).toBe('open');
    expect((updateRow?.afterSnapshot as { state: string }).state).toBe('closed');

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/comments`,
      headers: { cookie },
      payload: { body: 'auditable comment' },
    });
    const commentRow = await latestAudit(h.db, 'issue.comment.create', issue.id);
    expect(commentRow?.beforeSnapshot).toBeNull();
    expect((commentRow?.afterSnapshot as { body: string }).body).toBe('auditable comment');
  });

  async function latestAudit(db: DatabaseClient, action: string, targetId: string) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actionType, action), eq(auditLog.targetId, targetId)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    return rows[0] ?? null;
  }
});

describeIfDb('issues API — filters, search, pagination (AC2)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: 76561198000089000n },
      bridge: makeFakeBridge(),
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('filters by state', async () => {
    const open1 = await createIssue(h, ownerCookie, { title: 'open one', body: 'b' });
    await createIssue(h, ownerCookie, { title: 'open two', body: 'b' });
    const toClose = await createIssue(h, ownerCookie, { title: 'to close', body: 'b' });
    void open1;
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${toClose.id}`,
      headers: { cookie: ownerCookie },
      payload: { state: 'closed' },
    });

    const openRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?state=open',
      headers: { cookie: ownerCookie },
    });
    expect((openRes.json() as { total: number }).total).toBe(2);
    const closedRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?state=closed',
      headers: { cookie: ownerCookie },
    });
    expect((closedRes.json() as { total: number }).total).toBe(1);
  });

  it('filters by label name', async () => {
    await createIssue(h, ownerCookie, { title: 'a bug', body: 'b', labels: ['bug'] });
    await createIssue(h, ownerCookie, { title: 'a question', body: 'b', labels: ['question'] });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?label=bug',
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { total: number; items: Array<{ title: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe('a bug');
  });

  it('filters by assignee', async () => {
    const assignee = await seedPlayer(h.db, { name: 'Assignee' });
    const target = await createIssue(h, ownerCookie, { title: 'assign me', body: 'b' });
    await createIssue(h, ownerCookie, { title: 'unassigned', body: 'b' });
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${target.id}`,
      headers: { cookie: ownerCookie },
      payload: { assignee_player_id: assignee },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues?assignee=${assignee}`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { total: number; items: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(target.id);
  });

  it('runs full-text search on title/body', async () => {
    await createIssue(h, ownerCookie, {
      title: 'Yehorivka layer broken',
      body: 'the RAAS variant softlocks',
    });
    await createIssue(h, ownerCookie, { title: 'queue timer', body: 'priority slot' });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?q=softlocks',
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as { total: number; items: Array<{ title: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe('Yehorivka layer broken');
  });

  it('paginates results with page and per_page', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createIssue(h, ownerCookie, { title: `paged ${i}`, body: 'b' });
    }
    const page1 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?per_page=2&page=1',
      headers: { cookie: ownerCookie },
    });
    const b1 = page1.json() as {
      total: number;
      items: Array<{ number: number }>;
      per_page: number;
    };
    expect(b1.total).toBe(5);
    expect(b1.items).toHaveLength(2);
    expect(b1.per_page).toBe(2);
    const [firstItem, secondItem] = b1.items;
    expect(Boolean(firstItem && secondItem && firstItem.number > secondItem.number)).toBe(true);

    const page3 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues?per_page=2&page=3',
      headers: { cookie: ownerCookie },
    });
    expect((page3.json() as { items: unknown[] }).items).toHaveLength(1);
  });
});
