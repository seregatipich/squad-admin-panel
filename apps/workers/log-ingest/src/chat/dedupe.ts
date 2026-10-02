import { createHash } from 'node:crypto';
import type { ParsedChat } from '../parser/chat.js';
import type { ParsedReport } from '../parser/report.js';
import { chatSenderIdentity } from './commands.js';

/**
 * How long a handled chat line is remembered. Both producers deliver a line
 * within a second or two of each other; the per-player command cooldown (10 s),
 * automation cooldown (60 s) and report dedup window (5 min) cover repeats.
 */
export const CHAT_DEDUP_TTL_SECONDS = 15;

export interface ChatClaimRedis {
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<unknown>;
}

function digest(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

async function claim(redis: ChatClaimRedis | null, key: string): Promise<boolean> {
  if (!redis) return true;
  return (await redis.set(key, '1', 'EX', CHAT_DEDUP_TTL_SECONDS, 'NX')) === 'OK';
}

/**
 * Claims the right to react to one chat line (#2) with a command answer or an
 * automation. A line can reach worker-log-ingest twice — Squad builds that
 * still log chat deliver it through the log tail and through worker-rcon's RCON
 * feed — and each delivery must not answer or fire again. The first caller
 * claims `chat:handled:<server>:<sender>:<channel>:<hash of the text>`; the
 * timestamp is not part of the key because the two producers date the line
 * differently.
 *
 * @param redis - the connection, or `null` when Redis is unavailable (then every delivery is handled)
 * @param serverId - the server the line came from
 * @param chat - the chat line
 * @returns `true` for the first delivery of this line, `false` for a repeat
 */
export function claimChatLine(
  redis: ChatClaimRedis | null,
  serverId: string,
  chat: ParsedChat,
): Promise<boolean> {
  return claim(
    redis,
    `chat:handled:${serverId}:${chatSenderIdentity(chat)}:${chat.channel}:${digest(chat.message)}`,
  );
}

/**
 * Claims the right to record one `!report` (#2): the log tail and the RCON chat
 * feed can both deliver it. Keyed on the reporter, channel and what was
 * reported, never on the timestamp or tick the producers disagree on.
 *
 * @param redis - the connection, or `null` when Redis is unavailable
 * @param serverId - the server the report came from
 * @param report - the parsed report
 * @returns `true` for the first delivery, `false` for a repeat
 */
export function claimReport(
  redis: ChatClaimRedis | null,
  serverId: string,
  report: ParsedReport,
): Promise<boolean> {
  const reporter = report.reporterEos ?? report.reporterSteam ?? `name:${report.reporterName}`;
  return claim(
    redis,
    `chat:handled-report:${serverId}:${reporter}:${report.channel}:${digest(report.targetRaw, report.body)}`,
  );
}
