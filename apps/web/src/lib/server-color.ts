/**
 * Deterministic per-server chart colours.
 *
 * Every chart on `/statistics` must paint a given server in the same colour, so
 * the eye can follow one server across the whole page. The assignment is by
 * position in the **sorted** list of known server ids rather than by the order
 * the API happened to return them, which keeps the colour stable across
 * re-fetches and independent of the current selection.
 */

/** Chart palette, ordered; readable on the panel's dark background. */
export const SERVER_COLORS = [
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb7185',
  '#2dd4bf',
  '#facc15',
] as const;

const FALLBACK = SERVER_COLORS[0];

/**
 * Resolves the chart colour for `serverId`.
 *
 * @param serverId Server to colour.
 * @param knownServerIds Every server the page knows about; order is irrelevant,
 *   the list is sorted internally.
 * @returns A palette hex colour — the first entry when the server is unknown.
 */
export function serverColor(serverId: string, knownServerIds: readonly string[]): string {
  const index = [...knownServerIds].sort().indexOf(serverId);
  if (index < 0) return FALLBACK;
  return SERVER_COLORS[index % SERVER_COLORS.length] ?? FALLBACK;
}
