import { z } from 'zod';

/** Media allowlisted MIME types accepted by `POST /api/v1/media` uploads. */
export const MEDIA_UPLOAD_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'image/png',
  'image/jpeg',
] as const;
export type MediaUploadMimeType = (typeof MEDIA_UPLOAD_MIME_TYPES)[number];

export const mediaKind = z.enum(['video', 'image', 'external_link']);
export type MediaKind = z.infer<typeof mediaKind>;

/** Optional metadata fields accompanying a `POST /api/v1/media` multipart upload. */
export const mediaUploadMetadata = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
export type MediaUploadMetadata = z.infer<typeof mediaUploadMetadata>;

/** Request body for `POST /api/v1/media/link` — registers an external URL. */
export const mediaLinkInput = z
  .object({
    external_url: z.string().url().max(2000),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
export type MediaLinkInput = z.infer<typeof mediaLinkInput>;

/**
 * Response shape for a single media file/link row.
 *
 * `upload_token_id` is non-null only for files delivered through a one-time
 * delegated-upload link (VIDEO-3, #159); together with a null
 * `uploader_player_id` it is what marks evidence as anonymous/untrusted in the
 * UI. It is nullable so every pre-#159 caller keeps parsing unchanged.
 */
export const mediaFileResponse = z
  .object({
    id: z.string().uuid(),
    uploader_player_id: z.string().uuid().nullable(),
    upload_token_id: z.string().uuid().nullable(),
    kind: mediaKind,
    original_filename: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    external_url: z.string().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    created_at: z.string().datetime(),
    deleted_at: z.string().datetime().nullable(),
  })
  .strict();
export type MediaFileResponse = z.infer<typeof mediaFileResponse>;

/** Polymorphic entity kinds a `media_links` row can attach evidence to (VIDEO-2, #158). */
export const mediaLinkEntityType = z.enum(['player', 'moderation_action', 'match', 'issue']);
export type MediaLinkEntityType = z.infer<typeof mediaLinkEntityType>;

/** Request body for `POST /api/v1/media/:id/links` and query for its `DELETE` counterpart. */
export const mediaLinkAttachInput = z
  .object({ entity_type: mediaLinkEntityType, entity_id: z.string().uuid() })
  .strict();
export type MediaLinkAttachInput = z.infer<typeof mediaLinkAttachInput>;
export const mediaLinkDetachQuery = mediaLinkAttachInput;
export type MediaLinkDetachQuery = z.infer<typeof mediaLinkDetachQuery>;

/** Response shape for a single `media_links` row. */
export const mediaLinkResponse = z
  .object({
    id: z.string().uuid(),
    media_id: z.string().uuid(),
    entity_type: mediaLinkEntityType,
    entity_id: z.string().uuid(),
    linked_by_player_id: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
  })
  .strict();
export type MediaLinkResponse = z.infer<typeof mediaLinkResponse>;

/** A `media_links` row joined with the `media_files` row it points at. */
export const mediaLinkedFileResponse = z
  .object({ link: mediaLinkResponse, media: mediaFileResponse })
  .strict();
export type MediaLinkedFileResponse = z.infer<typeof mediaLinkedFileResponse>;

/** Default lifetime of a delegated upload token — two hours (VIDEO-3, #159). */
export const MEDIA_UPLOAD_TOKEN_DEFAULT_TTL_SECONDS = 7200;
/** Hard ceiling on a mint-time `expires_in_seconds` — seven days. */
export const MEDIA_UPLOAD_TOKEN_MAX_TTL_SECONDS = 604_800;

/**
 * Request body for `POST /api/v1/media/upload-tokens`.
 *
 * `target_entity_type` and `target_entity_id` must be supplied together or not
 * at all; the pairing is rejected with `400 invalid_target` by the route (and
 * backed by a CHECK constraint on `media_upload_tokens`) rather than encoded
 * here, so the caller gets a stable error code instead of a schema dump.
 * `max_size_bytes` is a request, not a grant — the route clamps it to the
 * server-wide upload cap.
 */
export const mintUploadTokenInput = z
  .object({
    target_entity_type: mediaLinkEntityType.optional(),
    target_entity_id: z.string().uuid().optional(),
    expires_in_seconds: z
      .number()
      .int()
      .min(60)
      .max(MEDIA_UPLOAD_TOKEN_MAX_TTL_SECONDS)
      .default(MEDIA_UPLOAD_TOKEN_DEFAULT_TTL_SECONDS),
    max_size_bytes: z.number().int().positive().optional(),
  })
  .strict();
export type MintUploadTokenInput = z.infer<typeof mintUploadTokenInput>;

/**
 * Response of a successful mint. `token` and the `upload_url` embedding it are
 * returned exactly once — neither is stored, logged, or auditable afterwards.
 */
export const uploadTokenResponse = z
  .object({
    id: z.string().uuid(),
    token: z.string(),
    upload_url: z.string().url(),
    expires_at: z.string().datetime(),
    max_size_bytes: z.number().int().positive(),
    target_entity_type: mediaLinkEntityType.nullable(),
    target_entity_id: z.string().uuid().nullable(),
  })
  .strict();
export type UploadTokenResponse = z.infer<typeof uploadTokenResponse>;

/** Query string of the public, session-less `POST /api/v1/public/media`. */
export const publicMediaUploadQuery = z.object({ token: z.string().min(1).max(512) }).strict();
export type PublicMediaUploadQuery = z.infer<typeof publicMediaUploadQuery>;
