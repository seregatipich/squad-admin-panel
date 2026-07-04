import { type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import { v7 as uuidv7 } from 'uuid';
import {
  BEACON_BIND,
  detectSquadFatal,
  isBenignNoise,
  MATCH_STATE_CHANGED,
  PLAYER_DISCONNECT,
  PLAYER_EOS_CONNECTION,
  PLAYER_JOIN_SUCCEEDED,
  parseLine,
  RCON_ADMIN_COMMAND,
  SERVER_EXIT_CODE,
} from './patterns.js';
import { type ParsedReport, parseReportFromLogLine } from './report.js';

export interface ParseErrorReport {
  lineSample: string;
  regex: string;
  errorMessage: string;
}

export interface SquadFatalReport {
  message: string;
  ts: string | null;
  file: string | null;
  line: number | null;
  raw: string;
}

export interface IngestorCallbacks {
  onParseError?: (report: ParseErrorReport) => void;
  onSquadFatal?: (report: SquadFatalReport) => void;
}

/** One instance per Squad server under observation. */
export class LogIngestor {
  private readonly serverId: string;
  private readonly beaconPort: number;
  private recentJoin: { name: string; ts: number } | null = null;
  private readonly joinCorrelationWindowMs: number;
  private readonly onParseError?: (report: ParseErrorReport) => void;
  private readonly onSquadFatal?: (report: SquadFatalReport) => void;
  private readonly onReport?: (report: ParsedReport) => void;

  constructor(params: {
    serverId: string;
    beaconPort: number;
    joinCorrelationWindowMs?: number;
    onParseError?: (report: ParseErrorReport) => void;
    onSquadFatal?: (report: SquadFatalReport) => void;
    onReport?: (report: ParsedReport) => void;
  }) {
    this.serverId = params.serverId;
    this.beaconPort = params.beaconPort;
    this.joinCorrelationWindowMs = params.joinCorrelationWindowMs ?? 2500;
    this.onParseError = params.onParseError;
    this.onSquadFatal = params.onSquadFatal;
    this.onReport = params.onReport;
  }

  ingest(line: string): EventEnvelope[] {
    if (isBenignNoise(line)) return [];
    const fatal = detectSquadFatal(line);
    if (fatal && this.onSquadFatal) {
      this.onSquadFatal({
        message: fatal.message,
        ts: fatal.ts,
        file: fatal.file,
        line: fatal.line,
        raw: line,
      });
    }
    const parsed = parseLine(line);
    if (!parsed) {
      if (!fatal && this.onParseError && line.startsWith('[')) {
        this.onParseError({
          lineSample: line.slice(0, 200),
          regex: 'PREFIX',
          errorMessage: 'log line did not match the timestamp/category prefix',
        });
      }
      return [];
    }
    if (this.onReport) {
      const report = parseReportFromLogLine(parsed);
      if (report) {
        this.onReport(report);
        return [];
      }
    }
    try {
      return this.handleMessage(parsed.category, parsed.message, parsed.ts.toISOString());
    } catch (err) {
      this.onParseError?.({
        lineSample: line.slice(0, 200),
        regex: parsed.category,
        errorMessage: (err as Error).message,
      });
      return [];
    }
  }

  private handleMessage(category: string, message: string, ts: string): EventEnvelope[] {
    const events: EventEnvelope[] = [];

    if (category === 'LogNet') {
      const bind = BEACON_BIND.exec(message);
      if (bind) {
        const port = Number(bind[1]);
        if (port === this.beaconPort) {
          events.push(this.build('server.ready', ts, { port }));
        }
        return events;
      }

      const join = PLAYER_JOIN_SUCCEEDED.exec(message);
      if (join) {
        this.recentJoin = { name: join[1] as string, ts: Date.parse(ts) };
        return events;
      }

      const disc = PLAYER_DISCONNECT.exec(message);
      if (disc) {
        events.push(
          this.build('player.disconnected', ts, {
            eos_id: disc[1] ?? null,
            steam_id64: disc[2] as string,
            reason: null,
          }),
        );
        return events;
      }
    }

    if (category === 'LogGameMode' || category === 'LogGameState') {
      const ms = MATCH_STATE_CHANGED.exec(message);
      if (ms) {
        const [, from, to] = ms;
        if (from === 'WaitingToStart' && to === 'InProgress') {
          events.push(this.build('match.started', ts, { from_state: from, to_state: to }));
        } else if (to === 'WaitingPostMatch' && from === 'InProgress') {
          events.push(this.build('match.ended', ts, { from_state: from, to_state: to }));
        }
      }
      return events;
    }

    if (category === 'LogSquad') {
      const admin = RCON_ADMIN_COMMAND.exec(message);
      if (admin) {
        events.push(
          this.build('rcon.connected', ts, {
            summary: admin[1],
            source: admin[2],
          }),
        );
      }
      return events;
    }

    if (category === 'LogCore') {
      const exit = SERVER_EXIT_CODE.exec(message);
      if (exit) {
        const code = Number(exit[2]);
        const type = code === 143 || code === 0 ? 'server.stopped' : 'server.crashed';
        events.push(this.build(type, ts, { exit_code: code }));
      }
      return events;
    }

    if (category.startsWith('LogRedpointEOS') || category === 'LogEOS') {
      const eos = PLAYER_EOS_CONNECTION.exec(message);
      if (eos && this.recentJoin) {
        const age = Date.parse(ts) - this.recentJoin.ts;
        if (age >= 0 && age < this.joinCorrelationWindowMs) {
          events.push(
            this.build('player.connected', ts, {
              name: this.recentJoin.name,
              eos_id: eos[1],
              steam_id64: eos[2],
              ip: null,
            }),
          );
        }
        this.recentJoin = null;
      }
      return events;
    }

    return events;
  }

  private build(
    type: EventEnvelope['type'],
    ts: string,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    return {
      event_id: uuidv7(),
      version: 1,
      type,
      server_id: this.serverId,
      ts,
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload,
    };
  }
}

export const streamFor = (serverId: string) => STREAM_NAME.eventsServer(serverId);
