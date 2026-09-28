import { rm } from 'node:fs/promises';
import { mediaFiles, mediaLinks } from '@squad/db/schema';
import {
  MEDIA_UPLOAD_MIME_TYPES,
  type MediaLinkEntityType,
  type MediaUploadMimeType,
  publicMediaUploadQuery,
} from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { writeAuditEntry } from '../lib/audit.js';
import {
  MediaMagicByteMismatchError,
  MediaSizeLimitExceededError,
  storeMediaUpload,
} from '../lib/media-storage.js';
import {
  isUploadTokenRedeemable,
  loadUploadTokenByRaw,
  redeemUploadToken,
} from '../lib/media-upload-tokens.js';

/** Anonymous uploads allowed from one IP per hour before the endpoint answers 429. */
export const PUBLIC_MEDIA_UPLOADS_PER_HOUR = 10;
export const PUBLIC_MEDIA_RATE_LIMIT_PREFIX = 'public-media:upload-rl:';
const RATE_LIMIT_WINDOW_SECONDS = 3600;

/** Audit actor label for uploads that arrive with no panel identity at all. */
const PUBLIC_UPLOAD_ACTOR_LABEL = 'public-upload';

function isUploadMimeType(value: string): value is MediaUploadMimeType {
  return (MEDIA_UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * VIDEO-3 (#159) — redeeming half of the delegated-upload flow. Deliberately
 * unauthenticated: the one-time token in the query string *is* the credential,
 * so the route never consults `req.user` and works with no cookie at all.
 *
 * Security shape:
 *  - every rejection of a bad, spent, or expired token is the same `410` with
 *    the same body, so the endpoint cannot be used to probe which tokens exist;
 *  - the token is burned only after the bytes are safely on disk, by the
 *    conditional `UPDATE` in `redeemUploadToken`, in the same transaction as
 *    the `media_files`/`media_links` rows and the audit entry — an aborted,
 *    rejected, or unpersisted upload leaves the link usable, while two
 *    concurrent uploads can never both succeed;
 *  - the raw token never reaches the database, the audit trail, the response,
 *    or the request logs (`redactSensitiveUrl` in `lib/logger.ts` masks
 *    `?token=`); the stored row records only `upload_token_id`.
 *
 * The per-IP limiter is a manual Redis `INCR`/`EXPIRE` (the `leaderboards.ts`
 * pattern) rather than the declarative `@fastify/rate-limit` config, because
 * that plugin is not registered in the integration harness and a declarative
 * limit would therefore be untestable.
 */
const publicMediaRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/public/media',
    { schema: { querystring: publicMediaUploadQuery }, config: { audit: false, public: true } },
    async (req, reply) => {
      const rateKey = `${PUBLIC_MEDIA_RATE_LIMIT_PREFIX}${req.ip}`;
      const hits = await app.redis.incr(rateKey).catch(() => 0);
      if (hits === 1) await app.redis.expire(rateKey, RATE_LIMIT_WINDOW_SECONDS).catch(() => {});
      if (hits > PUBLIC_MEDIA_UPLOADS_PER_HOUR) {
        reply.code(429);
        return { error: 'rate_limited' };
      }

      const token = await loadUploadTokenByRaw(app.db, req.query.token);
      if (!token || !isUploadTokenRedeemable(token)) {
        reply.code(410);
        return { error: 'token_used_or_expired' };
      }

      if (!req.isMultipart()) {
        reply.code(400);
        return { error: 'expected_multipart' };
      }
      const filePart = await req.file();
      if (!filePart) {
        reply.code(400);
        return { error: 'missing_file' };
      }

      if (!isUploadMimeType(filePart.mimetype)) {
        filePart.file.resume();
        reply.code(415);
        return { error: 'unsupported_media_type', mime_type: filePart.mimetype };
      }
      const mimeType = filePart.mimetype;

      const id = uuidv7();
      let stored: Awaited<ReturnType<typeof storeMediaUpload>>;
      try {
        stored = await storeMediaUpload({
          baseDir: app.config.MEDIA_STORAGE_DIR,
          id,
          mimeType,
          source: filePart.file,
          maxBytes: token.maxSizeBytes,
        });
      } catch (err) {
        if (err instanceof MediaMagicByteMismatchError) {
          reply.code(400);
          return { error: 'magic_byte_mismatch' };
        }
        if (err instanceof MediaSizeLimitExceededError) {
          reply.code(413);
          return { error: 'file_too_large' };
        }
        throw err;
      }

      // Redemption, the dedup lookup, both inserts and the audit row commit as
      // one transaction: if any of them fails the token is not burned and the
      // freshly written file is removed, so the sender can simply retry.
      const targetType = token.targetEntityType as MediaLinkEntityType | null;
      let persisted: { claimed: false } | { claimed: true; dedupPath: string | null | undefined };
      try {
        persisted = await app.db.transaction(async (tx) => {
          if (!(await redeemUploadToken(tx, token.id))) return { claimed: false } as const;

          // Same content-hash dedup as the authenticated upload route:
          // identical bytes reuse the existing storage_path instead of being
          // written twice.
          const existing = await tx
            .select({ storagePath: mediaFiles.storagePath })
            .from(mediaFiles)
            .where(and(eq(mediaFiles.sha256, stored.sha256), isNull(mediaFiles.deletedAt)))
            .limit(1);
          const dedupPath = existing[0]?.storagePath;

          await tx.insert(mediaFiles).values({
            id,
            uploaderPlayerId: null,
            uploadTokenId: token.id,
            kind: mimeType.startsWith('video/') ? 'video' : 'image',
            originalFilename: filePart.filename,
            mimeType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            storagePath: dedupPath ?? stored.relativePath,
            externalUrl: null,
            title: null,
            description: null,
          });

          if (targetType && token.targetEntityId) {
            await tx.insert(mediaLinks).values({
              id: uuidv7(),
              mediaId: id,
              entityType: targetType,
              entityId: token.targetEntityId,
              linkedByPlayerId: token.issuedByPlayerId,
            });
          }

          await writeAuditEntry(tx, {
            actor: { kind: 'system', label: PUBLIC_UPLOAD_ACTOR_LABEL },
            actorIp: req.ip ?? null,
            actionType: 'media.public_upload',
            targetType: 'media_file',
            targetId: id,
            after: {
              id,
              upload_token_id: token.id,
              size_bytes: stored.sizeBytes,
              mime_type: mimeType,
              target_entity_type: targetType,
              target_entity_id: token.targetEntityId,
            },
            context: { request_id: req.id, token_id: token.id, deduped: Boolean(dedupPath) },
            statusCode: 201,
          });
          return { claimed: true, dedupPath } as const;
        });
      } catch (err) {
        await rm(stored.absolutePath, { force: true });
        throw err;
      }

      if (!persisted.claimed) {
        await rm(stored.absolutePath, { force: true });
        reply.code(410);
        return { error: 'token_used_or_expired' };
      }
      if (persisted.dedupPath) await rm(stored.absolutePath, { force: true });

      app.liveBus.publish({
        type: 'media.uploaded',
        ts: new Date().toISOString(),
        data: {
          player_id: token.issuedByPlayerId,
          media_id: id,
          token_id: token.id,
          target_entity_type: targetType,
          target_entity_id: token.targetEntityId,
        },
      });

      reply.code(201);
      // Deliberately minimal: an anonymous uploader learns nothing about the
      // panel beyond the fact that their file landed.
      return { ok: true, media_id: id };
    },
  );
};

export default publicMediaRoutes;
