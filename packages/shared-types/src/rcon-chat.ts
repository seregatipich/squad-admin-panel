import { z } from 'zod';

/**
 * The in-game chat feed from worker-rcon to worker-log-ingest (#2).
 *
 * Current Squad builds do not write chat to SquadGame.log; the only live
 * producer is the RCON broadcast worker-rcon listens to. Everything that
 * reacts to a chat line — `!stats` / `!rules` / `!report` answers, the
 * `chat_keyword` automation condition, report records — lives in
 * worker-log-ingest, so worker-rcon hands each parsed line over on a stream of
 * its own, one per server. It is deliberately not an `EventEnvelope` on
 * `events:*`: a chat line is a work item for exactly one consumer, not a
 * domain event the plugin dispatcher, Discord notifier and alert rules should
 * see, and chat volume would crowd the capped event streams.
 */
export const RCON_CHAT_STREAM_PREFIX = 'rcon:chat:';
/** Consumer group of worker-log-ingest's chat reader. */
export const RCON_CHAT_GROUP = 'log-ingest-rcon-chat:v1';
/** Cap on retained chat entries per server; `XADD … MAXLEN ~` keeps the stream bounded. */
export const RCON_CHAT_STREAM_MAXLEN = 2000;

/**
 * @param serverId - the server's id
 * @returns the Redis stream key carrying that server's chat feed
 */
export function rconChatStream(serverId: string): string {
  return `${RCON_CHAT_STREAM_PREFIX}${serverId}`;
}

/** The server id a chat stream key belongs to, or `null` when the key is not a chat stream. */
export function serverIdFromRconChatStream(stream: string): string | null {
  if (!stream.startsWith(RCON_CHAT_STREAM_PREFIX)) return null;
  const serverId = stream.slice(RCON_CHAT_STREAM_PREFIX.length);
  return serverId.length > 0 && !serverId.includes(':') ? serverId : null;
}

export const rconChatEntrySchema = z
  .object({
    v: z.literal(1),
    /** When worker-rcon received the line; Squad's broadcast carries no clock. */
    ts: z.string().datetime(),
    channel: z.enum(['ChatAll', 'ChatTeam', 'ChatSquad', 'ChatAdmin']),
    eos_id: z.string().nullable(),
    steam_id64: z.string().nullable(),
    player_name: z.string().min(1).max(200),
    message: z.string().max(4000),
  })
  .strict();
export type RconChatEntry = z.infer<typeof rconChatEntrySchema>;
