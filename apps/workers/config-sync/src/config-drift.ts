import { createHash } from 'node:crypto';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import {
  ALLOWED_CONFIG_FILES,
  type AllowedConfigFile,
  PANEL_CONFIGS_ROOT,
} from '@squad/shared-config';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export const CONFIG_DRIFT_STATUS_KEY_PREFIX = 'config-drift:status:';
export const CONFIG_DRIFT_STATUS_TTL_SECONDS = 86_400;

/** Files with their own dedicated drift machinery, excluded from the generic
 *  sweep: Admins.cfg (SYNC-3/4 managed segment), LayerRotation.cfg (ROT-2
 *  managed segment), License.cfg (panel-managed, #45). */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([
  'Admins.cfg',
  'LayerRotation.cfg',
  'License.cfg',
]);

/** The 16-file generic sweep set (CFG-2, #64). Mirrors the API's
 *  `DRIFT_SWEEP_FILES` in `apps/api/src/routes/server-configs.ts`. */
export const CONFIG_DRIFT_SWEEP_FILES: readonly AllowedConfigFile[] = ALLOWED_CONFIG_FILES.filter(
  (f) => !EXCLUDED_FILES.has(f),
);

export type ConfigDriftFileState = 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';

export interface ConfigDriftFileStatus {
  state: ConfigDriftFileState;
  disk_sha256: string | null;
  version_sha256: string | null;
  tip_version_id: string | null;
}

/** JSON document published to `config-drift:status:<server_id>` (TTL 24h). */
export interface ConfigDriftStatus {
  checked_at: string;
  files: Record<string, ConfigDriftFileStatus>;
}

export interface DriftSweepContext {
  db: DatabaseClient;
  redis: Redis;
  bridge: BridgeClient;
  log: Logger;
}

interface TipRow extends Record<string, unknown> {
  filename: string;
  id: string;
  sha: string | null;
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'ENOENT' ||
    e.code === 'not_found' ||
    e.code === 'no_such_file' ||
    /no such file|not_found|enoent/i.test(e.message ?? '')
  );
}

/**
 * Compare every swept config file's on-disk sha256 against its
 * `config_versions` tip and publish the per-file result to
 * `config-drift:status:<server_id>` (`EX` 24h).
 *
 * Detect, never auto-correct: the sweep only reads and publishes — resolution
 * (accept / revert / reset-default) is operator-driven through the API. A
 * per-file bridge read failure degrades that file to `missing`/`unreachable`
 * instead of failing the sweep.
 */
export async function sweepServerConfigDrift(
  ctx: DriftSweepContext,
  serverId: string,
): Promise<ConfigDriftStatus> {
  const { db, redis, bridge, log } = ctx;
  const tipRows = await db.execute<TipRow>(sql`
    SELECT DISTINCT ON (filename) filename, id, encode(sha256, 'hex') AS sha
    FROM config_versions
    WHERE server_id = ${serverId}
    ORDER BY filename, created_at DESC
  `);
  const tips = new Map((tipRows as unknown as TipRow[]).map((r) => [r.filename, r]));

  const files: Record<string, ConfigDriftFileStatus> = {};
  for (const name of CONFIG_DRIFT_SWEEP_FILES) {
    const tip = tips.get(name) ?? null;
    let diskSha: string | null = null;
    let readError: unknown = null;
    try {
      const { content } = await bridge.fileRead({
        path: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/${name}`,
      });
      diskSha = createHash('sha256').update(content).digest('hex');
    } catch (err) {
      readError = err;
    }
    let state: ConfigDriftFileState;
    if (!tip) {
      state = 'unknown';
    } else if (readError) {
      state = isNotFoundError(readError) ? 'missing' : 'unreachable';
    } else {
      state = diskSha === tip.sha ? 'in_sync' : 'drift';
    }
    if (state === 'drift') {
      log.warn(
        { serverId, file: name, expected: tip?.sha, actual: diskSha },
        'config drift detected — awaiting operator resolution',
      );
    }
    files[name] = {
      state,
      disk_sha256: diskSha,
      version_sha256: tip?.sha ?? null,
      tip_version_id: tip?.id ?? null,
    };
  }

  const status: ConfigDriftStatus = { checked_at: new Date().toISOString(), files };
  await redis.set(
    `${CONFIG_DRIFT_STATUS_KEY_PREFIX}${serverId}`,
    JSON.stringify(status),
    'EX',
    CONFIG_DRIFT_STATUS_TTL_SECONDS,
  );
  return status;
}
