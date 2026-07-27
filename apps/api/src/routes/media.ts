import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { DatabaseClient } from '@squad/db';
import { type MediaFileRow, mediaFiles } from '@squad/db/schema';
import {
  MEDIA_UPLOAD_MIME_TYPES,
  type MediaFileResponse,
  type MediaUploadMimeType,
  mediaLinkInput,
  mediaUploadMetadata,
} from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import {
  MediaMagicByteMismatchError,
  MediaSizeLimitExceededError,
  resolveMediaPath,
  storeMediaUpload,
} from '../lib/media-storage.js';

const idParams = z.object({ id: z.string().uuid() });

function isUploadMimeType(value: string): value is MediaUploadMimeType {
  return (MEDIA_UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

/** Extracts a plain string value from a `req.file()` multipart field, if present. */
function multipartFieldValue(field: unknown): string | undefined {
  const value = Array.isArray(field) ? field[0] : field;
  if (value && typeof value === 'object' && (value as { type?: string }).type === 'field') {
    return String((value as { value: unknown }).value);
  }
  return undefined;
}

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

export function serializeMediaFile(row: MediaFileRow): MediaFileResponse {
  return {
    id: row.id,
    uploader_player_id: row.uploaderPlayerId,
    kind: row.kind as MediaFileResponse['kind'],
    original_filename: row.originalFilename,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    sha256: row.sha256,
    external_url: row.externalUrl,
    title: row.title,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export async function loadActiveMediaFile(
  db: DatabaseClient,
  id: string,
): Promise<MediaFileRow | null> {
  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, id), isNull(mediaFiles.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** Parses a single-range `Range: bytes=start-end` header into byte offsets clamped to `totalSize`. */
function parseRangeHeader(
  header: string,
  totalSize: number,
): { start: number; end: number } | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return 'invalid';

  let start: number;
  let end: number;
  if (!startStr) {
    // Suffix range "bytes=-N": last N bytes.
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr ? Number(endStr) : totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) {
    return 'invalid';
  }
  if (start >= totalSize) return 'invalid';
  return { start, end: Math.min(end, totalSize - 1) };
}

const mediaRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post('/api/v1/media', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    const actorId = req.user?.playerId;
    if (!actorId) {
      reply.code(401);
      return { error: 'unauthenticated' };
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

    const metadataParse = mediaUploadMetadata.safeParse({
      title: multipartFieldValue(filePart.fields.title),
      description: multipartFieldValue(filePart.fields.description),
    });
    if (!metadataParse.success) {
      filePart.file.resume();
      reply.code(400);
      return { error: 'invalid_metadata', issues: metadataParse.error.issues };
    }

    const id = uuidv7();
    let stored: Awaited<ReturnType<typeof storeMediaUpload>>;
    try {
      stored = await storeMediaUpload({
        baseDir: app.config.MEDIA_STORAGE_DIR,
        id,
        mimeType,
        source: filePart.file,
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

    const kind = mimeType.startsWith('video/') ? 'video' : 'image';

    // Dedup by content hash: if an active row already stores identical bytes,
    // reuse its storage_path and discard the file we just wrote so the same
    // content is never stored twice on disk.
    const existing = await app.db
      .select({ storagePath: mediaFiles.storagePath })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.sha256, stored.sha256), isNull(mediaFiles.deletedAt)))
      .limit(1);
    const dedupPath = existing[0]?.storagePath;
    const storagePath = dedupPath ?? stored.relativePath;
    if (dedupPath) {
      await rm(stored.absolutePath, { force: true });
    }

    const inserted = await app.db
      .insert(mediaFiles)
      .values({
        id,
        uploaderPlayerId: actorId,
        kind,
        originalFilename: filePart.filename,
        mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storagePath,
        externalUrl: null,
        title: metadataParse.data.title ?? null,
        description: metadataParse.data.description ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('media_files insert returned no row');

    await writeAuditEntry(app.db, {
      actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
      actorIp: req.ip ?? null,
      actionType: 'media.upload',
      targetType: 'media_file',
      targetId: id,
      after: serializeMediaFile(row),
      context: { request_id: req.id, deduped: Boolean(dedupPath) },
      statusCode: 201,
    });

    reply.code(201);
    return serializeMediaFile(row);
  });

  fast.post(
    '/api/v1/media/link',
    { schema: { body: mediaLinkInput }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const { external_url, title, description } = req.body;
      const id = uuidv7();
      const inserted = await app.db
        .insert(mediaFiles)
        .values({
          id,
          uploaderPlayerId: actorId,
          kind: 'external_link',
          originalFilename: external_url,
          mimeType: 'text/uri-list',
          sizeBytes: 0,
          sha256: createHash('sha256').update(external_url).digest('hex'),
          storagePath: null,
          externalUrl: external_url,
          title: title ?? null,
          description: description ?? null,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('media_files insert returned no row');

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.link.create',
        targetType: 'media_file',
        targetId: id,
        after: serializeMediaFile(row),
        context: { request_id: req.id },
        statusCode: 201,
      });

      reply.code(201);
      return serializeMediaFile(row);
    },
  );

  fast.get(
    '/api/v1/media/:id',
    { schema: { params: idParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const row = await loadActiveMediaFile(app.db, req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'media_not_found' };
      }
      return serializeMediaFile(row);
    },
  );

  fast.get(
    '/api/v1/media/:id/stream',
    { schema: { params: idParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const row = await loadActiveMediaFile(app.db, req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'media_not_found' };
      }
      if (!row.storagePath) {
        reply.code(400);
        return { error: 'not_a_stored_file' };
      }

      const absolutePath = resolveMediaPath(app.config.MEDIA_STORAGE_DIR, row.storagePath);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        reply.code(404);
        return { error: 'file_missing' };
      }
      const totalSize = fileStat.size;

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        reply.header('Content-Type', row.mimeType);
        reply.header('Content-Length', totalSize);
        reply.header('Accept-Ranges', 'bytes');
        reply.code(200);
        return reply.send(createReadStream(absolutePath));
      }

      const range = parseRangeHeader(rangeHeader, totalSize);
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${totalSize}`);
        reply.code(416);
        return { error: 'invalid_range' };
      }

      reply.header('Content-Type', row.mimeType);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
      reply.header('Content-Length', range.end - range.start + 1);
      reply.header('Accept-Ranges', 'bytes');
      reply.code(206);
      return reply.send(createReadStream(absolutePath, { start: range.start, end: range.end }));
    },
  );

  fast.delete(
    '/api/v1/media/:id',
    { schema: { params: idParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const row = await loadActiveMediaFile(app.db, req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'media_not_found' };
      }

      const isOwnFile = row.uploaderPlayerId === actorId;
      if (!isOwnFile && !req.user?.permissions.canManageMedia) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_manage_media' };
      }

      await app.db
        .update(mediaFiles)
        .set({ deletedAt: new Date() })
        .where(eq(mediaFiles.id, row.id));

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'media.delete',
        targetType: 'media_file',
        targetId: row.id,
        before: serializeMediaFile(row),
        context: { request_id: req.id },
        statusCode: 200,
      });

      return { ok: true };
    },
  );
};

export default mediaRoutes;
