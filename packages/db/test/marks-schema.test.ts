import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { markTypes, playerMarks } from '../src/schema/marks.js';

describe('marks schema surface', () => {
  it('exports markTypes and playerMarks tables', () => {
    expect(schema).toHaveProperty('markTypes');
    expect(schema).toHaveProperty('playerMarks');
  });

  it('mark_types has the SQSTAT taxonomy columns', () => {
    const cols = getTableColumns(markTypes);
    for (const name of [
      'id',
      'slug',
      'labelEn',
      'labelRu',
      'icon',
      'severity',
      'isActive',
      'sortOrder',
    ]) {
      expect(cols).toHaveProperty(name);
    }
    expect(cols.slug.notNull).toBe(true);
    expect(cols.isActive.notNull).toBe(true);
    expect(cols.isActive.hasDefault).toBe(true);
  });

  it('player_marks stamps author on create and preserves clearing metadata', () => {
    const cols = getTableColumns(playerMarks);
    expect(cols.playerId.notNull).toBe(true);
    expect(cols.markTypeId.notNull).toBe(true);
    expect(cols.createdBy.notNull).toBe(true);
    expect(cols.comment.notNull).toBe(false);
    expect(cols.clearedBy.notNull).toBe(false);
    expect(cols.clearedAt.notNull).toBe(false);
    expect(cols.clearReason.notNull).toBe(false);
  });

  it('player_marks primary key is a uuid', () => {
    const cols = getTableColumns(playerMarks);
    expect(cols.id.primary).toBe(true);
    expect(cols.id.columnType).toBe('PgUUID');
  });
});
