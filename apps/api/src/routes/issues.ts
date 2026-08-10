import {
  ISSUE_LINK_ENTITY_TYPES,
  type IssueLinkEntityType,
  type IssueLinkRow,
  issueComments,
  issueLabelLinks,
  issueLabels,
  issueLinks,
  issues,
  mediaFiles,
  moderationActions,
  players,
  servers,
} from '@squad/db/schema';
import { and, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
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

const MAX_LINKS_PER_CREATE = 20;
const PLAYER_CARD_ISSUES_LIMIT = 50;
/** Shown for a link whose polymorphic target row no longer exists. */
const DELETED_ENTITY_LABEL = 'Удалённый объект';

const stateSchema = z.enum(['open', 'in_progress', 'closed']);
const labelNamesSchema = z.array(z.string().trim().min(1).max(64)).max(20);
const linkInput = z.object({
  entity_type: z.enum(ISSUE_LINK_ENTITY_TYPES),
  entity_id: z.string().uuid(),
});

const createBody = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  labels: labelNamesSchema.optional(),
  links: z.array(linkInput).max(MAX_LINKS_PER_CREATE).optional(),
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
const linkIdParam = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });
const playerIdParam = z.object({ playerId: z.string().uuid() });

interface IssueLabelView {
  id: string;
  name: string;
  color: string;
}

/** A ticket→entity link expanded for display: `label` is human-readable, `ref` is where a click goes. */
interface IssueLinkView {
  id: string;
  issue_id: string;
  entity_type: IssueLinkEntityType;
  entity_id: string;
  label: string;
  ref: string | null;
  exists: boolean;
  created_by: string | null;
  created_at: string;
}

interface LinkTarget {
  entity_type: IssueLinkEntityType;
  entity_id: string;
}

interface ResolvedEntity {
  label: string;
  ref: string | null;
}

type IssueRow = typeof issues.$inferSelect;

function targetKey(target: LinkTarget): string {
  return `${target.entity_type}:${target.entity_id}`;
}

/**
 * Detects Postgres `23505` (unique violation). Drizzle wraps driver errors in a
 * `DrizzleQueryError`, so the SQLSTATE lives on `cause`, not on the thrown
 * error itself — the chain has to be walked.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function currentUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return req.user;
}

/**
 * Hand-rolled `panel_access` gate for the player-card endpoint. The rest of
 * this module deliberately gates on authentication only, but every other
 * section of the player card is panel-gated, so this one matches its host
 * surface rather than its host module (mirrors `media-links.ts`).
 */
function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
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

  /**
   * Batch-resolves the polymorphic targets of a set of links, one query per
   * `entity_type` present. A key missing from the returned map means the row
   * is gone — `entity_id` carries no foreign key, so that is a normal state
   * rather than an integrity failure, and callers render it as deleted.
   */
  async function resolveEntities(targets: LinkTarget[]): Promise<Map<string, ResolvedEntity>> {
    const resolved = new Map<string, ResolvedEntity>();
    const byType = new Map<IssueLinkEntityType, string[]>();
    for (const target of targets) {
      const list = byType.get(target.entity_type) ?? [];
      if (!list.includes(target.entity_id)) list.push(target.entity_id);
      byType.set(target.entity_type, list);
    }

    const playerIds = byType.get('player');
    if (playerIds?.length) {
      const rows = await app.db
        .select({ id: players.id, name: players.canonicalName })
        .from(players)
        .where(inArray(players.id, playerIds));
      for (const row of rows) {
        resolved.set(`player:${row.id}`, { label: row.name, ref: `/players/${row.id}` });
      }
    }

    const serverIds = byType.get('server');
    if (serverIds?.length) {
      const rows = await app.db
        .select({ id: servers.id, name: servers.displayName })
        .from(servers)
        // Soft-deleted servers 404 on `/servers/:id`, so a link to one must
        // read as gone rather than hand out a dead ref.
        .where(and(inArray(servers.id, serverIds), isNull(servers.deletedAt)));
      for (const row of rows) {
        resolved.set(`server:${row.id}`, { label: row.name, ref: `/servers/${row.id}` });
      }
    }

    const actionIds = byType.get('moderation_action');
    if (actionIds?.length) {
      const rows = await app.db
        .select({
          id: moderationActions.id,
          actionType: moderationActions.actionType,
          playerId: moderationActions.playerId,
          createdAt: moderationActions.createdAt,
        })
        .from(moderationActions)
        .where(inArray(moderationActions.id, actionIds));
      for (const row of rows) {
        resolved.set(`moderation_action:${row.id}`, {
          label: `${row.actionType} · ${row.createdAt.toISOString().slice(0, 10)}`,
          // No moderation-action page exists yet (MOD-2, #59); the offender's
          // card is the surface that shows the action.
          ref: `/players/${row.playerId}`,
        });
      }
    }

    const mediaIds = byType.get('media_file');
    if (mediaIds?.length) {
      const rows = await app.db
        .select({
          id: mediaFiles.id,
          title: mediaFiles.title,
          originalFilename: mediaFiles.originalFilename,
        })
        .from(mediaFiles)
        // Same reasoning as servers: the stream route only serves live rows.
        .where(and(inArray(mediaFiles.id, mediaIds), isNull(mediaFiles.deletedAt)));
      for (const row of rows) {
        resolved.set(`media_file:${row.id}`, {
          label: row.title ?? row.originalFilename,
          ref: `/api/v1/media/${row.id}/stream`,
        });
      }
    }

    return resolved;
  }

  async function findUnknownTargets(targets: LinkTarget[]): Promise<LinkTarget[]> {
    if (targets.length === 0) return [];
    const resolved = await resolveEntities(targets);
    return targets.filter((target) => !resolved.has(targetKey(target)));
  }

  async function serializeLinks(rows: IssueLinkRow[]): Promise<IssueLinkView[]> {
    if (rows.length === 0) return [];
    const targets: LinkTarget[] = rows.map((row) => ({
      entity_type: row.entityType as IssueLinkEntityType,
      entity_id: row.entityId,
    }));
    const resolved = await resolveEntities(targets);
    return rows.map((row, index) => {
      // biome-ignore lint/style/noNonNullAssertion: targets is built 1:1 from rows
      const hit = resolved.get(targetKey(targets[index]!));
      return {
        id: row.id,
        issue_id: row.issueId,
        entity_type: row.entityType as IssueLinkEntityType,
        entity_id: row.entityId,
        label: hit?.label ?? DELETED_ENTITY_LABEL,
        ref: hit?.ref ?? null,
        exists: hit !== undefined,
        created_by: row.createdBy,
        created_at: row.createdAt.toISOString(),
      };
    });
  }

  async function linksForIssue(issueId: string): Promise<IssueLinkView[]> {
    const rows = await app.db
      .select()
      .from(issueLinks)
      .where(eq(issueLinks.issueId, issueId))
      .orderBy(issueLinks.createdAt);
    return serializeLinks(rows);
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
    await writeAuditEntry(app.db, {
      actor: auditActor(req),
      actorIp: req.ip ?? null,
      actionType: 'issue.create',
      targetType: 'issue',
      targetId: id,
      before: null,
      after: { ...view, links },
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
    app.liveBus.publish({
      type: 'issue.created',
      ts: new Date().toISOString(),
      data: { issue: view },
    });
    return { ...view, links };
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
      links: await linksForIssue(issue.id),
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

  fast.post(
    '/api/v1/issues/:id/links',
    { schema: { params: idParam, body: linkInput } },
    async (req, reply) => {
      const user = currentUser(req, reply);
      if (!user) return;

      const issue = await getIssueRow(req.params.id);
      if (!issue) {
        reply.code(404);
        return { error: 'issue_not_found' };
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
        if (isUniqueViolation(err)) {
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
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'issue.link.create',
        targetType: 'issue',
        targetId: issue.id,
        before: null,
        after: view,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });
      return view;
    },
  );

  fast.delete(
    '/api/v1/issues/:id/links/:linkId',
    { schema: { params: linkIdParam } },
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

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'issue.link.delete',
        targetType: 'issue',
        targetId: row.issueId,
        before: view,
        after: null,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });
      return { ok: true };
    },
  );

  /**
   * Reverse lookup for the player card: the tickets still awaiting work that
   * name this player. `open_count` counts everything not yet `closed`, which is
   * exactly what `items` carries.
   */
  fast.get(
    '/api/v1/players/:playerId/issues',
    { schema: { params: playerIdParam } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const rows = await app.db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          createdAt: issues.createdAt,
        })
        .from(issueLinks)
        .innerJoin(issues, eq(issues.id, issueLinks.issueId))
        .where(
          and(
            eq(issueLinks.entityType, 'player'),
            eq(issueLinks.entityId, req.params.playerId),
            ne(issues.state, 'closed'),
          ),
        )
        .orderBy(desc(issues.number))
        .limit(PLAYER_CARD_ISSUES_LIMIT);

      return {
        open_count: rows.length,
        items: rows.map((row) => ({
          id: row.id,
          number: Number(row.number),
          title: row.title,
          state: row.state,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  );
};

export default issuesRoutes;
