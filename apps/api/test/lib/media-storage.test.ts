import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeMediaUpload } from '../../src/lib/media-storage.js';

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const NOW = new Date('2026-07-15T00:00:00Z');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe('storeMediaUpload stream failure handling (#37)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'media-storage-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('removes the partial file and rejects when the source aborts mid-upload', async () => {
    const aborted = new Error('premature close');
    async function* abortingSource(): AsyncGenerator<Buffer> {
      yield PNG_HEADER;
      yield Buffer.alloc(64 * 1024, 1);
      throw aborted;
    }

    await expect(
      storeMediaUpload({
        baseDir,
        id: 'aborted',
        mimeType: 'image/png',
        source: abortingSource(),
        now: NOW,
      }),
    ).rejects.toBe(aborted);

    expect(await listFiles(baseDir)).toEqual([]);
  });

  it('rejects instead of crashing when the destination cannot be written', async () => {
    // A directory already sitting at the target path makes open() fail with
    // EISDIR, the same unhandled WriteStream 'error' path as ENOSPC/EACCES.
    await mkdir(path.join(baseDir, '2026', '07', 'blocked.png'), { recursive: true });
    async function* source(): AsyncGenerator<Buffer> {
      yield PNG_HEADER;
      yield Buffer.alloc(1024, 1);
    }

    await expect(
      storeMediaUpload({
        baseDir,
        id: 'blocked',
        mimeType: 'image/png',
        source: source(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'EISDIR' });

    expect((await stat(path.join(baseDir, '2026', '07', 'blocked.png'))).isDirectory()).toBe(true);
  });

  it('still stores a well-formed upload', async () => {
    async function* source(): AsyncGenerator<Buffer> {
      yield PNG_HEADER;
      yield Buffer.alloc(1024, 1);
    }

    const stored = await storeMediaUpload({
      baseDir,
      id: 'ok',
      mimeType: 'image/png',
      source: source(),
      now: NOW,
    });

    expect(stored.relativePath).toBe('2026/07/ok.png');
    expect(stored.sizeBytes).toBe(PNG_HEADER.length + 1024);
    expect(await listFiles(baseDir)).toEqual(['ok.png']);
  });
});
