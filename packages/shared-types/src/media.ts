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

/** Response shape for a single media file/link row. */
export const mediaFileResponse = z
  .object({
    id: z.string().uuid(),
    uploader_player_id: z.string().uuid().nullable(),
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
