import { AsyncLocalStorage } from 'node:async_hooks';
import type { Writable } from 'node:stream';
import pino, { type DestinationStream, multistream } from 'pino';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

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
      '*.rcon_password',
      '*.license_key',
      '*.APP_ENCRYPTION_KEY',
    ],
    censor: '[redacted]',
  };
  const mixin = () => als.getStore() ?? {};
  const base = { service: 'api' };
  const lateSink = new LateSink();
  const sinkStream: DestinationStream = { write: (chunk) => lateSink.write(chunk) };
  if (isDev) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss' },
    });
    const logger = pino(
      { level, base, redact, mixin },
      multistream([
        { level: level as pino.Level, stream: pretty },
        { level: level as pino.Level, stream: sinkStream },
      ]),
    );
    return { logger, lateSink };
  }
  const logger = pino(
    { level, base, redact, mixin },
    multistream([
      { level: level as pino.Level, stream: process.stdout },
      { level: level as pino.Level, stream: sinkStream },
    ]),
  );
  return { logger, lateSink };
}

export type Logger = pino.Logger;
export type { LateSink };
