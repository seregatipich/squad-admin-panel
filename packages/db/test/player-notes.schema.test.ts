import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { playerNotes } from '../src/schema/player-notes.js';

describe('player_notes schema', () => {
  it('is exported from the schema barrel', () => {
    expect(schema).toHaveProperty('playerNotes');
  });

  it('maps to the player_notes table', () => {
    expect(getTableName(playerNotes)).toBe('player_notes');
  });

  it('requires id, player_id and body, and keeps a note whose author was deleted (#1137)', () => {
    const cols = getTableColumns(playerNotes);
    expect(cols.id.notNull).toBe(true);
    expect(cols.playerId.notNull).toBe(true);
    expect(cols.authorId.notNull).toBe(false);
    expect(cols.body.notNull).toBe(true);
    expect(cols.createdAt.notNull).toBe(true);
  });

  it('keeps edit/soft-delete columns nullable', () => {
    const cols = getTableColumns(playerNotes);
    expect(cols.updatedAt.notNull).toBe(false);
    expect(cols.deletedAt.notNull).toBe(false);
    expect(cols.deletedBy.notNull).toBe(false);
  });
});
