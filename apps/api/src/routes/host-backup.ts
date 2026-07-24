import type { FastifyPluginAsync } from 'fastify';

/**
 * Backup/restore surface for the restic mechanism delivered by INFRA-8 (#14).
 *
 * The API container has no docker socket, so every operation is delegated to
 * the Go host bridge (mirrors `host/docker-prune`): list snapshots, trigger a
 * one-off backup, and restore a chosen snapshot. Restore is destructive and is
 * gated by a typed confirmation token that must echo the snapshot id, on top of
 * the `host:manage` RBAC gate and the `backup.restore` audit entry.
 */
const hostBackupRoutes: FastifyPluginAsync = async (app) => {
  // Lists the restic snapshots in the panel backup repository. Read-only, but
  // gated by host:manage because the whole backup surface is operator-only.
  app.get(
    '/api/v1/host/backups',
    { config: { permissions: ['host:manage'], audit: false } },
    async (req, reply) => {
      try {
        const client = app.makeBridgeClient();
        try {
          const result = await client.backupSnapshots();
          return { snapshots: result.snapshots };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err: message }, 'backup_snapshots failed');
        reply.code(502);
        return { error: 'backup_list_failed', detail: message };
      }
    },
  );

  // Triggers a one-off restic backup (dumps + snapshot + retention) on the host.
  app.post(
    '/api/v1/host/backups',
    {
      config: {
        permissions: ['host:manage'],
        audit: { action: 'backup.run', resource: 'backup' },
      },
    },
    async (req, reply) => {
      try {
        const client = app.makeBridgeClient();
        try {
          const result = await client.backupRun();
          return { ok: true, exit_code: result.exit_code };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err: message }, 'backup_run failed');
        reply.code(502);
        return { error: 'backup_run_failed', detail: message };
      }
    },
  );

  // Restores a chosen snapshot. DESTRUCTIVE: overwrites the live Postgres +
  // Redis datasets. The body must carry `confirm` equal to the snapshot id in
  // the URL — a typed confirmation the UI forces the operator to enter — so a
  // stray or replayed POST cannot wipe live data.
  app.post<{ Params: { id: string }; Body: { confirm?: string } }>(
    '/api/v1/host/backups/:id/restore',
    {
      config: {
        permissions: ['host:manage'],
        audit: { action: 'backup.restore', resource: 'backup' },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const confirm = req.body?.confirm;
      if (!confirm || confirm !== id) {
        reply.code(400);
        return {
          error: 'confirm_required',
          detail: 'Body must include `confirm` equal to the snapshot id being restored.',
        };
      }
      try {
        const client = app.makeBridgeClient();
        try {
          const result = await client.backupRestore({ snapshot_id: id });
          return { ok: true, exit_code: result.exit_code };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err: message, snapshotId: id }, 'backup_restore failed');
        reply.code(502);
        return { error: 'backup_restore_failed', detail: message };
      }
    },
  );
};

export default hostBackupRoutes;
