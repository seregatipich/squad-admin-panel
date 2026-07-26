import type { Diag } from '@squad/diag';
import { type MapVoteSelection, selectNextLayer } from '@squad/shared-config';
import type { RconOperatorCommandName } from '@squad/shared-types';

/** One server with GAME-1 (#80) map auto-selection enabled. */
export interface MapVoteServerEntry {
  serverId: string;
  selection: MapVoteSelection;
  layerCooldown: number;
  mapCooldown: number;
}

/** A candidate-pool row enriched with `layers` catalog data. */
export interface MapVoteCandidateEntry {
  layer: string;
  map: string;
  weight: number;
  enabled: boolean;
  deprecated: boolean;
}

export interface MapVoteAuditEntry {
  actor: { kind: 'system'; label: 'map-vote-scheduler' };
  actionType:
    | 'server.map_vote.applied'
    | 'server.map_vote.skip_depot_update'
    | 'server.map_vote.no_candidates';
  targetType: 'server';
  targetId: string;
  context: Record<string, unknown>;
}

export interface MapVoteTickDeps {
  loadEnabledServers(): Promise<MapVoteServerEntry[]>;
  getLatestMatch(serverId: string): Promise<{ id: string } | null>;
  hasPickForMatch(matchId: string): Promise<boolean>;
  loadCandidates(serverId: string): Promise<MapVoteCandidateEntry[]>;
  /** Match history for cooldowns, newest first, including the open match. */
  loadRecentMatches(
    serverId: string,
  ): Promise<Array<{ layer: string; map: string; isSeed: boolean }>>;
  /**
   * Inserts the pick row with `ON CONFLICT (match_id) DO NOTHING RETURNING`.
   * Returns the new row id, or null when another tick already owns the match.
   */
  insertPick(pick: {
    serverId: string;
    matchId: string;
    layer: string;
    selection: MapVoteSelection;
    candidateSnapshot: MapVoteCandidateEntry[];
    rngSeed: string;
  }): Promise<string | null>;
  markPickApplied(pickId: string): Promise<void>;
  setPickFailure(pickId: string, reason: string): Promise<void>;
  isDepotUpdating(): Promise<boolean>;
  sendRconCommand(
    input: { serverId: string; command: RconOperatorCommandName; args: string[] },
    requestId: string,
  ): Promise<void>;
  writeAuditEntry(entry: MapVoteAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface MapVoteTickResult {
  applied: number;
  skippedDepotUpdate: number;
  noCandidates: number;
}

/**
 * GAME-1 (#80): applies exactly one `AdminSetNextLayer` per match on every
 * server with map auto-selection enabled. Idempotency is the unique
 * `map_vote_picks.match_id` row — the pick is claimed before the RCON enqueue
 * (with the deterministic request id `map-vote:<matchId>`), so a concurrent
 * tick that loses the insert race sends nothing. A depot update marks the
 * claimed pick failed instead of enqueueing; the pick applies at match start
 * for the following match, and manual ROT-3 actions issued later always win
 * (ADR: manual admin actions win).
 */
export async function runMapVoteTick(deps: MapVoteTickDeps): Promise<MapVoteTickResult> {
  let applied = 0;
  let skippedDepotUpdate = 0;
  let noCandidates = 0;

  try {
    for (const server of await deps.loadEnabledServers()) {
      const match = await deps.getLatestMatch(server.serverId);
      if (!match) continue;
      if (await deps.hasPickForMatch(match.id)) continue;

      const [candidates, recentMatches] = await Promise.all([
        deps.loadCandidates(server.serverId),
        deps.loadRecentMatches(server.serverId),
      ]);
      const result = selectNextLayer({
        candidates,
        recentMatches,
        settings: {
          selection: server.selection,
          layerCooldown: server.layerCooldown,
          mapCooldown: server.mapCooldown,
        },
        seed: match.id,
      });

      if (result.pick === null) {
        noCandidates++;
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'map-vote-scheduler' },
          actionType: 'server.map_vote.no_candidates',
          targetType: 'server',
          targetId: server.serverId,
          context: {
            match_id: match.id,
            reason: result.reason ?? null,
            excluded: result.excluded,
          },
        });
        continue;
      }

      const pickId = await deps.insertPick({
        serverId: server.serverId,
        matchId: match.id,
        layer: result.pick,
        selection: server.selection,
        candidateSnapshot: candidates,
        rngSeed: match.id,
      });
      if (pickId === null) continue;

      if (await deps.isDepotUpdating()) {
        skippedDepotUpdate++;
        await deps.setPickFailure(pickId, 'depot_update');
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'map-vote-scheduler' },
          actionType: 'server.map_vote.skip_depot_update',
          targetType: 'server',
          targetId: server.serverId,
          context: { match_id: match.id, pick_id: pickId, layer: result.pick },
        });
        continue;
      }

      try {
        await deps.sendRconCommand(
          { serverId: server.serverId, command: 'AdminSetNextLayer', args: [result.pick] },
          `map-vote:${match.id}`,
        );
      } catch (error) {
        await deps.setPickFailure(pickId, 'rcon_enqueue_failed');
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'map_vote.rcon_failed',
          severity: 'error',
          message: `map-vote pick ${pickId} rcon enqueue failed: ${String(error)}`,
          payload: { pick_id: pickId, server_id: server.serverId, match_id: match.id },
        });
        continue;
      }

      await deps.markPickApplied(pickId);
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'map-vote-scheduler' },
        actionType: 'server.map_vote.applied',
        targetType: 'server',
        targetId: server.serverId,
        context: {
          match_id: match.id,
          pick_id: pickId,
          layer: result.pick,
          selection: server.selection,
        },
      });
      applied++;
    }

    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'map_vote.run_ok',
      severity: 'info',
      message: `applied ${applied} map-vote pick${applied === 1 ? '' : 's'}`,
      payload: {
        applied,
        skipped_depot_update: skippedDepotUpdate,
        no_candidates: noCandidates,
      },
    });
    return { applied, skippedDepotUpdate, noCandidates };
  } catch (error) {
    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'map_vote.run_failed',
      severity: 'error',
      message: `map-vote tick failed: ${String(error)}`,
      payload: { err: String(error) },
    });
    throw error;
  }
}
