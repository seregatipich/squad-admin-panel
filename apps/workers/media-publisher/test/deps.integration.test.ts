import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDatabaseClient,
  mediaFiles,
  mediaPublications,
  mediaPublishSettings,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMediaPublisherDeps, type MediaPublisherDepsOptions } from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const NOW = new Date('2026-07-27T12:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 3_600_000);

let mediaBaseDir: string;
const createdMediaIds: string[] = [];

function requireDb() {
  if (!db) throw new Error('DATABASE_URL is required for this test');
  return db;
}

/** Writes a real file under the temp media dir and inserts the matching `media_files` row. */
async function insertStoredMedia(opts: { storagePath: string; sha256?: string }): Promise<string> {
  const id = randomUUID();
  const absolute = path.join(mediaBaseDir, opts.storagePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'fake-video-bytes');
  await requireDb()
    .insert(mediaFiles)
    .values({
      id,
      kind: 'video',
      originalFilename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 16,
      sha256: opts.sha256 ?? randomUUID().replace(/-/g, ''),
      storagePath: opts.storagePath,
      externalUrl: null,
    });
  createdMediaIds.push(id);
  return id;
}

async function insertPublication(opts: {
  mediaId: string;
  destination?: 'youtube' | 'telegram';
  status?: string;
  attempts?: number;
  nextAttemptAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await requireDb()
    .insert(mediaPublications)
    .values({
      id,
      mediaId: opts.mediaId,
      destination: opts.destination ?? 'telegram',
      status: opts.status ?? 'queued',
      attempts: opts.attempts ?? 0,
      nextAttemptAt: opts.nextAttemptAt === undefined ? PAST : opts.nextAttemptAt,
    });
  return id;
}

async function readPublication(id: string) {
  const rows = await requireDb()
    .select()
    .from(mediaPublications)
    .where(eq(mediaPublications.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`publication ${id} vanished`);
  return row;
}

async function readMedia(id: string) {
  const rows = await requireDb().select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`media ${id} vanished`);
  return row;
}

async function setReleaseLocalFile(enabled: boolean): Promise<void> {
  await requireDb()
    .insert(mediaPublishSettings)
    .values({ id: 1, releaseLocalFile: enabled })
    .onConflictDoUpdate({
      target: mediaPublishSettings.id,
      set: { releaseLocalFile: enabled },
    });
}

function makeDeps(overrides: Partial<MediaPublisherDepsOptions> = {}) {
  return createMediaPublisherDeps(requireDb(), { mediaBaseDir, env: {}, ...overrides });
}

beforeEach(async () => {
  if (!db) return;
  mediaBaseDir = mkdtempSync(path.join(tmpdir(), 'media-publisher-test-'));
  for (const id of createdMediaIds.splice(0)) {
    await db.delete(mediaFiles).where(eq(mediaFiles.id, id));
  }
});

afterAll(async () => {
  if (!db) return;
  for (const id of createdMediaIds.splice(0)) {
    await db.delete(mediaFiles).where(eq(mediaFiles.id, id));
  }
  if (mediaBaseDir) rmSync(mediaBaseDir, { recursive: true, force: true });
});

describeIfDb('createMediaPublisherDeps — claimDue', () => {
  it('claims a due queued publication and flips it to uploading', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/a.mp4' });
    const pubId = await insertPublication({ mediaId });

    const claimed = await makeDeps().claimDue(NOW, 10);

    const mine = claimed.filter((j) => j.id === pubId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      mediaId,
      destination: 'telegram',
      attempts: 0,
      storagePath: '2026/07/a.mp4',
      mimeType: 'video/mp4',
      originalFilename: 'clip.mp4',
    });
    expect((await readPublication(pubId)).status).toBe('uploading');
  });

  it('does not claim a publication whose backoff has not elapsed', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/b.mp4' });
    const pubId = await insertPublication({ mediaId, nextAttemptAt: FUTURE });

    const claimed = await makeDeps().claimDue(NOW, 10);

    expect(claimed.map((j) => j.id)).not.toContain(pubId);
    expect((await readPublication(pubId)).status).toBe('queued');
  });

  it('does not re-claim a publication already in a terminal state', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/c.mp4' });
    const published = await insertPublication({ mediaId, status: 'published' });
    const failed = await insertPublication({
      mediaId,
      destination: 'youtube',
      status: 'failed',
    });

    const claimed = await makeDeps().claimDue(NOW, 10);

    const ids = claimed.map((j) => j.id);
    expect(ids).not.toContain(published);
    expect(ids).not.toContain(failed);
  });

  it('does not claim a publication whose media file was soft-deleted', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/d.mp4' });
    await requireDb()
      .update(mediaFiles)
      .set({ deletedAt: new Date() })
      .where(eq(mediaFiles.id, mediaId));
    const pubId = await insertPublication({ mediaId });

    const claimed = await makeDeps().claimDue(NOW, 10);

    expect(claimed.map((j) => j.id)).not.toContain(pubId);
  });

  it('never hands the same publication to two concurrent claims', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/e.mp4' });
    const pubId = await insertPublication({ mediaId });

    const deps = makeDeps();
    const [first, second] = await Promise.all([deps.claimDue(NOW, 10), deps.claimDue(NOW, 10)]);

    const wins =
      first.filter((j) => j.id === pubId).length + second.filter((j) => j.id === pubId).length;
    expect(wins).toBe(1);
  });
});

describeIfDb('createMediaPublisherDeps — status transitions', () => {
  it('markPublished stores the external identifiers and clears the retry state', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/f.mp4' });
    const pubId = await insertPublication({ mediaId, status: 'uploading' });

    await makeDeps().markPublished(
      pubId,
      { externalId: 'yt-1', externalUrl: 'https://youtu.be/yt-1' },
      NOW,
    );

    expect(await readPublication(pubId)).toMatchObject({
      status: 'published',
      externalId: 'yt-1',
      externalUrl: 'https://youtu.be/yt-1',
      error: null,
      nextAttemptAt: null,
    });
  });

  it('markRetry returns the job to the queue with the new attempt count and schedule', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/g.mp4' });
    const pubId = await insertPublication({ mediaId, status: 'uploading', attempts: 1 });

    await makeDeps().markRetry(pubId, {
      attempts: 2,
      error: 'telegram_5xx',
      nextAttemptAt: FUTURE,
    });

    const row = await readPublication(pubId);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2);
    expect(row.error).toBe('telegram_5xx');
    expect(row.nextAttemptAt?.getTime()).toBe(FUTURE.getTime());
  });

  it('markFailed puts the job in the terminal failed state', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/h.mp4' });
    const pubId = await insertPublication({ mediaId, status: 'uploading', attempts: 7 });

    await makeDeps().markFailed(pubId, 'telegram_file_too_large', 8);

    expect(await readPublication(pubId)).toMatchObject({
      status: 'failed',
      attempts: 8,
      error: 'telegram_file_too_large',
      nextAttemptAt: null,
    });
  });

  it('deferUnconfigured requeues without consuming an attempt', async () => {
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/i.mp4' });
    const pubId = await insertPublication({ mediaId, status: 'uploading', attempts: 3 });

    await makeDeps().deferUnconfigured(pubId, FUTURE);

    const row = await readPublication(pubId);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(3);
    expect(row.error).toBe('destination_not_configured');
    expect(row.nextAttemptAt?.getTime()).toBe(FUTURE.getTime());
  });
});

describeIfDb('createMediaPublisherDeps — releaseIfEnabled', () => {
  async function claimedJob(mediaId: string, pubId: string) {
    const jobs = await makeDeps().claimDue(NOW, 50);
    const job = jobs.find((j) => j.id === pubId);
    if (!job) throw new Error(`publication ${pubId} was not claimed (media ${mediaId})`);
    return job;
  }

  it('does nothing when the release setting is disabled', async () => {
    await setReleaseLocalFile(false);
    const mediaId = await insertStoredMedia({ storagePath: '2026/07/j.mp4' });
    const pubId = await insertPublication({ mediaId });
    const job = await claimedJob(mediaId, pubId);
    await makeDeps().markPublished(pubId, { externalId: 'x', externalUrl: 'https://y/1' }, NOW);

    const released = await makeDeps().releaseIfEnabled(job, 'https://y/1');

    expect(released).toBe(false);
    expect((await readMedia(mediaId)).storagePath).toBe('2026/07/j.mp4');
  });

  it('atomically swaps storage_path for external_url without breaking the location CHECK', async () => {
    await setReleaseLocalFile(true);
    const storagePath = '2026/07/k.mp4';
    const mediaId = await insertStoredMedia({ storagePath });
    const pubId = await insertPublication({ mediaId });
    const job = await claimedJob(mediaId, pubId);
    await makeDeps().markPublished(pubId, { externalId: 'x', externalUrl: 'https://y/2' }, NOW);

    const released = await makeDeps().releaseIfEnabled(job, 'https://y/2');

    expect(released).toBe(true);
    const media = await readMedia(mediaId);
    expect(media.storagePath).toBeNull();
    expect(media.externalUrl).toBe('https://y/2');
    expect(existsSync(path.join(mediaBaseDir, storagePath))).toBe(false);
  });

  it('refuses to release while another publication of the same media is still pending', async () => {
    await setReleaseLocalFile(true);
    const storagePath = '2026/07/l.mp4';
    const mediaId = await insertStoredMedia({ storagePath });
    const pubId = await insertPublication({ mediaId, destination: 'telegram' });
    await insertPublication({ mediaId, destination: 'youtube', status: 'queued' });
    const job = await claimedJob(mediaId, pubId);
    await makeDeps().markPublished(pubId, { externalId: 'x', externalUrl: 'https://y/3' }, NOW);

    const released = await makeDeps().releaseIfEnabled(job, 'https://y/3');

    expect(released).toBe(false);
    expect((await readMedia(mediaId)).storagePath).toBe(storagePath);
    expect(existsSync(path.join(mediaBaseDir, storagePath))).toBe(true);
  });

  it('refuses to release a file that a second media row still points at (sha256 dedup)', async () => {
    await setReleaseLocalFile(true);
    const storagePath = '2026/07/m.mp4';
    const sha256 = randomUUID().replace(/-/g, '');
    const mediaId = await insertStoredMedia({ storagePath, sha256 });
    await insertStoredMedia({ storagePath, sha256 });
    const pubId = await insertPublication({ mediaId });
    const job = await claimedJob(mediaId, pubId);
    await makeDeps().markPublished(pubId, { externalId: 'x', externalUrl: 'https://y/4' }, NOW);

    const released = await makeDeps().releaseIfEnabled(job, 'https://y/4');

    expect(released).toBe(false);
    expect((await readMedia(mediaId)).storagePath).toBe(storagePath);
    expect(existsSync(path.join(mediaBaseDir, storagePath))).toBe(true);
  });

  it('refuses to release when the destination produced no external url to fall back on', async () => {
    await setReleaseLocalFile(true);
    const storagePath = '2026/07/n.mp4';
    const mediaId = await insertStoredMedia({ storagePath });
    const pubId = await insertPublication({ mediaId });
    const job = await claimedJob(mediaId, pubId);

    const released = await makeDeps().releaseIfEnabled(job, null);

    expect(released).toBe(false);
    expect((await readMedia(mediaId)).storagePath).toBe(storagePath);
  });
});

describeIfDb('createMediaPublisherDeps — publisher wiring', () => {
  it('exposes no publishers when no third-party credentials are configured', () => {
    const deps = makeDeps({ env: {} });
    expect(deps.publishers.telegram).toBeUndefined();
    expect(deps.publishers.youtube).toBeUndefined();
  });

  it('builds a telegram publisher once its bot token and chat id are present', () => {
    const deps = makeDeps({
      env: { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-1001' },
    });
    expect(deps.publishers.telegram).toBeTypeOf('function');
    expect(deps.publishers.youtube).toBeUndefined();
  });

  it('builds a youtube publisher only when the full OAuth triple is present', () => {
    const partial = makeDeps({
      env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b' },
    });
    expect(partial.publishers.youtube).toBeUndefined();

    const full = makeDeps({
      env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' },
    });
    expect(full.publishers.youtube).toBeTypeOf('function');
  });
});
