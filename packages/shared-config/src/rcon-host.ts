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

/**
 * The host a *player* should dial to join, for `steam://connect/<host>:<port>`
 * links in seeding notifications: the hostname of the panel's public URL.
 * Never the RCON dial target above, which is `127.0.0.1` for a local server
 * and meaningless to a player's Steam client (#980). Returns `null` when
 * `PANEL_PUBLIC_URL` is unset or unparsable, so callers omit the link rather
 * than fall back to a loopback address.
 */
export function seedPublicHost(env: { PANEL_PUBLIC_URL?: string } = process.env): string | null {
  if (!env.PANEL_PUBLIC_URL) return null;
  try {
    return new URL(env.PANEL_PUBLIC_URL).hostname;
  } catch {
    return null;
  }
}
