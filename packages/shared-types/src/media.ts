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

/** Community channels a stored media file can be fanned out to (VIDEO-4, #160). */
export const MEDIA_PUBLICATION_DESTINATIONS = ['youtube', 'telegram'] as const;
export const mediaPublicationDestination = z.enum(MEDIA_PUBLICATION_DESTINATIONS);
export type MediaPublicationDestination = z.infer<typeof mediaPublicationDestination>;

/**
 * Lifecycle of one publication. `queued` covers both "never tried" and
 * "waiting out a backoff or a YouTube quota window" — a job blocked on quota
 * stays here rather than moving to `failed`, which is the whole point of
 * separating `next_attempt_at` from the status.
 */
export const MEDIA_PUBLICATION_STATUSES = ['queued', 'uploading', 'published', 'failed'] as const;
export const mediaPublicationStatus = z.enum(MEDIA_PUBLICATION_STATUSES);
export type MediaPublicationStatus = z.infer<typeof mediaPublicationStatus>;

/** Request body for `POST /api/v1/media/:id/publications`. */
export const mediaPublishInput = z
  .object({
    destinations: z
      .array(mediaPublicationDestination)
      .min(1)
      .max(MEDIA_PUBLICATION_DESTINATIONS.length),
  })
  .strict();
export type MediaPublishInput = z.infer<typeof mediaPublishInput>;

/**
 * Response shape for one `media_publications` row.
 *
 * `external_url` stays null on a successful Telegram publish whenever the
 * configured chat has no publicly addressable message URL (neither an
 * `@username` channel nor a `-100…` supergroup); `external_id` is still set.
 * `error` carries a stable machine code — never a provider message, which
 * could echo a credential back at us.
 */
export const mediaPublicationResponse = z
  .object({
    id: z.string().uuid(),
    media_id: z.string().uuid(),
    destination: mediaPublicationDestination,
    status: mediaPublicationStatus,
    external_id: z.string().nullable(),
    external_url: z.string().nullable(),
    error: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    next_attempt_at: z.string().datetime().nullable(),
    requested_by_player_id: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type MediaPublicationResponse = z.infer<typeof mediaPublicationResponse>;

/**
 * Connection status of the publishing integrations. Reports only *whether*
 * each destination's credentials are present — never a value, not even masked.
 */
export const mediaPublishingIntegrationResponse = z
  .object({
    youtube_configured: z.boolean(),
    telegram_configured: z.boolean(),
    release_local_file: z.boolean(),
  })
  .strict();
export type MediaPublishingIntegrationResponse = z.infer<typeof mediaPublishingIntegrationResponse>;

/** Request body for `PATCH /api/v1/integrations/media-publishing`. */
export const mediaPublishingSettingsInput = z.object({ release_local_file: z.boolean() }).strict();
export type MediaPublishingSettingsInput = z.infer<typeof mediaPublishingSettingsInput>;
