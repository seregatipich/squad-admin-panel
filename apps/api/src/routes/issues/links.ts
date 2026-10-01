import { type IssueLinkRow, issueLinks } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { currentUser } from '../../lib/issues/current-user.js';
import { issueQueries } from '../../lib/issues/queries.js';
import { idParam, linkIdParam, linkInput } from '../../lib/issues/schemas.js';
import type { LinkTarget } from '../../lib/issues/views.js';
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from '../../lib/pg-errors.js';

/** Ticket-to-entity links. */
const issueLinkRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { getIssueRow, findUnknownTargets, serializeLinks } = issueQueries(app);

  fast.post(
    '/api/v1/issues/:id/links',
    {
      schema: { params: idParam, body: linkInput },
      config: { audit: { action: 'issue.link.create', resource: 'issue' } },
    },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const issue = await getIssueRow(req.params.id);
      if (!issue) {
        reply.code(404);
        return { error: 'issue_not_found' };
      }
      // Same rule as PATCH /issues/:id: changing a ticket, its links included,
      // belongs to its author or a can_manage_issues holder.
      if (issue.authorPlayerId !== user.playerId && !user.permissions.canManageIssues) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_issues' };
      }

      const target: LinkTarget = {
        entity_type: req.body.entity_type,
        entity_id: req.body.entity_id,
      };
      const unknown = await findUnknownTargets([target]);
      if (unknown.length > 0) {
        reply.code(422);
        return { error: 'unknown_entity', unknown };
      }

      let inserted: IssueLinkRow[];
      try {
        inserted = await app.db
          .insert(issueLinks)
          .values({
            id: uuidv7(),
            issueId: issue.id,
            entityType: target.entity_type,
            entityId: target.entity_id,
            createdBy: user.playerId,
          })
          .returning();
      } catch (err) {
        if (hasPgErrorCode(err, PG_UNIQUE_VIOLATION)) {
          reply.code(409);
          return { error: 'link_exists' };
        }
        throw err;
      }
      const row = inserted[0];
      if (!row) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      const [view] = await serializeLinks([row]);

      reply.code(201);
      req.auditSnapshots = { before: null, after: view };
      return view;
    },
  );

  fast.delete(
    '/api/v1/issues/:id/links/:linkId',
    {
      schema: { params: linkIdParam },
      config: { audit: { action: 'issue.link.delete', resource: 'issue' } },
    },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const rows = await app.db
        .select()
        .from(issueLinks)
        .where(and(eq(issueLinks.id, req.params.linkId), eq(issueLinks.issueId, req.params.id)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'link_not_found' };
      }

      const isAuthor = row.createdBy === user.playerId;
      if (!isAuthor && !user.permissions.canManageIssues) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_issues' };
      }

      const [view] = await serializeLinks([row]);
      await app.db.delete(issueLinks).where(eq(issueLinks.id, row.id));

      req.auditSnapshots = { before: view, after: null };
      return { ok: true };
    },
  );
};

export default issueLinkRoutes;
