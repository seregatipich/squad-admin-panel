/**
 * Live chat parser (CHAT-1).
 *
 * Squad writes every in-game chat line to SquadGame.log under the
 * `LogSquad`/`LogChat` category. Modern builds embed the sender's online
 * identity inline; older builds carry only a display name:
 *
 *   [YYYY.MM.DD-HH.MM.SS:mmm][<tick>]LogSquad: ChatMessage: <steam>
 *     [Online IDs: EOS: <eos32> steam: <steam17>] <Name> : <Channel> : <text>
 *
 * `parseChatFromLogLine` is a pure function so it can be unit-tested without a
 * live server. It returns one structured message per chat line regardless of
 * command (`!report` lines are still chat and are surfaced in the viewer). The
 * exact live wire format is env-gated and mirrors the REPORT-1 parser so both
 * stay in lockstep.
 */
import { type LogLine, parseLine } from './patterns.js';

export type ChatChannel = 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin';

export interface ParsedChat {
  ts: string;
  channel: ChatChannel;
  eosId: string | null;
  steamId64: string | null;
  playerName: string;
  message: string;
}

const CHAT_CATEGORIES = new Set(['LogSquad', 'LogChat']);

const CHAT_MESSAGE =
  /^ChatMessage:\s*(?<sender>.+?)\s*:\s*(?<channel>ChatAll|ChatTeam|ChatSquad|ChatAdmin)\s*:\s*(?<text>.*)$/;

const SENDER_IDS =
  /\[Online IDs:\s*EOS:\s*(?<eos>[0-9a-f]{32})(?:\s+steam:\s*(?<steam>\d{17}))?\s*\]/i;

const BARE_STEAM = /^(?<steam>\d{17})\b/;
const BARE_EOS = /^(?<eos>[0-9a-f]{32})\b/i;

function parseSender(sender: string): {
  eosId: string | null;
  steamId64: string | null;
  playerName: string;
} {
  const ids = SENDER_IDS.exec(sender);
  if (ids?.groups) {
    const name = sender
      .replace(SENDER_IDS, '')
      .replace(/^\d{17}\s*/, '')
      .trim();
    return {
      eosId: ids.groups.eos ? ids.groups.eos.toLowerCase() : null,
      steamId64: ids.groups.steam ?? null,
      playerName: name,
    };
  }
  const bareEos = BARE_EOS.exec(sender);
  if (bareEos?.groups?.eos) {
    return {
      eosId: bareEos.groups.eos.toLowerCase(),
      steamId64: null,
      playerName: sender.slice(bareEos.groups.eos.length).trim(),
    };
  }
  const bareSteam = BARE_STEAM.exec(sender);
  if (bareSteam?.groups?.steam) {
    return {
      eosId: null,
      steamId64: bareSteam.groups.steam,
      playerName: sender.slice(bareSteam.groups.steam.length).trim(),
    };
  }
  return { eosId: null, steamId64: null, playerName: sender.trim() };
}

export function parseChatFromLogLine(parsed: LogLine): ParsedChat | null {
  if (!CHAT_CATEGORIES.has(parsed.category)) return null;
  const chat = CHAT_MESSAGE.exec(parsed.message);
  if (!chat?.groups) return null;

  const message = (chat.groups.text ?? '').trim();
  if (!message) return null;

  const { eosId, steamId64, playerName } = parseSender(chat.groups.sender ?? '');
  if (!playerName) return null;

  return {
    ts: parsed.ts.toISOString(),
    channel: chat.groups.channel as ChatChannel,
    eosId,
    steamId64,
    playerName,
    message,
  };
}

export function parseChatLine(raw: string): ParsedChat | null {
  const parsed = parseLine(raw);
  if (!parsed) return null;
  return parseChatFromLogLine(parsed);
}
