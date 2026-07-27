import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('schema surface', () => {
  it('exports every P0 table', () => {
    const expected = [
      'sessions',
      'playerApiTokens',
      'roles',
      'rolePermissions',
      'servers',
      'serverCredentials',
      'serverSettings',
      'players',
      'playerNameHistory',
      'playerIpHistory',
      'events',
      'auditLog',
      'configVersions',
      'panelMeta',
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

  it('exports the issue-tracker tables and roles.can_manage_issues flag', () => {
    for (const name of ['issues', 'issueLabels', 'issueLabelLinks', 'issueComments']) {
      expect(schema).toHaveProperty(name);
    }
    expect(getTableColumns(schema.roles).canManageIssues.notNull).toBe(true);
  });

  it('issues.author_player_id is NOT NULL and assignee is nullable', () => {
    const cols = getTableColumns(schema.issues);
    expect(cols.authorPlayerId.notNull).toBe(true);
    expect(cols.assigneePlayerId.notNull).toBe(false);
    expect(cols.state.notNull).toBe(true);
  });

  it('players role assignment stores optional expiry and operator comment', () => {
    const cols = getTableColumns(schema.players);
    expect(cols.roleExpiresAt).toBeDefined();
    expect(cols.roleExpiresAt.notNull).toBe(false);
    expect(cols.roleComment).toBeDefined();
    expect(cols.roleComment.notNull).toBe(false);
  });

  it('vip_tiers carries nullable price_bonuses', () => {
    const cols = getTableColumns(schema.vipTiers);
    expect(cols.priceBonuses).toBeDefined();
    expect(cols.priceBonuses.notNull).toBe(false);
  });

  it('media_links carries the entity-type check and the uniqueness key', () => {
    const config = getTableConfig(schema.mediaLinks);
    const entityTypeCheck = config.checks.find(
      (check) => check.name === 'media_links_entity_type_check',
    );
    expect(entityTypeCheck).toBeDefined();

    const mediaEntityKey = config.indexes.find(
      (index) => index.config.name === 'media_links_media_entity_key',
    );
    expect(mediaEntityKey).toBeDefined();
    expect(mediaEntityKey?.config.unique).toBe(true);
    expect(mediaEntityKey?.config.columns.map((c) => (c as { name?: string }).name)).toEqual([
      'media_id',
      'entity_type',
      'entity_id',
    ]);
  });
});
