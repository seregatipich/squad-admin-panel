import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression #1315: the web `LiveEvent` union declared `match.started` and
 * `match.ended`, and two widgets subscribed to them, but the API never
 * publishes such frames — the subscriptions were silently dead. The unions in
 * `apps/api/src/plugins/live-bus.ts` and `apps/web/src/lib/live-bus.ts` are
 * maintained by hand, so this test makes a web-only frame type fail CI.
 */
function liveEventTypes(file: string): Set<string> {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('export type LiveEvent =');
  if (start < 0) throw new Error(`no LiveEvent union in ${file}`);
  const union = source.slice(start, source.indexOf('\n\n', start));
  return new Set(Array.from(union.matchAll(/^\s+type: '([^']+)';$/gm), (match) => match[1] ?? ''));
}

const WEB_UNION = path.resolve(__dirname, '../src/lib/live-bus.ts');
const API_UNION = path.resolve(__dirname, '../../api/src/plugins/live-bus.ts');

describe('live-bus event unions', () => {
  it('lets the web subscribe only to frame types the API declares', () => {
    const api = liveEventTypes(API_UNION);
    const web = liveEventTypes(WEB_UNION);

    expect(web.size).toBeGreaterThan(10);
    expect(Array.from(web).filter((type) => !api.has(type))).toEqual([]);
  });

  /**
   * Regression #1300/#829: the API `vote.ended` payload omitted `server_id`
   * although log-ingest publishes it (`apps/workers/log-ingest/src/vote/store.ts`)
   * and the web `VoteEndedData` requires it, so API-side code typed against the
   * union could not read it.
   */
  it('declares the server_id that log-ingest publishes in the API vote.ended payload', () => {
    const source = readFileSync(API_UNION, 'utf8');
    const start = source.indexOf("type: 'vote.ended';");
    const block = source.slice(start, source.indexOf("type: 'report.created';", start));

    expect(start).toBeGreaterThan(0);
    expect(block).toContain('server_id: string;');
  });

  /**
   * Worker-published frames the API deliberately does not model: `banname.matched`
   * is sent to the live-bus channel by log-ingest but has no consumer, and the
   * Redis bridge drops it (`apps/api/test/live-bus-redis-frames.test.ts`);
   * `bansync.*` is kept off the channel (`apps/workers/ban-sync/src/events.ts`).
   * Modelling one of them means choosing its audience, so it must be a
   * deliberate change that edits this list.
   */
  it('keeps worker-only frame types out of both unions', () => {
    const workerOnly = ['banname.matched', 'bansync.completed', 'bansync.failed'];
    const api = liveEventTypes(API_UNION);
    const web = liveEventTypes(WEB_UNION);

    expect(workerOnly.filter((type) => api.has(type) || web.has(type))).toEqual([]);
  });
});
