import { EVENTS_APPENDED_PG_CHANNEL } from '@squad/shared-config';
import fp from 'fastify-plugin';
import postgres from 'postgres';

/**
 * Live event feed. Migration 0116 fires `NOTIFY events_appended` for every
 * row stored in `events`, whoever wrote it; this plugin LISTENs on a dedicated
 * connection and turns the notifications into `server.events.appended`
 * live-bus frames, so an open event list refetches the moment something
 * happens instead of when someone reloads the page.
 *
 * A frame carries only which server and which kinds got new rows — never the
 * rows themselves. The client refetches through `GET /api/v1/events`, so the
 * usual permission checks decide what the viewer actually sees.
 *
 * A busy match stores many combat rows a second; notifications are coalesced
 * per server over `debounceMs` so a burst costs one frame, not hundreds.
 */

export interface EventsAppendedBatch {
  server_id: string | null;
  kinds: string[];
}

/** Parses one `events_appended` payload; malformed payloads yield `null`. */
export function parseEventsAppendedPayload(
  raw: string,
): { server_id: string | null; kind: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { server_id, kind } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || kind === '') return null;
  if (server_id !== null && typeof server_id !== 'string') return null;
  return { server_id, kind };
}

/**
 * Collects notifications and hands one batch per server to `emit` once
 * `debounceMs` has passed since the first notification of the window.
 */
export function createEventsAppendedCoalescer(
  emit: (batch: EventsAppendedBatch) => void,
  debounceMs: number,
): { push(raw: string): void; stop(): void } {
  const pending = new Map<string | null, Set<string>>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const batches = Array.from(pending, ([server_id, kinds]) => ({
      server_id,
      kinds: Array.from(kinds).sort(),
    }));
    pending.clear();
    for (const batch of batches) emit(batch);
  };
  return {
    push(raw) {
      const parsed = parseEventsAppendedPayload(raw);
      if (!parsed) return;
      let kinds = pending.get(parsed.server_id);
      if (!kinds) {
        kinds = new Set();
        pending.set(parsed.server_id, kinds);
      }
      kinds.add(parsed.kind);
      if (!timer) timer = setTimeout(flush, debounceMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

export interface EventsFeedOptions {
  databaseUrl: string;
  /** Coalescing window; defaults to 250ms. */
  debounceMs?: number;
}

export default fp<EventsFeedOptions>(async (app, opts) => {
  const coalescer = createEventsAppendedCoalescer((batch) => {
    app.liveBus.publish({
      type: 'server.events.appended',
      ts: new Date().toISOString(),
      data: batch,
    });
  }, opts.debounceMs ?? 250);

  // LISTEN pins its connection, so it gets its own single-connection client
  // instead of borrowing one from the query pool. postgres.js re-issues the
  // LISTEN by itself after a reconnect.
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  let unlisten: (() => Promise<void>) | null = null;
  try {
    const sub = await sql.listen(EVENTS_APPENDED_PG_CHANNEL, (payload) => coalescer.push(payload));
    unlisten = sub.unlisten;
  } catch (err) {
    // The feed only speeds the event list up; the page still loads over REST.
    app.log.warn(
      { err: (err as Error).message },
      'events-feed: LISTEN failed; the event list will not update live',
    );
  }

  app.addHook('onClose', async () => {
    coalescer.stop();
    await unlisten?.().catch(() => undefined);
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });
});
