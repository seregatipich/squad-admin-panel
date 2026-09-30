/** Redis key read by log-ingest's hot external-ban cache and bumped after a
 * successful CBAN-2 sync or a CBAN-4 source configuration change. */
export const EXTERNAL_BAN_CACHE_VERSION_KEY = 'external-bans:version';

/** Redis stream of manual "sync now" jobs: XADDed by the API, consumed by worker-ban-sync. */
export const BAN_SYNC_MANUAL_STREAM = 'bansync:manual';

/**
 * How long one manual sync request blocks another for the same source (#112).
 * A feed is downloaded, parsed and merged in full on every job, so repeated
 * clicks must not multiply that load or hammer the third-party feed.
 */
export const BAN_SYNC_MANUAL_DEDUP_SECONDS = 60;

/** Redis key held (SET NX EX) while a manual sync of `sourceId` is queued. */
export function banSyncManualPendingKey(sourceId: string): string {
  return `${BAN_SYNC_MANUAL_STREAM}:pending:${sourceId}`;
}
