import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { MediaUploadMimeType } from '@squad/shared-types';

/** Hard cap on a single media upload, in bytes. Resumable/chunked upload is out of scope for VIDEO-1. */
export const MEDIA_MAX_UPLOAD_BYTES = 2 * 1024 ** 3; // 2 GiB

const MIME_EXTENSIONS: Record<MediaUploadMimeType, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const MAGIC_BYTE_CHECK_LENGTH = 12;

/** Thrown when an uploaded stream exceeds `MEDIA_MAX_UPLOAD_BYTES` (or a caller-supplied cap). */
export class MediaSizeLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`upload exceeds the ${maxBytes}-byte size limit`);
    this.name = 'MediaSizeLimitExceededError';
  }
}

/** Thrown when the first bytes of an uploaded stream don't match the declared MIME type's file signature. */
export class MediaMagicByteMismatchError extends Error {
  constructor(mimeType: string) {
    super(`file contents do not match the declared mime type ${mimeType}`);
    this.name = 'MediaMagicByteMismatchError';
  }
}

/**
 * Checks the leading bytes of a file against the magic-byte signature for
 * `mimeType`. Guards against a client lying about `Content-Type` (or a
 * corrupted upload) for the four allowlisted formats.
 */
export function matchesMagicBytes(mimeType: MediaUploadMimeType, header: Buffer): boolean {
  switch (mimeType) {
    case 'image/png':
      return (
        header.length >= 8 &&
        header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/jpeg':
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'video/webm':
      return (
        header.length >= 4 &&
        header[0] === 0x1a &&
        header[1] === 0x45 &&
        header[2] === 0xdf &&
        header[3] === 0xa3
      );
    case 'video/mp4':
      // An MP4/ISO-BMFF file starts with a 4-byte box size followed by the
      // ASCII box type "ftyp" at bytes 4-8.
      return header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp';
    default:
      return false;
  }
}

export interface StoredMediaFile {
  /** Path relative to `baseDir`, e.g. `2026/07/<uuid>.mp4`. Persisted as `media_files.storage_path`. */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Streams an upload to `<baseDir>/<yyyy>/<mm>/<id><ext>`, computing its SHA-256
 * and size incrementally and validating its magic bytes against `mimeType`.
 *
 * On a size-limit breach or magic-byte mismatch, the partially-written file is
 * removed and the corresponding error is thrown after the source stream has
 * been fully drained (so the caller's multipart parser doesn't hang waiting
 * for more of a part we've already decided to reject).
 */
export async function storeMediaUpload(params: {
  baseDir: string;
  id: string;
  mimeType: MediaUploadMimeType;
  source: AsyncIterable<Buffer>;
  maxBytes?: number;
  now?: Date;
}): Promise<StoredMediaFile> {
  const maxBytes = params.maxBytes ?? MEDIA_MAX_UPLOAD_BYTES;
  const now = params.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const extension = MIME_EXTENSIONS[params.mimeType];
  const relativePath = path.posix.join(yyyy, mm, `${params.id}${extension}`);
  const absolutePath = path.join(params.baseDir, yyyy, mm, `${params.id}${extension}`);

  await mkdir(path.dirname(absolutePath), { recursive: true });

  const hash = createHash('sha256');
  const writeStream = createWriteStream(absolutePath);
  let sizeBytes = 0;
  let headerBuf = Buffer.alloc(0);
  let headerChecked = false;
  let rejection: Error | null = null;

  for await (const chunk of params.source) {
    sizeBytes += chunk.length;
    if (rejection) continue; // drain the rest of the part without further processing

    if (sizeBytes > maxBytes) {
      rejection = new MediaSizeLimitExceededError(maxBytes);
      continue;
    }

    if (!headerChecked) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length >= MAGIC_BYTE_CHECK_LENGTH) {
        headerChecked = true;
        if (!matchesMagicBytes(params.mimeType, headerBuf)) {
          rejection = new MediaMagicByteMismatchError(params.mimeType);
          continue;
        }
      }
    }

    hash.update(chunk);
    if (!writeStream.write(chunk)) {
      await new Promise<void>((resolve) => writeStream.once('drain', resolve));
    }
  }

  if (!rejection && !headerChecked && !matchesMagicBytes(params.mimeType, headerBuf)) {
    rejection = new MediaMagicByteMismatchError(params.mimeType);
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  if (rejection) {
    await rm(absolutePath, { force: true });
    throw rejection;
  }

  return { relativePath, absolutePath, sizeBytes, sha256: hash.digest('hex') };
}

/** Resolves a stored `media_files.storage_path` to an absolute path under `baseDir`. */
export function resolveMediaPath(baseDir: string, relativePath: string): string {
  return path.join(baseDir, relativePath);
}
