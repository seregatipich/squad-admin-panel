import { AsyncLocalStorage } from 'node:async_hooks';
import type { Writable } from 'node:stream';
import { createDiscordRedactingStream } from '@squad/shared-config';
import pino, { type DestinationStream, multistream } from 'pino';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function shouldDisableSensitiveAuthRequestLogging(request: { url: string }): boolean {
  return request.url.split('?', 1)[0] === '/api/v1/auth/bss/callback';
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
      '*.BSS_SSO_CLIENT_SECRET',
      '*.BSS_SSO_CLIENT_SECRET_NEXT',
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
