import { randomUUID } from 'node:crypto';
import { mediaFiles, mediaLinks, moderationActions, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches, invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(978000);
const LINKER_STEAM = testSteamId(978001);
const OTHER_PANEL_STEAM = testSteamId(978002);

let h: IntegrationHarness;
let ownerCookie: string;
let linkerCookie: string;
let otherPanelCookie: string;
let linkerPlayerId: string;

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
    userAgent: 'media-links-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

/** Inserts a bare `media_files` row (external link kind) without going through the upload route. */
async function insertMediaFile(uploaderPlayerId: string | null): Promise<string> {
  const id = randomUUID();
  await h.db.insert(mediaFiles).values({
    id,
    uploaderPlayerId,
    kind: 'external_link',
    originalFilename: `clip-${id}.mp4`,
    mimeType: 'text/uri-list',
    sizeBytes: 0,
    sha256: randomUUID().replace(/-/g, ''),
    storagePath: null,
    externalUrl: `https://clips.example.com/${id}`,
    title: null,
    description: null,
  });
  return id;
}

/** Inserts a player row and returns its id. Pass `steamId64: null` for an EOS-only player. */
async function insertPlayer(opts: {
  steamId64: bigint | null;
  canonicalName: string;
  roleId?: string | null;
  eosId?: string;
}): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: opts.canonicalName,
      canonicalNameNormalized: opts.canonicalName.toLowerCase(),
      eosId: opts.eosId ?? null,
      roleId: opts.roleId ?? null,
    })
    .returning({ id: players.id });
  const id = row?.id;
  if (!id) throw new Error('player insert returned no row');
  return id;
}

async function insertModerationAction(targetPlayerId: string): Promise<string> {
  const [row] = await h.db
    .insert(moderationActions)
    .values({
      playerId: targetPlayerId,
      actionType: 'warn',
      authorSystemLabel: 'media-links-test',
    })
    .returning({ id: moderationActions.id });
  const id = row?.id;
  if (!id) throw new Error('moderation_actions insert returned no row');
  return id;
}

type ConflictingLink = { mediaId: string; entityType: string; entityId: string };

/**
 * Runs `body` with the `media_links` race window forced open: the conflicting row
 * is committed after the route's pre-check SELECT has already reported "no existing
 * link", but before the route's own INSERT executes. That is the interleaving two
 * concurrent attach requests produce, and the only way to reach the route's
 * unique-violation handler — the pre-check swallows every non-racing duplicate.
 *
 * Only the timing is simulated. The database, the drizzle client, the unique index
 * and the thrown `DrizzleQueryError` are all real, so the route's `23505` handling
 * is exercised exactly as it would be under a live race.
 */
async function withRacingDuplicateInsert<T>(
  conflicting: ConflictingLink,
  body: () => Promise<T>,
): Promise<T> {
  type InsertBuilder = { values: (v: unknown) => { returning: () => Promise<unknown> } };
  const db = h.app.db as unknown as { insert: (table: unknown) => InsertBuilder };
  const realInsert = db.insert.bind(db);
  let fired = false;

  db.insert = (table: unknown): InsertBuilder => {
    const builder = realInsert(table);
    if (fired || table !== mediaLinks) return builder;
    fired = true;
    return {
      values: (v: unknown) => {
        const routeInsert = builder.values(v);
        return {
          returning: async () => {
            await realInsert(mediaLinks)
              .values({ id: randomUUID(), ...conflicting, linkedByPlayerId: null })
              .returning();
            return routeInsert.returning();
          },
        };
      },
    };
  };

  try {
    return await body();
  } finally {
    db.insert = realInsert;
  }
}

// One app per file: every case links its own freshly inserted players, actions
// and media files, so no case can see another's links.
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'MediaLinkOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  const [plainPanelRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'MediaLinksPlainUserTest',
      panelAccess: true,
      canManageMedia: false,
    })
    .returning({ id: roles.id });

  linkerPlayerId = await insertPlayer({
    steamId64: LINKER_STEAM,
    canonicalName: 'MediaLinksLinker',
    roleId: plainPanelRole?.id ?? null,
  });
  await insertPlayer({
    steamId64: OTHER_PANEL_STEAM,
    canonicalName: 'MediaLinksOtherPanel',
    roleId: plainPanelRole?.id ?? null,
  });

  linkerCookie = await loginAsSteam(LINKER_STEAM);
  otherPanelCookie = await loginAsSteam(OTHER_PANEL_STEAM);
});

afterEach(() => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
});

afterAll(async () => {
  await h?.cleanup();
});

describe('POST /api/v1/media/:id/links', () => {
  it('attaches a media file to a moderation action and returns 201', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978010),
      canonicalName: 'MediaLinksTarget1',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.media_id).toBe(mediaId);
    expect(json.entity_type).toBe('moderation_action');
    expect(json.entity_id).toBe(actionId);
    expect(json.linked_by_player_id).toBe(h.seed.ownerPlayerId);
    expect(typeof json.id).toBe('string');
    expect(typeof json.created_at).toBe('string');
  });

  it('returns 409 when the same link is created twice', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978011),
      canonicalName: 'MediaLinksTarget2',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_linked' });
  });

  it('returns 409 when a concurrent writer wins the race past the pre-check', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978012),
      canonicalName: 'MediaLinksTarget3',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const res = await withRacingDuplicateInsert(
      { mediaId, entityType: 'moderation_action', entityId: actionId },
      () =>
        h.app.inject({
          method: 'POST',
          url: `/api/v1/media/${mediaId}/links`,
          headers: { cookie: ownerCookie },
          payload: { entity_type: 'moderation_action', entity_id: actionId },
        }),
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_linked' });

    const rows = await h.db
      .select({ id: mediaLinks.id })
      .from(mediaLinks)
      .where(eq(mediaLinks.mediaId, mediaId));
    expect(rows).toHaveLength(1);
  });

  it('returns 404 when the target entity does not exist', async () => {
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'moderation_action', entity_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'entity_not_found' });
  });
});

describe('GET evidence listing', () => {
  it('lists moderation-action evidence on the player media endpoint', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978016),
      canonicalName: 'MediaLinksTarget7',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const attach = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(attach.statusCode).toBe(201);

    const playerMedia = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetPlayerId}/media`,
      headers: { cookie: ownerCookie },
    });
    expect(playerMedia.statusCode).toBe(200);
    const playerItems = playerMedia.json().items as Array<{
      link: { entity_type: string; entity_id: string };
      media: { id: string };
    }>;
    expect(
      playerItems.some((it) => it.media.id === mediaId && it.link.entity_id === actionId),
    ).toBe(true);

    const actionMedia = await h.app.inject({
      method: 'GET',
      url: `/api/v1/moderation-actions/${actionId}/media`,
      headers: { cookie: ownerCookie },
    });
    expect(actionMedia.statusCode).toBe(200);
    const actionItems = actionMedia.json().items as Array<{ media: { id: string } }>;
    expect(actionItems.some((it) => it.media.id === mediaId)).toBe(true);
  });

  it('accumulates evidence for an EOS-only player without steam_id64', async () => {
    const eosPlayerId = await insertPlayer({
      steamId64: null,
      canonicalName: 'MediaLinksEosOnly',
      eosId: `eos-${randomUUID()}`,
    });
    const mediaId = await insertMediaFile(h.seed.ownerPlayerId ?? null);

    const attach = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: ownerCookie },
      payload: { entity_type: 'player', entity_id: eosPlayerId },
    });
    expect(attach.statusCode).toBe(201);

    const playerMedia = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${eosPlayerId}/media`,
      headers: { cookie: ownerCookie },
    });
    expect(playerMedia.statusCode).toBe(200);
    const items = playerMedia.json().items as Array<{ media: { id: string } }>;
    expect(items.some((it) => it.media.id === mediaId)).toBe(true);
  });
});

describe('DELETE /api/v1/media/:id/links', () => {
  it('detaching another users link without can_manage_media returns 403', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978013),
      canonicalName: 'MediaLinksTarget4',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(linkerPlayerId);

    const attach = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: linkerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(attach.statusCode).toBe(201);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/links?entity_type=moderation_action&entity_id=${actionId}`,
      headers: { cookie: otherPanelCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_media' });

    const [row] = await h.db
      .select()
      .from(mediaLinks)
      .where(eq(mediaLinks.mediaId, mediaId))
      .limit(1);
    expect(row).toBeDefined();
  });

  it('detaching your own link returns 200', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978014),
      canonicalName: 'MediaLinksTarget5',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(linkerPlayerId);

    const attach = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: linkerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(attach.statusCode).toBe(201);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/links?entity_type=moderation_action&entity_id=${actionId}`,
      headers: { cookie: linkerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = await h.db.select().from(mediaLinks).where(eq(mediaLinks.mediaId, mediaId));
    expect(rows).toHaveLength(0);
  });
});

describe('audit trail', () => {
  it('writes an audit row on attach and on detach', async () => {
    const targetPlayerId = await insertPlayer({
      steamId64: testSteamId(978015),
      canonicalName: 'MediaLinksTarget6',
    });
    const actionId = await insertModerationAction(targetPlayerId);
    const mediaId = await insertMediaFile(linkerPlayerId);

    const attach = await h.app.inject({
      method: 'POST',
      url: `/api/v1/media/${mediaId}/links`,
      headers: { cookie: linkerCookie },
      payload: { entity_type: 'moderation_action', entity_id: actionId },
    });
    expect(attach.statusCode).toBe(201);
    const linkId = attach.json().id as string;

    await assertAuditRow(h, {
      action: 'media.link.attach',
      resource: 'media_link',
      targetId: linkId,
    });

    const detach = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}/links?entity_type=moderation_action&entity_id=${actionId}`,
      headers: { cookie: linkerCookie },
    });
    expect(detach.statusCode).toBe(200);

    await assertAuditRow(h, {
      action: 'media.link.detach',
      resource: 'media_link',
      targetId: linkId,
    });
  });
});
