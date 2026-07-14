import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('external ban sources schema', () => {
  it('exports the two new tables', () => {
    expect(schema).toHaveProperty('externalBanSources');
    expect(schema).toHaveProperty('externalBans');
  });

  it('external_ban_sources: name/url/format are NOT NULL, auth header is nullable and secret', () => {
    const cols = getTableColumns(schema.externalBanSources);
    expect(cols.name.notNull).toBe(true);
    expect(cols.url.notNull).toBe(true);
    expect(cols.format.notNull).toBe(true);
    expect(cols.authHeaderEncrypted.notNull).toBe(false);
    expect(cols.enabled.notNull).toBe(true);
    expect(cols.pollIntervalMinutes.notNull).toBe(true);
  });

  it('external_ban_sources: trust_level defaults to normal, poll interval defaults to 60', () => {
    const cols = getTableColumns(schema.externalBanSources);
    expect(cols.trustLevel.default).toBe('normal');
    expect(cols.pollIntervalMinutes.default).toBe(60);
    expect(cols.enabled.default).toBe(true);
    expect(cols.importedCount.default).toBe(0);
    expect(cols.onMatch.default).toBe('alert');
    expect(cols.onMatch.notNull).toBe(true);
  });

  it('external_bans: steam_id64 and eos_id are nullable (no players FK), source_id NOT NULL', () => {
    const cols = getTableColumns(schema.externalBans);
    expect(cols.steamId64.notNull).toBe(false);
    expect(cols.eosId.notNull).toBe(false);
    expect(cols.sourceId.notNull).toBe(true);
    expect(cols.raw.notNull).toBe(true);
  });

  it('roles table carries the can_manage_ban_sources panel flag (default false)', () => {
    const cols = getTableColumns(schema.roles);
    expect(cols.canManageBanSources.notNull).toBe(true);
    expect(cols.canManageBanSources.default).toBe(false);
  });
});
