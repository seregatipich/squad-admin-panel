import { servers } from '@squad/db/schema';
import { eq, inArray } from 'drizzle-orm';
import fp from 'fastify-plugin';

/**
 * Periodically reconciles `servers.status` against what systemd actually
 * reports. Needed because:
 *
 *   - POST /start sets status='starting' but nothing updates it to 'running'
 *     once squad-server finishes booting.
 *   - POST /stop sets status='stopping' but nothing updates it to 'stopped'.
 *   - systemd's `Restart=on-failure` can bring a crashed service back without
 *     the panel ever seeing the crash; status would otherwise be stale.
 *
 * Runs every 4 seconds, queries `systemctl is-active squad-server-{uuid}`
 * through the bridge, maps systemd's state vocabulary to our panel vocabulary,
 * and writes the update only if it differs.
 */
const INTERVAL_MS = 4000;

const TRANSIENT_STATES = new Set(['starting', 'stopping', 'running', 'stopped', 'ready']);

// systemd `is-active` → panel status.
function mapState(systemdState: string): string | null {
  const s = systemdState.trim();
  if (s === 'active') return 'running';
  if (s === 'activating') return 'starting';
  if (s === 'deactivating') return 'stopping';
  if (s === 'inactive') return 'stopped';
  if (s === 'failed') return 'failed';
  // 'not-found', 'unknown' — don't touch
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
        .where(inArray(servers.status, Array.from(TRANSIENT_STATES)));
      for (const row of rows) {
        try {
          const out = await app.bridge.systemctlAction({
            unit: `squad-server-${row.id}.service`,
            action: 'is-active',
          });
          const mapped = mapState(out.output);
          if (mapped && mapped !== row.status) {
            await app.db
              .update(servers)
              .set({ status: mapped, updatedAt: new Date() })
              .where(eq(servers.id, row.id));
            app.log.info(
              { serverId: row.id, from: row.status, to: mapped, raw: out.output.trim() },
              'reconciler: status updated',
            );
          }
        } catch (err) {
          app.log.debug(
            { err: (err as Error).message, serverId: row.id },
            'reconciler: is-active failed',
          );
        }
      }
    } finally {
      inFlight = false;
    }
  }

  // first tick after the app is ready
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
