import { playerNotes, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

/**
 * Issue #78 (finding 1137): notes are historical records. Deleting the player
 * who wrote one must keep the note, and the read routes must render it with a
 * placeholder author instead of dropping it (the old inner join) or removing
 * it (the old ON DELETE CASCADE).
 */
const OWNER_STEAM_ID = 76561198000029000n;
const SUBJECT_STEAM_ID = 76561198000029101n;
const AUTHOR_STEAM_ID = 76561198000029102n;
const DELETED_AUTHOR_NAME = 'Удалённый игрок';

async function seedPlayer(h: IntegrationHarness, steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() })
    .returning({ id: players.id });
  if (!row) throw new Error('player insert failed');
  return row.id;
}

async function deletePlayer(h: IntegrationHarness, steamId: bigint): Promise<void> {
  await h.db.delete(players).where(eq(players.steamId64, steamId));
}

describe('notes whose author was deleted (#1137)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let subjectId: string;
  let noteId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
    ownerCookie = await loginAsOwner(h);
    subjectId = await seedPlayer(h, SUBJECT_STEAM_ID, 'DeletedAuthorSubject');
    const authorId = await seedPlayer(h, AUTHOR_STEAM_ID, 'DoomedAuthor');
    noteId = uuidv7();
    await h.db
      .insert(playerNotes)
      .values({ id: noteId, playerId: subjectId, authorId, body: 'history must survive' });
    await deletePlayer(h, AUTHOR_STEAM_ID);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('keeps the note row with a null author', async () => {
    const [row] = await h.db.select().from(playerNotes).where(eq(playerNotes.id, noteId));
    expect(row).toBeDefined();
    expect(row?.authorId).toBeNull();
  });

  it('lists the note on the player with a placeholder author', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${subjectId}/notes`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { id: string; author: { id: string; name: string; role_color: string | null } }[];
    };
    const item = body.items.find((note) => note.id === noteId);
    expect(item?.author).toEqual({ id: '', name: DELETED_AUTHOR_NAME, role_color: null });
  });

  it('shows the note in the global feed and the CSV export', async () => {
    const feed = await h.app.inject({
      method: 'GET',
      url: '/api/v1/notes?player=DeletedAuthorSubject',
      headers: { cookie: ownerCookie },
    });
    expect(feed.statusCode).toBe(200);
    const items = (feed.json() as { items: { id: string; author: { id: string; name: string } }[] })
      .items;
    expect(items.find((note) => note.id === noteId)?.author).toMatchObject({
      id: '',
      name: DELETED_AUTHOR_NAME,
    });

    const exported = await h.app.inject({
      method: 'GET',
      url: '/api/v1/notes/export?player=DeletedAuthorSubject',
      headers: { cookie: ownerCookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain(DELETED_AUTHOR_NAME);
  });

  it('refuses edits from anyone else, since nobody is the author any more', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: ownerCookie },
      payload: { body: 'rewritten' },
    });
    expect(res.statusCode).toBe(403);
  });
});
