/**
 * In-game `!report` chat parser (REPORT-1).
 *
 * Squad writes chat lines to SquadGame.log under the `LogSquad`/`LogChat`
 * category. Modern builds embed the sender's online identity inline:
 *
 *   [YYYY.MM.DD-HH.MM.SS:mmm][<tick>]LogSquad: ChatMessage: <steam>
 *     [Online IDs: EOS: <eos32> steam: <steam17>] <Name> : <Channel> : <text>
 *
 * Older builds omit the `[Online IDs: …]` block and carry only a display name.
 * `parseReportLine` is a pure function so it can be unit-tested without a live
 * server; the exact live wire format is env-gated and may need a regex tweak
 * when validated against a real Squad host.
 */
import { CHAT_CATEGORIES, CHAT_MESSAGE, type ParsedChat } from './chat.js';
import { type LogLine, parseLine } from './patterns.js';

export interface ParsedReport {
  ts: string;
  tick: number;
  channel: string;
  reporterEos: string | null;
  reporterSteam: string | null;
  reporterName: string;
  targetRaw: string;
  body: string;
}

const SENDER_IDS =
  /\[Online IDs:\s*EOS:\s*(?<eos>[0-9a-f]{32})(?:\s+steam:\s*(?<steam>\d{17}))?\s*\]/i;

const BARE_STEAM = /^(?<steam>\d{17})\b/;
const BARE_EOS = /^(?<eos>[0-9a-f]{32})\b/i;

const REPORT_COMMAND = /^!report\b\s*(?<rest>.*)$/i;

function parseSender(sender: string): {
  reporterEos: string | null;
  reporterSteam: string | null;
  reporterName: string;
} {
  const ids = SENDER_IDS.exec(sender);
  if (ids?.groups) {
    const name = sender
      .replace(SENDER_IDS, '')
      .replace(/^\d{17}\s*/, '')
      .trim();
    return {
      reporterEos: ids.groups.eos ? ids.groups.eos.toLowerCase() : null,
      reporterSteam: ids.groups.steam ?? null,
      reporterName: name,
    };
  }
  const bareEos = BARE_EOS.exec(sender);
  if (bareEos?.groups?.eos) {
    return {
      reporterEos: bareEos.groups.eos.toLowerCase(),
      reporterSteam: null,
      reporterName: sender.slice(bareEos.groups.eos.length).trim(),
    };
  }
  const bareSteam = BARE_STEAM.exec(sender);
  if (bareSteam?.groups?.steam) {
    return {
      reporterEos: null,
      reporterSteam: bareSteam.groups.steam,
      reporterName: sender.slice(bareSteam.groups.steam.length).trim(),
    };
  }
  return { reporterEos: null, reporterSteam: null, reporterName: sender.trim() };
}

function splitTarget(rest: string): { targetRaw: string; body: string } | null {
  const trimmed = rest.trim();
  if (!trimmed) return null;
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return { targetRaw: trimmed, body: trimmed };
  const targetRaw = trimmed.slice(0, boundary);
  const body = trimmed.slice(boundary + 1).trim();
  return { targetRaw, body: body || targetRaw };
}

/**
 * Reads a `!report <target> <text>` from one chat message, wherever the line
 * came from. `null` when the text is not a report command or names no target.
 */
function reportFromMessage(
  text: string,
  ts: string,
  tick: number,
  channel: string,
  reporter: { reporterEos: string | null; reporterSteam: string | null; reporterName: string },
): ParsedReport | null {
  const command = REPORT_COMMAND.exec(text);
  if (!command?.groups) return null;
  const target = splitTarget(command.groups.rest ?? '');
  if (!target) return null;
  return {
    ts,
    tick,
    channel,
    ...reporter,
    targetRaw: target.targetRaw,
    body: target.body,
  };
}

export function parseReportFromLogLine(parsed: LogLine): ParsedReport | null {
  if (!CHAT_CATEGORIES.has(parsed.category)) return null;
  const chat = CHAT_MESSAGE.exec(parsed.message);
  if (!chat?.groups) return null;
  return reportFromMessage(
    chat.groups.text ?? '',
    parsed.ts.toISOString(),
    parsed.tick,
    chat.groups.channel as string,
    parseSender(chat.groups.sender ?? ''),
  );
}

/**
 * Reads a `!report` from a chat line that arrived over RCON (#2), where Squad
 * delivers in-game chat and no log line exists. The sender is already split
 * into ids and name; there is no log tick, so it is 0, and the report id is
 * derived from the receive time and the text like any other.
 *
 * @param chat - the parsed chat line
 * @returns the report, or `null` when the message is not `!report <target> ...`
 */
export function parseReportFromChat(chat: ParsedChat): ParsedReport | null {
  return reportFromMessage(chat.message, chat.ts, 0, chat.channel, {
    reporterEos: chat.eosId,
    reporterSteam: chat.steamId64,
    reporterName: chat.playerName,
  });
}

export function parseReportLine(raw: string): ParsedReport | null {
  const parsed = parseLine(raw);
  if (!parsed) return null;
  return parseReportFromLogLine(parsed);
}
