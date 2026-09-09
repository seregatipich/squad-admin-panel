/**
 * RCON chat broadcast parser.
 *
 * Squad does not write in-game chat to SquadGame.log; it pushes each message to
 * every authenticated RCON client as an unsolicited packet whose body looks
 * like:
 *
 *   [ChatAll] [Online IDs:EOS: <eos32> steam: <steam17>] <Name> : <text>
 *
 * The same packet type also carries admin-camera, squad-creation and kick/warn
 * notices, so anything that is not a chat line parses to `null` and is dropped
 * without logging (these arrive continuously on a busy server).
 *
 * A player name may itself contain " : ", which makes the split ambiguous. The
 * first separator wins, matching SquadJS's reference regex — the alternative
 * (last separator) would swallow any message containing " : " into the name.
 */
import type { ChatChannel, ChatInput } from '@squad/chat-ingest';

const CHAT_LINE =
  /^\[(?<channel>ChatAll|ChatTeam|ChatSquad|ChatAdmin)\]\s*\[Online IDs?:(?<ids>[^\]]*)\]\s*(?<name>.*?)\s:\s(?<message>.*)$/is;

/**
 * `<platform>: <id>` pairs inside the identity block. Squad emits them in no
 * fixed order and may carry platforms beyond EOS and Steam, so they are read
 * as pairs rather than matched positionally (mirrors SquadJS's id-parser).
 */
const ID_PAIR = /([^\s:]+)\s*:\s*(\S+)/g;

function parseIds(block: string): { eosId: string | null; steamId64: string | null } {
  let eosId: string | null = null;
  let steamId64: string | null = null;
  for (const match of block.matchAll(ID_PAIR)) {
    const platform = match[1]?.toLowerCase();
    const value = match[2];
    if (!platform || !value) continue;
    if (platform === 'eos' && /^[0-9a-f]{32}$/i.test(value)) eosId = value.toLowerCase();
    else if (platform === 'steam' && /^\d{17}$/.test(value)) steamId64 = value;
  }
  return { eosId, steamId64 };
}

/**
 * Parse one RCON broadcast body into a chat message.
 *
 * @param body - Raw packet body as Squad sent it.
 * @param ts - ISO-8601 receive timestamp; Squad's broadcast carries no clock.
 * @returns The parsed message, or `null` when the body is not a chat line, or
 *   carries neither an EOS nor a Steam id (the sender could never be resolved).
 */
export function parseRconChatLine(body: string, ts: string): ChatInput | null {
  // Only the packet's own framing is stripped: a trailing space belongs to
  // the separator of an empty message (`<Name> : `).
  const groups = CHAT_LINE.exec(body.replace(/[\0\r\n]+$/, ''))?.groups;
  if (!groups?.channel) return null;
  const { eosId, steamId64 } = parseIds(groups.ids ?? '');
  if (!eosId && !steamId64) return null;
  const name = (groups.name ?? '').trim();
  if (name === '') return null;
  return {
    ts,
    channel: groups.channel as ChatChannel,
    eosId,
    steamId64,
    playerName: name,
    message: groups.message ?? '',
  };
}
