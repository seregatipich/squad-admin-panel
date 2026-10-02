import type { PlayerIdCache } from '@squad/chat-ingest';
import type { DatabaseClient } from '@squad/db';
import {
  RCON_CHAT_GROUP,
  RCON_CHAT_STREAM_PREFIX,
  rconChatEntrySchema,
  serverIdFromRconChatStream,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { handleAutomationChat } from '../automation/chat.js';
import type { ParsedChat } from '../parser/chat.js';
import { parseReportFromChat } from '../parser/report.js';
import { handleReport } from '../report/store.js';
import { runStreamConsumer, scanStreams } from '../stream-consumer.js';
import { type ChatRedis, handleChatCommand } from './commands.js';
import { claimChatLine, claimReport } from './dedupe.js';

export interface RconChatDeps {
  db: DatabaseClient;
  /** The worker's shared connection; handlers and claims run on it. */
  redis: Redis;
  playerIds: PlayerIdCache;
  log: Pick<Logger, 'warn' | 'error'>;
}

/**
 * Reads the entry out of the raw `XREADGROUP` field list.
 *
 * @returns the chat line, or `null` when the field is missing or does not match the feed's schema
 */
function readChatEntry(fields: string[]): ParsedChat | null {
  const at = fields.indexOf('entry');
  const raw = at < 0 ? undefined : fields[at + 1];
  if (!raw) return null;
  try {
    const parsed = rconChatEntrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const entry = parsed.data;
    return {
      ts: entry.ts,
      channel: entry.channel,
      eosId: entry.eos_id,
      steamId64: entry.steam_id64,
      playerName: entry.player_name,
      message: entry.message,
    };
  } catch {
    return null;
  }
}

/**
 * Reacts to one in-game chat line that worker-rcon received over RCON (#2):
 * answers `!stats` / `!rules` / `!report` (AUTO-4), fires `chat_keyword`
 * automation rules (AUTO-1) and records a `!report` (REPORT-1). Squad does not
 * write chat to SquadGame.log, so the log tail's `onChat` never sees these
 * lines; this is the same set of handlers it calls, fed from the RCON feed.
 *
 * A line that also arrives through the log tail is handled once
 * ({@link claimChatLine}). Handler failures are logged and the entry is acked,
 * like the log path: a database error must not replay a command whose cooldown
 * is already claimed.
 *
 * @param deps - database, Redis, the sender cache and a logger
 * @param stream - the `rcon:chat:<serverId>` key the entry came from
 * @param fields - the raw entry fields
 * @throws when Redis is unreachable, so the entry stays pending and is retried
 */
export async function handleRconChatEntry(
  deps: RconChatDeps,
  stream: string,
  fields: string[],
): Promise<void> {
  const serverId = serverIdFromRconChatStream(stream);
  const chat = readChatEntry(fields);
  if (!serverId || !chat) {
    deps.log.warn({ stream }, 'malformed rcon chat entry dropped');
    return;
  }
  const redis: ChatRedis = deps.redis as unknown as ChatRedis;
  const guard = <T>(label: string, work: Promise<T>) =>
    work.catch((err: Error) =>
      deps.log.error({ err: err.message, serverId }, `rcon chat ${label} failed`),
    );

  if (await claimChatLine(deps.redis, serverId, chat)) {
    await Promise.all([
      guard(
        'command handling',
        handleChatCommand(deps.db, redis, { serverId, chat, playerIds: deps.playerIds }),
      ),
      guard('automation handling', handleAutomationChat(deps.db, redis, { serverId, chat })),
    ]);
  }
  const report = parseReportFromChat(chat);
  if (report && (await claimReport(deps.redis, serverId, report))) {
    await guard('report handling', handleReport(deps.db, deps.redis, { serverId, report }));
  }
}

/**
 * Runs the reader of worker-rcon's chat feed until `shouldStop` returns true.
 *
 * @param deps - see {@link RconChatDeps}
 * @param blocking - a connection dedicated to the blocking reads
 * @param shouldStop - polled once per read
 */
export function runRconChatConsumer(
  deps: RconChatDeps,
  blocking: Redis,
  shouldStop: () => boolean,
): Promise<void> {
  return runStreamConsumer({
    redis: blocking,
    log: deps.log,
    group: RCON_CHAT_GROUP,
    consumer: `log-ingest-rcon-chat-${process.pid}`,
    discoverStreams: (redis) =>
      scanStreams(
        redis,
        `${RCON_CHAT_STREAM_PREFIX}*`,
        (key) => serverIdFromRconChatStream(key) !== null,
      ),
    handle: (stream, _id, fields) => handleRconChatEntry(deps, stream, fields),
    dedupeByEntry: true,
    shouldStop,
  });
}
