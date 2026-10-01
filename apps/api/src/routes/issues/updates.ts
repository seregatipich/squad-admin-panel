import { issueComments, issueLabelLinks, issues, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { currentUser } from '../../lib/issues/current-user.js';
import { issueQueries } from '../../lib/issues/queries.js';
import { commentBody, idParam, patchBody } from '../../lib/issues/schemas.js';
import { serializeComment, serializeIssue } from '../../lib/issues/views.js';

/** Ticket edits (title, body, labels, assignee, state) and comments. */
const issueUpdateRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { labelsForIssues, resolveLabelIds, getIssueRow, resolvePlayerNames } = issueQueries(app);

  fast.patch(
    '/api/v1/issues/:id',
    {
      schema: { params: idParam, body: patchBody },
      config: { audit: { action: 'issue.update', resource: 'issue' } },
    },
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

      req.auditSnapshots = { before: beforeView, after: afterView };
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
    {
      schema: { params: idParam, body: commentBody },
      config: { audit: { action: 'issue.comment.create', resource: 'issue' } },
    },
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
      req.auditSnapshots = { before: null, after: view };
      app.liveBus.publish({
        type: 'issue.comment.created',
        ts: new Date().toISOString(),
        data: { issue_id: issue.id, comment: view },
      });
      return view;
    },
  );
};

export default issueUpdateRoutes;
