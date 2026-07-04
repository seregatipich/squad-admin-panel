import { describe, expect, it } from 'vitest';
import type { PlayerNote } from './live-bus';
import { formatRelativeNote, prependNote, removeNote, replaceNote } from './player-notes';

function note(id: string, body = 'x'): PlayerNote {
  return {
    id,
    player_id: 'p1',
    author: { id: 'a1', name: 'Admin', role_color: 'sky' },
    body,
    created_at: '2026-07-04T10:00:00.000Z',
    updated_at: null,
    edited: false,
  };
}

describe('prependNote', () => {
  it('adds a new note to the front', () => {
    const result = prependNote([note('a')], note('b'));
    expect(result.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('is idempotent for a duplicate id (dedupes the echoed WS event)', () => {
    const initial = [note('a')];
    const result = prependNote(initial, note('a'));
    expect(result).toBe(initial);
  });
});

describe('replaceNote', () => {
  it('swaps the matching note by id', () => {
    const result = replaceNote([note('a', 'old'), note('b', 'keep')], note('a', 'new'));
    expect(result.find((n) => n.id === 'a')?.body).toBe('new');
    expect(result.find((n) => n.id === 'b')?.body).toBe('keep');
  });
});

describe('removeNote', () => {
  it('drops the note with the given id', () => {
    const result = removeNote([note('a'), note('b')], 'a');
    expect(result.map((n) => n.id)).toEqual(['b']);
  });
});

describe('formatRelativeNote', () => {
  const base = Date.parse('2026-07-04T12:00:00.000Z');

  it('reports fresh notes as "только что"', () => {
    expect(formatRelativeNote('2026-07-04T11:59:40.000Z', base)).toBe('только что');
  });

  it('reports minutes', () => {
    expect(formatRelativeNote('2026-07-04T11:30:00.000Z', base)).toBe('30 мин назад');
  });

  it('reports hours', () => {
    expect(formatRelativeNote('2026-07-04T09:00:00.000Z', base)).toBe('3 ч назад');
  });

  it('reports days', () => {
    expect(formatRelativeNote('2026-07-01T12:00:00.000Z', base)).toBe('3 дн назад');
  });

  it('returns empty string for an invalid date', () => {
    expect(formatRelativeNote('not-a-date', base)).toBe('');
  });
});
