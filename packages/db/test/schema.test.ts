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

  it('player_discord_links enforces 1:1 in both directions (DISCORD-4)', () => {
    const config = getTableConfig(schema.playerDiscordLinks);
    expect(config.name).toBe('player_discord_links');

    // One link per player: player_id is the primary key.
    expect(config.columns.find((c) => c.name === 'player_id')?.primary).toBe(true);

    // One player per Discord account: discord_user_id is unique.
    const discordUserId = config.columns.find((c) => c.name === 'discord_user_id');
    expect(discordUserId?.isUnique).toBe(true);
    expect(discordUserId?.notNull).toBe(true);

    expect(config.columns.find((c) => c.name === 'discord_username')?.notNull).toBe(true);
    expect(config.columns.find((c) => c.name === 'linked_at')?.notNull).toBe(true);

    // Deleting a player takes its Discord link with it.
    const fk = config.foreignKeys.map((k) => k.reference())[0];
    expect(fk?.foreignTable).toBe(schema.players);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('discord_role_mappings maps one panel role to at most one Discord role (DISCORD-5)', () => {
    const config = getTableConfig(schema.discordRoleMappings);
    expect(config.name).toBe('discord_role_mappings');

    expect(config.columns.find((c) => c.name === 'role_id')?.notNull).toBe(true);
    expect(config.columns.find((c) => c.name === 'discord_role_id')?.notNull).toBe(true);
    expect(config.columns.find((c) => c.name === 'enabled')?.notNull).toBe(true);

    // One panel role ↔ one Discord role.
    const roleIdKey = config.indexes.find(
      (index) => index.config.name === 'discord_role_mappings_role_id_key',
    );
    expect(roleIdKey?.config.unique).toBe(true);
    expect(roleIdKey?.config.columns.map((c) => (c as { name?: string }).name)).toEqual([
      'role_id',
    ]);

    // Reconcile walks mappings by Discord role id.
    expect(
      config.indexes.find(
        (index) => index.config.name === 'discord_role_mappings_discord_role_id_idx',
      ),
    ).toBeDefined();

    // Deleting a panel role takes its mapping with it.
    const fk = config.foreignKeys.map((k) => k.reference())[0];
    expect(fk?.foreignTable).toBe(schema.roles);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('issue_links carries the entity-type check, the uniqueness key and a cascading issue_id', () => {
    const config = getTableConfig(schema.issueLinks);
    const entityTypeCheck = config.checks.find(
      (check) => check.name === 'issue_links_entity_type_check',
    );
    expect(entityTypeCheck).toBeDefined();

    const issueEntityKey = config.indexes.find(
      (index) => index.config.name === 'issue_links_issue_entity_key',
    );
    expect(issueEntityKey).toBeDefined();
    expect(issueEntityKey?.config.unique).toBe(true);
    expect(issueEntityKey?.config.columns.map((c) => (c as { name?: string }).name)).toEqual([
      'issue_id',
      'entity_type',
      'entity_id',
    ]);

    // entity_id is polymorphic across four tables, so issue_id is the only
    // cascading foreign key; created_by nulls out instead.
    const issueFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => (c as { name?: string }).name === 'issue_id'),
    );
    expect(issueFk?.onDelete).toBe('cascade');
    const createdByFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => (c as { name?: string }).name === 'created_by'),
    );
    expect(createdByFk?.onDelete).toBe('set null');
  });

  it('media_upload_tokens hashes its credential and pairs its target both-or-neither', () => {
    const config = getTableConfig(schema.mediaUploadTokens);
    const cols = getTableColumns(schema.mediaUploadTokens);

    // The raw token is never a column — only its digest is storable.
    expect(cols.tokenHash).toBeDefined();
    expect(cols.tokenHash.notNull).toBe(true);
    expect(Object.keys(cols)).not.toContain('token');
    expect(cols.usedAt.notNull).toBe(false);
    expect(cols.expiresAt.notNull).toBe(true);

    const tokenHashKey = config.indexes.find(
      (index) => index.config.name === 'media_upload_tokens_token_hash_key',
    );
    expect(tokenHashKey?.config.unique).toBe(true);

    expect(
      config.checks.find((check) => check.name === 'media_upload_tokens_target_pair_check'),
    ).toBeDefined();
    expect(
      config.checks.find((check) => check.name === 'media_upload_tokens_target_type_check'),
    ).toBeDefined();
  });

  it('media_files carries the nullable upload_token_id provenance column', () => {
    const cols = getTableColumns(schema.mediaFiles);
    expect(cols.uploadTokenId).toBeDefined();
    expect(cols.uploadTokenId.notNull).toBe(false);
  });
});
