import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script Node was started with.
 *
 * Workers call this so importing their entry file from a test does not start
 * the worker. Symlinks are resolved on both sides, so launching through a
 * symlinked path still counts.
 *
 * @param moduleUrl - The caller's `import.meta.url`.
 * @param entryArgv - The started script's path; defaults to `process.argv[1]`.
 * @returns `true` when `moduleUrl` and the started script are the same file;
 *   `false` when there is no started script or either path cannot be resolved.
 */
export function isMainEntrypoint(
  moduleUrl: string,
  entryArgv: string | undefined = process.argv[1],
): boolean {
  if (!entryArgv) return false;
  try {
    return realpathSync(entryArgv) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
