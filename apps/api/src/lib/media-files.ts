import { rm } from 'node:fs/promises';
import type { DatabaseClient } from '@squad/db';
import { type MediaFileRow, mediaFiles, type NewMediaFile } from '@squad/db/schema';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { resolveMediaPath, type StoredMediaFile } from './media-storage.js';

/**
 * First key of the per-`storage_path` advisory lock. Every writer that makes a
 * row point at stored bytes, or decides those bytes are unreferenced, holds
 * `pg_advisory_xact_lock(hashtext(MEDIA_STORAGE_LOCK), hashtext(storage_path))`:
 * the upload dedup here, {@link softDeleteMedia}, and worker-media-publisher's
 * `releaseIfEnabled`. The key is duplicated there by value (workers share no
 * code), so both sides must change together.
 */
export const MEDIA_STORAGE_LOCK = 'media_storage_path';

type MediaTx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

async function lockStoragePath(tx: MediaTx, storagePath: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${MEDIA_STORAGE_LOCK}), hashtext(${storagePath}))`,
  );
}

/** True while an active (not soft-deleted) row other than `exceptId` references `storagePath`. */
async function storagePathInUse(
  tx: MediaTx,
  storagePath: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.storagePath, storagePath),
        isNull(mediaFiles.deletedAt),
        exceptId ? ne(mediaFiles.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Records freshly stored upload bytes as a `media_files` row, reusing the
 * bytes of an active row with the same SHA-256 instead of keeping a second
 * copy on disk.
 *
 * The dedup candidate is re-checked under its storage-path lock, so a
 * concurrent release (worker-media-publisher) or delete of that row cannot
 * remove the file the new row is about to reference. The just-written file is
 * removed only after the insert commits (dedup) or when the insert fails, so
 * no path leaves bytes on disk that no row references.
 *
 * @param db - Database client.
 * @param baseDir - `MEDIA_STORAGE_DIR` the upload was written under.
 * @param stored - Result of `storeMediaUpload` for this upload.
 * @param values - Row columns other than the storage/hash/size fields.
 * @returns The inserted row and whether it reuses another row's bytes.
 * @throws Whatever the insert throws, after removing the uploaded file.
 */
export async function insertUploadedMedia(
  db: DatabaseClient,
  baseDir: string,
  stored: StoredMediaFile,
  values: Omit<NewMediaFile, 'storagePath' | 'sha256' | 'sizeBytes'>,
): Promise<{ row: MediaFileRow; deduped: boolean }> {
  let result: { row: MediaFileRow; deduped: boolean };
  try {
    result = await db.transaction(async (tx) => {
      const candidates = await tx
        .select({ storagePath: mediaFiles.storagePath })
        .from(mediaFiles)
        .where(
          and(
            eq(mediaFiles.sha256, stored.sha256),
            isNull(mediaFiles.deletedAt),
            isNotNull(mediaFiles.storagePath),
          ),
        )
        .limit(1);
      let dedupPath = candidates[0]?.storagePath ?? null;
      if (dedupPath) {
        await lockStoragePath(tx, dedupPath);
        if (!(await storagePathInUse(tx, dedupPath))) dedupPath = null;
      }
      const inserted = await tx
        .insert(mediaFiles)
        .values({
          ...values,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          storagePath: dedupPath ?? stored.relativePath,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('media_files insert returned no row');
      return { row, deduped: dedupPath !== null };
    });
  } catch (err) {
    await rm(stored.absolutePath, { force: true });
    throw err;
  }
  if (result.deduped) await rm(resolveMediaPath(baseDir, stored.relativePath), { force: true });
  return result;
}

/**
 * Soft-deletes a media row and frees its bytes when no other active row
 * still references them (dedup shares one file between rows).
 *
 * @param db - Database client.
 * @param baseDir - `MEDIA_STORAGE_DIR`.
 * @param row - The active row to delete.
 * @returns Whether the file on disk was removed.
 */
export async function softDeleteMedia(
  db: DatabaseClient,
  baseDir: string,
  row: Pick<MediaFileRow, 'id' | 'storagePath'>,
): Promise<boolean> {
  const { storagePath } = row;
  const releasable = await db.transaction(async (tx) => {
    if (storagePath) await lockStoragePath(tx, storagePath);
    await tx.update(mediaFiles).set({ deletedAt: new Date() }).where(eq(mediaFiles.id, row.id));
    if (!storagePath) return false;
    return !(await storagePathInUse(tx, storagePath, row.id));
  });
  if (!releasable || !storagePath) return false;
  // The database no longer references the bytes; a missing file is fine.
  await rm(resolveMediaPath(baseDir, storagePath), { force: true });
  return true;
}
