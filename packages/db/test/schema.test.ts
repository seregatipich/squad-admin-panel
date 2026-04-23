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
});
