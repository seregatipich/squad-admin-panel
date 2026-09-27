import { createHash } from 'node:crypto';
import { serverCredentials } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { decryptString, deserialize } from './crypto.js';
import { LICENSE_KEY_MASK } from './license-cfg.js';
import { readRconPassword } from './sidecar-config.js';

/**
 * Secret-bearing config files and the key whose value is a secret (#10).
 *
 * `Rcon.cfg` carries the RCON password (full game-server admin) and
 * `License.cfg` the Squad license key. Both values stay in the file on disk
 * only: every API response and every `config_versions` row the panel writes
 * carries {@link CONFIG_SECRET_MASK} instead (the table is append-only, so a
 * plaintext row could never be removed).
 */
const SECRET_KEY_BY_FILE: Readonly<Record<string, string>> = {
  'Rcon.cfg': 'Password',
  'License.cfg': 'LicenseKey',
};

/** Substituted for a secret value; the same mask SRV-6 (#45) uses for the license key. */
export const CONFIG_SECRET_MASK = LICENSE_KEY_MASK;

function secretLineRe(key: string): RegExp {
  return new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)([^\\r\\n]*)$`, 'gim');
}

/**
 * Replaces the secret value of a secret-bearing config file with
 * {@link CONFIG_SECRET_MASK}. Empty values are left as they are (nothing to
 * hide), and content of any other file is returned unchanged.
 *
 * @param filename - Config file name, e.g. `Rcon.cfg`.
 * @param content - File content as read from disk or from `config_versions`.
 * @returns The content with every non-empty secret value masked.
 */
export function maskConfigSecrets(filename: string, content: string): string {
  const key = SECRET_KEY_BY_FILE[filename];
  if (!key) return content;
  return content.replace(secretLineRe(key), (line: string, prefix: string, value: string) =>
    value.trim() === '' ? line : `${prefix}${CONFIG_SECRET_MASK}`,
  );
}

/**
 * Whether `content` still carries a masked `Password=` line, i.e. it came
 * from a masked API response or a masked history row.
 */
function hasMaskedRconPassword(content: string): boolean {
  for (const match of content.matchAll(secretLineRe('Password'))) {
    if (match[2]?.trim() === CONFIG_SECRET_MASK) return true;
  }
  return false;
}

/** The `Password=` value of the current `Rcon.cfg` on disk, or null when unusable. */
async function diskRconPassword(app: FastifyInstance, serverId: string): Promise<string | null> {
  try {
    const onDisk = await readRconPassword(app.bridge, serverId, 'config-write');
    return onDisk === CONFIG_SECRET_MASK ? null : onDisk;
  } catch {
    // Missing or unparseable file.
    return null;
  }
}

/** The panel's authoritative RCON password from `server_credentials`, or null. */
async function credentialsRconPassword(
  app: FastifyInstance,
  serverId: string,
): Promise<string | null> {
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds?.rconPasswordEncrypted) return null;
  return decryptString(
    app.encryptionKey,
    deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
  );
}

/** Thrown when a masked `Rcon.cfg` is written but no real password is known. */
export class RconPasswordUnavailableError extends Error {
  readonly statusCode = 422;

  constructor() {
    super('rcon_password_unavailable');
    this.name = 'RconPasswordUnavailableError';
  }
}

/**
 * Turns `Rcon.cfg` content that may carry a masked password back into the
 * bytes to write on disk: every `Password=********` line gets a real password.
 * A password typed by the operator is kept as typed; content without a masked
 * line is returned unchanged.
 *
 * Which password fills the mask depends on the write:
 * - Editor save (no `versionSha256`): the password in the current file on disk,
 *   so a round-trip changes nothing but the edited lines, falling back to the
 *   encrypted `server_credentials` copy when the file is missing or unreadable.
 * - Restore of a stored version (`versionSha256` set — restore and drift
 *   revert): the file on disk may carry an out-of-band password, so it must not
 *   win by default. The candidate (`server_credentials` first, then disk) whose
 *   filled content hashes to `versionSha256` reproduces the version exactly;
 *   when none does, the panel's `server_credentials` copy is used, and the disk
 *   only when no credentials row exists.
 *
 * @param app - Fastify instance (bridge, db, encryptionKey).
 * @param serverId - Server whose `Rcon.cfg` is being written.
 * @param content - Content from the editor or from a history row.
 * @param opts.versionSha256 - `sha256` of the history row being restored.
 * @returns The content to write to disk.
 * @throws {RconPasswordUnavailableError} When a masked line is present but
 *   neither the file on disk nor `server_credentials` holds a password —
 *   writing the mask itself would set a publicly known RCON password.
 */
export async function unmaskRconPassword(
  app: FastifyInstance,
  serverId: string,
  content: string,
  opts?: { versionSha256?: Buffer },
): Promise<string> {
  if (!hasMaskedRconPassword(content)) return content;
  const fill = (password: string): string =>
    content.replace(secretLineRe('Password'), (line: string, prefix: string, value: string) =>
      value.trim() === CONFIG_SECRET_MASK ? `${prefix}${password}` : line,
    );

  if (!opts?.versionSha256) {
    const password =
      (await diskRconPassword(app, serverId)) ?? (await credentialsRconPassword(app, serverId));
    if (password === null) throw new RconPasswordUnavailableError();
    return fill(password);
  }

  const candidates = [
    await credentialsRconPassword(app, serverId),
    await diskRconPassword(app, serverId),
  ].filter((password): password is string => password !== null);
  if (candidates.length === 0) throw new RconPasswordUnavailableError();
  const { versionSha256 } = opts;
  const exact = candidates
    .map(fill)
    .find((filled) => createHash('sha256').update(filled).digest().equals(versionSha256));
  return exact ?? fill(candidates[0] as string);
}
