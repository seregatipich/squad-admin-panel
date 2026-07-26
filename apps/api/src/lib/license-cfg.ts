import { createHash } from 'node:crypto';
import { configVersions, serverCredentials } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { decryptString, deserialize } from './crypto.js';

const LICENSE_FILE = 'License.cfg';

/** Written on detach (the bridge has no single-file delete). */
export const LICENSE_PLACEHOLDER = '// Server license key\n';

/** Substituted for the real key everywhere except the file on disk. */
export const LICENSE_KEY_MASK = '********';

/**
 * Re-renders `License.cfg` from the stored `server_credentials` license and
 * writes it to the server's ServerConfig directory via the bridge.
 *
 * Deliberately BYPASSES `writeVersion` (server-configs.ts): the plaintext key
 * must never enter `config_versions` (its read permission, `config:view`, is
 * weaker than `server:edit_settings`), and `License.cfg` is a
 * `requires_restart` file, so no reload signal must be fired. Instead a MASKED
 * copy (`LicenseKey=********`, or the detach placeholder) is inserted as the
 * history row, deduped against the current tip by sha256.
 *
 * @param app - Fastify instance (db, bridge, encryptionKey).
 * @param serverId - Target server uuid; its credentials row is re-read here.
 * @param authorPlayerId - Actor for the history row, or null for system.
 * @param authorIp - Actor IP for the history row, or null.
 * @throws When the bridge write fails; the DB license update has already been
 *   committed by the caller, so a retry re-renders from the stored state.
 */
export async function syncLicenseCfg(
  app: FastifyInstance,
  serverId: string,
  authorPlayerId: string | null,
  authorIp: string | null,
): Promise<void> {
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });

  let content: string;
  let masked: string;
  if (creds?.licenseKeyEncrypted) {
    const licenseKey = decryptString(
      app.encryptionKey,
      deserialize(Buffer.from(creds.licenseKeyEncrypted as unknown as Buffer)),
    );
    const licenseId = creds.licenseId ?? '';
    content = `LicenseId=${licenseId}\nLicenseKey=${licenseKey}\n`;
    masked = `LicenseId=${licenseId}\nLicenseKey=${LICENSE_KEY_MASK}\n`;
  } else {
    content = LICENSE_PLACEHOLDER;
    masked = LICENSE_PLACEHOLDER;
  }

  await app.bridge.fileAtomicWrite({
    path: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/${LICENSE_FILE}`,
    content,
  });

  const prev = await app.db
    .select({ id: configVersions.id, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, LICENSE_FILE)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const prevRow = prev[0];
  const maskedSha = createHash('sha256').update(masked).digest();
  if (prevRow && Buffer.from(prevRow.sha as unknown as Buffer).equals(maskedSha)) {
    return; // unchanged (e.g. repeated id-only save) — don't pollute history
  }
  await app.db.insert(configVersions).values({
    serverId,
    filename: LICENSE_FILE,
    content: masked,
    sha256: maskedSha,
    parentVersionId: prevRow?.id ?? null,
    authorPlayerId,
    authorLabel: authorPlayerId ? null : 'system',
    authorIp,
    message: 'license updated from server settings',
  });
}
