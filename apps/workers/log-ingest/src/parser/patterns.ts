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

/**
 * `LogNet: AddClientConnection: Added client connection: [UNetConnection]
 * RemoteAddr: <ip>:<port>, Name: EOSIpNetConnection_..., Driver: GameNetDriver
 * EOSNetDriver_..., ...` — fires when the client's network connection is
 * established, shortly before `Join succeeded`. Only the EOS/IP driver
 * variant carries a real dotted-quad address (the Steam driver variant
 * puts the SteamID64 in the RemoteAddr slot instead), so anchoring on a
 * dotted IPv4 address naturally excludes it.
 */
export const PLAYER_REMOTE_ADDR =
  /^AddClientConnection: Added client connection: \[UNetConnection\] RemoteAddr: (\d{1,3}(?:\.\d{1,3}){3}):\d+/;

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

export const SQUAD_LOG_EXIT = /^\[(?<ts>[^\]]+)\]\[ *\d+\]LogExit: (?<msg>.*)$/;
export const SQUAD_FATAL_ERROR = /^\[(?<ts>[^\]]+)\]\[ *\d+\]Fatal error: (?<msg>.*)$/;
export const SQUAD_ASSERTION_FAILED =
  /Assertion failed: (?<msg>.*) \[File:(?<file>[^\]]+) Line: (?<line>\d+)\]/;

export interface SquadFatalMatch {
  ts: string | null;
  message: string;
  file: string | null;
  line: number | null;
}

export function detectSquadFatal(line: string): SquadFatalMatch | null {
  const assertion = SQUAD_ASSERTION_FAILED.exec(line);
  if (assertion?.groups) {
    return {
      ts: null,
      message: assertion.groups.msg ?? '',
      file: assertion.groups.file ?? null,
      line: Number(assertion.groups.line),
    };
  }
  const exit = SQUAD_LOG_EXIT.exec(line);
  if (exit?.groups) {
    return {
      ts: exit.groups.ts ?? null,
      message: exit.groups.msg ?? '',
      file: null,
      line: null,
    };
  }
  const fatal = SQUAD_FATAL_ERROR.exec(line);
  if (fatal?.groups) {
    return {
      ts: fatal.groups.ts ?? null,
      message: fatal.groups.msg ?? '',
      file: null,
      line: null,
    };
  }
  return null;
}
