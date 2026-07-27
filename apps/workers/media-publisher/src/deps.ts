import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseClient } from '@squad/db';
import { mediaFiles, mediaPublications, mediaPublishSettings } from '@squad/db/schema';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { createTelegramPublisher } from './publishers/telegram.js';
import { createYouTubePublisher } from './publishers/youtube.js';
import type {
  MediaPublicationDestination,
  MediaPublicationJob,
  MediaPublisher,
  MediaPublisherTickDeps,
} from './tick.js';

/** Environment slice carrying the third-party publishing credentials. */
export interface MediaPublisherEnv {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REFRESH_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface MediaPublisherDepsOptions {
  mediaBaseDir: string;
  env?: MediaPublisherEnv;
  fetch?: typeof fetch;
  readMedia?: (absolutePath: string) => Promise<Uint8Array>;
  removeFile?: (absolutePath: string) => Promise<void>;
}

/** The DB/IO half of the tick's dependencies — everything except `diag` and the clock. */
export type MediaPublisherRuntimeDeps = Omit<MediaPublisherTickDeps, 'diag' | 'now' | 'batchSize'>;

/** Raw row shape of the claim statement, in snake_case as Postgres returns it. */
interface ClaimedRow {
  id: string;
  media_id: string;
  destination: string;
  attempts: number;
  storage_path: string | null;
  mime_type: string;
  size_bytes: string | number;
  title: string | null;
  description: string | null;
  original_filename: string;
}

export function createMediaPublisherDeps(
  db: DatabaseClient,
  options: MediaPublisherDepsOptions,
): MediaPublisherRuntimeDeps {
  const env = options.env ?? {};
  const removeFile =
    options.removeFile ?? ((absolutePath: string) => rm(absolutePath, { force: true }));

  const publishers: Partial<Record<MediaPublicationDestination, MediaPublisher>> = {};
  const telegram = createTelegramPublisher({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    mediaBaseDir: options.mediaBaseDir,
    fetch: options.fetch,
    readMedia: options.readMedia,
  });
  if (telegram) publishers.telegram = telegram;
  const youtube = createYouTubePublisher({
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN,
    mediaBaseDir: options.mediaBaseDir,
    fetch: options.fetch,
    readMedia: options.readMedia,
  });
  if (youtube) publishers.youtube = youtube;

  return {
    publishers,

    /**
     * Claims due publications in a single statement.
     *
     * `FOR UPDATE ... SKIP LOCKED` inside the CTE plus the `status = 'queued'`
     * re-check on the UPDATE is what makes a second worker (or a second tick
     * overlapping a slow one) unable to pick up the same row: whichever
     * statement gets the lock flips the status, and the other either skips the
     * locked row or finds it no longer queued.
     */
    async claimDue(now: Date, limit: number): Promise<MediaPublicationJob[]> {
      const rows = (await db.execute(sql`
        WITH due AS (
          SELECT p.id
          FROM media_publications p
          JOIN media_files m ON m.id = p.media_id
          WHERE p.status = 'queued'
            AND p.next_attempt_at IS NOT NULL
            AND p.next_attempt_at <= ${now.toISOString()}::timestamptz
            AND m.deleted_at IS NULL
          ORDER BY p.next_attempt_at ASC
          LIMIT ${limit}
          FOR UPDATE OF p SKIP LOCKED
        )
        UPDATE media_publications p
        SET status = 'uploading', updated_at = now()
        FROM due, media_files m
        WHERE p.id = due.id
          AND m.id = p.media_id
          AND p.status = 'queued'
        RETURNING
          p.id,
          p.media_id,
          p.destination,
          p.attempts,
          m.storage_path,
          m.mime_type,
          m.size_bytes,
          m.title,
          m.description,
          m.original_filename
      `)) as unknown as ClaimedRow[];

      return rows.map((row) => ({
        id: row.id,
        mediaId: row.media_id,
        destination: row.destination as MediaPublicationDestination,
        attempts: Number(row.attempts),
        storagePath: row.storage_path,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        title: row.title,
        description: row.description,
        originalFilename: row.original_filename,
      }));
    },

    async markPublished(id, result, now) {
      await db
        .update(mediaPublications)
        .set({
          status: 'published',
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          error: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(mediaPublications.id, id));
    },

    async markRetry(id, patch) {
      await db
        .update(mediaPublications)
        .set({
          status: 'queued',
          attempts: patch.attempts,
          error: patch.error,
          nextAttemptAt: patch.nextAttemptAt,
          updatedAt: new Date(),
        })
        .where(eq(mediaPublications.id, id));
    },

    async markFailed(id, error, attempts) {
      await db
        .update(mediaPublications)
        .set({
          status: 'failed',
          attempts,
          error,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(mediaPublications.id, id));
    },

    /**
     * Returns a job to the queue because its destination has no credentials.
     * Deliberately leaves `attempts` alone: a destination nobody configured is
     * not a failing job, and burning its retry budget would eventually mark it
     * `failed` for an operator's omission.
     */
    async deferUnconfigured(id, nextAttemptAt) {
      await db
        .update(mediaPublications)
        .set({
          status: 'queued',
          error: 'destination_not_configured',
          nextAttemptAt,
          updatedAt: new Date(),
        })
        .where(eq(mediaPublications.id, id));
    },

    /**
     * Applies the "free the disk after publishing" setting.
     *
     * Three guards must all hold, because each one protects against losing
     * evidence outright:
     *  - the destination produced a real `external_url` to fall back on;
     *  - every other publication of this media has already finished, so a
     *    still-queued destination does not lose the file it was going to upload;
     *  - no second `media_files` row shares this `storage_path` — uploads are
     *    deduplicated by sha256, so one file on disk can back several rows.
     *
     * The swap itself is a single UPDATE: `media_files_exactly_one_location_check`
     * forbids a row holding both or neither location, so clearing
     * `storage_path` and setting `external_url` cannot be two statements.
     */
    async releaseIfEnabled(job: MediaPublicationJob, externalUrl: string | null): Promise<boolean> {
      if (!externalUrl || !job.storagePath) return false;

      const settings = await db
        .select({ releaseLocalFile: mediaPublishSettings.releaseLocalFile })
        .from(mediaPublishSettings)
        .where(eq(mediaPublishSettings.id, 1))
        .limit(1);
      if (!settings[0]?.releaseLocalFile) return false;

      const pending = await db
        .select({ id: mediaPublications.id })
        .from(mediaPublications)
        .where(
          and(
            eq(mediaPublications.mediaId, job.mediaId),
            ne(mediaPublications.id, job.id),
            ne(mediaPublications.status, 'published'),
          ),
        )
        .limit(1);
      if (pending.length > 0) return false;

      const sharing = await db
        .select({ id: mediaFiles.id })
        .from(mediaFiles)
        .where(
          and(
            eq(mediaFiles.storagePath, job.storagePath),
            ne(mediaFiles.id, job.mediaId),
            isNull(mediaFiles.deletedAt),
          ),
        )
        .limit(1);
      if (sharing.length > 0) return false;

      const updated = await db
        .update(mediaFiles)
        .set({ storagePath: null, externalUrl })
        .where(and(eq(mediaFiles.id, job.mediaId), eq(mediaFiles.storagePath, job.storagePath)))
        .returning({ id: mediaFiles.id });
      if (updated.length === 0) return false;

      // The database no longer references the bytes; reclaiming them is best
      // effort, and a missing file must not fail the publication.
      await removeFile(path.join(options.mediaBaseDir, job.storagePath)).catch(() => undefined);
      return true;
    },
  };
}
