import type { FastifyPluginAsync } from 'fastify';
import { cleanupOrphans } from '../lib/cleanup-orphans.js';

const hostActionsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/v1/host/restart',
    {
      config: {
        permissions: ['host:manage'],
        audit: { action: 'host.bridge.restart', resource: 'host' },
      },
    },
    async (_req, reply) => {
      try {
        const res = await app.bridge.hostAgentRestart();
        return { status: res.status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/closed|reset|EPIPE/i.test(message)) {
          return { status: 'restarting' };
        }
        reply.code(502);
        return { error: 'bridge_unreachable', detail: message };
      }
    },
  );

  // Inventory orphan host directories (configs/<uuid> + saved/<uuid>
  // whose UUID is no longer present in `servers`). Read-only — does NOT
  // delete; useful for the operator to preview what cleanup would touch.
  app.get(
    '/api/v1/host/orphans',
    { config: { permissions: ['host:view'], audit: false } },
    async (req) => {
      return cleanupOrphans({
        db: app.db,
        bridge: app.bridge,
        log: req.log,
        actorPlayerId: req.user?.playerId ?? null,
        actorIp: req.ip ?? null,
        dryRun: true,
      });
    },
  );

  // Removes orphan host directories whose UUID has no row in `servers`
  // (active or soft-deleted). Audit-logged via writeAuditEntry inside
  // cleanupOrphans when at least one removal succeeds.
  app.post(
    '/api/v1/host/cleanup-orphans',
    {
      config: {
        permissions: ['host:manage'],
        audit: { action: 'host.cleanup_orphans', resource: 'host' },
      },
    },
    async (req) => {
      return cleanupOrphans({
        db: app.db,
        bridge: app.bridge,
        log: req.log,
        actorPlayerId: req.user?.playerId ?? null,
        actorIp: req.ip ?? null,
      });
    },
  );

  // Frees disk by running `docker system prune -af` on the host. Removes
  // stopped containers, unused images, and the entire build cache.
  // Volumes are NOT pruned (squad-depot + per-server data must survive).
  app.post(
    '/api/v1/host/docker-prune',
    {
      config: {
        permissions: ['host:manage'],
        audit: { action: 'host.docker_prune', resource: 'host' },
      },
    },
    async (req, reply) => {
      try {
        const client = app.makeBridgeClient();
        try {
          const result = await client.dockerPrune();
          return {
            ok: true,
            exit_code: result.exit_code,
            reclaimed_bytes: result.reclaimed_bytes,
            reclaimed_human: result.reclaimed_human,
          };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err: message }, 'docker_prune failed');
        reply.code(502);
        return { error: 'docker_prune_failed', detail: message };
      }
    },
  );
};

export default hostActionsRoutes;
