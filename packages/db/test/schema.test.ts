import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('schema surface', () => {
  it('exports every P0 table', () => {
    const expected = [
      'users',
      'sessions',
      'userIdentities',
      'userApiTokens',
      'organizations',
      'organizationMembers',
      'roles',
      'rolePermissions',
      'roleServerScopes',
      'userRoleAssignments',
      'servers',
      'serverCredentials',
      'serverSettings',
      'players',
      'playerNameHistory',
      'playerIpHistory',
      'events',
      'processedEvents',
      'auditLog',
    ];
    for (const name of expected) {
      expect(schema).toHaveProperty(name);
    }
  });

  it('server_credentials.rcon_host is nullable (per-service RCON_HOST_DEFAULT fallback)', () => {
    // The column used to be NOT NULL DEFAULT '127.0.0.1', which baked a
    // value that worked for worker-rcon (--network host) but not api
    // (bridge network). Migration 0007 dropped NOT NULL so NULL means
    // "resolve against my caller's RCON_HOST_DEFAULT env var".
    const cols = getTableColumns(schema.serverCredentials);
    expect(cols.rconHost.notNull).toBe(false);
  });

  it('server_credentials primary key columns are NOT NULL', () => {
    const cols = getTableColumns(schema.serverCredentials);
    expect(cols.serverId.notNull).toBe(true);
    expect(cols.rconPort.notNull).toBe(true);
    expect(cols.rconPasswordEncrypted.notNull).toBe(true);
  });
});
