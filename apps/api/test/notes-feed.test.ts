import { playerNameHistory, playerNotes, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000021000n;

let seq = 0;
function nextSteamId(): bigint {
  seq += 1;
  return 76561198000021100n + BigInt(seq);
}

async function seedPlayer(
  h: IntegrationHarness,
  roleName: string | null,
  name: string,
): Promise<string> {
  let roleId: string | null = null;
  if (roleName) {
    const roleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, roleName))
      .limit(1);
    roleId = roleRows[0]?.id ?? null;
    if (!roleId) throw new Error(`role ${roleName} not seeded`);
  }
  const inserted = await h.db
    .insert(players)
    .values({
      steamId64: nextSteamId(),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error('player insert failed');
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'test-harness',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function addNameHistory(
  h: IntegrationHarness,
  playerId: string,
  name: string,
): Promise<void> {
  await h.db.insert(playerNameHistory).values({
    playerId,
    name,
    nameNormalized: name.toLowerCase(),
  });
}

interface SeedNote {
  playerId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  deletedAt?: Date;
  deletedBy?: string;
}

async function insertNote(h: IntegrationHarness, note: SeedNote): Promise<string> {
  const id = uuidv7();
  await h.db.insert(playerNotes).values({
    id,
    playerId: note.playerId,
    authorId: note.authorId,
    body: note.body,
    createdAt: note.createdAt,
    deletedAt: note.deletedAt ?? null,
    deletedBy: note.deletedBy ?? null,
  });
  return id;
}

interface FeedDto {
  id: string;
  player_id: string;
  target: { id: string; name: string };
  author: { id: string; name: string; role_color: string | null; role_name: string | null };
  body: string;
  deleted: boolean;
  deleted_by: { id: string; name: string | null } | null;
}

interface FeedResponse {
  items: FeedDto[];
  next_cursor: string | null;
  can_view_deleted: boolean;
}

describe('global notes feed', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let subjectA: string;
  let subjectB: string;
  let authorX: string;
  let authorY: string;
  let n1: string;
  let n2: string;
  let n3: string;
  let n4: string;

  beforeEach(async () => {
    seq = 0;
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
    ownerCookie = await loginAsOwner(h);

    subjectA = await seedPlayer(h, null, 'AlphaTarget');
    subjectB = await seedPlayer(h, null, 'BravoTarget');
    await addNameHistory(h, subjectA, 'OldAlphaNick');

    authorX = await seedPlayer(h, 'Admin', 'AdminX');
    authorY = await seedPlayer(h, 'Admin', 'AdminY');

    const base = Date.now();
    n1 = await insertNote(h, {
      playerId: subjectA,
      authorId: authorX,
      body: 'cheating suspected',
      createdAt: new Date(base + 1000),
    });
    n2 = await insertNote(h, {
      playerId: subjectA,
      authorId: authorY,
      body: 'cheating and toxic',
      createdAt: new Date(base + 2000),
    });
    n3 = await insertNote(h, {
      playerId: subjectB,
      authorId: authorX,
      body: 'wallhack cheating',
      createdAt: new Date(base + 3000),
    });
    n4 = await insertNote(h, {
      playerId: subjectB,
      authorId: authorY,
      body: 'will be deleted',
      createdAt: new Date(base + 4000),
      deletedAt: new Date(base + 5000),
      deletedBy: h.seed.ownerPlayerId,
    });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function feed(cookie: string, query = ''): Promise<FeedResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/notes${query}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as FeedResponse;
  }

  it('401 without a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/notes' });
    expect(res.statusCode).toBe(401);
  });

  it('returns all active notes across players, newest-first, excluding deleted by default', async () => {
    const body = await feed(ownerCookie);
    expect(body.items.map((n) => n.id)).toEqual([n3, n2, n1]);
    expect(body.items.every((n) => !n.deleted)).toBe(true);
    expect(body.can_view_deleted).toBe(true);
    const first = body.items[0];
    expect(first?.target.id).toBe(subjectB);
    expect(first?.target.name).toBe('BravoTarget');
    expect(first?.author.name).toBe('AdminX');
  });

  it('combines a body text search with an author filter', async () => {
    const textOnly = await feed(ownerCookie, '?q=cheating');
    expect(textOnly.items.map((n) => n.id).sort()).toEqual([n1, n2, n3].sort());

    const combined = await feed(ownerCookie, `?q=cheating&author=${authorX}`);
    expect(combined.items.map((n) => n.id)).toEqual([n3, n1]);
    expect(combined.items.every((n) => n.author.id === authorX)).toBe(true);
  });

  it('filters by target nickname honoring name history', async () => {
    const byCurrent = await feed(ownerCookie, '?player=AlphaTarget');
    expect(byCurrent.items.map((n) => n.id).sort()).toEqual([n1, n2].sort());

    const byHistory = await feed(ownerCookie, '?player=OldAlphaNick');
    expect(byHistory.items.map((n) => n.id).sort()).toEqual([n1, n2].sort());

    const byBravo = await feed(ownerCookie, '?player=Bravo');
    expect(byBravo.items.map((n) => n.id)).toEqual([n3]);
  });

  it('omits deleted notes for a user without can_edit_roles even when include_deleted=true', async () => {
    const adminCookie = await loginAs(h, authorX);
    const body = await feed(adminCookie, '?includeDeleted=true');
    expect(body.can_view_deleted).toBe(false);
    expect(body.items.map((n) => n.id)).toEqual([n3, n2, n1]);
    expect(body.items.some((n) => n.id === n4)).toBe(false);
  });

  it('shows deleted notes (struck-through metadata) to can_edit_roles when include_deleted=true', async () => {
    const body = await feed(ownerCookie, '?includeDeleted=true');
    expect(body.can_view_deleted).toBe(true);
    expect(body.items.map((n) => n.id)).toEqual([n4, n3, n2, n1]);
    const deleted = body.items.find((n) => n.id === n4);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.deleted_by?.id).toBe(h.seed.ownerPlayerId);
    expect(deleted?.deleted_by?.name).toBeTruthy();
  });

  it('paginates via a keyset cursor', async () => {
    const page1 = await feed(ownerCookie, '?limit=2');
    expect(page1.items.map((n) => n.id)).toEqual([n3, n2]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await feed(
      ownerCookie,
      `?limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? '')}`,
    );
    expect(page2.items.map((n) => n.id)).toEqual([n1]);
    expect(page2.next_cursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/notes?cursor=not-a-cursor',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  describe('GET /api/v1/notes/authors', () => {
    it('lists distinct note authors that hold a role', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/notes/authors',
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ id: string; name: string }> };
      expect(body.items.map((a) => a.id).sort()).toEqual([authorX, authorY].sort());
      expect(body.items.map((a) => a.name)).toEqual(['AdminX', 'AdminY']);
    });
  });

  describe('GET /api/v1/notes/export', () => {
    it('exports a CSV matching the active filters', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/notes/export?q=cheating&author=${authorX}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.body.trim().split('\r\n');
      expect(lines[0]).toBe(
        'created_at,author,author_role,target_player,target_player_id,body,edited,deleted,deleted_at,deleted_by',
      );
      const dataRows = lines.slice(1);
      expect(dataRows).toHaveLength(2);
      const joined = dataRows.join('\n');
      expect(joined).toContain('wallhack cheating');
      expect(joined).toContain('cheating suspected');
      expect(joined).not.toContain('cheating and toxic');
      expect(joined).not.toContain('will be deleted');
    });

    it('excludes deleted rows from CSV for a user without can_edit_roles', async () => {
      const adminCookie = await loginAs(h, authorX);
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/notes/export?includeDeleted=true',
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('will be deleted');
    });
  });
});
