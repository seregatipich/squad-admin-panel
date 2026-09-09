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
  /^\[(?<channel>ChatAll|ChatTeam|ChatSquad|ChatAdmin)\]\s*\[Online IDs?:\s*EOS:\s*(?<eos>[0-9a-f]{32})(?:\s+steam:\s*(?<steam>\d{17}))?\s*\]\s*(?<name>.*?)\s:\s(?<message>.*)$/is;

/**
 * Parse one RCON broadcast body into a chat message.
 *
 * @param body - Raw packet body as Squad sent it.
 * @param ts - ISO-8601 receive timestamp; Squad's broadcast carries no clock.
 * @returns The parsed message, or `null` when the body is not a chat line.
 */
export function parseRconChatLine(body: string, ts: string): ChatInput | null {
  // Only the packet's own framing is stripped: a trailing space belongs to
  // the separator of an empty message (`<Name> : `).
  const match = CHAT_LINE.exec(body.replace(/[\0\r\n]+$/, ''));
  const groups = match?.groups;
  if (!groups?.channel || !groups.eos) return null;
  const name = (groups.name ?? '').trim();
  if (name === '') return null;
  return {
    ts,
    channel: groups.channel as ChatChannel,
    eosId: groups.eos.toLowerCase(),
    steamId64: groups.steam ?? null,
    playerName: name,
    message: groups.message ?? '',
  };
}
