import { PassThrough } from 'node:stream';
import { PANEL_SAVED_ROOT } from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';

/**
 * Browse and download the on-disk Squad server log files for a server.
 *
 * Raw logs live on the host filesystem at
 * `${PANEL_SAVED_ROOT}/<serverId>/SquadGame/Saved/Logs/` and are reachable only
 * through the Go bridge. Both routes are gated behind `server:download_logs`.
 *
 *   GET /api/v1/servers/:id/logs/files
 *     Lists `SquadGame*.log` files with size, mtime (RFC3339) and an `is_live`
 *     flag on the active `SquadGame.log`.
 *
 *   GET /api/v1/servers/:id/logs/files/:name/download
 *     Streams the chosen file to the client as an attachment. The bridge emits
 *     the file in chunks (`file_read_stream`) which are piped straight to the
 *     reply, so a multi-hundred-megabyte log is never buffered in full — the
 *     hard acceptance criterion for this feature.
 */

// Files Squad writes: the live `SquadGame.log` plus rotated
// `SquadGame-<timestamp>.log` siblings. The character class forbids path
// separators and `..`, so `:name` cannot escape the Logs directory.
const LOG_NAME_REGEX = /^SquadGame[A-Za-z0-9._-]*\.log$/;

const listParams = z.object({ id: z.string().uuid() });
const downloadParams = z.object({
  id: z.string().uuid(),
  name: z.string().regex(LOG_NAME_REGEX),
});

function logsDir(serverId: string): string {
  return `${PANEL_SAVED_ROOT}/${serverId}/SquadGame/Saved/Logs`;
}

const serverLogFilesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

  fast.get(
    '/api/v1/servers/:id/logs/files',
    {
      schema: { params: listParams },
      config: { permissions: ['server:download_logs'], audit: false },
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const { files } = await app.bridge.squadLogList({ path: logsDir(id) });
        return { files };
      } catch (err) {
        reply.code(502);
        return { error: 'bridge_error', detail: (err as Error).message };
      }
    },
  );

  fast.get(
    '/api/v1/servers/:id/logs/files/:name/download',
    {
      schema: { params: downloadParams },
      config: { permissions: ['server:download_logs'], audit: false },
    },
    async (req, reply) => {
      const { id, name } = req.params;
      const path = `${logsDir(id)}/${name}`;

      // Dedicated bridge connection so an aborted download tears down the
      // bridge-side read cleanly (mirrors server-logs.ts).
      const client = app.makeBridgeClient();
      const stream = new PassThrough();

      void reply.header('Content-Type', 'application/octet-stream');
      void reply.header('Content-Disposition', `attachment; filename="${name}"`);

      // Frames are written to the PassThrough as they arrive from the bridge and
      // flushed to the client by Fastify — the file is streamed, never collected
      // into a single buffer before sending.
      void (async () => {
        try {
          await client.connect();
          await client.fileReadStream({ path }, (frame) => {
            const data = typeof frame.data === 'string' ? frame.data : '';
            if (data.length > 0) stream.write(Buffer.from(data, 'base64'));
          });
          stream.end();
        } catch (err) {
          stream.destroy(err as Error);
        } finally {
          await client.close().catch(() => undefined);
        }
      })();

      return reply.send(stream);
    },
  );
};

export default serverLogFilesRoutes;
