/**
 * Contract of the `rcon:squad-crowns:{serverId}` Redis hash (squad history,
 * docs/superpowers/specs/2026-09-27-squad-history-design.md §2).
 *
 * worker-rcon writes one field per squad creator (EOS id) whose leadership
 * earned a crown in the current match, and deletes the hash on a match reset.
 * `GET /api/v1/servers/:id/roster` reads it and attaches the matching entry to
 * each roster player as `squad_crown`.
 */
import { z } from 'zod';
import { squadLeaderChangeReason } from './events.js';

export const SQUAD_CROWNS_KEY_PREFIX = 'rcon:squad-crowns:';

/** Refreshed on every write; a hash whose server stopped reporting expires on its own. */
export const SQUAD_CROWNS_TTL_SECONDS = 6 * 60 * 60;

/** Redis key of one server's crown hash. */
export function squadCrownsKey(serverId: string): string {
  return `${SQUAD_CROWNS_KEY_PREFIX}${serverId}`;
}

/** One change of command away from the creator. */
export const squadCrownHandoffSchema = z
  .object({
    to_name: z.string(),
    reason: squadLeaderChangeReason,
    at: z.string().datetime(),
  })
  .strict();

/** One squad the creator made in the current match. */
export const squadCrownSquadSchema = z
  .object({
    squad_name: z.string(),
    team_id: z.number().int(),
    squad_id: z.number().int(),
    /** `null` when the squad already existed when the worker started tracking it. */
    created_at: z.string().datetime().nullable(),
    handoffs: z.array(squadCrownHandoffSchema),
    disbanded_at: z.string().datetime().nullable(),
    /** When the creator left the squad, disconnected, or let it disband while leading it. */
    abandoned_at: z.string().datetime().nullable(),
  })
  .strict();

/** A creator's crown: `grey` handed command to a squadmate, `red` abandoned a squad while leading it. */
export const squadCrownSchema = z
  .object({
    color: z.enum(['grey', 'red']),
    squads: z.array(squadCrownSquadSchema),
  })
  .strict();

export type SquadCrownHandoff = z.infer<typeof squadCrownHandoffSchema>;
export type SquadCrownSquad = z.infer<typeof squadCrownSquadSchema>;
export type SquadCrown = z.infer<typeof squadCrownSchema>;
