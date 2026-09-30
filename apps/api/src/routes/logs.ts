import { servers as serversTbl } from '@squad/db';
import {
  decodeLogEntry,
  LOG_LEVELS,
  LOG_SOURCES,
  type LogLevel,
  PANEL_LOGS_STREAM,
  sourceCode,
} from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { streamBundle } from '../lib/log-export.js';

// Derived from the shared source table so a new source (config-sync → C, #781)
// can never be silently dropped from `src=` filtering again.
const SOURCE_CODES: ReadonlySet<string> = new Set(LOG_SOURCES.map(sourceCode));
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
/** Longest `src` filter: every source code once, comma-separated. */
const SRC_FILTER_MAX = SOURCE_CODES.length * 2 - 1;

/**
 * Everything `streamBundle` puts in a support bundle, each gated by its own
 * catalogue key elsewhere: panel logs (`host:view`, as `GET /api/v1/logs`),
 * host metrics (`host:metrics`), the audit slice (`audit:view`) and game
 * server stdout tails, which carry player IPs (`server:download_logs`).
 * The route requires all four so no caller — in particular an API token
 * scoped to `host:metrics` alone — reads more through the bundle than
 * through the dedicated routes.
 */
export const LOG_EXPORT_PERMISSIONS = [
  'host:view',
  'host:metrics',
  'audit:view',
  'server:download_logs',
] as const;

/** Stream entries read per XRANGE/XREVRANGE round trip while scanning for matches. */
const LOG_SCAN_CHUNK = 500;

/**
 * Upper bound on raw stream entries one request scans. Filters are applied in
 * process, so a narrow filter over a long run of non-matching entries would
 * otherwise walk the whole stream; the response cursors let the caller resume.
 */
const LOG_SCAN_BUDGET = 20_000;

type DecodedEntry = ReturnType<typeof decodeLogEntry> & { id: string };

/** Decodes one raw stream entry, or returns null when it is malformed. */
function decodeStreamEntry(id: string, fields: string[]): DecodedEntry | null {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i] ?? ''] = fields[i + 1] ?? '';
  }
  try {
    return { id, ...decodeLogEntry(id, obj) };
  } catch {
    return null;
  }
}

/**
 * Panel log routes.
 *
 * `GET /api/v1/logs` scans the panel log stream newest-first (or, with
 * `after`, oldest-first from that id) and applies the src/lvl/srv/q filters
 * while scanning, until `limit` matches are collected or {@link LOG_SCAN_BUDGET}
 * raw entries were read. Entries are returned newest-first together with
 * `newest_scanned_id` / `oldest_scanned_id`: the ids of the newest and oldest
 * raw entries actually scanned (null when nothing was scanned). A live tail
 * must advance its `after` cursor to `newest_scanned_id` even when `entries`
 * is empty, otherwise a run of non-matching entries would be re-read forever.
 */
const logsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/logs',
    {
      config: { permissions: ['host:view'], audit: false },
      schema: {
        querystring: z.object({
          src: z.string().max(SRC_FILTER_MAX).optional(),
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
      const codes = q.src ? new Set(q.src.split(',').filter((c) => SOURCE_CODES.has(c))) : null;
      const minRank = q.lvl ? LEVEL_RANK[q.lvl] : 0;

      const matches = (e: DecodedEntry): boolean => {
        if (codes && !codes.has(sourceCode(e.source))) return false;
        if (LEVEL_RANK[e.level] < minRank) return false;
        if (q.srv && e.serverId !== q.srv) return false;
        if (q.q && !e.msg.toLowerCase().includes(q.q.toLowerCase())) return false;
        return true;
      };

      const entries: DecodedEntry[] = [];
      let newestScannedId: string | null = null;
      let oldestScannedId: string | null = null;
      let scanned = 0;
      const forward = Boolean(q.after);
      let cursor = q.after ? `(${q.after}` : q.before ? `(${q.before}` : '+';

      scan: while (scanned < LOG_SCAN_BUDGET) {
        const batch = (
          forward
            ? await app.redis.xrange(PANEL_LOGS_STREAM, cursor, '+', 'COUNT', LOG_SCAN_CHUNK)
            : await app.redis.xrevrange(PANEL_LOGS_STREAM, cursor, '-', 'COUNT', LOG_SCAN_CHUNK)
        ) as Array<[string, string[]]>;
        for (const [id, fields] of batch) {
          scanned += 1;
          if (forward) {
            oldestScannedId ??= id;
            newestScannedId = id;
          } else {
            newestScannedId ??= id;
            oldestScannedId = id;
          }
          const entry = decodeStreamEntry(id, fields);
          if (entry && matches(entry)) entries.push(entry);
          if (entries.length >= q.limit) break scan;
        }
        const last = batch.at(-1);
        if (!last || batch.length < LOG_SCAN_CHUNK) break;
        cursor = `(${last[0]}`;
      }
      if (forward) entries.reverse();

      return {
        entries,
        newest_scanned_id: newestScannedId,
        oldest_scanned_id: oldestScannedId,
      };
    },
  );
  fast.get(
    '/api/v1/logs/export',
    { config: { permissions: [...LOG_EXPORT_PERMISSIONS], audit: false } },
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
