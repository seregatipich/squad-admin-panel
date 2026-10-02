import type { DatabaseClient } from '@squad/db';
import {
  issues,
  matches,
  mediaFiles,
  mediaLinks,
  mediaPublications,
  moderationActions,
  players,
} from '@squad/db/schema';
import {
  type MediaLinkEntityType,
  type MediaLinkedFileResponse,
  type MediaLinkResponse,
  type MediaPublicationResponse,
  mediaLinkAttachInput,
  mediaLinkDetachQuery,
} from '@squad/shared-types';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { panelGuard } from '../lib/panel-guard.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import { loadActiveMediaFile, serializeMediaFile } from './media.js';
import { serializeMediaPublication } from './media-publications.js';

/**
 * Most evidence items `GET /api/v1/players/:playerId/media` returns, newest
 * link first; bounds the response for a player with a long moderation history.
 */
export const PLAYER_MEDIA_LIMIT = 500;

const mediaIdParams = z.object({ id: z.string().uuid() });
const playerIdParams = z.object({ playerId: z.string().uuid() });
const moderationActionIdParams = z.object({ id: z.string().uuid() });

/**
 * Detects Postgres `23505` (unique violation). Drizzle wraps driver errors in a
 * `DrizzleQueryError`, so the SQLSTATE lives on `cause`, not on the thrown
 * error itself — the chain has to be walked.
 */

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

/**
 * Loads the `media_publications` rows of a set of media files in one query,
 * grouped by media id, so a listing can embed them instead of the UI fetching
 * each file's publications separately (#444).
 */
async function loadPublicationsByMedia(
  db: DatabaseClient,
  mediaIds: string[],
): Promise<Map<string, MediaPublicationResponse[]>> {
  const byMedia = new Map<string, MediaPublicationResponse[]>();
  if (mediaIds.length === 0) return byMedia;
  const rows = await db
    .select()
    .from(mediaPublications)
    .where(inArray(mediaPublications.mediaId, mediaIds))
    .orderBy(asc(mediaPublications.destination));
  for (const row of rows) {
    const list = byMedia.get(row.mediaId) ?? [];
    list.push(serializeMediaPublication(row));
    byMedia.set(row.mediaId, list);
  }
  return byMedia;
}

const mediaLinksRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/media/:id/links',
    {
      schema: { params: mediaIdParams, body: mediaLinkAttachInput },
      config: {
        permissions: ['player:view'],
        audit: { action: 'media.link.attach', resource: 'media_link' },
      },
    },
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
      req.auditSnapshots = { targetId: row.id, after: response, context: { request_id: req.id } };

      reply.code(201);
      return response;
    },
  );

  fast.delete(
    '/api/v1/media/:id/links',
    {
      schema: { params: mediaIdParams, querystring: mediaLinkDetachQuery },
      config: { audit: { action: 'media.link.detach', resource: 'media_link' } },
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

      req.auditSnapshots = {
        targetId: row.id,
        before: serializeMediaLink(row),
        context: { request_id: req.id },
      };

      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/media',
    { schema: { params: playerIdParams }, config: { permissions: ['player:view'], audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const rows = await app.db
        .select({ link: mediaLinks, media: mediaFiles })
        .from(mediaLinks)
        .innerJoin(mediaFiles, eq(mediaFiles.id, mediaLinks.mediaId))
        .where(
          and(
            isNull(mediaFiles.deletedAt),
            or(
              and(eq(mediaLinks.entityType, 'player'), eq(mediaLinks.entityId, playerId)),
              and(
                eq(mediaLinks.entityType, 'moderation_action'),
                inArray(
                  mediaLinks.entityId,
                  app.db
                    .select({ id: moderationActions.id })
                    .from(moderationActions)
                    .where(eq(moderationActions.playerId, playerId)),
                ),
              ),
            ),
          ),
        )
        .orderBy(desc(mediaLinks.createdAt), desc(mediaLinks.id))
        .limit(PLAYER_MEDIA_LIMIT);
      const publications = await loadPublicationsByMedia(
        app.db,
        Array.from(new Set(rows.map((row) => row.media.id))),
      );
      // Publications and the caller's `can_manage_media` ride along so the
      // player card renders every publish control from this one response
      // (#444) and offers «Опубликовать» only to a manager (#440).
      return {
        items: rows.map((row) => ({
          link: serializeMediaLink(row.link),
          media: serializeMediaFile(row.media),
          publications: publications.get(row.media.id) ?? [],
        })),
        can_manage_media: req.user?.permissions.canManageMedia ?? false,
      };
    },
  );

  fast.get(
    '/api/v1/moderation-actions/:id/media',
    {
      schema: { params: moderationActionIdParams },
      config: { permissions: ['player:view'], audit: false },
    },
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
