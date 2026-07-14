/** ROT-1 catalog row, as returned by `GET /api/v1/layers`. */
export interface LayerRow {
  id: string;
  name: string;
  map: string;
  gamemode: string;
  version: string;
  is_seed: boolean;
  deprecated: boolean;
}

/** One ordered row of the rotation editor, as returned by `GET /api/v1/servers/:id/rotation`. */
export interface RotationEntry {
  layer: string;
  known: boolean;
  map: string | null;
  gamemode: string | null;
  version: string | null;
  is_seed: boolean | null;
  deprecated: boolean | null;
}

export interface PoolFilter {
  map?: string;
  gamemode?: string;
  seedOnly?: boolean;
  query?: string;
}

/** Converts a catalog row into the shape stored in the ordered rotation list. */
export function toRotationEntry(layer: LayerRow): RotationEntry {
  return {
    layer: layer.name,
    known: true,
    map: layer.map,
    gamemode: layer.gamemode,
    version: layer.version,
    is_seed: layer.is_seed,
    deprecated: layer.deprecated,
  };
}

/**
 * Moves the entry at `fromIndex` to `toIndex`, clamping the destination to
 * the list bounds. Used by both native HTML5 drag-and-drop and the
 * up/down keyboard-fallback buttons.
 */
export function moveEntry(
  list: readonly RotationEntry[],
  fromIndex: number,
  toIndex: number,
): RotationEntry[] {
  const next = [...list];
  if (fromIndex < 0 || fromIndex >= next.length) return next;
  const clampedTo = Math.max(0, Math.min(toIndex, next.length - 1));
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return next;
  next.splice(clampedTo, 0, moved);
  return next;
}

/** Appends a layer (known or a manually entered unknown name) to the end of the rotation. */
export function addLayer(list: readonly RotationEntry[], entry: RotationEntry): RotationEntry[] {
  return [...list, entry];
}

/** Removes the entry at `index`. */
export function removeAt(list: readonly RotationEntry[], index: number): RotationEntry[] {
  return list.filter((_, i) => i !== index);
}

/** Filters the ROT-1 catalog pool for the add-from-pool picker. */
export function filterPool(layers: readonly LayerRow[], filter: PoolFilter): LayerRow[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  return layers.filter((layer) => {
    if (filter.map && layer.map !== filter.map) return false;
    if (filter.gamemode && layer.gamemode !== filter.gamemode) return false;
    if (filter.seedOnly && !layer.is_seed) return false;
    if (query && !layer.name.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** Builds the PUT body from the current display order. */
export function buildSavePayload(entries: readonly RotationEntry[]): { layers: string[] } {
  return { layers: entries.map((entry) => entry.layer) };
}
