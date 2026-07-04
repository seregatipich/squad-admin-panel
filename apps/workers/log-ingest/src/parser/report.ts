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
import { type LogLine, parseLine } from './patterns.js';

export interface ParsedReport {
  ts: string;
  channel: string;
  reporterEos: string | null;
  reporterSteam: string | null;
  reporterName: string;
  targetRaw: string;
  body: string;
}

const CHAT_CATEGORIES = new Set(['LogSquad', 'LogChat']);

const CHAT_MESSAGE =
  /^ChatMessage:\s*(?<sender>.+?)\s*:\s*(?<channel>ChatAll|ChatTeam|ChatSquad|ChatAdmin)\s*:\s*(?<text>.+)$/;

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

export function parseReportFromLogLine(parsed: LogLine): ParsedReport | null {
  if (!CHAT_CATEGORIES.has(parsed.category)) return null;
  const chat = CHAT_MESSAGE.exec(parsed.message);
  if (!chat?.groups) return null;

  const command = REPORT_COMMAND.exec(chat.groups.text ?? '');
  if (!command?.groups) return null;

  const target = splitTarget(command.groups.rest ?? '');
  if (!target) return null;

  const { reporterEos, reporterSteam, reporterName } = parseSender(chat.groups.sender ?? '');

  return {
    ts: parsed.ts.toISOString(),
    channel: chat.groups.channel as string,
    reporterEos,
    reporterSteam,
    reporterName,
    targetRaw: target.targetRaw,
    body: target.body,
  };
}

export function parseReportLine(raw: string): ParsedReport | null {
  const parsed = parseLine(raw);
  if (!parsed) return null;
  return parseReportFromLogLine(parsed);
}
