/**
 * Tells a "file does not exist" failure from a bridge `file_read` apart from
 * every other failure (timeout, EIO, EACCES, bridge down).
 *
 * Matches both the fake harness bridge (`code: 'ENOENT'`) and the Go bridge's
 * not-found variants (the same patterns the config-sync worker tolerates).
 *
 * @param err - Whatever the bridge call rejected with.
 * @returns True only when the file is missing.
 */
export function isFileNotFoundError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'ENOENT' ||
    e.code === 'not_found' ||
    e.code === 'no_such_file' ||
    /no such file|not_found|enoent/i.test(e.message ?? '')
  );
}
