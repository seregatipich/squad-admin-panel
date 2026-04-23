import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function buildLogger(level: string) {
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
  if (isDev) {
    return pino({
      level,
      base,
      redact,
      mixin,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss' },
      },
    });
  }
  return pino({ level, base, redact, mixin });
}

export type Logger = ReturnType<typeof buildLogger>;
