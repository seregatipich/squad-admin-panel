import { AsyncLocalStorage } from 'node:async_hooks';
import type { Writable } from 'node:stream';
import { createDiscordRedactingStream } from '@squad/shared-config';
import pino, { type DestinationStream, multistream } from 'pino';
import { DISCORD_CALLBACK_PATH } from './discord-oauth.js';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

/**
 * Auth callbacks whose query string carries one-time credentials: the Steam
 * OpenID assertion and the Discord OAuth `code`/`state`.
 */
const SENSITIVE_AUTH_CALLBACK_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/auth/steam/callback',
  DISCORD_CALLBACK_PATH,
]);

/**
 * Fastify `disableRequestLogging` predicate: suppresses the automatic
 * request/response log lines (which include the full URL) for the sensitive
 * auth callbacks, so their credentials never reach stdout or the `panel:logs`
 * stream.
 *
 * @param request - the incoming request; only `url` is read.
 * @returns `true` when the path, ignoring the query string, is a sensitive callback.
 */
export function shouldDisableSensitiveAuthRequestLogging(request: { url: string }): boolean {
  return SENSITIVE_AUTH_CALLBACK_PATHS.has(request.url.split('?', 1)[0] ?? '');
}

class LateSink {
  private inner: Writable | null = null;
  setInner(s: Writable): void {
    this.inner = s;
  }
  write(chunk: string): boolean {
    return this.inner ? this.inner.write(chunk) : true;
  }
}

export function buildLogger(level: string): { logger: pino.Logger; lateSink: LateSink } {
  const isDev = process.env.NODE_ENV !== 'production';
  const redact = {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.body.password',
      'req.body.passwordConfirm',
      'req.body.totp_code',
      'req.body.backup_code',
      'req.body.client_secret',
      '*.rcon_password',
      '*.license_key',
      '*.APP_ENCRYPTION_KEY',
    ],
    censor: '[redacted]',
  };
  const mixin = () => als.getStore() ?? {};
  const base = { service: 'api' };
  const lateSink = new LateSink();
  const sinkStream: DestinationStream = createDiscordRedactingStream(lateSink);
  if (isDev) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss' },
    });
    const logger = pino(
      { level, base, redact, mixin },
      multistream([
        { level: level as pino.Level, stream: createDiscordRedactingStream(pretty) },
        { level: level as pino.Level, stream: sinkStream },
      ]),
    );
    return { logger, lateSink };
  }
  const logger = pino(
    { level, base, redact, mixin },
    multistream([
      { level: level as pino.Level, stream: createDiscordRedactingStream(process.stdout) },
      { level: level as pino.Level, stream: sinkStream },
    ]),
  );
  return { logger, lateSink };
}

export type Logger = pino.Logger;
export type { LateSink };
