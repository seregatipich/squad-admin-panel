import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaSizeLimitExceededError, storeMediaUpload } from '../src/lib/media-storage.js';

/**
 * Regression (#40, #196): `@fastify/multipart` caps a part at
 * `limits.fileSize` by ending the stream early with `file.truncated = true`
 * instead of erroring. `storeMediaUpload` counted bytes against the same
 * limit, so its size check could never fire and a cut-off video was stored
 * and answered 201. These tests drive the real multipart parser.
 */

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOUNDARY = '----media-storage-test';

function multipartBody(file: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

let baseDir: string;
let app: FastifyInstance;

async function buildApp(fileSizeLimit: number): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(multipart, { limits: { fileSize: fileSizeLimit, files: 1 } });
  instance.post('/upload', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'missing_file' });
    try {
      const stored = await storeMediaUpload({
        baseDir,
        id: 'upload',
        mimeType: 'image/png',
        source: part.file,
      });
      return reply.code(201).send({ size_bytes: stored.sizeBytes });
    } catch (err) {
      if (err instanceof MediaSizeLimitExceededError) {
        return reply.code(413).send({ error: 'file_too_large' });
      }
      throw err;
    }
  });
  return instance;
}

async function storedFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(baseDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(entry.name);
  }
  return out;
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'media-storage-test-'));
});

afterEach(async () => {
  await app?.close();
  await rm(baseDir, { recursive: true, force: true });
});

describe('storeMediaUpload behind @fastify/multipart', () => {
  it('rejects a part the parser truncated at limits.fileSize and removes the partial file', async () => {
    app = await buildApp(64);
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(Buffer.concat([PNG_HEADER, Buffer.alloc(200, 1)])),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file_too_large' });
    expect(await storedFiles()).toEqual([]);
  });

  it('stores a part that fits within limits.fileSize', async () => {
    app = await buildApp(64);
    const file = Buffer.concat([PNG_HEADER, Buffer.alloc(40, 1)]);
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(file),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ size_bytes: file.length });
    expect(await storedFiles()).toEqual(['upload.png']);
  });

  it('accepts a part exactly at limits.fileSize', async () => {
    app = await buildApp(64);
    const file = Buffer.concat([PNG_HEADER, Buffer.alloc(56, 1)]);
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(file),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ size_bytes: 64 });
  });
});
