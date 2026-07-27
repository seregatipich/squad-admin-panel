import { mediaPublications, mediaPublishSettings } from '@squad/db/schema';
import {
  type MediaPublicationDestination,
  type MediaPublicationResponse,
  type MediaPublicationStatus,
  type MediaPublishingIntegrationResponse,
  mediaPublicationDestination,
  mediaPublishInput,
  mediaPublishingSettingsInput,
} from '@squad/shared-types';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { loadActiveMediaFile } from './media.js';

const mediaIdParams = z.object({ id: z.string().uuid() });
const publicationParams = z.object({
  id: z.string().uuid(),
  destination: mediaPublicationDestination,
});

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

/**
 * Mutation gate for everything in this module. `can_manage_media` is a boolean
 * role flag, and `GET /api/v1/me` deliberately does not expose it — the UI
 * hides these controls by observing a 403, so this must answer with the stable
 * `required` code the front end keys off.
 */
function manageMediaGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  const denied = panelGuard(req, reply);
  if (denied) return denied;
  if (!req.user?.permissions.canManageMedia) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_manage_media' };
  }
  return null;
}

function serializeMediaPublication(
  row: typeof mediaPublications.$inferSelect,
): MediaPublicationResponse {
  return {
    id: row.id,
    media_id: row.mediaId,
    destination: row.destination as MediaPublicationDestination,
    status: row.status as MediaPublicationStatus,
    external_id: row.externalId,
    external_url: row.externalUrl,
    error: row.error,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    requested_by_player_id: row.requestedByPlayerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Reads the singleton publishing settings, tolerating an absent row.
 *
 * Migration 0097 seeds `id = 1`, but an isolated test schema or a hand-rolled
 * database can lack it; answering with the safe default (release disabled)
 * beats 500-ing a read-only status endpoint.
 */
async function readReleaseLocalFile(db: FastifyRequest['server']['db']): Promise<boolean> {
  const rows = await db
    .select({ releaseLocalFile: mediaPublishSettings.releaseLocalFile })
    .from(mediaPublishSettings)
    .where(eq(mediaPublishSettings.id, 1))
    .limit(1);
  return rows[0]?.releaseLocalFile ?? false;
}

const mediaPublicationsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/media/:id/publications',
    { schema: { params: mediaIdParams, body: mediaPublishInput }, config: { audit: false } },
    async (req, reply) => {
      const denied = manageMediaGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const media = await loadActiveMediaFile(app.db, req.params.id);
      if (!media) {
        reply.code(404);
        return { error: 'media_not_found' };
      }
      // An `external_link` row has no bytes of ours to upload anywhere; it is
      // already somebody else's public URL.
      if (!media.storagePath) {
        reply.code(400);
        return { error: 'not_a_stored_file' };
      }

      const requested = Array.from(new Set(req.body.destinations));
      const existing = await app.db
        .select({ destination: mediaPublications.destination })
        .from(mediaPublications)
        .where(eq(mediaPublications.mediaId, media.id));
      const taken = new Set(existing.map((row) => row.destination));
      const conflicts = requested.filter((destination) => taken.has(destination));
      if (conflicts.length > 0) {
        // All-or-nothing: a partially applied batch would make the caller's
        // retry ambiguous. The unique index below is the race backstop.
        reply.code(409);
        return { error: 'already_queued', destinations: conflicts };
      }

      const now = new Date();
      let inserted: (typeof mediaPublications.$inferSelect)[];
      try {
        inserted = await app.db
          .insert(mediaPublications)
          .values(
            requested.map((destination) => ({
              id: uuidv7(),
              mediaId: media.id,
              destination,
              status: 'queued',
              attempts: 0,
              nextAttemptAt: now,
              requestedByPlayerId: actorId,
            })),
          )
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'already_queued', destinations: requested };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.publish',
        targetType: 'media_file',
        targetId: media.id,
        after: { publications: inserted.map(serializeMediaPublication) },
        context: { request_id: req.id, destinations: requested },
        statusCode: 201,
      });

      reply.code(201);
      return { items: inserted.map(serializeMediaPublication) };
    },
  );

  fast.get(
    '/api/v1/media/:id/publications',
    { schema: { params: mediaIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const media = await loadActiveMediaFile(app.db, req.params.id);
      if (!media) {
        reply.code(404);
        return { error: 'media_not_found' };
      }

      const rows = await app.db
        .select()
        .from(mediaPublications)
        .where(eq(mediaPublications.mediaId, media.id))
        .orderBy(asc(mediaPublications.destination));
      return { items: rows.map(serializeMediaPublication) };
    },
  );

  fast.delete(
    '/api/v1/media/:id/publications/:destination',
    { schema: { params: publicationParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = manageMediaGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const media = await loadActiveMediaFile(app.db, req.params.id);
      if (!media) {
        reply.code(404);
        return { error: 'media_not_found' };
      }

      const removed = await app.db
        .delete(mediaPublications)
        .where(
          and(
            eq(mediaPublications.mediaId, media.id),
            eq(mediaPublications.destination, req.params.destination),
          ),
        )
        .returning();
      const row = removed[0];
      if (!row) {
        reply.code(404);
        return { error: 'publication_not_found' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.publish.delete',
        targetType: 'media_file',
        targetId: media.id,
        before: serializeMediaPublication(row),
        context: { request_id: req.id, destination: req.params.destination },
        statusCode: 200,
      });

      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/integrations/media-publishing',
    { config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const response: MediaPublishingIntegrationResponse = {
        youtube_configured: Boolean(
          app.config.YOUTUBE_CLIENT_ID &&
            app.config.YOUTUBE_CLIENT_SECRET &&
            app.config.YOUTUBE_REFRESH_TOKEN,
        ),
        telegram_configured: Boolean(app.config.TELEGRAM_BOT_TOKEN && app.config.TELEGRAM_CHAT_ID),
        release_local_file: await readReleaseLocalFile(app.db),
      };
      return response;
    },
  );

  fast.patch(
    '/api/v1/integrations/media-publishing',
    { schema: { body: mediaPublishingSettingsInput }, config: { audit: false } },
    async (req, reply) => {
      const denied = manageMediaGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const before = await readReleaseLocalFile(app.db);
      const releaseLocalFile = req.body.release_local_file;
      await app.db
        .insert(mediaPublishSettings)
        .values({ id: 1, releaseLocalFile, updatedByPlayerId: actorId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: mediaPublishSettings.id,
          set: { releaseLocalFile, updatedByPlayerId: actorId, updatedAt: new Date() },
        });

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.publish.settings.update',
        targetType: 'media_publish_settings',
        targetId: null,
        before: { release_local_file: before },
        after: { release_local_file: releaseLocalFile },
        context: { request_id: req.id },
        statusCode: 200,
      });

      const response: MediaPublishingIntegrationResponse = {
        youtube_configured: Boolean(
          app.config.YOUTUBE_CLIENT_ID &&
            app.config.YOUTUBE_CLIENT_SECRET &&
            app.config.YOUTUBE_REFRESH_TOKEN,
        ),
        telegram_configured: Boolean(app.config.TELEGRAM_BOT_TOKEN && app.config.TELEGRAM_CHAT_ID),
        release_local_file: releaseLocalFile,
      };
      return response;
    },
  );
};

/**
 * Detects a Postgres unique-violation, including drizzle-orm 0.45's wrapped
 * form where the SQLSTATE sits on `err.cause` rather than the thrown error —
 * a flat `err.code === '23505'` check silently misses it and turns a benign
 * duplicate into a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export default mediaPublicationsRoutes;
