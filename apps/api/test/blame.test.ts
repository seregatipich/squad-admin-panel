import { describe, expect, it } from 'vitest';
import { type BlameVersion, computeBlame } from '../src/lib/blame.js';

function v(id: string, author: string | null, created_at: string, content: string): BlameVersion {
  return { id, author_player_id: author, author_label: null, created_at, content };
}

const BUDGET = { timeoutMs: 5_000 };

/** Runs computeBlame and fails the test if it ran out of its time budget. */
function mustBlame(versions: BlameVersion[], opts: { timeoutMs: number }) {
  const result = computeBlame(versions, opts);
  if (!result) throw new Error('computeBlame ran out of its time budget');
  return result;
}

describe('computeBlame', () => {
  it('#283: gives up with undefined once the diff budget is spent', () => {
    const lines = (prefix: string) =>
      Array.from({ length: 50_000 }, (_, i) => `${prefix}${i}`).join('\n');
    const started = Date.now();
    const result = computeBlame(
      [
        v('v1', 'alice', '2026-04-01T00:00:00Z', lines('x')),
        v('v2', 'bob', '2026-04-02T00:00:00Z', lines('y')),
      ],
      { timeoutMs: 50 },
    );
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns an empty array for no versions', () => {
    expect(mustBlame([], BUDGET)).toEqual([]);
  });

  it('attributes every line to the sole version when only one exists', () => {
    const result = mustBlame(
      [v('v1', 'alice', '2026-04-01T00:00:00Z', 'line-a\nline-b\n')],
      BUDGET,
    );
    expect(result).toHaveLength(3);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
    expect(result.every((l) => l.author_player_id === 'alice')).toBe(true);
  });

  it('keeps prior attribution on unchanged lines between two versions', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'keep\nkeep'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'keep\nkeep'),
    ];
    const result = mustBlame(versions, BUDGET);
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
  });

  it('attributes inserted lines to the version that inserted them', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'keep'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'keep\nnew-line'),
    ];
    const result = mustBlame(versions, BUDGET);
    expect(result[0]?.version_id).toBe('v1');
    expect(result[1]?.version_id).toBe('v2');
    expect(result[1]?.author_player_id).toBe('bob');
  });

  it('drops deleted lines from the output', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'a\nb\nc'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'a\nc'),
    ];
    const result = mustBlame(versions, BUDGET);
    expect(result.map((l) => l.text)).toEqual(['a', 'c']);
    expect(result.every((l) => l.version_id === 'v1')).toBe(true);
  });

  it('modifications reattribute only the changed lines', () => {
    const versions = [
      v('v1', 'alice', '2026-04-01T00:00:00Z', 'one\ntwo\nthree'),
      v('v2', 'bob', '2026-04-02T00:00:00Z', 'one\nTWO\nthree'),
    ];
    const result = mustBlame(versions, BUDGET);
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
    const result = mustBlame(versions, BUDGET);
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
    expect(mustBlame(versions, BUDGET).map((l) => [l.text, l.version_id])).toEqual([
      ['one', 'v1'],
      ['TWO', 'v2'],
    ]);
    expect(mustBlame([...versions].reverse(), BUDGET).map((l) => [l.text, l.version_id])).toEqual([
      ['one', 'v2'],
      ['two', 'v1'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const result = mustBlame([v('v1', 'alice', '2026-04-01T00:00:00Z', 'a\r\nb\r\nc')], BUDGET);
    expect(result.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});
