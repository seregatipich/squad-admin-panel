/**
 * Squad log patterns, validated against v10.3.1 actual output (§0A.5).
 *
 * Each raw log line looks like:
 *   [YYYY.MM.DD-HH.MM.SS:mmm][<tick>]<Category>: [<Verbosity>: ]<message>
 *
 * `parseLine` strips the prefix + verbosity and returns `{ category, message, ts, tick }`.
 * The event patterns below operate on `message` alone; `handleMessage` additionally
 * switches on `category` where relevant.
 */

export interface LogLine {
  ts: Date;
  tick: number;
  category: string;
  verbosity: string | null;
  raw: string;
  message: string;
}

const PREFIX =
  /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]\[\s*(\d+)\](Log[A-Za-z0-9_]+): (?:(Display|Verbose|Warning|Error): )?(.*)$/;

export function parseLine(line: string): LogLine | null {
  const match = PREFIX.exec(line);
  if (!match) return null;
  const ts = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
    ),
  );
  return {
    ts,
    tick: Number(match[8]),
    category: match[9] as string,
    verbosity: match[10] ?? null,
    raw: line,
    message: match[11] as string,
  };
}

// Patterns operate on the `message` portion (category already consumed).

export const BEACON_BIND = /^Created socket for bind address: 0\.0\.0\.0:(\d{4,5})$/;

export const MATCH_STATE_CHANGED = /^Match State Changed from (\S+) to (\S+)$/;

export const RCON_ADMIN_COMMAND = /^ADMIN COMMAND: (.+?) from (RCON|\S+)$/;

export const SERVER_EXIT_CODE =
  /^FUnixPlatformMisc::RequestExit\(bForce=(true|false), ReturnCode=(\d+)\)/;

export const PLAYER_JOIN_SUCCEEDED = /^Join succeeded: (.+)$/;

export const PLAYER_EOS_CONNECTION =
  /(?:EOS Connection|EOSNet).*?EOS:([a-f0-9]{32}).*Steam:(\d{17})/;

export const PLAYER_DISCONNECT =
  /^UChannel::Close: .+UniqueId: (?:EOS:([a-f0-9]{32})\|STEAM:)?(\d{17})/;

// Benign noise filter; ingest drops these before ever looking for events.
export const BENIGN_NOISE = [
  /LogStreaming: (?:Error|Warning): CreateExport: .+ (?:EngineFailedStartAudio|PropellerMistEffectsAudio|SQCenterOfMassWaterFX)/,
  /LogSquad: Error: Failed to spawn EquipableItem/,
  /LogRedpointEOS: Verbose: /,
  /LogStreaming: Warning: Skipped failed export/,
];

export function isBenignNoise(line: string): boolean {
  for (const r of BENIGN_NOISE) {
    if (r.test(line)) return true;
  }
  return false;
}
