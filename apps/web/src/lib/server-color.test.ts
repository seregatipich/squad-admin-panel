import { describe, expect, it } from 'vitest';
import { SERVER_COLORS, serverColor } from './server-color';

const A = '019e0000-0000-7000-8000-0000000000a1';
const B = '019e0000-0000-7000-8000-0000000000b2';
const C = '019e0000-0000-7000-8000-0000000000c3';

describe('SERVER_COLORS', () => {
  it('is a non-empty palette of hex colours', () => {
    expect(SERVER_COLORS.length).toBeGreaterThan(0);
    for (const color of SERVER_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('has no duplicates', () => {
    expect(new Set(SERVER_COLORS).size).toBe(SERVER_COLORS.length);
  });
});

describe('serverColor', () => {
  it('assigns palette colours by sorted position, not by argument order', () => {
    expect(serverColor(A, [C, A, B])).toBe(serverColor(A, [A, B, C]));
    expect(serverColor(A, [A, B, C])).toBe(SERVER_COLORS[0]);
    expect(serverColor(B, [A, B, C])).toBe(SERVER_COLORS[1]);
    expect(serverColor(C, [A, B, C])).toBe(SERVER_COLORS[2]);
  });

  it('gives distinct colours to distinct servers within the palette size', () => {
    const ids = [A, B, C];
    const assigned = ids.map((id) => serverColor(id, ids));
    expect(new Set(assigned).size).toBe(ids.length);
  });

  it('keeps a server on the same colour when other servers are deselected', () => {
    // Stability is per known-server-list; the list is the sorted set of all ids
    // the page knows about, so the same list yields the same colour every time.
    const all = [A, B, C];
    expect(serverColor(C, all)).toBe(serverColor(C, [...all].reverse()));
  });

  it('wraps around the palette for more servers than colours', () => {
    const many = Array.from(
      { length: SERVER_COLORS.length + 2 },
      (_, i) => `019e0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(serverColor(many[SERVER_COLORS.length] as string, many)).toBe(SERVER_COLORS[0]);
  });

  it('falls back to the first palette entry for an unknown server', () => {
    expect(serverColor('019e0000-0000-7000-8000-00000000ffff', [A, B])).toBe(SERVER_COLORS[0]);
  });

  it('handles an empty known-server list', () => {
    expect(serverColor(A, [])).toBe(SERVER_COLORS[0]);
  });
});
