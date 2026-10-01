import { issueComments, issueLabelLinks, issueLabels, issueLinks, issues } from '@squad/db/schema';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { currentUser } from '../../lib/issues/current-user.js';
import { issueQueries } from '../../lib/issues/queries.js';
import { createBody, idParam, listQuery } from '../../lib/issues/schemas.js';
import type { LinkTarget } from '../../lib/issues/views.js';
import { serializeComment, serializeIssue, targetKey } from '../../lib/issues/views.js';

/** Ticket labels, creation, list and detail. */
const issueTicketRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const {
    labelsForIssues,
    resolveLabelIds,
    getIssueRow,
    resolvePlayerNames,
    findUnknownTargets,
    linksForIssue,
  } = issueQueries(app);

  fast.get('/api/v1/issues/labels', async (req, reply) => {
    const user = currentUser(req, reply);
    if (!user) return;
    const rows = await app.db
      .select({ id: issueLabels.id, name: issueLabels.name, color: issueLabels.color })
      .from(issueLabels)
      .orderBy(issueLabels.name);
    return { items: rows };
  });

  fast.post(
    '/api/v1/issues',
    {
      schema: { body: createBody },
      config: { audit: { action: 'issue.create', resource: 'issue' } },
    },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const resolved = await resolveLabelIds(req.body.labels ?? []);
      if (!resolved.ok) {
        reply.code(422);
        return { error: 'unknown_labels', unknown: resolved.unknown };
      }

      // Deduplicated so an auto-ticket that names the same entity twice does not
      // trip the unique index and roll the whole create back.
      const linkTargets: LinkTarget[] = [];
      const seenTargets = new Set<string>();
      for (const raw of req.body.links ?? []) {
        const key = targetKey(raw);
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        linkTargets.push({ entity_type: raw.entity_type, entity_id: raw.entity_id });
      }
      const unknownTargets = await findUnknownTargets(linkTargets);
      if (unknownTargets.length > 0) {
        reply.code(422);
        return { error: 'unknown_entity', unknown: unknownTargets };
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
        if (linkTargets.length > 0) {
          await tx.insert(issueLinks).values(
            linkTargets.map((target) => ({
              id: uuidv7(),
              issueId: id,
              entityType: target.entity_type,
              entityId: target.entity_id,
              createdBy: user.playerId,
            })),
          );
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
      const links = await linksForIssue(id);

      reply.code(201);
      req.auditSnapshots = { before: null, after: { ...view, links }, targetId: id };
      app.liveBus.publish({
        type: 'issue.created',
        ts: new Date().toISOString(),
        data: { issue: view },
      });
      return { ...view, links };
    },
  );

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
      links: await linksForIssue(issue.id),
    };
  });
};

export default issueTicketRoutes;
