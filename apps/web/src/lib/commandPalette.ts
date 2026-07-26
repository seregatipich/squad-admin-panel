import { flattenNavItems, type NavGroup, type NavItem } from '@/lib/nav';

/** Minimum query length (inclusive) before triggering a player search request. */
export const PLAYER_SEARCH_MIN_LENGTH = 3;

export interface PlayerSearchResult {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  clan_name: string | null;
}

export interface ServerResult {
  id: string;
  display_name: string;
  slug: string;
}

export type PaletteResult =
  | ({ kind: 'page' } & NavItem)
  | ({ kind: 'player' } & PlayerSearchResult)
  | ({ kind: 'server' } & ServerResult);

/**
 * Returns the nav pages visible to `permissions` whose label or href match
 * `query` (case-insensitive substring). An empty query matches every visible
 * page. Items with `requiresEconomy` are visible only while `economyEnabled`
 * is true (ECON-5 #165), mirroring the sidebar filter.
 */
export function filterPageResults(
  groups: NavGroup[],
  permissions: string[],
  query: string,
  economyEnabled = false,
): NavItem[] {
  const visible = flattenNavItems(groups).filter(
    (item) =>
      (!item.permission || permissions.includes(item.permission)) &&
      (!item.requiresEconomy || economyEnabled),
  );
  const needle = query.trim().toLowerCase();
  if (!needle) return visible;
  return visible.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.href.toLowerCase().includes(needle),
  );
}

/** Filters servers client-side by display name or slug (case-insensitive substring). */
export function filterServerResults(servers: ServerResult[], query: string): ServerResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return servers;
  return servers.filter(
    (server) =>
      server.display_name.toLowerCase().includes(needle) ||
      server.slug.toLowerCase().includes(needle),
  );
}

/** Whether `query` is long enough to trigger a player search request. */
export function shouldSearchPlayers(query: string): boolean {
  return query.trim().length >= PLAYER_SEARCH_MIN_LENGTH;
}

/** Whether a keyboard event should toggle the command palette open (Ctrl/Cmd+K). */
export function isPaletteHotkey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
}

/** Resolves the navigation target for a selected palette result. */
export function resultHref(result: PaletteResult): string {
  switch (result.kind) {
    case 'page':
      return result.href;
    case 'player':
      return `/players/${result.id}`;
    case 'server':
      return `/servers/${result.id}`;
  }
}

/** Human label shown for a palette result row. */
export function resultLabel(result: PaletteResult): string {
  switch (result.kind) {
    case 'page':
      return result.label;
    case 'player':
      return result.canonical_name;
    case 'server':
      return result.display_name;
  }
}
