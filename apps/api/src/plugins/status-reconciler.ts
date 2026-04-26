import { servers } from '@squad/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';

/**
 * Periodically reconciles `servers.status` against what Docker actually
 * reports via container_inspect. Needed because:
 *
 *   - POST /start sets status='starting' but nothing updates it to 'running'
 *     once Squad finishes booting inside the container.
 *   - POST /stop sets status='stopping' but nothing updates it to 'stopped'.
 *   - Docker's `--restart unless-stopped` can resurrect a crashed container
 *     without the panel ever seeing it; status would otherwise go stale.
 */
const INTERVAL_MS = 4000;

const TRANSIENT_STATES = new Set(['starting', 'stopping', 'running', 'stopped', 'ready']);

function mapState(dockerState: string, running: boolean): string | null {
  if (running) return 'running';
  const s = dockerState.trim().toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'restarting' || s === 'created') return 'starting';
  if (s === 'removing' || s === 'paused') return 'stopping';
  if (s === 'exited' || s === 'dead') return 'stopped';
  if (s === 'not_found') return 'stopped';
  return null;
}

export default fp(async (app) => {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = await app.db
        .select({ id: servers.id, status: servers.status })
        .from(servers)
        .where(
          and(inArray(servers.status, Array.from(TRANSIENT_STATES)), isNull(servers.deletedAt)),
        );
      for (const row of rows) {
        try {
          const res = await app.bridge.containerInspect({ name: `squad-${row.id}` });
          const mapped = mapState(res.state, res.running);
          if (mapped && mapped !== row.status) {
            await app.db
              .update(servers)
              .set({
                status: mapped,
                updatedAt: new Date(),
                containerId: res.pid ? String(res.pid) : null,
              })
              .where(eq(servers.id, row.id));
            app.log.info(
              {
                serverId: row.id,
                from: row.status,
                to: mapped,
                raw: res.state,
                running: res.running,
              },
              'reconciler: status updated',
            );
            app.liveBus?.publish({
              type: 'server.status',
              ts: new Date().toISOString(),
              data: { server_id: row.id, status: mapped, source: 'reconciler' },
            });
          }
        } catch (err) {
          app.log.debug(
            { err: (err as Error).message, serverId: row.id },
            'reconciler: inspect failed',
          );
        }
      }
    } finally {
      inFlight = false;
    }
  }

  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      void tick().catch((err) =>
        app.log.error({ err: (err as Error).message }, 'reconciler: tick'),
      );
    }, INTERVAL_MS);
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
});
