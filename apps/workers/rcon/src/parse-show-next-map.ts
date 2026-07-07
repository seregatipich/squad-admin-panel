/**
 * Parse Squad's `ShowNextMap` RCON response.
 *
 * Typical outputs:
 *   Next level is Fallujah, layer is Fallujah_RAAS_v1
 *   Next level is , layer is To be voted
 */

export interface RconNextMap {
  level: string | null;
  layer: string | null;
}

const NEXT_MAP = /^Next level is\s*(.*?),\s*layer is\s*(.*?)\s*$/;

function normalizePart(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'To be voted') return null;
  return trimmed;
}

export function parseShowNextMap(raw: string): RconNextMap | null {
  const match = NEXT_MAP.exec(raw.trim());
  if (!match) return null;
  return {
    level: normalizePart(match[1] as string),
    layer: normalizePart(match[2] as string),
  };
}
