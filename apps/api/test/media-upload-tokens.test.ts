import { createHash, randomUUID } from 'node:crypto';
import { auditLog, mediaUploadTokens, moderationActions, players, roles } from '@squad/db/schema';
import { eq, gte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEDIA_MAX_UPLOAD_BYTES } from '../src/lib/media-storage.js';
import { invalidateAllPermissionCaches, invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(989000);
const NO_PANEL_STEAM = testSteamId(989001);
const TARGET_STEAM = testSteamId(989002);

let h: IntegrationHarness;
let ownerCookie: string;
let targetPlayerId: string;

/** Flattens audit rows to text; `audit_log` carries bigint/Buffer columns plain JSON rejects. */
function stringifyAuditRows(rows: unknown[]): string {
  return JSON.stringify(rows, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

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
    userAgent: 'media-upload-tokens-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'UploadTokenOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  const [noPanelRole] = await h.db
    .insert(roles)
    .values({ id: randomUUID(), name: 'UploadTokenNoPanelTest', panelAccess: false })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'UploadTokenNoPanel',
    canonicalNameNormalized: 'uploadtokennopanel',
    roleId: noPanelRole?.id ?? null,
  });

  const [target] = await h.db
    .insert(players)
    .values({
      steamId64: TARGET_STEAM,
      canonicalName: 'UploadTokenTarget',
      canonicalNameNormalized: 'uploadtokentarget',
    })
    .returning({ id: players.id });
  targetPlayerId = target?.id ?? '';
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

describe('POST /api/v1/media/upload-tokens', () => {
  it('rejects unauthenticated mint requests with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('rejects mint requests from users without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('mints a token and persists only its sha-256 hash, never the raw value', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(typeof json.token).toBe('string');
    expect(json.token.length).toBeGreaterThanOrEqual(32);
    expect(json.upload_url).toBe(`https://panel.test/upload/${json.token}`);
    expect(json.max_size_bytes).toBe(MEDIA_MAX_UPLOAD_BYTES);
    expect(json.target_entity_type).toBeNull();
    expect(json.target_entity_id).toBeNull();

    const [row] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, json.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.tokenHash).toBe(createHash('sha256').update(json.token).digest('hex'));
    expect(row?.tokenHash).not.toBe(json.token);
    expect(row?.usedAt).toBeNull();
    expect(row?.issuedByPlayerId).toBe(h.seed.ownerPlayerId);
  });

  it('defaults the lifetime to two hours and honours an explicit expires_in_seconds', async () => {
    const before = Date.now();
    const def = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(def.statusCode).toBe(201);
    const defaultExpiry = new Date(def.json().expires_at).getTime();
    expect(defaultExpiry - before).toBeGreaterThan(7200_000 - 60_000);
    expect(defaultExpiry - before).toBeLessThan(7200_000 + 60_000);

    const custom = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { expires_in_seconds: 600 },
    });
    expect(custom.statusCode).toBe(201);
    const customExpiry = new Date(custom.json().expires_at).getTime();
    expect(customExpiry - before).toBeGreaterThan(600_000 - 60_000);
    expect(customExpiry - before).toBeLessThan(600_000 + 60_000);
  });

  it('pre-binds the token to a moderation action target', async () => {
    const [action] = await h.db
      .insert(moderationActions)
      .values({
        playerId: targetPlayerId,
        actionType: 'ban',
        authorSystemLabel: 'upload-token-test',
      })
      .returning({ id: moderationActions.id });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { target_entity_type: 'moderation_action', target_entity_id: action?.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().target_entity_type).toBe('moderation_action');
    expect(res.json().target_entity_id).toBe(action?.id);

    const [row] = await h.db
      .select()
      .from(mediaUploadTokens)
      .where(eq(mediaUploadTokens.id, res.json().id))
      .limit(1);
    expect(row?.targetEntityType).toBe('moderation_action');
    expect(row?.targetEntityId).toBe(action?.id);
  });

  it('rejects a half-specified target with 400 invalid_target', async () => {
    const typeOnly = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { target_entity_type: 'player' },
    });
    expect(typeOnly.statusCode).toBe(400);
    expect(typeOnly.json()).toEqual({ error: 'invalid_target' });

    const idOnly = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { target_entity_id: randomUUID() },
    });
    expect(idOnly.statusCode).toBe(400);
    expect(idOnly.json()).toEqual({ error: 'invalid_target' });
  });

  it('rejects a target that does not exist with 404 entity_not_found', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { target_entity_type: 'player', target_entity_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'entity_not_found' });
  });

  it('clamps a requested max_size_bytes to the server-wide upload cap', async () => {
    const under = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { max_size_bytes: 1024 },
    });
    expect(under.statusCode).toBe(201);
    expect(under.json().max_size_bytes).toBe(1024);

    const over = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { max_size_bytes: MEDIA_MAX_UPLOAD_BYTES * 4 },
    });
    expect(over.statusCode).toBe(201);
    expect(over.json().max_size_bytes).toBe(MEDIA_MAX_UPLOAD_BYTES);
  });

  it('audit-logs the mint by token id and never records the raw token', async () => {
    const since = new Date(Date.now() - 5_000);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-tokens',
      headers: { cookie: ownerCookie },
      payload: { target_entity_type: 'player', target_entity_id: targetPlayerId },
    });
    expect(res.statusCode).toBe(201);
    const rawToken = res.json().token as string;

    await assertAuditRow(h, {
      action: 'media.upload_token.mint',
      resource: 'media_upload_token',
      targetId: res.json().id,
    });

    const rows = await h.db.select().from(auditLog).where(gte(auditLog.createdAt, since));
    expect(rows.length).toBeGreaterThan(0);
    expect(stringifyAuditRows(rows)).not.toContain(rawToken);
  });
});
