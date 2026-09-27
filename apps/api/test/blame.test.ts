import { describe, expect, it } from 'vitest';
import { type BlameVersion, computeBlame } from '../src/lib/blame.js';

function v(id: string, author: string | null, created_at: string, content: string): BlameVersion {
  return { id, author_player_id: author, author_label: null, created_at, content };
}

describe('computeBlame', () => {
  it('returns an empty array for no versions', () => {
    expect(computeBlame([])).toEqual([]);
  });

  it('attributes every line to the sole version when only one exists', () => {
    const result = computeBlame([v('v1', 'alice', '2026-04-01T00:00:00Z', 'line-a\nline-b\n')]);
    expect(result).toHaveLength(3);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
    expect(result.every((l) => l.author_player_id === 'alice')).toBe(true);
  });

  it('keeps prior attribution on unchanged lines between two versions', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'keep\nkeep'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'keep\nkeep'),
    ];
    const result = computeBlame(versions);
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
  });

  it('attributes inserted lines to the version that inserted them', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'keep'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'keep\nnew-line'),
    ];
    const result = computeBlame(versions);
    expect(result[0]?.version_id).toBe('v1');
    expect(result[1]?.version_id).toBe('v2');
    expect(result[1]?.author_player_id).toBe('bob');
  });

  it('drops deleted lines from the output', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'a\nb\nc'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'a\nc'),
    ];
    const result = computeBlame(versions);
    expect(result.map((l) => l.text)).toEqual(['a', 'c']);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
  });

  it('modifications reattribute only the changed lines', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'one\ntwo\nthree'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'one\nTWO\nthree'),
    ];
    const result = computeBlame(versions);
    expect(result[0]?.version_id).toBe('v1');
    expect(result[1]?.version_id).toBe('v2');
    expect(result[1]?.author_player_id).toBe('bob');
    expect(result[2]?.version_id).toBe('v1');
  });

  it('tip is attributed to the most recent author that touched each line across three versions', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'x\ny\nz'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'x\nY\nz'),
      v('v3', 'carol', '2026-04-03T00:00:00Z', 'x\nY\nZZ'),
    ];
    const result = computeBlame(versions);
    expect(result[0]?.author_player_id).toBe('alice');
    expect(result[1]?.author_player_id).toBe('bob');
    expect(result[2]?.author_player_id).toBe('carol');
  });

  it('walks versions in the given order even when their millisecond stamps tie (#36)', () => {
    // The route orders on the full-precision timestamp in SQL; the ISO strings
    // here are truncated, so computeBlame must not re-sort on them.
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00.000Z', 'one\ntwo'),
      v('v2', 'bob', '2026-04-01T00:00:00.000Z', 'one\nTWO'),
    ];
    expect(computeBlame(versions).map((l) => [l.text, l.version_id])).toEqual([
      ['one', 'v1'],
      ['TWO', 'v2'],
    ]);
    expect(computeBlame([...versions].reverse()).map((l) => [l.text, l.version_id])).toEqual([
      ['one', 'v2'],
      ['two', 'v1'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const result = computeBlame([v('v1', 'alice', '2026-04-01T00:00:00Z', 'a\r\nb\r\nc')]);
    expect(result.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});
