import type { DatabaseClient } from '@squad/db';
import { players, roles } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let steamCounter = 76561198000210000n;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

async function seedRole(
  db: DatabaseClient,
  opts: { canManageIssues?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: true,
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
    userAgent: 'issues-ui-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface IssueView {
  id: string;
  number: number;
  state: string;
  author_player_id: string;
  assignee_player_id: string | null;
  author: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
}

async function createIssue(
  h: IntegrationHarness,
  cookie: string,
  payload: { title: string; body: string; labels?: string[] },
): Promise<IssueView> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/issues',
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as IssueView;
}

function collectEvents(h: IntegrationHarness): { events: LiveEvent[]; stop: () => void } {
  const events: LiveEvent[] = [];
  const stop = h.app.liveBus.subscribe((event) => events.push(event));
  return { events, stop };
}

describeIfDb('issues UI API — labels, enrichment, live-bus, /me flag (ISSUE-2)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: 76561198000208000n },
      bridge: makeFakeBridge(),
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('GET /api/v1/issues/labels requires auth and returns the system labels', async () => {
    const unauth = await h.app.inject({ method: 'GET', url: '/api/v1/issues/labels' });
    expect(unauth.statusCode).toBe(401);

    const alice = await seedPlayer(h.db, { name: 'LabelsViewer' });
    const cookie = await loginAs(h, alice);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues/labels',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ name: string; color: string }> };
    const names = body.items.map((label) => label.name);
    expect(names).toEqual(expect.arrayContaining(['bug', 'suggestion', 'question']));
    for (const label of body.items) {
      expect(label.color).toMatch(/^#/);
    }
  });

  it('serialized issue exposes author {id,name}; assignee {id,name} once assigned', async () => {
    const author = await seedPlayer(h.db, { name: 'AuthorNamed' });
    const managerRoleId = await seedRole(h.db, { canManageIssues: true });
    const manager = await seedPlayer(h.db, { name: 'ManagerNamed', roleId: managerRoleId });
    const authorCookie = await loginAs(h, author);
    const managerCookie = await loginAs(h, manager);

    const created = await createIssue(h, authorCookie, { title: 'Named', body: 'has author' });
    expect(created.author).toEqual({ id: author, name: 'AuthorNamed' });
    expect(created.assignee).toBeNull();

    const assigned = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${created.id}`,
      headers: { cookie: managerCookie },
      payload: { assignee_player_id: manager },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as IssueView).assignee).toEqual({ id: manager, name: 'ManagerNamed' });

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${created.id}`,
      headers: { cookie: authorCookie },
    });
    expect((detail.json() as IssueView).author).toEqual({ id: author, name: 'AuthorNamed' });

    const list = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues?assignee=${manager}`,
      headers: { cookie: authorCookie },
    });
    const listItem = (list.json() as { items: IssueView[] }).items.find(
      (item) => item.id === created.id,
    );
    expect(listItem?.assignee).toEqual({ id: manager, name: 'ManagerNamed' });
  });

  it('issue comments carry the author name in detail and create responses', async () => {
    const author = await seedPlayer(h.db, { name: 'CommentAuthor' });
    const cookie = await loginAs(h, author);
    const issue = await createIssue(h, cookie, { title: 'Comment names', body: 'thread' });

    const posted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/comments`,
      headers: { cookie },
      payload: { body: 'hello there' },
    });
    expect(posted.statusCode).toBe(201);
    const comment = posted.json() as {
      author: { id: string; name: string } | null;
      issue_id: string;
    };
    expect(comment.author).toEqual({ id: author, name: 'CommentAuthor' });
    expect(comment.issue_id).toBe(issue.id);

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    const detailBody = detail.json() as {
      comments: Array<{ body: string; author: { name: string } | null }>;
    };
    expect(detailBody.comments[0]?.author?.name).toBe('CommentAuthor');
  });

  it('publishes issue.created, issue.updated and issue.comment.created on the live bus', async () => {
    const author = await seedPlayer(h.db, { name: 'LiveAuthor' });
    const cookie = await loginAs(h, author);
    const { events, stop } = collectEvents(h);
    try {
      const issue = await createIssue(h, cookie, { title: 'Live', body: 'push me' });

      await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/issues/${issue.id}`,
        headers: { cookie },
        payload: { state: 'closed' },
      });
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/issues/${issue.id}/comments`,
        headers: { cookie },
        payload: { body: 'streamed comment' },
      });

      const forThisIssue = events.filter((event) => {
        if (event.type === 'issue.created' || event.type === 'issue.updated') {
          return event.data.issue.id === issue.id;
        }
        if (event.type === 'issue.comment.created') return event.data.issue_id === issue.id;
        return false;
      });
      const created = forThisIssue.find((event) => event.type === 'issue.created');
      const updated = forThisIssue.find((event) => event.type === 'issue.updated');
      const commented = forThisIssue.find((event) => event.type === 'issue.comment.created');

      expect(created?.type).toBe('issue.created');
      expect(updated?.type === 'issue.updated' && updated.data.issue.state).toBe('closed');
      expect(commented?.type === 'issue.comment.created' && commented.data.comment.body).toBe(
        'streamed comment',
      );
    } finally {
      stop();
    }
  });

  it('GET /api/v1/me reports can_manage_issues per role (false for plain, true for manager)', async () => {
    const plain = await seedPlayer(h.db, { name: 'PlainMe' });
    const plainCookie = await loginAs(h, plain);
    const managerRoleId = await seedRole(h.db, { canManageIssues: true });
    const manager = await seedPlayer(h.db, { name: 'ManagerMe', roleId: managerRoleId });
    const managerCookie = await loginAs(h, manager);

    const plainMe = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: plainCookie },
    });
    expect((plainMe.json() as { can_manage_issues: boolean }).can_manage_issues).toBe(false);

    const managerMe = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: managerCookie },
    });
    expect((managerMe.json() as { can_manage_issues: boolean }).can_manage_issues).toBe(true);
  });

  it('direct manage call without can_manage_issues returns 403 with a readable error', async () => {
    const author = await seedPlayer(h.db, { name: 'Reporter' });
    const outsider = await seedPlayer(h.db, { name: 'Outsider' });
    const authorCookie = await loginAs(h, author);
    const outsiderCookie = await loginAs(h, outsider);
    const issue = await createIssue(h, authorCookie, { title: 'Guarded', body: 'no touch' });

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie: outsiderCookie },
      payload: { state: 'closed' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', required: 'can_manage_issues' });
  });
});
