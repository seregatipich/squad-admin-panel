import {
  type ChatScope,
  type ChatSource,
  chatMessages,
  type DatabaseClient,
  playerNameHistory,
  players,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { desc, eq, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ChatFlagDetector } from './flag-rules.js';

/** In-game chat channels, named as Squad names them on the wire. */
export type ChatChannel = 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin';

/**
 * One chat line, however it reached the panel. Both producers — the log tailer
 * and the RCON broadcast listener — normalise to this shape so a message is
 * stored and fanned out identically whatever carried it.
 */
export interface ChatInput {
  /** ISO-8601 timestamp of the message. */
  ts: string;
  channel: ChatChannel;
  eosId: string | null;
  steamId64: string | null;
  playerName: string;
  message: string;
}

const CHANNEL_SCOPE: Record<ChatChannel, ChatScope> = {
  ChatAll: 'all',
  ChatTeam: 'team',
  ChatSquad: 'squad',
  ChatAdmin: 'admin',
};

export interface ChatRecord {
  playerId: string;
  serverId: string;
  sentAt: Date;
  scope: ChatScope;
  message: string;
  source?: ChatSource;
  teamId?: number | null;
  squadId?: number | null;
  isFlagged?: boolean;
  matchedRuleId?: string | null;
}

export async function recordChatMessage(db: DatabaseClient, record: ChatRecord): Promise<void> {
  await db.insert(chatMessages).values({
    playerId: record.playerId,
    serverId: record.serverId,
    sentAt: record.sentAt,
    scope: record.scope,
    message: record.message,
    source: record.source ?? 'log',
    teamId: record.teamId ?? null,
    squadId: record.squadId ?? null,
    isFlagged: record.isFlagged ?? false,
    matchedRuleId: record.matchedRuleId ?? null,
  });
}

export const LIVE_BUS_CHANNEL = 'live-bus';

export interface ChatPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface ChatMessageData {
  id: string;
  server_id: string;
  ts: string;
  channel: ChatChannel;
  player_id: string | null;
  player_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  message: string;
}

export interface ChatMessageFrame {
  type: 'chat.message';
  ts: string;
  data: ChatMessageData;
}

export async function resolvePlayerId(db: DatabaseClient, chat: ChatInput): Promise<string | null> {
  const filters = [];
  if (chat.eosId) filters.push(eq(players.eosId, chat.eosId));
  if (chat.steamId64) filters.push(eq(players.steamId64, BigInt(chat.steamId64)));
  if (filters.length > 0) {
    const rows = await db
      .select({ id: players.id })
      .from(players)
      .where(filters.length === 1 ? filters[0] : or(...filters))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }

  const normalized = normalizePlayerName(chat.playerName);
  if (!normalized) return null;
  const direct = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.canonicalNameNormalized, normalized))
    .limit(1);
  if (direct[0]) return direct[0].id;
  const historical = await db
    .select({ id: playerNameHistory.playerId })
    .from(playerNameHistory)
    .where(eq(playerNameHistory.nameNormalized, normalized))
    .orderBy(desc(playerNameHistory.lastSeenAt))
    .limit(1);
  return historical[0]?.id ?? null;
}

export function buildChatFrame(
  playerId: string | null,
  serverId: string,
  chat: ChatInput,
): ChatMessageFrame {
  return {
    type: 'chat.message',
    ts: chat.ts,
    data: {
      id: uuidv7(),
      server_id: serverId,
      ts: chat.ts,
      channel: chat.channel,
      player_id: playerId,
      player_name: chat.playerName,
      steam_id64: chat.steamId64,
      eos_id: chat.eosId,
      message: chat.message,
    },
  };
}

/**
 * Fan one chat line out to the live bus and persist it.
 *
 * The frame is published whatever happens; the archive row is written only
 * when the sender resolves to a known player, because `chat_messages.player_id`
 * is required. A sender the panel has never seen (no roster poll yet, no name
 * history) therefore shows up live but is not archived.
 *
 * A failed insert never breaks the live feed — the frame is already published
 * by then — but it is reported through `onArchiveError` instead of vanishing:
 * chat shown live and silently lost from the archive is exactly the kind of
 * gap this pipeline exists to close.
 *
 * @param db - Database client used for identity lookup and the insert.
 * @param redis - Live-bus publisher, or null to skip the fan-out.
 * @param source - Which pipeline carried the line; stored on the archive row.
 * @param onArchiveError - Called when the archive insert fails; the live frame
 *   has already been published at that point and is still returned.
 * @param detector - Optional profanity/flag matcher (CHATLOG-5).
 * @returns The frame that was published, so callers can reuse it.
 */
export async function handleChat(
  db: DatabaseClient,
  redis: ChatPublisher | null,
  {
    serverId,
    chat,
    source = 'log',
    onArchiveError,
  }: {
    serverId: string;
    chat: ChatInput;
    source?: ChatSource;
    onArchiveError?: (err: Error) => void;
  },
  detector?: ChatFlagDetector | null,
): Promise<ChatMessageFrame> {
  const playerId = await resolvePlayerId(db, chat);
  const frame = buildChatFrame(playerId, serverId, chat);
  if (redis) await redis.publish(LIVE_BUS_CHANNEL, JSON.stringify(frame));
  if (playerId) {
    const matchedRuleId = detector ? await detector.detect(chat.message).catch(() => null) : null;
    await recordChatMessage(db, {
      playerId,
      serverId,
      sentAt: new Date(chat.ts),
      scope: CHANNEL_SCOPE[chat.channel],
      message: chat.message,
      source,
      isFlagged: matchedRuleId !== null,
      matchedRuleId,
    }).catch((err) => onArchiveError?.(err as Error));
  }
  return frame;
}
