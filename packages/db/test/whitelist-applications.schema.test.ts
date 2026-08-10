import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('whitelist_applications schema (WL-3)', () => {
  it('is exported from the schema surface', () => {
    expect(schema).toHaveProperty('whitelistApplications');
  });

  it('declares the full WL-3 column set with correct nullability', () => {
    const cols = getTableColumns(schema.whitelistApplications);

    // Required identity + payload.
    expect(cols.id.notNull).toBe(true);
    expect(cols.steamId64.notNull).toBe(true);
    expect(cols.body.notNull).toBe(true);
    expect(cols.status.notNull).toBe(true);
    expect(cols.source.notNull).toBe(true);
    expect(cols.createdAt.notNull).toBe(true);

    // Optional/nullable columns.
    expect(cols.playerId.notNull).toBe(false);
    expect(cols.contact.notNull).toBe(false);
    expect(cols.requestedRoleId.notNull).toBe(false);
    expect(cols.reviewerPlayerId.notNull).toBe(false);
    expect(cols.reviewNote.notNull).toBe(false);
    expect(cols.grantedRoleId.notNull).toBe(false);
    expect(cols.grantedUntil.notNull).toBe(false);
    expect(cols.decidedAt.notNull).toBe(false);
  });

  it('defaults status to pending and source to public', () => {
    const cols = getTableColumns(schema.whitelistApplications);
    expect(cols.status.default).toBe('pending');
    expect(cols.source.default).toBe('public');
  });

  it('maps camelCase fields to snake_case columns', () => {
    const cols = getTableColumns(schema.whitelistApplications);
    expect(cols.steamId64.name).toBe('steam_id64');
    expect(cols.playerId.name).toBe('player_id');
    expect(cols.requestedRoleId.name).toBe('requested_role_id');
    expect(cols.reviewerPlayerId.name).toBe('reviewer_player_id');
    expect(cols.reviewNote.name).toBe('review_note');
    expect(cols.grantedRoleId.name).toBe('granted_role_id');
    expect(cols.grantedUntil.name).toBe('granted_until');
    expect(cols.decidedAt.name).toBe('decided_at');
  });

  it('stores SteamID64 as a bigint', () => {
    const cols = getTableColumns(schema.whitelistApplications);
    expect(cols.steamId64.dataType).toBe('bigint');
  });
});

describe('panel_meta gains the WL-3 portal switch + default term', () => {
  it('adds whitelist_applications_enabled (NOT NULL, default false)', () => {
    const cols = getTableColumns(schema.panelMeta);
    expect(cols.whitelistApplicationsEnabled).toBeDefined();
    expect(cols.whitelistApplicationsEnabled.name).toBe('whitelist_applications_enabled');
    expect(cols.whitelistApplicationsEnabled.notNull).toBe(true);
    expect(cols.whitelistApplicationsEnabled.default).toBe(false);
  });

  it('adds a nullable whitelist_application_default_days (NULL = permanent grant)', () => {
    const cols = getTableColumns(schema.panelMeta);
    expect(cols.whitelistApplicationDefaultDays).toBeDefined();
    expect(cols.whitelistApplicationDefaultDays.name).toBe('whitelist_application_default_days');
    expect(cols.whitelistApplicationDefaultDays.notNull).toBe(false);
  });
});
