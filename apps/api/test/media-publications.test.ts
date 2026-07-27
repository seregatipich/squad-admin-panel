import { randomUUID } from 'node:crypto';
import { mediaFiles, mediaPublications, players, roles } from '@squad/db/schema';
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

const OWNER_STEAM = testSteamId(993000);
const PLAIN_PANEL_STEAM = testSteamId(993001);

const TELEGRAM_BOT_TOKEN = '1234567:AAHfake-telegram-bot-token-value';
const YOUTUBE_REFRESH_TOKEN = '1//0f-fake-refresh-token';

let h: IntegrationHarness;
let ownerCookie: string;
let plainCookie: string;

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
    userAgent: 'media-publications-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

/** Inserts a `media_files` row that has a local file on disk (the publishable kind). */
async function insertStoredMedia(): Promise<string> {
  const id = randomUUID();
  await h.db.insert(mediaFiles).values({
    id,
    uploaderPlayerId: h.seed.ownerPlayerId ?? null,
    kind: 'video',
    originalFilename: `clip-${id}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    sha256: randomUUID().replace(/-/g, ''),
    storagePath: `2026/07/${id}.mp4`,
    externalUrl: null,
    title: 'Нарушение',
    description: null,
  });
  return id;
}

/** Inserts an external-link `media_files` row — nothing local to upload anywhere. */
async function insertExternalMedia(): Promise<string> {
  const id = randomUUID();
  await h.db.insert(mediaFiles).values({
    id,
    uploaderPlayerId: h.seed.ownerPlayerId ?? null,
    kind: 'external_link',
    originalFilename: `https://clips.example.com/${id}`,
    mimeType: 'text/uri-list',
    sizeBytes: 0,
    sha256: randomUUID().replace(/-/g, ''),
    storagePath: null,
    externalUrl: `https://clips.example.com/${id}`,
  });
  return id;
}

/**
 * Flattens an `audit_log` row to a string for secret-leak assertions.
 * Audit rows carry `bigint` columns, which plain `JSON.stringify` refuses.
 */
function stringifyAudit(row: unknown): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function withPublishingCredentials(): void {
  const config = h.app.config as unknown as Record<string, string>;
  config.TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKEN;
  config.TELEGRAM_CHAT_ID = '-1001234567890';
  config.YOUTUBE_CLIENT_ID = 'fake.apps.googleusercontent.com';
  config.YOUTUBE_CLIENT_SECRET = 'GOCSPX-fake-client-secret';
  config.YOUTUBE_REFRESH_TOKEN = YOUTUBE_REFRESH_TOKEN;
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'MediaPubOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  const [plainRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'MediaPublicationsPlainUserTest',
      panelAccess: true,
      canManageMedia: false,
    })
    .returning({ id: roles.id });

  await h.db.insert(players).values({
    steamId64: PLAIN_PANEL_STEAM,
    canonicalName: 'MediaPubPlain',
    canonicalNameNormalized: 'mediapubplain',
    roleId: plainRole?.id ?? null,
  });
  plainCookie = await loginAsSteam(PLAIN_PANEL_STEAM);
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

describe('POST /api/v1/media/:id/publications', () => {
  it('queues a publication per requested destination and returns 201', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram', 'youtube'] },
    });

    expect(res.statusCode).toBe(201);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.destination).sort()).toEqual(['telegram', 'youtube']);
    for (const item of items) {
      expect(item.media_id).toBe(mediaId);
      expect(item.status).toBe('queued');
      expect(item.attempts).toBe(0);
      expect(item.external_id).toBeNull();
      expect(item.external_url).toBeNull();
      expect(item.error).toBeNull();
      expect(typeof item.next_attempt_at).toBe('string');
      expect(item.requested_by_player_id).toBe(h.seed.ownerPlayerId);
    }

    const rows = await h.db
      .select()
      .from(mediaPublications)
      .where(eq(mediaPublications.mediaId, mediaId));
    expect(rows).toHaveLength(2);
  });

  it('returns 403 for a panel user without can_manage_media', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: plainCookie },
      payload: { destinations: ['telegram'] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_media' });
    const rows = await h.db
      .select()
      .from(mediaPublications)
      .where(eq(mediaPublications.mediaId, mediaId));
    expect(rows).toHaveLength(0);
  });

  it('returns 401 without a session', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      payload: { destinations: ['telegram'] },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown media id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${randomUUID()}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram'] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'media_not_found' });
  });

  it('returns 409 when a destination is already queued for that media', async () => {
    const mediaId = await insertStoredMedia();
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram'] },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram', 'youtube'] },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_queued', destinations: ['telegram'] });
    // The whole request is rejected — youtube must not have been queued either.
    const rows = await h.db
      .select()
      .from(mediaPublications)
      .where(eq(mediaPublications.mediaId, mediaId));
    expect(rows).toHaveLength(1);
  });

  it('refuses to publish an external-link media row that has no local file', async () => {
    const mediaId = await insertExternalMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not_a_stored_file' });
  });

  it('rejects an empty destination list', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('writes a media.publish audit row that carries no publishing secrets', async () => {
    withPublishingCredentials();
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram', 'youtube'] },
    });
    expect(res.statusCode).toBe(201);

    const row = await assertAuditRow(h, {
      action: 'media.publish',
      resource: 'media_file',
      targetId: mediaId,
    });
    expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
    const serialized = stringifyAudit(row);
    expect(serialized).not.toContain(TELEGRAM_BOT_TOKEN);
    expect(serialized).not.toContain(YOUTUBE_REFRESH_TOKEN);
    expect(serialized).not.toContain('GOCSPX-fake-client-secret');
  });
});

describe('GET /api/v1/media/:id/publications', () => {
  it('lists the publications of a media file for any panel user', async () => {
    const mediaId = await insertStoredMedia();
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram'] },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: plainCookie },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ destination: 'telegram', status: 'queued' });
  });

  it('surfaces a retrying quota-blocked publication as still queued with a future schedule', async () => {
    const mediaId = await insertStoredMedia();
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['youtube'] },
    });
    const future = new Date(Date.now() + 7 * 3_600_000);
    await h.db
      .update(mediaPublications)
      .set({ error: 'quota_exceeded', nextAttemptAt: future, attempts: 3 })
      .where(eq(mediaPublications.mediaId, mediaId));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const item = (res.json().items as Array<Record<string, unknown>>)[0];
    expect(item?.status).toBe('queued');
    expect(item?.status).not.toBe('failed');
    expect(item?.error).toBe('quota_exceeded');
    expect(new Date(String(item?.next_attempt_at)).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404 for an unknown media id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${randomUUID()}/publications`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without a session', async () => {
    const mediaId = await insertStoredMedia();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/publications`,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/v1/media/:id/publications/:destination', () => {
  async function queueTelegram(mediaId: string): Promise<void> {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/publications`,
      headers: { cookie: ownerCookie },
      payload: { destinations: ['telegram'] },
    });
    expect(res.statusCode).toBe(201);
  }

  it('removes the publication and writes an audit row', async () => {
    const mediaId = await insertStoredMedia();
    await queueTelegram(mediaId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/publications/telegram`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const rows = await h.db
      .select()
      .from(mediaPublications)
      .where(eq(mediaPublications.mediaId, mediaId));
    expect(rows).toHaveLength(0);
    await assertAuditRow(h, {
      action: 'media.publish.delete',
      resource: 'media_file',
      targetId: mediaId,
    });
  });

  it('returns 403 for a panel user without can_manage_media', async () => {
    const mediaId = await insertStoredMedia();
    await queueTelegram(mediaId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/publications/telegram`,
      headers: { cookie: plainCookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_media' });
  });

  it('returns 404 when no publication exists for that destination', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/publications/telegram`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'publication_not_found' });
  });

  it('rejects an unknown destination with 400', async () => {
    const mediaId = await insertStoredMedia();

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/publications/vk`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/integrations/media-publishing', () => {
  it('reports both destinations as unconfigured on a bare deployment', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      youtube_configured: false,
      telegram_configured: false,
      release_local_file: false,
    });
  });

  it('reports a destination as configured once its credentials are present, without echoing them', async () => {
    withPublishingCredentials();

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      youtube_configured: true,
      telegram_configured: true,
      release_local_file: false,
    });
    expect(res.body).not.toContain(TELEGRAM_BOT_TOKEN);
    expect(res.body).not.toContain(YOUTUBE_REFRESH_TOKEN);
    expect(res.body).not.toContain('GOCSPX-fake-client-secret');
  });

  it('treats a partially configured YouTube app as unconfigured', async () => {
    const config = h.app.config as unknown as Record<string, string>;
    config.YOUTUBE_CLIENT_ID = 'fake.apps.googleusercontent.com';
    config.YOUTUBE_CLIENT_SECRET = 'GOCSPX-fake-client-secret';

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
    });

    expect(res.json().youtube_configured).toBe(false);
  });

  it('is readable by any panel user and closed to anonymous callers', async () => {
    const asPlain = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: plainCookie },
    });
    expect(asPlain.statusCode).toBe(200);

    const anonymous = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('PATCH /api/v1/integrations/media-publishing', () => {
  it('persists the release-local-file switch and audits the change', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
      payload: { release_local_file: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().release_local_file).toBe(true);

    const readBack = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
    });
    expect(readBack.json().release_local_file).toBe(true);

    await assertAuditRow(h, { action: 'media.publish.settings.update' });
  });

  it('can switch the release-local-file behaviour back off', async () => {
    await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
      payload: { release_local_file: true },
    });
    const off = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: ownerCookie },
      payload: { release_local_file: false },
    });

    expect(off.statusCode).toBe(200);
    expect(off.json().release_local_file).toBe(false);
  });

  it('returns 403 for a panel user without can_manage_media', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/media-publishing',
      headers: { cookie: plainCookie },
      payload: { release_local_file: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_media' });
  });
});
