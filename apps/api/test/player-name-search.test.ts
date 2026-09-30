import { events, players } from '@squad/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { playerNameMatch } from '../src/lib/player-name-search.js';

const dialect = new PgDialect();

/**
 * Audit #117/#118/#138 — the routes used to load every player whose name
 * contained the query and bind each id as its own `IN (...)` parameter, so a
 * one-letter search on a large database crossed Postgres' 65 535 bind limit
 * and answered 500. The shared predicate keeps the match in a subquery.
 */
describe('playerNameMatch', () => {
  it('binds a fixed number of parameters however many players could match', () => {
    const predicate = playerNameMatch(players.id, 'a');
    if (!predicate) throw new Error('expected a predicate');
    const query = dialect.sqlToQuery(predicate);
    expect(query.params).toEqual(['%a%', '%a%']);
    expect(query.sql).toMatch(/select/i);
    expect(query.sql).toContain('player_name_history');
  });

  it('normalises the query like stored names: clan tag stripped, spaces collapsed, lowercased', () => {
    const predicate = playerNameMatch(players.id, '  [TAG]  Some   Nick ');
    if (!predicate) throw new Error('expected a predicate');
    expect(dialect.sqlToQuery(predicate).params).toEqual(['%some nick%', '%some nick%']);
  });

  it('escapes LIKE wildcards in the query', () => {
    const predicate = playerNameMatch(players.id, '100%_\\');
    if (!predicate) throw new Error('expected a predicate');
    expect(dialect.sqlToQuery(predicate).params).toEqual(['%100\\%\\_\\\\%', '%100\\%\\_\\\\%']);
  });

  it('casts the ids to text for a text player-id column such as events.actor_id', () => {
    const predicate = playerNameMatch(events.actorId, 'nick');
    if (!predicate) throw new Error('expected a predicate');
    expect(dialect.sqlToQuery(predicate).sql).toContain('::text');
    const uuidPredicate = playerNameMatch(players.id, 'nick');
    if (!uuidPredicate) throw new Error('expected a predicate');
    expect(dialect.sqlToQuery(uuidPredicate).sql).not.toContain('::text');
  });

  it('returns null for a query that is blank after normalisation', () => {
    expect(playerNameMatch(players.id, '   ')).toBeNull();
  });
});
