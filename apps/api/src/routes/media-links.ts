import type { DatabaseClient } from '@squad/db';
import {
  issues,
  matches,
  mediaFiles,
  mediaLinks,
  moderationActions,
  players,
} from '@squad/db/schema';
import {
  type MediaLinkEntityType,
  type MediaLinkedFileResponse,
  type MediaLinkResponse,
  mediaLinkAttachInput,
  mediaLinkDetachQuery,
} from '@squad/shared-types';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { loadActiveMediaFile, serializeMediaFile } from './media.js';

const mediaIdParams = z.object({ id: z.string().uuid() });
const playerIdParams = z.object({ playerId: z.string().uuid() });
const moderationActionIdParams = z.object({ id: z.string().uuid() });

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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function serializeMediaLink(row: typeof mediaLinks.$inferSelect): MediaLinkResponse {
  return {
    id: row.id,
    media_id: row.mediaId,
    entity_type: row.entityType as MediaLinkEntityType,
    entity_id: row.entityId,
    linked_by_player_id: row.linkedByPlayerId,
    created_at: row.createdAt.toISOString(),
  };
}

/** Checks whether the polymorphic target of a `media_links` row exists, per `entity_type`. */
export async function entityExists(
  db: DatabaseClient,
  entityType: MediaLinkEntityType,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'player': {
      const rows = await db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, entityId))
        .limit(1);
      return rows.length > 0;
    }
    case 'moderation_action': {
      const rows = await db
        .select({ id: moderationActions.id })
        .from(moderationActions)
        .where(eq(moderationActions.id, entityId))
        .limit(1);
      return rows.length > 0;
    }
    case 'match': {
      const rows = await db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.id, entityId))
        .limit(1);
      return rows.length > 0;
    }
    case 'issue': {
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, entityId))
        .limit(1);
      return rows.length > 0;
    }
    default:
      return false;
  }
}

/** Loads the active `media_files` row for each of a set of `media_links` rows, pairing link + media. */
async function loadLinkedFiles(
  db: DatabaseClient,
  links: (typeof mediaLinks.$inferSelect)[],
): Promise<MediaLinkedFileResponse[]> {
  if (links.length === 0) return [];
  const mediaIds = Array.from(new Set(links.map((link) => link.mediaId)));
  const mediaRows = await db
    .select()
    .from(mediaFiles)
    .where(and(inArray(mediaFiles.id, mediaIds), isNull(mediaFiles.deletedAt)));
  const byId = new Map(mediaRows.map((row) => [row.id, row]));
  const items: MediaLinkedFileResponse[] = [];
  for (const link of links) {
    const media = byId.get(link.mediaId);
    if (!media) continue;
    items.push({ link: serializeMediaLink(link), media: serializeMediaFile(media) });
  }
  return items;
}

const mediaLinksRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/media/:id/links',
    { schema: { params: mediaIdParams, body: mediaLinkAttachInput }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const mediaFile = await loadActiveMediaFile(app.db, req.params.id);
      if (!mediaFile) {
        reply.code(404);
        return { error: 'media_not_found' };
      }

      const { entity_type, entity_id } = req.body;
      const targetExists = await entityExists(app.db, entity_type, entity_id);
      if (!targetExists) {
        reply.code(404);
        return { error: 'entity_not_found' };
      }

      const existingLink = await app.db
        .select({ id: mediaLinks.id })
        .from(mediaLinks)
        .where(
          and(
            eq(mediaLinks.mediaId, mediaFile.id),
            eq(mediaLinks.entityType, entity_type),
            eq(mediaLinks.entityId, entity_id),
          ),
        )
        .limit(1);
      if (existingLink.length > 0) {
        reply.code(409);
        return { error: 'already_linked' };
      }

      const id = uuidv7();
      let inserted: (typeof mediaLinks.$inferSelect)[];
      try {
        inserted = await app.db
          .insert(mediaLinks)
          .values({
            id,
            mediaId: mediaFile.id,
            entityType: entity_type,
            entityId: entity_id,
            linkedByPlayerId: actorId,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'already_linked' };
        }
        throw err;
      }
      const row = inserted[0];
      if (!row) throw new Error('media_links insert returned no row');

      const response = serializeMediaLink(row);
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.link.attach',
        targetType: 'media_link',
        targetId: row.id,
        after: response,
        context: { request_id: req.id },
        statusCode: 201,
      });

      reply.code(201);
      return response;
    },
  );

  fast.delete(
    '/api/v1/media/:id/links',
    {
      schema: { params: mediaIdParams, querystring: mediaLinkDetachQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const { entity_type, entity_id } = req.query;
      const rows = await app.db
        .select()
        .from(mediaLinks)
        .where(
          and(
            eq(mediaLinks.mediaId, req.params.id),
            eq(mediaLinks.entityType, entity_type),
            eq(mediaLinks.entityId, entity_id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'link_not_found' };
      }

      const isOwnLink = row.linkedByPlayerId === actorId;
      if (!isOwnLink && !req.user?.permissions.canManageMedia) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_media' };
      }

      await app.db.delete(mediaLinks).where(eq(mediaLinks.id, row.id));

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.link.detach',
        targetType: 'media_link',
        targetId: row.id,
        before: serializeMediaLink(row),
        context: { request_id: req.id },
        statusCode: 200,
      });

      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/media',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const actionRows = await app.db
        .select({ id: moderationActions.id })
        .from(moderationActions)
        .where(eq(moderationActions.playerId, req.params.playerId));
      const actionIds = actionRows.map((row) => row.id);

      const directLinks = await app.db
        .select()
        .from(mediaLinks)
        .where(
          and(eq(mediaLinks.entityType, 'player'), eq(mediaLinks.entityId, req.params.playerId)),
        );

      const actionLinks =
        actionIds.length > 0
          ? await app.db
              .select()
              .from(mediaLinks)
              .where(
                and(
                  eq(mediaLinks.entityType, 'moderation_action'),
                  inArray(mediaLinks.entityId, actionIds),
                ),
              )
          : [];

      const items = await loadLinkedFiles(app.db, [...directLinks, ...actionLinks]);
      return { items };
    },
  );

  fast.get(
    '/api/v1/moderation-actions/:id/media',
    { schema: { params: moderationActionIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const links = await app.db
        .select()
        .from(mediaLinks)
        .where(
          and(
            eq(mediaLinks.entityType, 'moderation_action'),
            eq(mediaLinks.entityId, req.params.id),
          ),
        );

      const items = await loadLinkedFiles(app.db, links);
      return { items };
    },
  );
};

export default mediaLinksRoutes;
