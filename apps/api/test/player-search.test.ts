import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { escapeLike, steamId64Equals } from '../src/lib/player-search.js';

/** #40, finding #1328: search helpers shared by the player-name search routes. */
const dialect = new PgDialect();

describe('steamId64Equals', () => {
  it('compares the column to a bigint parameter instead of casting the column', () => {
    const query = dialect.sqlToQuery(steamId64Equals(sql`p.steam_id64`, '76561198000000001'));
    expect(query.sql).toBe('p.steam_id64 = $1::bigint');
    expect(query.params).toEqual(['76561198000000001']);
  });

  it.each([
    ['a name', 'Bravo'],
    ['a mixed string', '7656x'],
    ['an empty string', ''],
    ['a number above bigint', '9223372036854775808'],
    ['a string longer than 19 digits', '1'.repeat(20)],
  ])('renders false for %s', (_label, input) => {
    expect(dialect.sqlToQuery(steamId64Equals(sql`p.steam_id64`, input)).sql).toBe('false');
  });

  it('accepts the largest bigint', () => {
    const query = dialect.sqlToQuery(steamId64Equals(sql`c`, '9223372036854775807'));
    expect(query.params).toEqual(['9223372036854775807']);
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and the backslash so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeLike('Bravo zz')).toBe('Bravo zz');
  });
});
