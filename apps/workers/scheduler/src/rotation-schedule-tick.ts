import type { Diag } from '@squad/diag';
import type { RconOperatorCommandName } from '@squad/shared-types';

/** One enabled row from `rotation_schedule` (ROT-4, #147). */
export interface RotationScheduleEntry {
  id: string;
  serverId: string;
  scheduledAt: Date;
  layer: string;
  mode: 'set_next' | 'force_change';
  lastExecutedAt: Date | null;
}

export interface RotationScheduleAuditEntry {
  actor: { kind: 'system'; label: 'rotation-scheduler' };
  actionType: 'server.rotation_schedule.execute' | 'server.rotation_schedule.skip_depot_update';
  targetType: 'rotation_schedule';
  targetId: string;
  context: Record<string, unknown>;
}

export interface RotationScheduleTickDeps {
  now?: Date;
  loadEnabledEntries(): Promise<RotationScheduleEntry[]>;
  isDepotUpdating(): Promise<boolean>;
  sendRconCommand(input: {
    serverId: string;
    command: RconOperatorCommandName;
    args: string[];
  }): Promise<void>;
  setLastExecutedAt(entryId: string, executedAt: Date): Promise<void>;
  writeAuditEntry(entry: RotationScheduleAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface RotationScheduleTickResult {
  executed: number;
  skippedDepotUpdate: number;
}

/** Returns the one-off schedule occurrence when it is due and not yet executed. */
export function resolveDueRotationSchedule(entry: RotationScheduleEntry, now: Date): Date | null {
  if (entry.lastExecutedAt !== null || entry.scheduledAt.getTime() > now.getTime()) return null;
  return entry.scheduledAt;
}

/** Executes due rotation changes through worker-rcon and records their audit trail. */
export async function runRotationScheduleTick(
  deps: RotationScheduleTickDeps,
): Promise<RotationScheduleTickResult> {
  const now = deps.now ?? new Date();
  let executed = 0;
  let skippedDepotUpdate = 0;

  try {
    for (const entry of await deps.loadEnabledEntries()) {
      const occurrence = resolveDueRotationSchedule(entry, now);
      if (!occurrence) continue;

      if (await deps.isDepotUpdating()) {
        skippedDepotUpdate++;
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'rotation-scheduler' },
          actionType: 'server.rotation_schedule.skip_depot_update',
          targetType: 'rotation_schedule',
          targetId: entry.id,
          context: { server_id: entry.serverId, occurrence: occurrence.toISOString() },
        });
        continue;
      }

      const command: RconOperatorCommandName =
        entry.mode === 'force_change' ? 'AdminChangeLayer' : 'AdminSetNextLayer';
      try {
        await deps.sendRconCommand({
          serverId: entry.serverId,
          command,
          args: [entry.layer],
        });
      } catch (error) {
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'rotation_schedule.rcon_failed',
          severity: 'error',
          message: `rotation_schedule ${entry.id} rcon enqueue failed: ${String(error)}`,
          payload: { entry_id: entry.id, server_id: entry.serverId },
        });
        continue;
      }

      await deps.setLastExecutedAt(entry.id, occurrence);
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'rotation-scheduler' },
        actionType: 'server.rotation_schedule.execute',
        targetType: 'rotation_schedule',
        targetId: entry.id,
        context: {
          server_id: entry.serverId,
          layer: entry.layer,
          mode: entry.mode,
          command,
          occurrence: occurrence.toISOString(),
        },
      });
      executed++;
    }

    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'rotation_schedule.run_ok',
      severity: 'info',
      message: `executed ${executed} rotation schedule entr${executed === 1 ? 'y' : 'ies'}`,
      payload: { executed, skipped_depot_update: skippedDepotUpdate },
    });
    return { executed, skippedDepotUpdate };
  } catch (error) {
    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'rotation_schedule.run_failed',
      severity: 'error',
      message: `rotation schedule tick failed: ${String(error)}`,
      payload: { err: String(error) },
    });
    throw error;
  }
}
