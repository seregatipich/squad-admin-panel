import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '..', 'drizzle');

describe('balancer_settings schema (GAME-2, #81)', () => {
  it('is exported from the schema surface as a singleton table', () => {
    expect(schema).toHaveProperty('balancerSettings');
    expect(getTableName(schema.balancerSettings)).toBe('balancer_settings');
  });

  it('declares every threshold column NOT NULL with the documented default', () => {
    const cols = getTableColumns(schema.balancerSettings);
    expect(cols.enabled.default).toBe(false);
    expect(cols.winStreakThreshold.default).toBe(3);
    expect(cols.ticketDiffThreshold.default).toBe(150);
    expect(cols.oneSidedRoundsThreshold.default).toBe(2);
    expect(cols.quorum.default).toBe(5);
    expect(cols.passThresholdPct.default).toBe(60);
    expect(cols.requireModeratorVeto.default).toBe(false);
    expect(cols.preferSquadGrouping.default).toBe(true);
    expect(cols.playerLevelEnabled.default).toBe(false);
    for (const key of [
      'enabled',
      'winStreakThreshold',
      'ticketDiffThreshold',
      'oneSidedRoundsThreshold',
      'quorum',
      'passThresholdPct',
      'requireModeratorVeto',
      'preferSquadGrouping',
      'playerLevelEnabled',
    ] as const) {
      expect(cols[key].notNull, key).toBe(true);
    }
  });

  it('maps camelCase props to snake_case columns and keeps the actor nullable', () => {
    const cols = getTableColumns(schema.balancerSettings);
    expect(cols.winStreakThreshold.name).toBe('win_streak_threshold');
    expect(cols.ticketDiffThreshold.name).toBe('ticket_diff_threshold');
    expect(cols.oneSidedRoundsThreshold.name).toBe('one_sided_rounds_threshold');
    expect(cols.passThresholdPct.name).toBe('pass_threshold_pct');
    expect(cols.requireModeratorVeto.name).toBe('require_moderator_veto');
    expect(cols.preferSquadGrouping.name).toBe('prefer_squad_grouping');
    expect(cols.playerLevelEnabled.name).toBe('player_level_enabled');
    expect(cols.updatedByPlayerId.name).toBe('updated_by_player_id');
    expect(cols.updatedByPlayerId.notNull).toBe(false);
  });
});

describe('balancer_proposals schema (GAME-2, #81)', () => {
  it('is exported from the schema surface', () => {
    expect(schema).toHaveProperty('balancerProposals');
    expect(getTableName(schema.balancerProposals)).toBe('balancer_proposals');
  });

  it('stores signals and proposal as jsonb so exporter drift needs no migration', () => {
    const cols = getTableColumns(schema.balancerProposals);
    expect(cols.signals.dataType).toBe('json');
    expect(cols.proposal.dataType).toBe('json');
    expect(cols.signals.notNull).toBe(true);
    expect(cols.proposal.notNull).toBe(true);
    expect(cols.schemaVersion.name).toBe('schema_version');
    expect(cols.schemaVersion.notNull).toBe(true);
    expect(cols.schemaVersion.default).toBe(1);
  });

  it('carries the exporter idempotency key and the review status', () => {
    const cols = getTableColumns(schema.balancerProposals);
    expect(cols.sourceSnapshotId.name).toBe('source_snapshot_id');
    expect(cols.sourceSnapshotId.notNull).toBe(true);
    expect(cols.status.default).toBe('open');
    expect(cols.status.notNull).toBe(true);
    expect(cols.mode.notNull).toBe(true);
    expect(cols.generatedAt.name).toBe('generated_at');
    expect(cols.generatedAt.notNull).toBe(true);
  });

  it('keeps the optional match/layer/gamemode context nullable', () => {
    const cols = getTableColumns(schema.balancerProposals);
    expect(cols.matchId.notNull).toBe(false);
    expect(cols.layer.notNull).toBe(false);
    expect(cols.gamemode.notNull).toBe(false);
  });
});

describe('balancer_decisions schema (GAME-2, #81)', () => {
  it('is exported from the schema surface', () => {
    expect(schema).toHaveProperty('balancerDecisions');
    expect(getTableName(schema.balancerDecisions)).toBe('balancer_decisions');
  });

  it('requires a proposal and a decision, and keeps the veto reason nullable', () => {
    const cols = getTableColumns(schema.balancerDecisions);
    expect(cols.proposalId.name).toBe('proposal_id');
    expect(cols.proposalId.notNull).toBe(true);
    expect(cols.decision.notNull).toBe(true);
    expect(cols.vetoReasonKind.name).toBe('veto_reason_kind');
    expect(cols.vetoReasonKind.notNull).toBe(false);
    expect(cols.vetoReason.notNull).toBe(false);
    expect(cols.decidedByPlayerId.name).toBe('decided_by_player_id');
    expect(cols.decidedByPlayerId.notNull).toBe(false);
  });
});

describe('migration 0103_balancer', () => {
  const sql = readFileSync(path.join(drizzleDir, '0103_balancer.sql'), 'utf-8');

  it('creates all three balancer tables in one file', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS balancer_settings');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS balancer_proposals');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS balancer_decisions');
  });

  it('declares the documented CHECK constraints', () => {
    expect(sql).toContain('balancer_settings_singleton');
    expect(sql).toContain('balancer_proposals_mode_check');
    expect(sql).toContain('balancer_proposals_status_check');
    expect(sql).toContain('balancer_decisions_decision_check');
    expect(sql).toContain('balancer_decisions_veto_reason_required');
  });

  it('declares the unique snapshot key and the lookup indexes', () => {
    expect(sql).toContain('balancer_proposals_source_snapshot_key');
    expect(sql).toContain('balancer_proposals_server_generated_idx');
    expect(sql).toContain('balancer_proposals_status_idx');
    expect(sql).toContain('balancer_decisions_proposal_idx');
  });

  it('is registered in the drizzle journal at the reserved slot', () => {
    const journal = JSON.parse(
      readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entry = journal.entries.find((e) => e.tag === '0103_balancer');
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(88);
    expect(entry?.when).toBe(1783403300000);
  });
});
