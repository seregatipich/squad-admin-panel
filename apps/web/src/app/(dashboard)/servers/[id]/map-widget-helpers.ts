/**
 * Pure helpers for the ROT-3 current/next-map widget (`MapWidget`). Kept
 * side-effect-free and framework-free so they're trivial to unit test.
 */

/** Minimal shape of a picked/resolved layer needed to gate the deprecated-layer confirm. */
export interface DeprecationGate {
  deprecated: boolean;
}

/**
 * Formats the elapsed time since a match started, for the widget's "идёт N
 * мин" label. Returns "—" when there is no open match (`startedAtIso` is
 * null — e.g. log-ingest hasn't written the `matches` row yet).
 */
export function formatMatchElapsed(startedAtIso: string | null, nowMs: number): string {
  if (!startedAtIso) return '—';
  const startedMs = Date.parse(startedAtIso);
  if (Number.isNaN(startedMs)) return '—';
  const elapsedMin = Math.max(0, Math.floor((nowMs - startedMs) / 60_000));
  if (elapsedMin < 60) return `${elapsedMin} мин`;
  const hours = Math.floor(elapsedMin / 60);
  const mins = elapsedMin % 60;
  return `${hours} ч ${String(mins).padStart(2, '0')} мин`;
}

/**
 * Whether the layer picker's submit button may be enabled: nothing selected
 * never submits; a deprecated layer additionally requires the explicit
 * "Понимаю, слой устаревший" checkbox to be ticked.
 */
export function canSubmitLayer(layer: DeprecationGate | null, confirmChecked: boolean): boolean {
  if (!layer) return false;
  if (layer.deprecated && !confirmChecked) return false;
  return true;
}

/** Case-insensitive substring filter over the layer catalog picker's search box. */
export function filterLayers<T extends { name: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(q));
}
