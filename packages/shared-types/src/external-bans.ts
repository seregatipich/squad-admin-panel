/** Redis key read by log-ingest's hot external-ban cache and bumped after a
 * successful CBAN-2 sync or a CBAN-4 source configuration change. */
export const EXTERNAL_BAN_CACHE_VERSION_KEY = 'external-bans:version';
