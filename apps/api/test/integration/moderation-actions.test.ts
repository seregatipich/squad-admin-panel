import {
  mediaFiles,
  mediaLinks,
  moderationActions,
  players,
  roleSquadPermissions,
  roles,
  servers,
} from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches, invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

vi.mock('../../src/routes/server-configs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/server-configs.js')>();
  return { ...actual, writeVersion: vi.fn(actual.writeVersion) };
});

import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';
import { writeVersion } from '../../src/routes/server-configs.js';

const OWNER_STEAM_ID = 76561198000000991n;

let h: IntegrationHarness;
let playerId: string;
let authorId: string;

// One app + database per file. Every test seeds its own players, servers,
// roles and media under unique SteamIDs/uuids and asserts only on rows scoped
// to them, so tests share the database without resets.
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterAll(async () => {
  await h?.cleanup();
});

async function seedPlayer(steamId: bigint, name: string, eosId?: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: steamId,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId: eosId ?? `eos-${name.toLowerCase()}`,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedServer(displayName: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({ id, displayName, slug: `mod-test-${id}` });
  return id;
}

/** Seeds a panel-access role with the given live-Squad permissions and a player assigned to it. */
async function seedActorWithSquadPermissions(opts: {
  steamId64: bigint;
  squadPermissionKeys: string[];
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `ModTest-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of opts.squadPermissionKeys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  const stub = `Mod${String(opts.steamId64).slice(-6)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
      eosId: `eos-${stub.toLowerCase()}`,
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed actor');
  return row.id;
}

async function loginAsPlayerId(playerIdValue: string): Promise<string> {
  invalidatePermissionCache(playerIdValue);
  const { token } = await createSession(h.db, h.redis, {
    playerId: playerIdValue,
    ip: null,
    userAgent: 'moderation-actions-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

function bansCfgPath(serverId: string): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/Bans.cfg`;
}

/** Inserts a bare `media_files` row (external-link kind) without going through the upload route. */
async function seedMediaFile(opts: { title?: string; deleted?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await h.db.insert(mediaFiles).values({
    id,
    uploaderPlayerId: null,
    kind: 'external_link',
    originalFilename: `clip-${id}.mp4`,
    mimeType: 'text/uri-list',
    sizeBytes: 0,
    sha256: id.replace(/-/g, ''),
    storagePath: null,
    externalUrl: `https://clips.example.com/${id}`,
    title: opts.title ?? null,
    description: null,
    deletedAt: opts.deleted ? new Date() : null,
  });
  return id;
}

function okOutcome(overrides: Partial<WorkerRconCommandOutcome> = {}): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-mod-test',
    response: 'ok',
    via: 'worker-rcon',
    ...overrides,
  } as WorkerRconCommandOutcome;
}

describe('GET /api/v1/players/:playerId/moderation-actions', () => {
  // Both tests only read this history, so it is seeded once.
  beforeAll(async () => {
    playerId = await seedPlayer(76561198000000123n, 'TargetPlayer');
    authorId = await seedPlayer(76561198000000124n, 'ModeratorPlayer');
    await h.db.insert(moderationActions).values([
      {
        playerId,
        actionType: 'name_kick',
        authorSystemLabel: 'banname-worker',
        reason: 'Banned nickname rule matched',
        context: { rule_id: 'rule-1' },
        createdAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        playerId,
        actionType: 'warn',
        authorPlayerId: authorId,
        reason: 'Please stop teamkilling',
        createdAt: new Date('2026-06-02T10:00:00Z'),
      },
    ]);
  });

  it('returns moderation actions newest-first with resolved author', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/moderation-actions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      actions: Array<{
        action_type: string;
        reason: string | null;
        context: Record<string, unknown>;
        author:
          | { kind: 'player'; id: string; name: string | null }
          | { kind: 'system'; label: string | null };
      }>;
    };
    expect(body.actions).toHaveLength(2);
    expect(body.actions[0]).toMatchObject({
      action_type: 'warn',
      author: { kind: 'player', id: authorId, name: 'ModeratorPlayer' },
    });
    expect(body.actions[1]).toMatchObject({
      action_type: 'name_kick',
      reason: 'Banned nickname rule matched',
      author: { kind: 'system', label: 'banname-worker' },
    });
    expect(body.actions[1].context).toMatchObject({ rule_id: 'rule-1' });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/moderation-actions`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('RBAC: mod:* squad-permission gate', () => {
  afterEach(() => {
    invalidateAllPermissionCaches();
  });

  it('panel user without squad ban permission cannot see mod:ban_perm', async () => {
    const actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(977100),
      squadPermissionKeys: [],
    });
    const cookie = await loginAsPlayerId(actorId);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { permissions: string[] };
    expect(body.permissions).not.toContain('mod:ban_perm');
    expect(body.permissions).not.toContain('mod:ban_temp');
    expect(body.permissions).not.toContain('mod:unban');
  });

  it('panel user with squad ban permission receives mod:ban_perm', async () => {
    const actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(977101),
      squadPermissionKeys: ['ban'],
    });
    const cookie = await loginAsPlayerId(actorId);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { permissions: string[] };
    expect(body.permissions).toContain('mod:ban_perm');
    expect(body.permissions).toContain('mod:ban_temp');
    expect(body.permissions).toContain('mod:unban');
  });
});

describe('POST /api/v1/players/:playerId/moderation-actions', () => {
  beforeEach(() => {
    vi.mocked(sendRconCommandViaWorker).mockReset();
  });

  afterEach(() => {
    invalidateAllPermissionCaches();
  });

  it('POST ban writes a ledger row, a Bans.cfg line and an audit entry', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome({ requestId: 'req-ban-1' }));
    const serverId = await seedServer('Mod Test Server');
    const targetId = await seedPlayer(testSteamId(977110), 'BanTarget');
    const actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(977111),
      squadPermissionKeys: ['ban'],
    });
    const cookie = await loginAsPlayerId(actorId);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
        ban_length: '0',
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      action: { id: string; action_type: string; reason: string | null };
    };
    expect(body.action.action_type).toBe('ban');
    expect(body.action.reason).toBe('aimbot');

    // The panel's own Bans.cfg copy is only ever rewritten by the revert
    // route (`removeBanLines`); a ban itself is enforced live via RCON, and
    // it is Squad's own AdminBan handler on the game server — not this
    // route — that appends the `Banned:<steamId64>:<expiry>` line to the
    // live Bans.cfg (no live Squad server is available here; see the Test
    // matrix "end-to-end" row). What's directly verifiable is that the RCON
    // command actually sent encodes exactly that line: the right command,
    // target, ban_length and reason.
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      h.redis,
      expect.objectContaining({
        serverId,
        command: 'AdminBan',
        args: ['eos-bantarget', '0', 'aimbot'],
      }),
    );

    const [row] = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.id, body.action.id))
      .limit(1);
    expect(row?.actionType).toBe('ban');
    expect(row?.context).toMatchObject({ ban_length: '0', rcon_request_id: 'req-ban-1' });

    await assertAuditRow(h, { action: 'moderation.action', resource: 'player', targetId });
  });

  it('POST ban is rejected for a user without the ban squad permission', async () => {
    const serverId = await seedServer('Mod Test Server 2');
    const targetId = await seedPlayer(testSteamId(977112), 'BanTarget2');
    const actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(977113),
      squadPermissionKeys: [],
    });
    const cookie = await loginAsPlayerId(actorId);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
      }),
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { required: string }).required).toBe('ban');
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/moderation-actions/:id/revert', () => {
  let serverId: string;
  let actorId: string;
  let cookie: string;

  // The actor's SteamID is unique, so it is seeded once for the describe.
  beforeAll(async () => {
    actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(977120),
      squadPermissionKeys: ['ban'],
    });
  });

  beforeEach(async () => {
    vi.mocked(sendRconCommandViaWorker).mockReset().mockResolvedValue(okOutcome());
    vi.mocked(writeVersion).mockClear();
    serverId = await seedServer('Revert Test Server');
    cookie = await loginAsPlayerId(actorId);
  });

  afterEach(() => {
    invalidateAllPermissionCaches();
  });

  it('revert removes only the target player line from Bans.cfg', async () => {
    const targetId = await seedPlayer(testSteamId(977121), 'RevertTarget');
    const targetSteamId = String(testSteamId(977121));
    const otherSteamId = String(testSteamId(977122));

    h.bridge.files.set(
      bansCfgPath(serverId),
      Buffer.from(
        [
          `Banned:${targetSteamId}:0 // target ban`,
          '// keep me - operator comment',
          `Banned:${otherSteamId}:0 // other ban`,
          '',
        ].join('\n'),
        'utf-8',
      ),
    );

    const [action] = await h.db
      .insert(moderationActions)
      .values({
        playerId: targetId,
        serverId,
        actionType: 'ban',
        authorPlayerId: actorId,
        reason: 'aimbot',
        context: { ban_length: '0' },
      })
      .returning({ id: moderationActions.id });
    if (!action) throw new Error('failed to seed ban action');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/moderation-actions/${action.id}/revert`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'appeal accepted' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      action: { action_type: string };
      removed_lines: number;
    };
    expect(body.removed_lines).toBe(1);
    expect(body.action.action_type).toBe('unban');

    const fileContent = h.bridge.files.get(bansCfgPath(serverId))?.toString('utf-8');
    expect(fileContent).toBe(
      ['// keep me - operator comment', `Banned:${otherSteamId}:0 // other ban`, ''].join('\n'),
    );

    const [reverted] = await h.db
      .select({ revertedAt: moderationActions.revertedAt })
      .from(moderationActions)
      .where(eq(moderationActions.id, action.id))
      .limit(1);
    expect(reverted?.revertedAt).not.toBeNull();
  });

  it('revert marks every active ban row for that player and server as reverted', async () => {
    const targetId = await seedPlayer(testSteamId(977123), 'DoubleBanned');
    const targetSteamId = String(testSteamId(977123));
    h.bridge.files.set(
      bansCfgPath(serverId),
      Buffer.from(`Banned:${targetSteamId}:0 // first ban\n`, 'utf-8'),
    );

    const inserted = await h.db
      .insert(moderationActions)
      .values([
        {
          playerId: targetId,
          serverId,
          actionType: 'ban',
          authorPlayerId: actorId,
          reason: 'first ban',
          context: { ban_length: '0' },
        },
        {
          playerId: targetId,
          serverId,
          actionType: 'ban',
          authorPlayerId: actorId,
          reason: 'second ban (re-offended)',
          context: { ban_length: '0' },
        },
      ])
      .returning({ id: moderationActions.id });
    const [firstBan, secondBan] = inserted;
    if (!firstBan || !secondBan) throw new Error('failed to seed ban actions');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/moderation-actions/${firstBan.id}/revert`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'appeal accepted' }),
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db
      .select({ id: moderationActions.id, revertedAt: moderationActions.revertedAt })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, targetId),
          eq(moderationActions.serverId, serverId),
          eq(moderationActions.actionType, 'ban'),
        ),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.revertedAt, `row ${row.id} should be reverted`).not.toBeNull();
    }
    expect(rows.map((r) => r.id).sort()).toEqual([firstBan.id, secondBan.id].sort());
  });

  it('revert on a file with no matching line leaves the file untouched', async () => {
    const targetId = await seedPlayer(testSteamId(977124), 'NoLineTarget');
    const unrelatedContent = '// nothing to see here\n';
    h.bridge.files.set(bansCfgPath(serverId), Buffer.from(unrelatedContent, 'utf-8'));

    const [action] = await h.db
      .insert(moderationActions)
      .values({
        playerId: targetId,
        serverId,
        actionType: 'ban',
        authorPlayerId: actorId,
        reason: 'aimbot',
        context: { ban_length: '0' },
      })
      .returning({ id: moderationActions.id });
    if (!action) throw new Error('failed to seed ban action');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/moderation-actions/${action.id}/revert`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'appeal accepted' }),
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { removed_lines: number }).removed_lines).toBe(0);
    expect(writeVersion).not.toHaveBeenCalled();
    expect(h.bridge.files.get(bansCfgPath(serverId))?.toString('utf-8')).toBe(unrelatedContent);
  });
});

describe('GET /api/v1/players/:playerId/moderation-actions history filters', () => {
  afterEach(() => {
    invalidateAllPermissionCaches();
  });

  it('history filters by action_type and server_id', async () => {
    const cookie = await loginAsOwner(h);
    const targetId = await seedPlayer(testSteamId(977131), 'FilterTarget');
    const serverA = await seedServer('Filter Server A');
    const serverB = await seedServer('Filter Server B');

    await h.db.insert(moderationActions).values([
      {
        playerId: targetId,
        serverId: serverA,
        actionType: 'ban',
        authorSystemLabel: 'test',
        reason: 'r1',
      },
      {
        playerId: targetId,
        serverId: serverA,
        actionType: 'warn',
        authorSystemLabel: 'test',
        reason: 'r2',
      },
      {
        playerId: targetId,
        serverId: serverB,
        actionType: 'ban',
        authorSystemLabel: 'test',
        reason: 'r3',
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/moderation-actions?action_type=ban&server_id=${serverA}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      actions: Array<{
        action_type: string;
        server: { id: string } | null;
        reason: string | null;
      }>;
    };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({
      action_type: 'ban',
      server: { id: serverA },
      reason: 'r1',
    });
  });
});

interface EvidenceApiItem {
  id: string;
  kind: string;
  external_url: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  title: string | null;
  linked_by_player_id: string | null;
  linked_at: string;
}

interface ActionWithEvidence {
  id: string;
  action_type: string;
  evidence: EvidenceApiItem[];
  evidence_count: number;
}

describe('MOD-3 evidence on moderation actions', () => {
  let serverId: string;
  let actorId: string;
  let cookie: string;

  // The actor's SteamID is unique, so it is seeded once for the describe.
  beforeAll(async () => {
    actorId = await seedActorWithSquadPermissions({
      steamId64: testSteamId(988000),
      squadPermissionKeys: ['ban', 'kick'],
    });
  });

  beforeEach(async () => {
    vi.mocked(sendRconCommandViaWorker).mockReset().mockResolvedValue(okOutcome());
    serverId = await seedServer('Evidence Test Server');
    cookie = await loginAsPlayerId(actorId);
  });

  afterEach(() => {
    invalidateAllPermissionCaches();
  });

  it('attaching two evidence_media_ids creates exactly two moderation_action media_links', async () => {
    const targetId = await seedPlayer(testSteamId(988001), 'EvidenceTarget1');
    const mediaA = await seedMediaFile({ title: 'Клип с аимботом' });
    const mediaB = await seedMediaFile();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
        ban_length: '0',
        evidence_media_ids: [mediaA, mediaB],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: ActionWithEvidence };
    expect(body.action.evidence_count).toBe(2);

    const links = await h.db
      .select()
      .from(mediaLinks)
      .where(
        and(
          eq(mediaLinks.entityType, 'moderation_action'),
          eq(mediaLinks.entityId, body.action.id),
        ),
      );
    expect(links).toHaveLength(2);
    expect(links.map((row) => row.mediaId).sort()).toEqual([mediaA, mediaB].sort());
    for (const link of links) {
      expect(link.linkedByPlayerId).toBe(actorId);
    }
  });

  it('history returns evidence_count and both evidence items with kind, external_url and title', async () => {
    const targetId = await seedPlayer(testSteamId(988002), 'EvidenceTarget2');
    const mediaA = await seedMediaFile({ title: 'Клип с аимботом' });
    const mediaB = await seedMediaFile();

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'kick',
        reason: 'toxicity',
        evidence_media_ids: [mediaA, mediaB],
      }),
    });
    expect(created.statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: ActionWithEvidence[] };
    expect(body.actions).toHaveLength(1);
    const action = body.actions[0];
    if (!action) throw new Error('expected one moderation action');
    expect(action.evidence_count).toBe(2);
    expect(action.evidence).toHaveLength(2);

    const withTitle = action.evidence.find((item) => item.id === mediaA);
    expect(withTitle).toMatchObject({
      kind: 'external_link',
      title: 'Клип с аимботом',
      mime_type: 'text/uri-list',
      size_bytes: 0,
      linked_by_player_id: actorId,
    });
    expect(withTitle?.external_url).toMatch(/^https:\/\/clips\.example\.com\//);
    expect(typeof withTitle?.linked_at).toBe('string');
    expect(action.evidence.some((item) => item.id === mediaB)).toBe(true);
  });

  it('soft-deleted media disappears from evidence but its media_links row survives', async () => {
    const targetId = await seedPlayer(testSteamId(988003), 'EvidenceTarget3');
    const keptMedia = await seedMediaFile({ title: 'kept' });
    const doomedMedia = await seedMediaFile({ title: 'doomed' });

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'warn',
        reason: 'first warning',
        evidence_media_ids: [keptMedia, doomedMedia],
      }),
    });
    expect(created.statusCode).toBe(200);
    const actionId = (created.json() as { action: ActionWithEvidence }).action.id;

    await h.db
      .update(mediaFiles)
      .set({ deletedAt: new Date() })
      .where(eq(mediaFiles.id, doomedMedia));

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const action = (res.json() as { actions: ActionWithEvidence[] }).actions[0];
    if (!action) throw new Error('expected one moderation action');
    expect(action.evidence_count).toBe(1);
    expect(action.evidence.map((item) => item.id)).toEqual([keptMedia]);

    const links = await h.db
      .select()
      .from(mediaLinks)
      .where(
        and(eq(mediaLinks.entityType, 'moderation_action'), eq(mediaLinks.entityId, actionId)),
      );
    expect(links).toHaveLength(2);
  });

  it('an unknown evidence media id is rejected with 400 before the action is enforced', async () => {
    const targetId = await seedPlayer(testSteamId(988004), 'EvidenceTarget4');
    const goodMedia = await seedMediaFile();
    const unknownMedia = uuidv7();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
        evidence_media_ids: [goodMedia, unknownMedia],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'evidence_media_not_found', media_id: unknownMedia });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();

    const rows = await h.db
      .select({ id: moderationActions.id })
      .from(moderationActions)
      .where(eq(moderationActions.playerId, targetId));
    expect(rows).toHaveLength(0);
  });

  it('a soft-deleted evidence media id is rejected with 400', async () => {
    const targetId = await seedPlayer(testSteamId(988005), 'EvidenceTarget5');
    const deletedMedia = await seedMediaFile({ deleted: true });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
        evidence_media_ids: [deletedMedia],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'evidence_media_not_found', media_id: deletedMedia });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('rejects more than ten evidence_media_ids with a 400 from the body schema', async () => {
    const targetId = await seedPlayer(testSteamId(988006), 'EvidenceTarget6');
    const eleven = Array.from({ length: 11 }, () => uuidv7());

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'ban',
        reason: 'aimbot',
        evidence_media_ids: eleven,
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('duplicate ids in evidence_media_ids are deduplicated into a single link', async () => {
    const targetId = await seedPlayer(testSteamId(988007), 'EvidenceTarget7');
    const mediaA = await seedMediaFile();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        server_id: serverId,
        action_type: 'warn',
        reason: 'dup evidence',
        evidence_media_ids: [mediaA, mediaA],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: ActionWithEvidence };
    expect(body.action.evidence_count).toBe(1);

    const links = await h.db
      .select()
      .from(mediaLinks)
      .where(
        and(
          eq(mediaLinks.entityType, 'moderation_action'),
          eq(mediaLinks.entityId, body.action.id),
        ),
      );
    expect(links).toHaveLength(1);
  });

  it('loads evidence for a whole history page in one query, not one per action', async () => {
    const emptyTargetId = await seedPlayer(testSteamId(988008), 'EvidenceEmptyTarget');
    const targetId = await seedPlayer(testSteamId(988009), 'EvidenceBatchTarget');

    for (let i = 0; i < 5; i++) {
      const mediaId = await seedMediaFile();
      const created = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${targetId}/moderation-actions`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({
          server_id: serverId,
          action_type: 'warn',
          reason: `warning ${i}`,
          evidence_media_ids: [mediaId],
        }),
      });
      expect(created.statusCode).toBe(200);
    }

    const get = (playerId: string) =>
      h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${playerId}/moderation-actions`,
        headers: { cookie },
      });

    // Warm the session/permission caches so the measured deltas differ only
    // by the evidence query itself.
    await get(emptyTargetId);
    await get(targetId);

    const selectSpy = vi.spyOn(h.db, 'select');
    await get(emptyTargetId);
    const baseline = selectSpy.mock.calls.length;
    selectSpy.mockClear();
    const withEvidence = await get(targetId);
    const loaded = selectSpy.mock.calls.length;
    selectSpy.mockRestore();

    const body = withEvidence.json() as { actions: ActionWithEvidence[] };
    expect(body.actions).toHaveLength(5);
    for (const action of body.actions) {
      expect(action.evidence_count).toBe(1);
    }
    // Five actions, five attached files, exactly one extra SELECT over the
    // zero-action baseline — a per-action loop would have cost five.
    expect(loaded).toBe(baseline + 1);
  });

  it('rejects a history read from a user without panel access with 403', async () => {
    const targetId = await seedPlayer(testSteamId(988010), 'EvidenceTarget10');
    const [noPanelRole] = await h.db
      .insert(roles)
      .values({
        id: uuidv7(),
        name: `NoPanel-${uuidv7()}`,
        color: 'blue',
        isSystemRole: false,
        panelAccess: false,
      })
      .returning({ id: roles.id });
    const [outsider] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(988011),
        canonicalName: 'EvidenceOutsider',
        canonicalNameNormalized: 'evidenceoutsider',
        eosId: 'eos-evidenceoutsider',
        roleId: noPanelRole?.id ?? null,
      })
      .returning({ id: players.id });
    if (!outsider) throw new Error('failed to seed outsider');
    const outsiderCookie = await loginAsPlayerId(outsider.id);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});
