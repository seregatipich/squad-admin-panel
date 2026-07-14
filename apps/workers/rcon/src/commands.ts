import { setTimeout as sleep } from 'node:timers/promises';
import {
  RCON_COMMAND_GROUP,
  type RconCommandRequest,
  type RconCommandResult,
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandResultKey,
  rconCommandResultSchema,
  rconCommandStream,
  rconOperatorCommandNameSchema,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

const RESULT_TTL_SECONDS = 120;
const DEFAULT_BLOCK_MS = 500;
const DEFAULT_COUNT = 10;
const BROADCAST_MAX_CHARS = 300;
const TARGET_MAX_CHARS = 64;
const DEFAULT_RECLAIM_MIN_IDLE_MS = 60_000;
const DEFAULT_RECLAIM_INTERVAL_MS = 30_000;
// Squad RCON ban-length syntax: a bare integer (days) or an integer with a
// unit suffix (seconds/minutes/hours/days/weeks/months/years); '0' = permanent.
const BAN_LENGTH_PATTERN = /^\d+[smhdwMy]?$/;

type StreamReadResult = Array<[string, Array<[string, string[]]>]> | null;

export interface RconCommandQueueOptions {
  redis: Redis;
  log: Logger;
  serverId: string;
  execute: (command: string) => Promise<string>;
  blockMs?: number;
  count?: number;
  consumerName?: string;
  resultTtlSeconds?: number;
  reclaimMinIdleMs?: number;
  reclaimIntervalMs?: number;
}

export function buildOperatorCommand(input: unknown): string {
  const parsed = rconCommandRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`unsupported or invalid rcon operator command: ${parsed.error.message}`);
  }
  const request = parsed.data;
  switch (request.command) {
    case 'AdminBroadcast':
      return `AdminBroadcast ${validateBroadcastText(request.args)}`;
    case 'AdminEndMatch':
      ensureNoArgs(request);
      return 'AdminEndMatch';
    case 'AdminReloadServerConfig':
      ensureNoArgs(request);
      return 'AdminReloadServerConfig';
    case 'AdminWarn':
      return buildAdminWarnCommand(request.args);
    case 'AdminKick':
      return buildAdminKickCommand(request.args);
    case 'AdminBan':
      return buildAdminBanCommand(request.args);
  }
}

export class RconCommandQueue {
  private readonly stream: string;
  private readonly blockMs: number;
  private readonly count: number;
  private readonly consumerName: string;
  private readonly resultTtlSeconds: number;
  private readonly reclaimMinIdleMs: number;
  private readonly reclaimIntervalMs: number;
  private running = false;
  private loopPromise?: Promise<void>;
  private nextReclaimAt = 0;

  constructor(private readonly opts: RconCommandQueueOptions) {
    this.stream = rconCommandStream(opts.serverId);
    this.blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
    this.count = opts.count ?? DEFAULT_COUNT;
    this.consumerName =
      opts.consumerName ?? `worker-rcon-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.resultTtlSeconds = opts.resultTtlSeconds ?? RESULT_TTL_SECONDS;
    this.reclaimMinIdleMs = opts.reclaimMinIdleMs ?? DEFAULT_RECLAIM_MIN_IDLE_MS;
    this.reclaimIntervalMs = opts.reclaimIntervalMs ?? DEFAULT_RECLAIM_INTERVAL_MS;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.opts.redis.xgroup('CREATE', this.stream, RCON_COMMAND_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if ((err as Error).message?.includes('BUSYGROUP')) return;
      throw err;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureGroup();
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
  }

  async processOnce(): Promise<number> {
    const result = (await this.opts.redis.xreadgroup(
      'GROUP',
      RCON_COMMAND_GROUP,
      this.consumerName,
      'COUNT',
      String(this.count),
      'BLOCK',
      String(this.blockMs),
      'STREAMS',
      this.stream,
      '>',
    )) as StreamReadResult;
    if (!result) return 0;

    let processed = 0;
    for (const [streamName, entries] of result) {
      for (const [streamId, kv] of entries) {
        await this.processEntry(streamName, streamId, kv);
        processed++;
      }
    }
    return processed;
  }

  async reclaimPendingOnce(): Promise<number> {
    const result = (await this.opts.redis.xautoclaim(
      this.stream,
      RCON_COMMAND_GROUP,
      this.consumerName,
      this.reclaimMinIdleMs,
      '0-0',
      'COUNT',
      String(this.count),
    )) as [string, Array<[string, string[]]>, string[]];
    const entries = result?.[1] ?? [];
    let processed = 0;
    for (const [streamId, kv] of entries) {
      await this.processEntry(this.stream, streamId, kv);
      processed++;
    }
    return processed;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processOnce();
        if (Date.now() >= this.nextReclaimAt) {
          await this.reclaimPendingOnce();
          this.nextReclaimAt = Date.now() + this.reclaimIntervalMs;
        }
        if (processed === 0) await sleep(25);
      } catch (err) {
        this.opts.log.warn(
          { err: (err as Error).message, serverId: this.opts.serverId },
          'rcon command queue read failed',
        );
        await sleep(1000);
      }
    }
  }

  private async processEntry(streamName: string, streamId: string, kv: string[]): Promise<void> {
    const raw = getField(kv, 'request');
    if (!raw) {
      await this.opts.redis.xack(streamName, RCON_COMMAND_GROUP, streamId);
      return;
    }

    let request: unknown;
    try {
      request = JSON.parse(raw);
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, streamId, serverId: this.opts.serverId },
        'malformed rcon command request',
      );
      await this.opts.redis.xack(streamName, RCON_COMMAND_GROUP, streamId);
      return;
    }

    const startedAt = Date.now();
    const requestId = requestIdOf(request);
    const commandName = commandNameOf(request);
    if (requestId && (await this.resultExists(requestId))) {
      await this.opts.redis.xack(streamName, RCON_COMMAND_GROUP, streamId);
      return;
    }
    try {
      const command = buildOperatorCommand(request);
      const response = await this.opts.execute(command);
      if (requestId) {
        await this.writeResult({
          ok: true,
          server_id: this.opts.serverId,
          request_id: requestId,
          ...(commandName ? { command: commandName } : {}),
          response,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
        });
      }
      await this.opts.redis.xack(streamName, RCON_COMMAND_GROUP, streamId);
    } catch (err) {
      if (requestId) {
        await this.writeResult({
          ok: false,
          server_id: this.opts.serverId,
          request_id: requestId,
          ...(commandName ? { command: commandName } : {}),
          error: (err as Error).message,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
        });
      }
      await this.opts.redis.xack(streamName, RCON_COMMAND_GROUP, streamId);
    }
  }

  private async writeResult(result: RconCommandResult): Promise<void> {
    const payload = JSON.stringify(rconCommandResultSchema.parse(result));
    await this.opts.redis.set(
      rconCommandResultKey(result.request_id),
      payload,
      'EX',
      this.resultTtlSeconds,
    );
  }

  private async resultExists(requestId: string): Promise<boolean> {
    try {
      return (await this.opts.redis.get(rconCommandResultKey(requestId))) !== null;
    } catch {
      return false;
    }
  }
}

function validateBroadcastText(args: string[]): string {
  if (args.length !== 1) throw new Error('AdminBroadcast expects exactly one message argument');
  return assertSafeSingleLineText(args[0], 'AdminBroadcast message', BROADCAST_MAX_CHARS);
}

/**
 * Builds `AdminWarn <target> <message>`, reusing the same text-safety checks
 * as AdminBroadcast (no CR/LF/NUL, length cap) for the warning message. The
 * target is the player's EOS id, SteamID64, or in-game name — whatever the
 * caller resolved from the live roster.
 */
function buildAdminWarnCommand(args: string[]): string {
  if (args.length !== 2) {
    throw new Error('AdminWarn expects exactly two arguments: target id and message');
  }
  const target = assertSafeSingleLineText(args[0], 'AdminWarn target', TARGET_MAX_CHARS);
  const message = assertSafeSingleLineText(args[1], 'AdminWarn message', BROADCAST_MAX_CHARS);
  return `AdminWarn ${target} ${message}`;
}

/**
 * Builds `AdminKick <target> <reason>`, reusing the same text-safety checks as
 * AdminWarn (no CR/LF/NUL, length cap). The target is the player's EOS id,
 * SteamID64, or in-game name resolved by the caller; the reason is surfaced to
 * the kicked player. Automated kicks (banned-name / external-ban / clan-tag
 * enforcement) enqueue this command via the worker-rcon queue.
 */
function buildAdminKickCommand(args: string[]): string {
  if (args.length !== 2) {
    throw new Error('AdminKick expects exactly two arguments: target id and reason');
  }
  const target = assertSafeSingleLineText(args[0], 'AdminKick target', TARGET_MAX_CHARS);
  const reason = assertSafeSingleLineText(args[1], 'AdminKick reason', BROADCAST_MAX_CHARS);
  return `AdminKick ${target} ${reason}`;
}

/**
 * Builds `AdminBan <target> <banLength> <reason>`. The target and reason use
 * the same text-safety checks as AdminKick/AdminWarn; `banLength` is Squad's
 * RCON ban-duration syntax — a bare number of days, or a number followed by a
 * unit (`s`/`m`/`h`/`d`/`w`/`M`/`y`) — with `0` meaning a permanent ban.
 * Report-card bans (REPORT-3, #113) default to `0` unless the moderator picks
 * a shorter duration.
 */
function buildAdminBanCommand(args: string[]): string {
  if (args.length !== 3) {
    throw new Error('AdminBan expects exactly three arguments: target id, ban length and reason');
  }
  const target = assertSafeSingleLineText(args[0], 'AdminBan target', TARGET_MAX_CHARS);
  const banLength = assertValidBanLength(args[1]);
  const reason = assertSafeSingleLineText(args[2], 'AdminBan reason', BROADCAST_MAX_CHARS);
  return `AdminBan ${target} ${banLength} ${reason}`;
}

function assertValidBanLength(value: string | undefined): string {
  const text = value?.trim();
  if (!text) throw new Error('AdminBan length is required');
  if (!BAN_LENGTH_PATTERN.test(text)) {
    throw new Error(`invalid AdminBan length: ${text}`);
  }
  return text;
}

function assertSafeSingleLineText(
  value: string | undefined,
  label: string,
  maxChars: number,
): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  if (/[\r\n\0]/u.test(text)) throw new Error(`unsafe ${label}`);
  return text;
}

function ensureNoArgs(request: RconCommandRequest): void {
  if (request.args.length > 0) throw new Error(`${request.command} does not accept arguments`);
}

function getField(kv: string[], name: string): string | null {
  const idx = kv.indexOf(name);
  if (idx < 0 || idx + 1 >= kv.length) return null;
  return kv[idx + 1] ?? null;
}

function requestIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const requestId = value.request_id;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}

function commandNameOf(value: unknown): RconOperatorCommandName | null {
  if (!isRecord(value)) return null;
  const parsed = rconOperatorCommandNameSchema.safeParse(value.command);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
