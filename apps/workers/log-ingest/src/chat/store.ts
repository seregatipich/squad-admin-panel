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
import type { ChatChannel, ParsedChat } from '../parser/chat.js';
import type { ChatFlagDetector } from './flag-rules.js';

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

export async function resolvePlayerId(
  db: DatabaseClient,
  chat: ParsedChat,
): Promise<string | null> {
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
  chat: ParsedChat,
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

export async function handleChat(
  db: DatabaseClient,
  redis: ChatPublisher | null,
  { serverId, chat }: { serverId: string; chat: ParsedChat },
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
      source: 'log',
      isFlagged: matchedRuleId !== null,
      matchedRuleId,
    }).catch(() => undefined);
  }
  return frame;
}
