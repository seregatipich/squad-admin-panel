import { mediaUploadTokens } from '@squad/db/schema';
import { mintUploadTokenInput, type UploadTokenResponse } from '@squad/shared-types';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { writeAuditEntry } from '../lib/audit.js';
import { MEDIA_MAX_UPLOAD_BYTES } from '../lib/media-storage.js';
import { mintUploadToken, uploadTokenUrl } from '../lib/media-upload-tokens.js';
import { entityExists } from './media-links.js';

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
 * VIDEO-3 (#159) — minting half of the delegated-upload flow. Issues a
 * one-time credential that lets an outside player upload a single file with no
 * panel session at all, optionally pre-bound to the evidence target so the
 * upload files itself into the right case.
 *
 * The raw token leaves the process exactly once, in this response body: it is
 * hashed on the way into the database and deliberately kept out of the audit
 * trail, which records only the token's id.
 */
const mediaUploadTokensRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/media/upload-tokens',
    { schema: { body: mintUploadTokenInput }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const { target_entity_type, target_entity_id, expires_in_seconds, max_size_bytes } = req.body;
      if ((target_entity_type === undefined) !== (target_entity_id === undefined)) {
        reply.code(400);
        return { error: 'invalid_target' };
      }
      if (target_entity_type && target_entity_id) {
        const exists = await entityExists(app.db, target_entity_type, target_entity_id);
        if (!exists) {
          reply.code(404);
          return { error: 'entity_not_found' };
        }
      }

      // A token can request a smaller cap but never a larger one than the
      // server-wide limit the multipart parser itself enforces.
      const maxSizeBytes = Math.min(
        max_size_bytes ?? MEDIA_MAX_UPLOAD_BYTES,
        MEDIA_MAX_UPLOAD_BYTES,
      );
      const expiresAt = new Date(Date.now() + expires_in_seconds * 1000);
      const id = uuidv7();
      const minted = mintUploadToken();

      await app.db.insert(mediaUploadTokens).values({
        id,
        tokenHash: minted.hash,
        issuedByPlayerId: actorId,
        targetEntityType: target_entity_type ?? null,
        targetEntityId: target_entity_id ?? null,
        expiresAt,
        maxSizeBytes,
      });

      const response: UploadTokenResponse = {
        id,
        token: minted.raw,
        upload_url: uploadTokenUrl(app.config.PANEL_PUBLIC_URL, minted.raw),
        expires_at: expiresAt.toISOString(),
        max_size_bytes: maxSizeBytes,
        target_entity_type: target_entity_type ?? null,
        target_entity_id: target_entity_id ?? null,
      };

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.upload_token.mint',
        targetType: 'media_upload_token',
        targetId: id,
        // Deliberately omits `token` and `upload_url` — the raw credential must
        // never reach the audit trail.
        after: {
          id,
          expires_at: response.expires_at,
          max_size_bytes: maxSizeBytes,
          target_entity_type: response.target_entity_type,
          target_entity_id: response.target_entity_id,
        },
        context: { request_id: req.id },
        statusCode: 201,
      });

      reply.code(201);
      return response;
    },
  );
};

export default mediaUploadTokensRoutes;
