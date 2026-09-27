import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaSizeLimitExceededError, storeMediaUpload } from '../src/lib/media-storage.js';

/**
 * #36 finding 38: busboy stops a file part at exactly `limits.fileSize` bytes,
 * sets `file.truncated` and ends the stream without an error. When the
 * multipart cap equals `storeMediaUpload`'s own `maxBytes` (production:
 * both `MEDIA_MAX_UPLOAD_BYTES`), the byte count never exceeds `maxBytes`, so
 * only the truncation flag can reveal the oversize upload. A real Fastify +
 * @fastify/multipart stack with a tiny cap reproduces that without 2 GiB.
 */
const CAP_BYTES = 64;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let app: FastifyInstance;
let baseDir: string;

function pngOfSize(size: number): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 0x61)]);
}

function multipartBody(file: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----truncation-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'squad-media-truncation-'));
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: CAP_BYTES, files: 1 } });
  app.post('/upload', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'file_required' });
    try {
      const stored = await storeMediaUpload({
        baseDir,
        id: 'upload',
        mimeType: 'image/png',
        source: part.file,
        maxBytes: CAP_BYTES,
      });
      return { size_bytes: stored.sizeBytes };
    } catch (err) {
      if (err instanceof MediaSizeLimitExceededError) {
        return reply.code(413).send({ error: 'file_too_large' });
      }
      throw err;
    }
  });
});

afterAll(async () => {
  await app.close();
  rmSync(baseDir, { recursive: true, force: true });
});

function storedFiles(): string[] {
  return readdirSync(baseDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe('storeMediaUpload behind a multipart cap equal to maxBytes', () => {
  it('stores an upload of exactly the cap', async () => {
    const { body, contentType } = multipartBody(pngOfSize(CAP_BYTES));
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ size_bytes: CAP_BYTES });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('rejects an upload one byte over the cap with 413 and keeps no truncated file', async () => {
    const { body, contentType } = multipartBody(pngOfSize(CAP_BYTES + 1));
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file_too_large' });
    expect(storedFiles()).toEqual([]);
  });
});
