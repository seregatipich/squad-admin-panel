import { servers as serversTbl } from '@squad/db';
import {
  decodeLogEntry,
  LOG_LEVELS,
  type LogLevel,
  PANEL_LOGS_STREAM,
  sourceCode,
} from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { streamBundle } from '../lib/log-export.js';

const SOURCE_CODES = ['B', 'R', 'L', 'W', 'D', 'I', 'A'] as const;
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const logsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/logs',
    {
      config: { permissions: ['host:view'], audit: false },
      schema: {
        querystring: z.object({
          src: z.string().optional(),
          lvl: z.enum(LOG_LEVELS).optional(),
          srv: z.string().uuid().optional(),
          q: z.string().max(120).optional(),
          before: z
            .string()
            .regex(/^\d+-\d+$/)
            .optional(),
          after: z
            .string()
            .regex(/^\d+-\d+$/)
            .optional(),
          limit: z.coerce.number().int().min(1).max(2000).default(500),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        src?: string;
        lvl?: LogLevel;
        srv?: string;
        q?: string;
        before?: string;
        after?: string;
        limit: number;
      };
      const codes = q.src
        ? new Set(
            q.src
              .split(',')
              .filter((c) => SOURCE_CODES.includes(c as (typeof SOURCE_CODES)[number])),
          )
        : null;
      const minRank = q.lvl ? LEVEL_RANK[q.lvl] : 0;

      let items: Array<[string, string[]]>;
      if (q.after) {
        items = (await app.redis.xrange(
          PANEL_LOGS_STREAM,
          `(${q.after}`,
          '+',
          'COUNT',
          q.limit,
        )) as Array<[string, string[]]>;
        items.reverse();
      } else if (q.before) {
        items = (await app.redis.xrevrange(
          PANEL_LOGS_STREAM,
          `(${q.before}`,
          '-',
          'COUNT',
          q.limit,
        )) as Array<[string, string[]]>;
      } else {
        items = (await app.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', q.limit)) as Array<
          [string, string[]]
        >;
      }

      const entries = items
        .map(([id, fields]) => {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            obj[fields[i] ?? ''] = fields[i + 1] ?? '';
          }
          try {
            return { id, ...decodeLogEntry(id, obj) };
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((e) => {
          if (codes && !codes.has(sourceCode(e.source))) return false;
          if (LEVEL_RANK[e.level] < minRank) return false;
          if (q.srv && e.serverId !== q.srv) return false;
          if (q.q && !e.msg.toLowerCase().includes(q.q.toLowerCase())) return false;
          return true;
        });

      return { entries };
    },
  );
  app.get(
    '/api/v1/logs/export',
    { config: { permissions: ['host:metrics'], audit: false } },
    async (_req, reply) => {
      const rows = await app.db
        .select({ id: serversTbl.id, display_name: serversTbl.displayName })
        .from(serversTbl);
      const fname = `panel-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt.gz`;
      void reply.header('Content-Type', 'text/plain; charset=utf-8');
      void reply.header('Content-Encoding', 'gzip');
      void reply.header('Content-Disposition', `attachment; filename="${fname}"`);
      return reply.send(streamBundle(app, rows));
    },
  );
};

export default logsRoutes;
