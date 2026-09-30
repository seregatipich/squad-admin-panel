import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('player_sessions schema', () => {
  it('is exported from the schema surface', () => {
    expect(schema).toHaveProperty('playerSessions');
  });

  it('declares the full session column set', () => {
    const cols = getTableColumns(schema.playerSessions);
    for (const name of [
      'id',
      'playerId',
      'serverId',
      'connectedAt',
      'disconnectedAt',
      'durationSeconds',
      'closedReason',
      'mode',
    ]) {
      expect(cols).toHaveProperty(name);
    }
  });

  it('requires player/server/connected_at and allows nullable close columns', () => {
    const cols = getTableColumns(schema.playerSessions);
    expect(cols.playerId.notNull).toBe(true);
    expect(cols.serverId.notNull).toBe(true);
    expect(cols.connectedAt.notNull).toBe(true);
    expect(cols.disconnectedAt.notNull).toBe(false);
    expect(cols.durationSeconds.notNull).toBe(false);
    expect(cols.closedReason.notNull).toBe(false);
  });

  it('defaults mode to online', () => {
    const cols = getTableColumns(schema.playerSessions);
    expect(cols.mode.notNull).toBe(true);
    expect(cols.mode.default).toBe('online');
  });

  it('maps camelCase fields to snake_case columns', () => {
    const cols = getTableColumns(schema.playerSessions);
    expect(cols.playerId.name).toBe('player_id');
    expect(cols.serverId.name).toBe('server_id');
    expect(cols.connectedAt.name).toBe('connected_at');
    expect(cols.disconnectedAt.name).toBe('disconnected_at');
    expect(cols.durationSeconds.name).toBe('duration_seconds');
    expect(cols.closedReason.name).toBe('closed_reason');
  });

  it('pins the closed_reason and mode vocabularies', () => {
    expect(schema.CLOSED_REASONS).toEqual(['disconnect', 'server_crashed', 'kicked', 'banned']);
    expect(schema.SESSION_MODES).toEqual(['online', 'boost', 'queue', 'seed']);
  });
});
