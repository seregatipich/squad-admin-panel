import type { BridgeClient, SquadLogRetentionSweepResult } from '@squad/bridge-client';
import type { Diag } from '@squad/diag';
import type { Logger } from 'pino';

export const LOG_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

type RetentionBridge = Pick<BridgeClient, 'squadLogRetentionSweep'>;
type RetentionLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface LogRetentionSweepDeps {
  bridge: RetentionBridge;
  diag: Diag;
  log: RetentionLogger;
  /**
   * Returns the server UUIDs whose expiring rotated logs must be archived into
   * the restic backup staging tree before deletion (LOG-3, #51). Resolves to an
   * empty array when no server has the toggle on — the delete-only default.
   */
  listArchiveServerIds: () => Promise<string[]>;
}

export async function runLogRetentionSweep({
  bridge,
  diag,
  log,
  listArchiveServerIds,
}: LogRetentionSweepDeps): Promise<void> {
  try {
    const archiveServerIds = await listArchiveServerIds();
    const result = await bridge.squadLogRetentionSweep({ archive_server_ids: archiveServerIds });
    const fields = retentionCounterFields(result);
    const severity = result.error_count > 0 ? 'warn' : 'info';
    log[severity](fields, 'log retention sweep completed');
    await diag
      .emit({
        component: 'worker-log-ingest',
        kind: 'log.retention.sweep',
        severity,
        message: `log retention sweep completed: deleted=${result.deleted_count}, archived=${result.archived_count}, bytes=${result.deleted_bytes}, errors=${result.error_count}`,
        payload: {
          ...fields,
          errors: result.errors,
        },
      })
      .catch(() => undefined);
  } catch (err) {
    const message = errorMessage(err);
    log.error({ err: message }, 'log retention sweep failed');
    await diag
      .emit({
        component: 'worker-log-ingest',
        kind: 'log.retention.sweep_failed',
        severity: 'error',
        message: `log retention sweep failed: ${message}`,
        payload: { error: message },
      })
      .catch(() => undefined);
  }
}

export function scheduleLogRetentionSweep(deps: LogRetentionSweepDeps): () => void {
  let stopped = false;
  let inFlight = false;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    runLogRetentionSweep(deps)
      .catch((err) => deps.log.error({ err: errorMessage(err) }, 'log retention sweep failed'))
      .finally(() => {
        inFlight = false;
      });
  };

  run();
  const interval = setInterval(run, LOG_RETENTION_SWEEP_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function retentionCounterFields(result: SquadLogRetentionSweepResult) {
  return {
    retention_days: result.retention_days,
    cutoff: result.cutoff,
    servers_scanned: result.servers_scanned,
    log_dirs_scanned: result.log_dirs_scanned,
    files_scanned: result.files_scanned,
    deleted_count: result.deleted_count,
    deleted_bytes: result.deleted_bytes,
    archived_count: result.archived_count,
    archived_bytes: result.archived_bytes,
    error_count: result.error_count,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
