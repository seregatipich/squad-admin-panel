/**
 * SRV-6 (#45): License.cfg is a `requires_restart` config — Squad reads it at
 * boot, so a saved license only takes effect once the container (re)starts
 * after the save. Mirrors the API's `restart_required` derivation so the badge
 * can be recomputed client-side from GET /servers/:id state.
 *
 * @param licenseUpdatedAt - ISO timestamp of the last stored-license change,
 *   or null when no license change is on record.
 * @param containerRunning - Whether the server container is currently running.
 * @param containerStartedAt - ISO timestamp the container last started, or
 *   null/absent when not running or unknown.
 * @returns true when the stored license has not yet been picked up by a
 *   (re)start — i.e. the operator must restart the server to apply it.
 */
export function licenseRestartRequired(
  licenseUpdatedAt: string | null,
  containerRunning: boolean,
  containerStartedAt: string | null,
): boolean {
  if (!licenseUpdatedAt) return false;
  if (!containerRunning || !containerStartedAt) return true;
  return new Date(containerStartedAt).getTime() < new Date(licenseUpdatedAt).getTime();
}
