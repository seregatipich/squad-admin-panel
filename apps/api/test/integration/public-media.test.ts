import { randomUUID } from 'node:crypto';
import {
  auditLog,
  mediaFiles,
  mediaLinks,
  mediaUploadTokens,
  moderationActions,
  players,
} from '@squad/db/schema';
import { eq, gte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import type { LiveEvent } from '../../src/plugins/live-bus.js';
import {
  PUBLIC_MEDIA_RATE_LIMIT_PREFIX,
  PUBLIC_MEDIA_UPLOADS_PER_HOUR,
} from '../../src/routes/public-media.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

const OWNER_STEAM = testSteamId(989100);
const TARGET_STEAM = testSteamId(989101);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payloadLength = 64): Buffer {
  const payload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) payload[i] = i % 256;
  return Buffer.concat([PNG_SIGNATURE, payload]);
}

/** Builds a `multipart/form-data` payload carrying a single file part. */
function buildMultipartPayload(file: { filename: string; contentType: string; content: Buffer }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----publicMediaBoundary${randomUUID().replace(/-/g, '')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, file.content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

let h: IntegrationHarness;
let ownerCookie: string;
let targetPlayerId: string;

/** Flattens audit rows to text; `audit_log` carries bigint/Buffer columns plain JSON rejects. */
function stringifyAuditRows(rows: unknown[]): string {
  return JSON.stringify(rows, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

interface MintedToken {
  id: string;
  token: string;
}

async function mintToken(payload: Record<string, unknown> = {}): Promise<MintedToken> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-tokens',
    headers: { cookie: ownerCookie },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  }
  return { id: res.json().id as string, token: res.json().token as string };
}

async function uploadWithToken(
  token: string,
  content: Buffer = pngBytes(),
  contentType = 'image/png',
  filename = 'evidence.png',
) {
  const { body, contentType: multipartType } = buildMultipartPayload({
    filename,
    contentType,
    content,
  });
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/public/media?token=${encodeURIComponent(token)}`,
    headers: { 'content-type': multipartType },
    payload: body,
  });
}

// One app + database per file. Every test mints its own token and asserts on
// rows keyed by that token or the media id it produced, so they share the
// owner session and target player.
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'PublicMediaOwner' },
  });
  ownerCookie = await loginAsOwner(h);
  const [target] = await h.db
    .insert(players)
    .values({
      steamId64: TARGET_STEAM,
      canonicalName: 'PublicMediaTarget',
      canonicalNameNormalized: 'publicmediatarget',
    })
    .returning({ id: players.id });
  targetPlayerId = target?.id ?? '';
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  // The manual per-IP limiter is keyed on `req.ip`, which every injected
  // request shares; reset it so one test's uploads never starve the next.
  const keys = await h.redis.keys(`${PUBLIC_MEDIA_RATE_LIMIT_PREFIX}*`);
  if (keys.length > 0) await h.redis.del(...keys);
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded in beforeAll
  invalidatePermissionCache(h.seed.ownerPlayerId!);
});

describe('POST /api/v1/public/media', () => {
  it('accepts an anonymous upload with no panel session and records it as token-provenanced', async () => {
    const minted = await mintToken();
    const content = pngBytes(128);
    const res = await uploadWithToken(minted.token, content);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, media_id: expect.any(String) });

    const [row] = await h.db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, res.json().media_id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.uploaderPlayerId).toBeNull();
    expect(row?.uploadTokenId).toBe(minted.id);
    expect(row?.sizeBytes).toBe(content.length);
    expect(row?.kind).toBe('image');

    const [token] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, minted.id))
      .limit(1);
    expect(token?.usedAt).not.toBeNull();
  });

  it('auto-links the upload to the pre-bound ban so it shows in that action evidence', async () => {
    const [action] = await h.db
      .insert(moderationActions)
      .values({
        playerId: targetPlayerId,
        actionType: 'ban',
        authorSystemLabel: 'public-media-test',
      })
      .returning({ id: moderationActions.id });
    const actionId = action?.id ?? '';

    const minted = await mintToken({
      target_entity_type: 'moderation_action',
      target_entity_id: actionId,
    });
    const res = await uploadWithToken(minted.token);
    expect(res.statusCode).toBe(201);
    const mediaId = res.json().media_id as string;

    const links = await h.db.select().from(mediaLinks).where(eq(mediaLinks.mediaId, mediaId));
    expect(links).toHaveLength(1);
    expect(links[0]?.entityType).toBe('moderation_action');
    expect(links[0]?.entityId).toBe(actionId);
    expect(links[0]?.linkedByPlayerId).toBe(h.seed.ownerPlayerId);

    const evidence = await h.app.inject({
      method: 'GET',
      url: `/api/v1/moderation-actions/${actionId}/media`,
      headers: { cookie: ownerCookie },
    });
    expect(evidence.statusCode).toBe(200);
    const items = evidence.json().items as { media: Record<string, unknown> }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.media.id).toBe(mediaId);
    expect(items[0]?.media.uploader_player_id).toBeNull();
    expect(items[0]?.media.upload_token_id).toBe(minted.id);
  });

  it('rejects a second upload with the same token with 410', async () => {
    const minted = await mintToken();
    const first = await uploadWithToken(minted.token, pngBytes(80));
    expect(first.statusCode).toBe(201);

    const second = await uploadWithToken(minted.token, pngBytes(96));
    expect(second.statusCode).toBe(410);
    expect(second.json()).toEqual({ error: 'token_used_or_expired' });

    const rows = await h.db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.uploadTokenId, minted.id));
    expect(rows).toHaveLength(1);
  });

  it('rejects an expired token with 410', async () => {
    const minted = await mintToken();
    await h.db
      .update(mediaUploadTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mediaUploadTokens.id, minted.id));

    const res = await uploadWithToken(minted.token);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'token_used_or_expired' });
  });

  it('rejects an unknown token with 410 without revealing whether it ever existed', async () => {
    const res = await uploadWithToken('this-token-was-never-issued-0123456789abcdef');
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'token_used_or_expired' });
  });

  it('rejects a missing token query parameter with 400', async () => {
    const { body, contentType } = buildMultipartPayload({
      filename: 'a.png',
      contentType: 'image/png',
      content: pngBytes(),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/public/media',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an upload above the token max_size_bytes with 413 and leaves the token unused', async () => {
    const minted = await mintToken({ max_size_bytes: 64 });
    const res = await uploadWithToken(minted.token, pngBytes(512));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file_too_large' });

    const [token] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, minted.id))
      .limit(1);
    expect(token?.usedAt).toBeNull();
  });

  it('rejects bytes that do not match the declared mime type with 400 and leaves the token unused', async () => {
    const minted = await mintToken();
    const res = await uploadWithToken(
      minted.token,
      Buffer.concat([Buffer.from('definitely-not-a-png'), Buffer.alloc(32, 3)]),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'magic_byte_mismatch' });

    const [token] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, minted.id))
      .limit(1);
    expect(token?.usedAt).toBeNull();
  });

  it('rejects a disallowed mime type with 415', async () => {
    const minted = await mintToken();
    const res = await uploadWithToken(
      minted.token,
      Buffer.from('%PDF-1.7\n'),
      'application/pdf',
      'evidence.pdf',
    );
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_media_type');
  });

  it('rate-limits anonymous uploads per IP with 429', async () => {
    const minted = await mintToken();
    const key = `${PUBLIC_MEDIA_RATE_LIMIT_PREFIX}127.0.0.1`;
    await h.redis.set(key, String(PUBLIC_MEDIA_UPLOADS_PER_HOUR), 'EX', 3600);

    const res = await uploadWithToken(minted.token);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');

    const [token] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, minted.id))
      .limit(1);
    expect(token?.usedAt).toBeNull();
  });

  it('redeems a token exactly once under two concurrent uploads', async () => {
    const minted = await mintToken();
    const [a, b] = await Promise.all([
      uploadWithToken(minted.token, pngBytes(100)),
      uploadWithToken(minted.token, pngBytes(200)),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 410]);

    const rows = await h.db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.uploadTokenId, minted.id));
    expect(rows).toHaveLength(1);
  });

  it('audit-logs the public upload as a system actor without the raw token', async () => {
    const since = new Date(Date.now() - 5_000);
    const minted = await mintToken();
    const res = await uploadWithToken(minted.token);
    expect(res.statusCode).toBe(201);

    const entry = await assertAuditRow(h, {
      action: 'media.public_upload',
      resource: 'media_file',
      targetId: res.json().media_id,
    });
    expect(entry.actorKind).toBe('system');
    expect(entry.actorPlayerId).toBeNull();

    const rows = await h.db.select().from(auditLog).where(gte(auditLog.createdAt, since));
    expect(rows.length).toBeGreaterThan(0);
    expect(stringifyAuditRows(rows)).not.toContain(minted.token);
  });

  it('publishes a media.uploaded live event addressed to the minting admin', async () => {
    const minted = await mintToken({
      target_entity_type: 'player',
      target_entity_id: targetPlayerId,
    });
    const seen: LiveEvent[] = [];
    const stop = h.app.liveBus.subscribe((event) => seen.push(event));
    try {
      const res = await uploadWithToken(minted.token);
      expect(res.statusCode).toBe(201);
      const event = seen.find((e) => e.type === 'media.uploaded');
      expect(event).toBeDefined();
      if (event?.type !== 'media.uploaded') throw new Error('unreachable');
      expect(event.data.player_id).toBe(h.seed.ownerPlayerId);
      expect(event.data.media_id).toBe(res.json().media_id);
      expect(event.data.token_id).toBe(minted.id);
      expect(event.data.target_entity_type).toBe('player');
      expect(event.data.target_entity_id).toBe(targetPlayerId);
    } finally {
      stop();
    }
  });
});
