import { issueComments, issueLabelLinks, issueLabels, issues, players } from '@squad/db/schema';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { ensureSystemIssueLabels } from '../lib/issue-labels.js';
import type { IssueCommentLiveView, IssueLiveView, IssuePlayerRef } from '../plugins/live-bus.js';

const TITLE_MAX = 200;
const BODY_MAX = 4000;
const PER_PAGE_DEFAULT = 20;
const PER_PAGE_MAX = 100;

const stateSchema = z.enum(['open', 'in_progress', 'closed']);
const labelNamesSchema = z.array(z.string().trim().min(1).max(64)).max(20);

const createBody = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  labels: labelNamesSchema.optional(),
});

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    body: z.string().trim().min(1).max(BODY_MAX).optional(),
    labels: labelNamesSchema.optional(),
    assignee_player_id: z.string().uuid().nullable().optional(),
    state: stateSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

const commentBody = z.object({
  body: z.string().trim().min(1).max(BODY_MAX),
});

const listQuery = z.object({
  state: stateSchema.optional(),
  label: z.string().trim().min(1).max(64).optional(),
  assignee: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(PER_PAGE_MAX).default(PER_PAGE_DEFAULT),
});

const idParam = z.object({ id: z.string().uuid() });

interface IssueLabelView {
  id: string;
  name: string;
  color: string;
}

type IssueRow = typeof issues.$inferSelect;

function currentUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return req.user;
}

function auditActor(req: FastifyRequest): AuditActor {
  return {
    kind: 'steam',
    // biome-ignore lint/style/noNonNullAssertion: callers guard req.user first
    playerId: req.user!.playerId,
    tokenId: req.apiTokenId ?? null,
  };
}

function playerRef(id: string | null, names: Map<string, string>): IssuePlayerRef | null {
  if (!id) return null;
  return { id, name: names.get(id) ?? id };
}

function serializeIssue(
  row: IssueRow,
  labels: IssueLabelView[],
  names: Map<string, string>,
): IssueLiveView {
  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    body: row.body,
    state: row.state as IssueLiveView['state'],
    author_player_id: row.authorPlayerId,
    assignee_player_id: row.assigneePlayerId,
    author: playerRef(row.authorPlayerId, names),
    assignee: playerRef(row.assigneePlayerId, names),
    labels,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

function serializeComment(
  row: { id: string; authorPlayerId: string; body: string; createdAt: Date },
  issueId: string,
  names: Map<string, string>,
): IssueCommentLiveView {
  return {
    id: row.id,
    issue_id: issueId,
    author_player_id: row.authorPlayerId,
    author: playerRef(row.authorPlayerId, names),
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
}

const issuesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  await ensureSystemIssueLabels(app.db);

  async function labelsForIssues(issueIds: string[]): Promise<Map<string, IssueLabelView[]>> {
    const grouped = new Map<string, IssueLabelView[]>();
    if (issueIds.length === 0) return grouped;
    const rows = await app.db
      .select({
        issueId: issueLabelLinks.issueId,
        id: issueLabels.id,
        name: issueLabels.name,
        color: issueLabels.color,
      })
      .from(issueLabelLinks)
      .innerJoin(issueLabels, eq(issueLabels.id, issueLabelLinks.labelId))
      .where(inArray(issueLabelLinks.issueId, issueIds))
      .orderBy(issueLabels.name);
    for (const row of rows) {
      const list = grouped.get(row.issueId) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      grouped.set(row.issueId, list);
    }
    return grouped;
  }

  async function resolveLabelIds(
    names: string[],
  ): Promise<{ ok: true; ids: string[] } | { ok: false; unknown: string[] }> {
    const deduped = Array.from(new Set(names));
    if (deduped.length === 0) return { ok: true, ids: [] };
    const rows = await app.db
      .select({ id: issueLabels.id, name: issueLabels.name })
      .from(issueLabels)
      .where(inArray(issueLabels.name, deduped));
    const foundByName = new Map(rows.map((row) => [row.name, row.id]));
    const unknown = deduped.filter((name) => !foundByName.has(name));
    if (unknown.length > 0) return { ok: false, unknown };
    return { ok: true, ids: deduped.map((name) => foundByName.get(name) as string) };
  }

  async function getIssueRow(id: string): Promise<IssueRow | null> {
    const rows = await app.db.select().from(issues).where(eq(issues.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function resolvePlayerNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
    const names = new Map<string, string>();
    if (unique.length === 0) return names;
    const rows = await app.db
      .select({ id: players.id, name: players.canonicalName })
      .from(players)
      .where(inArray(players.id, unique));
    for (const row of rows) names.set(row.id, row.name);
    return names;
  }

  fast.get('/api/v1/issues/labels', async (req, reply) => {
    const user = currentUser(req, reply);
    if (!user) return;
    const rows = await app.db
      .select({ id: issueLabels.id, name: issueLabels.name, color: issueLabels.color })
      .from(issueLabels)
      .orderBy(issueLabels.name);
    return { items: rows };
  });

  fast.post('/api/v1/issues', { schema: { body: createBody } }, async (req, reply) => {
    const user = currentUser(req, reply);
    if (!user) return;

    const resolved = await resolveLabelIds(req.body.labels ?? []);
    if (!resolved.ok) {
      reply.code(422);
      return { error: 'unknown_labels', unknown: resolved.unknown };
    }

    const id = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx.insert(issues).values({
        id,
        authorPlayerId: user.playerId,
        title: req.body.title,
        body: req.body.body,
        state: 'open',
      });
      if (resolved.ids.length > 0) {
        await tx
          .insert(issueLabelLinks)
          .values(resolved.ids.map((labelId) => ({ issueId: id, labelId })));
      }
    });

    const created = await getIssueRow(id);
    if (!created) {
      reply.code(500);
      return { error: 'insert_failed' };
    }
    const labels = (await labelsForIssues([id])).get(id) ?? [];
    const names = await resolvePlayerNames([created.authorPlayerId, created.assigneePlayerId]);
    const view = serializeIssue(created, labels, names);

    reply.code(201);
    await writeAuditEntry(app.db, {
      actor: auditActor(req),
      actorIp: req.ip ?? null,
      actionType: 'issue.create',
      targetType: 'issue',
      targetId: id,
      before: null,
      after: view,
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
    app.liveBus.publish({
      type: 'issue.created',
      ts: new Date().toISOString(),
      data: { issue: view },
    });
    return view;
  });

  fast.get('/api/v1/issues', { schema: { querystring: listQuery } }, async (req, reply) => {
    const user = currentUser(req, reply);
    if (!user) return;

    const { state, label, assignee, q, page, per_page } = req.query;
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(issues.state, state));
    if (assignee) clauses.push(eq(issues.assigneePlayerId, assignee));
    if (label) {
      clauses.push(
        sql`EXISTS (
          SELECT 1 FROM issue_label_links ill
          JOIN issue_labels il ON il.id = ill.label_id
          WHERE ill.issue_id = ${issues.id} AND il.name = ${label}
        )`,
      );
    }
    if (q) {
      clauses.push(sql`${issues.searchVector} @@ websearch_to_tsquery('simple', ${q})`);
    }
    const whereClause = clauses.length > 0 ? and(...clauses) : undefined;

    const countRows = await app.db
      .select({ total: sql<number>`count(*)::int` })
      .from(issues)
      .where(whereClause);
    const total = countRows[0]?.total ?? 0;

    const rows = await app.db
      .select()
      .from(issues)
      .where(whereClause)
      .orderBy(desc(issues.number))
      .limit(per_page)
      .offset((page - 1) * per_page);

    const labelMap = await labelsForIssues(rows.map((row) => row.id));
    const names = await resolvePlayerNames(
      rows.flatMap((row) => [row.authorPlayerId, row.assigneePlayerId]),
    );
    return {
      items: rows.map((row) => serializeIssue(row, labelMap.get(row.id) ?? [], names)),
      total,
      page,
      per_page,
    };
  });

  fast.get('/api/v1/issues/:id', { schema: { params: idParam } }, async (req, reply) => {
    const user = currentUser(req, reply);
    if (!user) return;

    const issue = await getIssueRow(req.params.id);
    if (!issue) {
      reply.code(404);
      return { error: 'issue_not_found' };
    }
    const labels = (await labelsForIssues([issue.id])).get(issue.id) ?? [];
    const comments = await app.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);

    const names = await resolvePlayerNames([
      issue.authorPlayerId,
      issue.assigneePlayerId,
      ...comments.map((comment) => comment.authorPlayerId),
    ]);

    return {
      ...serializeIssue(issue, labels, names),
      comments: comments.map((comment) => serializeComment(comment, issue.id, names)),
    };
  });

  fast.patch(
    '/api/v1/issues/:id',
    { schema: { params: idParam, body: patchBody } },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const issue = await getIssueRow(req.params.id);
      if (!issue) {
        reply.code(404);
        return { error: 'issue_not_found' };
      }

      const isAuthor = issue.authorPlayerId === user.playerId;
      const canManage = user.permissions.canManageIssues;
      const assigneeProvided = req.body.assignee_player_id !== undefined;

      if (!isAuthor && !canManage) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_issues' };
      }
      if (assigneeProvided && !canManage) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_issues' };
      }

      if (req.body.assignee_player_id) {
        const assigneeRows = await app.db
          .select({ id: players.id })
          .from(players)
          .where(eq(players.id, req.body.assignee_player_id))
          .limit(1);
        if (!assigneeRows[0]) {
          reply.code(422);
          return { error: 'unknown_assignee' };
        }
      }

      let resolvedLabelIds: string[] | null = null;
      if (req.body.labels !== undefined) {
        const resolved = await resolveLabelIds(req.body.labels);
        if (!resolved.ok) {
          reply.code(422);
          return { error: 'unknown_labels', unknown: resolved.unknown };
        }
        resolvedLabelIds = resolved.ids;
      }

      const beforeLabels = (await labelsForIssues([issue.id])).get(issue.id) ?? [];
      const beforeNames = await resolvePlayerNames([issue.authorPlayerId, issue.assigneePlayerId]);
      const beforeView = serializeIssue(issue, beforeLabels, beforeNames);

      const updates: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
      if (req.body.title !== undefined) updates.title = req.body.title;
      if (req.body.body !== undefined) updates.body = req.body.body;
      if (assigneeProvided) updates.assigneePlayerId = req.body.assignee_player_id ?? null;
      if (req.body.state !== undefined && req.body.state !== issue.state) {
        updates.state = req.body.state;
        updates.closedAt = req.body.state === 'closed' ? new Date() : null;
      }

      await app.db.transaction(async (tx) => {
        await tx.update(issues).set(updates).where(eq(issues.id, issue.id));
        if (resolvedLabelIds !== null) {
          await tx.delete(issueLabelLinks).where(eq(issueLabelLinks.issueId, issue.id));
          if (resolvedLabelIds.length > 0) {
            await tx
              .insert(issueLabelLinks)
              .values(resolvedLabelIds.map((labelId) => ({ issueId: issue.id, labelId })));
          }
        }
      });

      const updated = await getIssueRow(issue.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      const afterLabels = (await labelsForIssues([issue.id])).get(issue.id) ?? [];
      const afterNames = await resolvePlayerNames([
        updated.authorPlayerId,
        updated.assigneePlayerId,
      ]);
      const afterView = serializeIssue(updated, afterLabels, afterNames);

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'issue.update',
        targetType: 'issue',
        targetId: issue.id,
        before: beforeView,
        after: afterView,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });
      app.liveBus.publish({
        type: 'issue.updated',
        ts: new Date().toISOString(),
        data: { issue: afterView },
      });
      return afterView;
    },
  );

  fast.post(
    '/api/v1/issues/:id/comments',
    { schema: { params: idParam, body: commentBody } },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const issue = await getIssueRow(req.params.id);
      if (!issue) {
        reply.code(404);
        return { error: 'issue_not_found' };
      }

      const commentId = uuidv7();
      const inserted = await app.db
        .insert(issueComments)
        .values({
          id: commentId,
          issueId: issue.id,
          authorPlayerId: user.playerId,
          body: req.body.body,
        })
        .returning({ id: issueComments.id, createdAt: issueComments.createdAt });
      const row = inserted[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      const names = await resolvePlayerNames([user.playerId]);
      const view = serializeComment(
        {
          id: row.id,
          authorPlayerId: user.playerId,
          body: req.body.body,
          createdAt: row.createdAt,
        },
        issue.id,
        names,
      );

      reply.code(201);
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'issue.comment.create',
        targetType: 'issue',
        targetId: issue.id,
        before: null,
        after: view,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });
      app.liveBus.publish({
        type: 'issue.comment.created',
        ts: new Date().toISOString(),
        data: { issue_id: issue.id, comment: view },
      });
      return view;
    },
  );
};

export default issuesRoutes;
