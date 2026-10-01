/** The generic drift sweep set and the guards of the drift routes. */

import { configVersions } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, type AllowedConfigFile } from '@squad/shared-config';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isAllowed } from './common.js';

/** Managed-segment files (SYNC-3/4, ROT-2) — their drift story is owned by
 *  the dedicated machinery, not the generic CFG-2 sweep. */
const MANAGED_SEGMENT_FILES: readonly string[] = ['Admins.cfg', 'LayerRotation.cfg'];

/**
 * The generic drift sweep set (CFG-2, #64): every allowlisted config file
 * except the managed-segment files and the panel-managed `License.cfg` (#45).
 * Mirrored by the config-sync worker's `config-drift.ts` sweep.
 */
export const DRIFT_SWEEP_FILES: readonly AllowedConfigFile[] = ALLOWED_CONFIG_FILES.filter(
  (f) => f !== 'License.cfg' && !MANAGED_SEGMENT_FILES.includes(f),
);

/** Drift state of one config file in the drift sweep. */
export type DriftState = 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';

/** Why a file is excluded from generic drift resolution (not allowlisted, panel-managed, or owned by the managed-segment machinery), or `null` when it takes part. */
export function driftGuardError(
  name: string,
): 'file_not_in_allowlist' | 'panel_managed_file' | 'managed_file' | null {
  if (!isAllowed(name)) return 'file_not_in_allowlist';
  if (name === 'License.cfg') return 'panel_managed_file';
  if (MANAGED_SEGMENT_FILES.includes(name)) return 'managed_file';
  return null;
}

/** Latest `config_versions` row of a file (id, stored content, sha256), or `null` when the file has no history. */
export async function readTipVersion(
  app: FastifyInstance,
  serverId: string,
  name: string,
): Promise<{ id: string; content: string; sha: Buffer } | null> {
  const rows = await app.db
    .select({ id: configVersions.id, content: configVersions.content, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, name)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, content: row.content, sha: row.sha } : null;
}
