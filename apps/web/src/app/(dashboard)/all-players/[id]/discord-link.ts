/** Shape returned by `GET /api/v1/players/:playerId/discord` (DISCORD-4, #151). */
export interface DiscordLinkResponse {
  linked: boolean;
  discord_user_id: string | null;
  discord_username: string | null;
  linked_at: string | null;
}

/** Full-page redirect entry point of the OAuth flow — never fetched. */
export const DISCORD_OAUTH_LOGIN_URL = '/api/v1/auth/discord/login';

/** Self-service unlink; available to any session on its own link. */
export const SELF_UNLINK_URL = '/api/v1/players/me/discord/link';

export function buildDiscordLinkUrl(playerId: string): string {
  return `/api/v1/players/${playerId}/discord`;
}

/** Forced unlink of somebody else's link; the API gates it on `can_assign_roles`. */
export function buildForceUnlinkUrl(playerId: string): string {
  return `/api/v1/players/${playerId}/discord/link`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Validates and narrows a decoded JSON body from the Discord link endpoint,
 * returning `null` for any shape mismatch so a malformed response renders as
 * an error instead of crashing the section.
 */
export function parseDiscordLink(json: unknown): DiscordLinkResponse | null {
  if (!json || typeof json !== 'object') return null;
  const value = json as Record<string, unknown>;
  if (typeof value.linked !== 'boolean') return null;
  if (
    !isNullableString(value.discord_user_id) ||
    !isNullableString(value.discord_username) ||
    !isNullableString(value.linked_at)
  ) {
    return null;
  }
  return {
    linked: value.linked,
    discord_user_id: value.discord_user_id,
    discord_username: value.discord_username,
    linked_at: value.linked_at,
  };
}

/**
 * Renders the link timestamp as a date, or an em dash when absent/unparsable.
 *
 * @param linkedAt ISO timestamp of the Discord link, or `null`.
 * @param locale BCP-47 tag to format in; required, because the browser's own
 *   locale has nothing to do with the language the panel is displayed in.
 */
export function formatLinkedAt(linkedAt: string | null, locale: string): string {
  if (!linkedAt) return '—';
  const date = new Date(linkedAt);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(locale);
}
