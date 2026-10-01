/**
 * Creator crowns for the live roster (see
 * docs/components/workers/rcon/flows.md).
 *
 * Folds `squad.*` events into one history per squad creator (EOS id) for the
 * current match:
 * - grey: the creator handed command to someone while staying in the squad;
 * - red: the creator left the squad or disconnected while leading it, or the
 *   squad disbanded under them.
 * Red overrides grey. Getting command back never clears a crown, and a creator
 * who never gave up command has no crown.
 *
 * The book is in-memory in `PerServerSupervisor` and mirrored into
 * `rcon:squad-crowns:{serverId}` (only creators with a crown).
 */
import { type SquadCrown, type SquadCrownSquad, squadCrownSchema } from '@squad/shared-types';
import type { SquadEvent } from './squad-tracker.js';

export interface CreatorHistory {
  color: SquadCrown['color'] | null;
  squads: SquadCrownSquad[];
}

/** Creator EOS id → history, for the current match. */
export type CrownBook = Map<string, CreatorHistory>;

function historyFor(book: CrownBook, eosId: string): CreatorHistory {
  const existing = book.get(eosId);
  if (existing) return existing;
  const history: CreatorHistory = { color: null, squads: [] };
  book.set(eosId, history);
  return history;
}

/**
 * The creator's live record of the squad an event is about. A squad that
 * already existed when tracking started (worker restart, baseline) gets its
 * record on first use, with an unknown creation time.
 */
function squadRecord(
  history: CreatorHistory,
  squad: { team_id: number; squad_id: number; squad_name: string },
): SquadCrownSquad {
  const existing = history.squads.findLast(
    (record) =>
      record.team_id === squad.team_id &&
      record.squad_id === squad.squad_id &&
      record.disbanded_at === null,
  );
  if (existing) {
    existing.squad_name = squad.squad_name;
    return existing;
  }
  const record: SquadCrownSquad = {
    squad_name: squad.squad_name,
    team_id: squad.team_id,
    squad_id: squad.squad_id,
    created_at: null,
    handoffs: [],
    disbanded_at: null,
    abandoned_at: null,
  };
  history.squads.push(record);
  return record;
}

/**
 * Applies one event to the book in place.
 *
 * @returns The EOS id of the creator whose history changed, or `null` when the
 *   event is a change of command that did not start at the squad's creator.
 */
export function applySquadEvent(book: CrownBook, event: SquadEvent): string | null {
  const creatorEosId = event.payload.creator.eos_id;
  switch (event.type) {
    case 'squad.created': {
      historyFor(book, creatorEosId).squads.push({
        squad_name: event.payload.squad_name,
        team_id: event.payload.team_id,
        squad_id: event.payload.squad_id,
        created_at: event.at,
        handoffs: [],
        disbanded_at: null,
        abandoned_at: null,
      });
      return creatorEosId;
    }
    case 'squad.leader_changed': {
      if (event.payload.from.eos_id !== creatorEosId) return null;
      const history = historyFor(book, creatorEosId);
      const record = squadRecord(history, event.payload);
      record.handoffs.push({
        to_name: event.payload.to.name,
        reason: event.payload.reason,
        at: event.at,
      });
      if (event.payload.reason === 'passed') {
        history.color = history.color ?? 'grey';
      } else {
        history.color = 'red';
        record.abandoned_at = event.at;
      }
      return creatorEosId;
    }
    case 'squad.disbanded': {
      const history = historyFor(book, creatorEosId);
      const record = squadRecord(history, event.payload);
      record.disbanded_at = event.at;
      if (event.payload.creator_was_leader) {
        history.color = 'red';
        record.abandoned_at = event.at;
      }
      return creatorEosId;
    }
  }
}

/** The crown to publish for a creator, or `null` while they have none. */
export function crownOf(history: CreatorHistory): SquadCrown | null {
  if (history.color === null) return null;
  return { color: history.color, squads: history.squads };
}

/**
 * Rebuilds the book from `HGETALL rcon:squad-crowns:{serverId}` after a worker
 * restart. A field that is not valid JSON or does not match the contract is
 * dropped, and that creator starts over.
 */
export function crownBookFromHash(raw: Record<string, string>): CrownBook {
  const book: CrownBook = new Map();
  for (const [eosId, value] of Object.entries(raw)) {
    try {
      const parsed = squadCrownSchema.safeParse(JSON.parse(value));
      if (parsed.success) book.set(eosId, { color: parsed.data.color, squads: parsed.data.squads });
    } catch {
      // unreadable field: the creator's history restarts empty
    }
  }
  return book;
}
