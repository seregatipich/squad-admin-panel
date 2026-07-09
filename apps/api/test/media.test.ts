import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { mediaFiles, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches, invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(830000);
const NO_PANEL_STEAM = testSteamId(830001);
const OTHER_UPLOADER_STEAM = testSteamId(830002);
const MEDIA_MANAGER_STEAM = testSteamId(830003);
const PLAIN_PANEL_USER_STEAM = testSteamId(830004);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payloadLength = 64): Buffer {
  const payload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) payload[i] = i % 256;
  return Buffer.concat([PNG_SIGNATURE, payload]);
}

function mp4Bytes(payloadLength = 2000): Buffer {
  // 4-byte box size (irrelevant to our check) + "ftyp" box type, then a
  // recognisable byte pattern so Range responses can be verified precisely.
  const header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const payload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) payload[i] = i % 256;
  return Buffer.concat([header, payload]);
}

/** Builds a `multipart/form-data` payload with plain fields followed by a single file part. */
function buildMultipartPayload(
  fields: Record<string, string>,
  file: { fieldname: string; filename: string; contentType: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----mediaTestBoundary${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

let h: IntegrationHarness;
let ownerCookie: string;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`no player seeded for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'media-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'MediaOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  const [queuePriority] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'MediaNoPanel',
    canonicalNameNormalized: 'medianopanel',
    roleId: queuePriority?.id ?? null,
  });

  const [plainPanelRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'MediaPlainUserTest',
      panelAccess: true,
      canManageMedia: false,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values([
    {
      steamId64: OTHER_UPLOADER_STEAM,
      canonicalName: 'MediaOtherUploader',
      canonicalNameNormalized: 'mediaotheruploader',
      roleId: plainPanelRole?.id ?? null,
    },
    {
      steamId64: PLAIN_PANEL_USER_STEAM,
      canonicalName: 'MediaPlainUser',
      canonicalNameNormalized: 'mediaplainuser',
      roleId: plainPanelRole?.id ?? null,
    },
  ]);

  const [mediaManagerRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'MediaManagerTest',
      panelAccess: true,
      canManageMedia: true,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: MEDIA_MANAGER_STEAM,
    canonicalName: 'MediaManager',
    canonicalNameNormalized: 'mediamanager',
    roleId: mediaManagerRole?.id ?? null,
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

describe('POST /api/v1/media', () => {
  it('rejects unauthenticated uploads with 401', async () => {
    const { body, contentType } = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'a.png', contentType: 'image/png', content: pngBytes() },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects uploads from users without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const { body, contentType } = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'a.png', contentType: 'image/png', content: pngBytes() },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('stores a valid PNG upload, writes a row + file on disk, and audit-logs the upload', async () => {
    const content = pngBytes(128);
    const { body, contentType } = buildMultipartPayload(
      { title: 'Alpha screenshot', description: 'A test screenshot' },
      { fieldname: 'file', filename: 'alpha.png', contentType: 'image/png', content },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie: ownerCookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.kind).toBe('image');
    expect(json.mime_type).toBe('image/png');
    expect(json.size_bytes).toBe(content.length);
    expect(json.title).toBe('Alpha screenshot');
    expect(json.description).toBe('A test screenshot');
    expect(json.uploader_player_id).toBe(h.seed.ownerPlayerId);

    const [row] = await h.db.select().from(mediaFiles).where(eq(mediaFiles.id, json.id)).limit(1);
    expect(row).toBeDefined();
    expect(row?.storagePath).toBeTruthy();
    const absolutePath = path.join(h.mediaDir, row?.storagePath ?? '');
    const dirFiles = readdirSync(path.dirname(absolutePath));
    expect(dirFiles).toContain(path.basename(absolutePath));

    await assertAuditRow(h, { action: 'media.upload', resource: 'media_file', targetId: json.id });
  });

  it('rejects a file whose bytes do not match the declared mime type', async () => {
    const wrongContent = Buffer.concat([Buffer.from('not-a-png-header-'), Buffer.alloc(32, 7)]);
    const { body, contentType } = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'fake.png', contentType: 'image/png', content: wrongContent },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie: ownerCookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'magic_byte_mismatch' });
  });

  it('dedups identical bytes by sha256 instead of storing them twice', async () => {
    const content = pngBytes(96);

    const first = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'one.png', contentType: 'image/png', content },
    );
    const res1 = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie: ownerCookie, 'content-type': first.contentType },
      payload: first.body,
    });
    expect(res1.statusCode).toBe(201);
    const id1 = res1.json().id as string;

    const second = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'two.png', contentType: 'image/png', content },
    );
    const res2 = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie: ownerCookie, 'content-type': second.contentType },
      payload: second.body,
    });
    expect(res2.statusCode).toBe(201);
    const id2 = res2.json().id as string;

    expect(id2).not.toBe(id1);

    const rows = await h.db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.sha256, res1.json().sha256));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.storagePath).toBe(rows[1]?.storagePath);

    const absolutePath = path.join(h.mediaDir, rows[0]?.storagePath ?? '');
    const dirFiles = readdirSync(path.dirname(absolutePath));
    const matching = dirFiles.filter((f) => f === path.basename(absolutePath));
    expect(matching).toHaveLength(1);
  });
});

describe('POST /api/v1/media/link', () => {
  it('registers a valid external URL', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/link',
      headers: { cookie: ownerCookie },
      payload: {
        external_url: 'https://clips.example.com/watch?v=abc123',
        title: 'Great clip',
      },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.kind).toBe('external_link');
    expect(json.external_url).toBe('https://clips.example.com/watch?v=abc123');
    expect(json.title).toBe('Great clip');

    await assertAuditRow(h, {
      action: 'media.link.create',
      resource: 'media_file',
      targetId: json.id,
    });
  });

  it('rejects an invalid URL with a validation error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/link',
      headers: { cookie: ownerCookie },
      payload: { external_url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/media/:id and /stream', () => {
  async function uploadVideo(cookie: string, content: Buffer): Promise<string> {
    const { body, contentType } = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'clip.mp4', contentType: 'video/mp4', content },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('returns metadata for a stored file', async () => {
    const id = await uploadVideo(ownerCookie, mp4Bytes(500));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('video');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${randomUUID()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('streams the full file with 200 when no Range header is sent', async () => {
    const content = mp4Bytes(1000);
    const id = await uploadVideo(ownerCookie, content);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${id}/stream`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(Number(res.headers['content-length'])).toBe(content.length);
    expect(res.rawPayload).toEqual(content);
  });

  it('streams a byte range with 206 and a correct Content-Range', async () => {
    const content = mp4Bytes(1000);
    const id = await uploadVideo(ownerCookie, content);
    const start = 100;
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${id}/stream`,
      headers: { cookie: ownerCookie, range: `bytes=${start}-` },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(
      `bytes ${start}-${content.length - 1}/${content.length}`,
    );
    expect(Number(res.headers['content-length'])).toBe(content.length - start);
    expect(res.rawPayload).toEqual(content.subarray(start));
  });
});

describe('DELETE /api/v1/media/:id', () => {
  async function uploadAs(cookie: string): Promise<string> {
    const { body, contentType } = buildMultipartPayload(
      {},
      { fieldname: 'file', filename: 'own.png', contentType: 'image/png', content: pngBytes(48) },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { cookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('lets the uploader soft-delete their own file', async () => {
    const otherCookie = await loginAsSteam(OTHER_UPLOADER_STEAM);
    const id = await uploadAs(otherCookie);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${id}`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await h.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);
    expect(row?.deletedAt).not.toBeNull();

    await assertAuditRow(h, { action: 'media.delete', resource: 'media_file', targetId: id });
  });

  it("forbids deleting another user's file without can_manage_media", async () => {
    const otherCookie = await loginAsSteam(OTHER_UPLOADER_STEAM);
    const id = await uploadAs(otherCookie);

    const plainPanelCookie = await loginAsSteam(PLAIN_PANEL_USER_STEAM);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${id}`,
      headers: { cookie: plainPanelCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_media' });

    const [row] = await h.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);
    expect(row?.deletedAt).toBeNull();
  });

  it("lets a user with can_manage_media delete someone else's file", async () => {
    const otherCookie = await loginAsSteam(OTHER_UPLOADER_STEAM);
    const id = await uploadAs(otherCookie);
    const managerCookie = await loginAsSteam(MEDIA_MANAGER_STEAM);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${id}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await h.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('returns 404 for an already-deleted file', async () => {
    const id = await uploadAs(ownerCookie);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${id}`,
      headers: { cookie: ownerCookie },
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
