/**
 * Resolve the host to dial for a server's RCON listener.
 *
 * Stored credentials use `rcon_host = NULL` as "no override — use my
 * service's default". The env var `RCON_HOST_DEFAULT` differs between
 * panel services so the same Squad listener is reachable from both
 * planes:
 *   - apps/api          (compose bridge network)  → host.docker.internal
 *   - apps/workers/rcon (--network host)          → 127.0.0.1
 *
 * An explicit non-null value in credentials always wins — that's the
 * escape hatch for pinning a remote Squad instance.
 */
export function resolveRconHost(
  credsHost: string | null | undefined,
  env: { RCON_HOST_DEFAULT?: string } = process.env,
): string {
  if (credsHost) return credsHost;
  if (env.RCON_HOST_DEFAULT) return env.RCON_HOST_DEFAULT;
  return '127.0.0.1';
}
