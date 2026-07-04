import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('player_reports schema', () => {
  it('is exported from the schema surface', () => {
    expect(schema).toHaveProperty('playerReports');
  });

  it('declares the full report lifecycle column set', () => {
    const cols = getTableColumns(schema.playerReports);
    const expected = [
      'id',
      'serverId',
      'reporterPlayerId',
      'targetPlayerId',
      'targetRaw',
      'body',
      'source',
      'status',
      'handlerPlayerId',
      'resolutionNote',
      'createdAt',
      'claimedAt',
      'resolvedAt',
    ];
    for (const name of expected) {
      expect(cols).toHaveProperty(name);
    }
  });

  it('requires server_id and body but allows nullable reporter/target', () => {
    const cols = getTableColumns(schema.playerReports);
    expect(cols.serverId.notNull).toBe(true);
    expect(cols.body.notNull).toBe(true);
    expect(cols.source.notNull).toBe(true);
    expect(cols.reporterPlayerId.notNull).toBe(false);
    expect(cols.targetPlayerId.notNull).toBe(false);
    expect(cols.resolutionNote.notNull).toBe(false);
    expect(cols.claimedAt.notNull).toBe(false);
    expect(cols.resolvedAt.notNull).toBe(false);
  });

  it('defaults status to pending', () => {
    const cols = getTableColumns(schema.playerReports);
    expect(cols.status.default).toBe('pending');
    expect(cols.status.notNull).toBe(true);
  });

  it('maps camelCase fields to snake_case columns', () => {
    const cols = getTableColumns(schema.playerReports);
    expect(cols.reporterPlayerId.name).toBe('reporter_player_id');
    expect(cols.targetPlayerId.name).toBe('target_player_id');
    expect(cols.targetRaw.name).toBe('target_raw');
    expect(cols.handlerPlayerId.name).toBe('handler_player_id');
    expect(cols.resolutionNote.name).toBe('resolution_note');
  });
});
