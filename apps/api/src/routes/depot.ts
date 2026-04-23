import { DEPOT_VOLUME_NAME } from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Manages the shared `squad-depot` Docker volume that holds Squad game
 * binaries. One-time initial population and subsequent upgrades both go
 * through the bridge's depot_update RPC, which spawns a transient
 * steamcmd container. Progress streams through a Redis pub/sub channel
 * so multiple UI tabs can watch the same update.
 */

const DEPOT_MARKER = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGameServer.sh`;
const DEPOT_MANIFEST = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/steamapps/appmanifest_403240.acf`;

function parseBuildId(manifest: string): string | null {
  const m = /"buildid"\s+"(\d+)"/.exec(manifest);
  return m?.[1] ?? null;
}

const depotRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/depot', { config: { permissions: ['server:view'], audit: false } }, async () => {
    let populated = false;
    let buildId: string | null = null;
    try {
      await app.bridge.fileRead({ path: DEPOT_MARKER });
      populated = true;
    } catch {
      populated = false;
    }
    if (populated) {
      try {
        const { content } = await app.bridge.fileRead({ path: DEPOT_MANIFEST });
        buildId = parseBuildId(content);
      } catch {
        buildId = null;
      }
    }
    const lastUpdateRaw = await app.redis.get('depot:last_update');
    return {
      volume: DEPOT_VOLUME_NAME,
      populated,
      build_id: buildId,
      last_update: lastUpdateRaw ? JSON.parse(lastUpdateRaw) : null,
    };
  });

  app.post(
    '/api/v1/depot/update',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'depot.update', resource: 'depot' },
      },
    },
    async () => {
      const existing = await app.redis.get('depot:updating');
      if (existing) {
        return { status: 'already_in_progress', since: existing };
      }
      const startedAt = new Date().toISOString();
      await app.redis.set('depot:updating', startedAt, 'EX', 3600);
      (async () => {
        const dedicated = app.makeBridgeClient();
        try {
          await dedicated.connect();
          await dedicated.depotUpdate((frame) => {
            const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            void app.redis.xadd(
              'depot:progress',
              'MAXLEN',
              '~',
              '5000',
              '*',
              'stream',
              frame.stream,
              'text',
              text,
            );
          });
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
          );
        } catch (err) {
          await app.redis.set(
            'depot:last_update',
            JSON.stringify({
              finished_at: new Date().toISOString(),
              status: 'failed',
              error: (err as Error).message,
            }),
          );
        } finally {
          await app.redis.del('depot:updating');
          await dedicated.close().catch(() => undefined);
        }
      })();
      return { status: 'started', started_at: startedAt };
    },
  );

  app.get(
    '/api/v1/depot/progress/ws',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket) => {
      let closed = false;
      let lastId = '0';
      void (async () => {
        try {
          const backfill = (await app.redis.xrange(
            'depot:progress',
            '-',
            '+',
            'COUNT',
            '500',
          )) as Array<[string, string[]]>;
          for (const [id, kv] of backfill) {
            lastId = id;
            const idx = kv.indexOf('text');
            if (idx < 0) continue;
            const stream = kv[kv.indexOf('stream') + 1] ?? 'stdout';
            const text = kv[idx + 1] ?? '';
            socket.send(JSON.stringify({ ts: new Date().toISOString(), stream, message: text }));
          }
          while (!closed) {
            const res = (await app.redis.xread(
              'BLOCK',
              '5000',
              'STREAMS',
              'depot:progress',
              lastId,
            )) as Array<[string, Array<[string, string[]]>]> | null;
            if (!res) continue;
            for (const [, entries] of res) {
              for (const [id, kv] of entries) {
                lastId = id;
                const idx = kv.indexOf('text');
                if (idx < 0) continue;
                const stream = kv[kv.indexOf('stream') + 1] ?? 'stdout';
                const text = kv[idx + 1] ?? '';
                socket.send(
                  JSON.stringify({ ts: new Date().toISOString(), stream, message: text }),
                );
              }
            }
          }
        } catch {
          // socket gone
        }
      })();
      socket.on('close', () => {
        closed = true;
      });
    },
  );
};

export default depotRoutes;
