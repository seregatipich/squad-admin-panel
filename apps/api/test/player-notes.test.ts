import { auditLog, playerNotes, players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000009000n;

let seq = 0;
function nextSteamId(): bigint {
  seq += 1;
  return 76561198000009100n + BigInt(seq);
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

async function createNote(
  h: IntegrationHarness,
  cookie: string,
  playerId: string,
  body: string,
): Promise<{ id: string; body: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/players/${playerId}/notes`,
    headers: { cookie },
    payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; body: string };
}

describe('player notes', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let subjectId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
    ownerCookie = await loginAsOwner(h);
  });

  beforeEach(async () => {
    // A fresh subject per case keeps list totals and ordering to the notes
    // this case wrote; `seq` keeps counting so SteamIDs never repeat.
    subjectId = await seedPlayer(h, null, 'SubjectPlayer');
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  describe('POST /api/v1/players/:playerId/notes', () => {
    it('401 without a session', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${subjectId}/notes`,
        payload: { body: 'hi' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a note with author metadata and writes an audit row', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
        payload: { body: 'подозрительный игрок' },
      });
      expect(res.statusCode).toBe(201);
      const dto = res.json() as {
        id: string;
        player_id: string;
        author: { id: string; name: string; role_color: string | null };
        body: string;
        updated_at: string | null;
        edited: boolean;
      };
      expect(dto.player_id).toBe(subjectId);
      expect(dto.body).toBe('подозрительный игрок');
      expect(dto.author.id).toBe(h.seed.ownerPlayerId);
      expect(dto.updated_at).toBeNull();
      expect(dto.edited).toBe(false);

      const auditRows = await h.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.actionType, 'player_note.create'), eq(auditLog.targetId, dto.id)));
      expect(auditRows).toHaveLength(1);
      expect((auditRows[0]?.afterSnapshot as { body: string }).body).toBe('подозрительный игрок');
      expect(auditRows[0]?.beforeSnapshot).toBeNull();
    });

    it('400 on empty/whitespace body', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
        payload: { body: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 on body over 2000 chars', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
        payload: { body: 'x'.repeat(2001) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 when the player does not exist', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/players/00000000-0000-7000-8000-000000000000/notes',
        headers: { cookie: ownerCookie },
        payload: { body: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('stores markup literally (no XSS, no escaping artifacts)', async () => {
      const payload = `<script>alert("xss")</script> "quoted" & 'apos'`;
      const created = await createNote(h, ownerCookie, subjectId, payload);
      expect(created.body).toBe(payload);

      const stored = await h.db
        .select({ body: playerNotes.body })
        .from(playerNotes)
        .where(eq(playerNotes.id, created.id))
        .limit(1);
      expect(stored[0]?.body).toBe(payload);

      const list = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
      });
      const body = list.json() as { items: Array<{ body: string }> };
      expect(body.items[0]?.body).toBe(payload);
      expect(body.items[0]?.body).not.toContain('&quot;');
      expect(body.items[0]?.body).not.toContain('&lt;');
    });

    it('publishes a note.created live event', async () => {
      const received: LiveEvent[] = [];
      const unsub = h.app.liveBus.subscribe((event) => received.push(event));
      try {
        const created = await createNote(h, ownerCookie, subjectId, 'realtime note');
        const evt = received.find((e) => e.type === 'note.created');
        expect(evt).toBeDefined();
        if (evt && evt.type === 'note.created') {
          expect(evt.data.player_id).toBe(subjectId);
          expect(evt.data.note.id).toBe(created.id);
          expect(evt.data.note.body).toBe('realtime note');
        }
      } finally {
        unsub();
      }
    });
  });

  describe('GET /api/v1/players/:playerId/notes', () => {
    it('401 without a session', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns newest-first with a total count', async () => {
      await createNote(h, ownerCookie, subjectId, 'first');
      await createNote(h, ownerCookie, subjectId, 'second');
      await createNote(h, ownerCookie, subjectId, 'third');

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ body: string }>; total: number };
      expect(body.total).toBe(3);
      expect(body.items.map((n) => n.body)).toEqual(['third', 'second', 'first']);
    });

    it('paginates via keyset cursor', async () => {
      await createNote(h, ownerCookie, subjectId, 'n1');
      await createNote(h, ownerCookie, subjectId, 'n2');
      await createNote(h, ownerCookie, subjectId, 'n3');

      const page1 = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes?limit=2`,
        headers: { cookie: ownerCookie },
      });
      const b1 = page1.json() as {
        items: Array<{ body: string }>;
        next_cursor: string | null;
        total: number;
      };
      expect(b1.items.map((n) => n.body)).toEqual(['n3', 'n2']);
      expect(b1.total).toBe(3);
      expect(b1.next_cursor).not.toBeNull();

      const page2 = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes?limit=2&cursor=${encodeURIComponent(b1.next_cursor ?? '')}`,
        headers: { cookie: ownerCookie },
      });
      const b2 = page2.json() as { items: Array<{ body: string }>; next_cursor: string | null };
      expect(b2.items.map((n) => n.body)).toEqual(['n1']);
      expect(b2.next_cursor).toBeNull();
    });

    it('hides soft-deleted notes', async () => {
      const keep = await createNote(h, ownerCookie, subjectId, 'keep');
      const drop = await createNote(h, ownerCookie, subjectId, 'drop');
      await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${drop.id}`,
        headers: { cookie: ownerCookie },
      });
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${subjectId}/notes`,
        headers: { cookie: ownerCookie },
      });
      const body = res.json() as { items: Array<{ id: string }>; total: number };
      expect(body.total).toBe(1);
      expect(body.items.map((n) => n.id)).toEqual([keep.id]);
    });
  });

  describe('PATCH /api/v1/notes/:noteId', () => {
    it('lets the author edit and marks it edited', async () => {
      const created = await createNote(h, ownerCookie, subjectId, 'before edit');
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: ownerCookie },
        payload: { body: 'after edit' },
      });
      expect(res.statusCode).toBe(200);
      const dto = res.json() as { body: string; updated_at: string | null; edited: boolean };
      expect(dto.body).toBe('after edit');
      expect(dto.edited).toBe(true);
      expect(dto.updated_at).not.toBeNull();

      const auditRows = await h.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.actionType, 'player_note.update'), eq(auditLog.targetId, created.id)),
        );
      expect(auditRows).toHaveLength(1);
      expect((auditRows[0]?.beforeSnapshot as { body: string }).body).toBe('before edit');
      expect((auditRows[0]?.afterSnapshot as { body: string }).body).toBe('after edit');
    });

    it('403 when a different admin (no can_edit_roles) edits', async () => {
      const authorId = await seedPlayer(h, 'Admin', 'AuthorAdmin');
      const authorCookie = await loginAs(h, authorId);
      const created = await createNote(h, authorCookie, subjectId, 'author note');

      const otherId = await seedPlayer(h, 'Admin', 'OtherAdmin');
      const otherCookie = await loginAs(h, otherId);
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: otherCookie },
        payload: { body: 'hijack' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('403 even for an owner editing someone else note (author-only)', async () => {
      const authorId = await seedPlayer(h, 'Admin', 'AuthorAdmin2');
      const authorCookie = await loginAs(h, authorId);
      const created = await createNote(h, authorCookie, subjectId, 'owned by admin');
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: ownerCookie },
        payload: { body: 'owner override' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404 for a missing note', async () => {
      const res = await h.app.inject({
        method: 'PATCH',
        url: '/api/v1/notes/00000000-0000-7000-8000-000000000000',
        headers: { cookie: ownerCookie },
        payload: { body: 'nope' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/notes/:noteId', () => {
    it('soft-deletes for the author and records before/after in audit_log', async () => {
      const authorId = await seedPlayer(h, 'Admin', 'DeleterAdmin');
      const authorCookie = await loginAs(h, authorId);
      const created = await createNote(h, authorCookie, subjectId, 'delete me');

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: authorCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const row = await h.db
        .select()
        .from(playerNotes)
        .where(eq(playerNotes.id, created.id))
        .limit(1);
      expect(row[0]?.deletedAt).not.toBeNull();
      expect(row[0]?.deletedBy).toBe(authorId);

      const auditRows = await h.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.actionType, 'player_note.delete'), eq(auditLog.targetId, created.id)),
        );
      expect(auditRows).toHaveLength(1);
      expect((auditRows[0]?.beforeSnapshot as { deleted_at: string | null }).deleted_at).toBeNull();
      expect(
        (auditRows[0]?.afterSnapshot as { deleted_at: string | null }).deleted_at,
      ).not.toBeNull();
    });

    it('allows an owner (can_edit_roles) to delete another admin note', async () => {
      const authorId = await seedPlayer(h, 'Admin', 'AuthorForOwnerDelete');
      const authorCookie = await loginAs(h, authorId);
      const created = await createNote(h, authorCookie, subjectId, 'owner will delete');
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
    });

    it('403 when a different admin without can_edit_roles deletes', async () => {
      const authorId = await seedPlayer(h, 'Admin', 'AuthorProtected');
      const authorCookie = await loginAs(h, authorId);
      const created = await createNote(h, authorCookie, subjectId, 'protected note');

      const otherId = await seedPlayer(h, 'Admin', 'OtherProtected');
      const otherCookie = await loginAs(h, otherId);
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: otherCookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404 on a second delete of the same note', async () => {
      const created = await createNote(h, ownerCookie, subjectId, 'once');
      await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: ownerCookie },
      });
      const second = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/notes/${created.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(second.statusCode).toBe(404);
    });
  });
});
