/**
 * Squad `ListPlayers` role-strings are faction-scoped kit identifiers, e.g.
 * `USA_Rifleman_01`, `RGF_SL_01`, `INS_Medic`. The numeric suffix is a
 * loadout variant (not a distinct kit) and the leading faction token varies
 * per faction (USA/RGF/MEA/INS/BAF/CAF/USMC) while the underlying kit is the
 * same across factions. This module strips both so `player_kit_time`
 * (DOSSIER-3) can key on a single faction-agnostic kit name instead of the
 * raw per-faction role-string.
 */

const KNOWN_FACTIONS: ReadonlySet<string> = new Set([
  'USA',
  'RGF',
  'MEA',
  'INS',
  'BAF',
  'CAF',
  'USMC',
]);

const NUMERIC_SUFFIX = /^\d+$/;

/**
 * Normalize a raw Squad role-string into a faction-agnostic kit name.
 *
 * Strips the leading faction token (one of USA/RGF/MEA/INS/BAF/CAF/USMC) and
 * any trailing numeric loadout-variant suffix (e.g. `_01`), leaving the kit
 * identifier shared across factions (`Rifleman`, `SL`, `Medic`, `LAT`, `HAT`,
 * `AutoRifleman`, `Grenadier`, `Marksman`, `Machinegunner`, `Crewman`,
 * `Pilot`, `Sapper`, `UAV`, ...).
 *
 * @param rawRole - The raw `Role:` field from `ListPlayers` (or `null`/`undefined`
 *   for a player without a role, e.g. between spawns).
 * @returns The normalized kit name, or `null` when `rawRole` is null/empty, has
 *   no recognized faction prefix, or has no kit segment left after stripping.
 */
export function normalizeRoleName(rawRole: string | null | undefined): string | null {
  if (!rawRole) return null;
  const trimmed = rawRole.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split('_').filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const [faction, ...rest] = parts as [string, ...string[]];
  if (!KNOWN_FACTIONS.has(faction)) return null;

  while (rest.length > 1 && NUMERIC_SUFFIX.test(rest[rest.length - 1] as string)) {
    rest.pop();
  }
  if (rest.length === 0 || NUMERIC_SUFFIX.test(rest[0] as string)) return null;

  return rest.join('_');
}
