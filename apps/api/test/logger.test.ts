import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { als, buildLogger, shouldDisableSensitiveAuthRequestLogging } from '../src/lib/logger.js';

describe('buildLogger', () => {
  it('returns a pino logger and a LateSink', () => {
    const { logger, lateSink } = buildLogger('info');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(lateSink).toBeDefined();
  });

  it('logger has service=api in the base bindings', () => {
    const chunks: string[] = [];
    const { logger, lateSink } = buildLogger('trace');
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    lateSink.setInner(sink);
    logger.info('test-message');
    const found = chunks.some((c) => c.includes('"service":"api"'));
    expect(found).toBe(true);
  });

  it('respects the configured log level', () => {
    const chunks: string[] = [];
    const { logger, lateSink } = buildLogger('warn');
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    lateSink.setInner(sink);
    logger.debug('should-be-suppressed');
    logger.warn('should-appear');
    const hasDebug = chunks.some((c) => c.includes('should-be-suppressed'));
    const hasWarn = chunks.some((c) => c.includes('should-appear'));
    expect(hasDebug).toBe(false);
    expect(hasWarn).toBe(true);
  });

  it('redacts a client secret when a request body is logged explicitly', () => {
    const chunks: string[] = [];
    const { logger, lateSink } = buildLogger('info');
    lateSink.setInner(
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      }),
    );
    logger.info({ req: { body: { client_secret: 'sentinel-client-secret' } } }, 'request');

    expect(chunks.join('')).not.toContain('sentinel-client-secret');
    expect(chunks.join('')).toContain('[redacted]');
  });
});

describe('sensitive auth request logging', () => {
  it('disables automatic logs for the Discord OAuth callback, whose query carries code/state (#66)', () => {
    expect(
      shouldDisableSensitiveAuthRequestLogging({
        url: '/api/v1/auth/discord/callback?code=secret-code&state=secret-state',
      }),
    ).toBe(true);
    expect(shouldDisableSensitiveAuthRequestLogging({ url: '/api/v1/auth/discord/login' })).toBe(
      false,
    );
  });

  it('disables automatic logs only for the OAuth callback paths', () => {
    expect(
      shouldDisableSensitiveAuthRequestLogging({
        url: '/api/v1/auth/steam/callback?n=nonce&openid.sig=secret',
      }),
    ).toBe(true);
    expect(
      shouldDisableSensitiveAuthRequestLogging({ url: '/api/v1/auth/steam/callback-extra' }),
    ).toBe(false);
    expect(shouldDisableSensitiveAuthRequestLogging({ url: '/api/v1/auth/steam/login' })).toBe(
      false,
    );
  });
});

describe('als (AsyncLocalStorage)', () => {
  it('is an AsyncLocalStorage instance', () => {
    expect(als).toBeInstanceOf(AsyncLocalStorage);
  });

  it('stores and retrieves a RequestContext', async () => {
    const ctx = { requestId: 'test-req-id', userId: 'u-1' };
    await new Promise<void>((resolve) => {
      als.run(ctx, () => {
        const stored = als.getStore();
        expect(stored).toEqual(ctx);
        expect(stored?.requestId).toBe('test-req-id');
        resolve();
      });
    });
  });

  it('returns undefined outside of a run context', () => {
    expect(als.getStore()).toBeUndefined();
  });
});

describe('LateSink', () => {
  it('write returns true when no inner stream is set', () => {
    const { lateSink } = buildLogger('info');
    const result = lateSink.write('{"msg":"test"}\n');
    expect(result).toBe(true);
  });

  it('delegates write to the inner stream after setInner', () => {
    const written: string[] = [];
    const { lateSink } = buildLogger('info');
    const sink = new Writable({
      write(chunk, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    lateSink.setInner(sink);
    lateSink.write('hello\n');
    expect(written).toContain('hello\n');
  });
});

describe('request URL redaction (audit #71, #1310)', () => {
  function captureRequestLog(url: string): string {
    const chunks: string[] = [];
    const { logger, lateSink } = buildLogger('info');
    lateSink.setInner(
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      }),
    );
    // The shape Fastify hands the `req` serializer for "incoming request".
    const request = {
      method: 'POST',
      url,
      headers: {},
      host: 'panel.example',
      ip: '203.0.113.7',
      socket: { remotePort: 51234 },
    };
    logger.info({ req: request }, 'incoming request');
    return chunks.join('');
  }

  it('never logs the one-time upload token from the query string', () => {
    const out = captureRequestLog('/api/v1/public/media?token=sentinel-upload-token&x=1');
    expect(out).not.toContain('sentinel-upload-token');
    expect(out).toContain('/api/v1/public/media?token=[redacted]&x=1');
  });

  it('never logs an appeal tracking token from the path', () => {
    const out = captureRequestLog('/api/v1/public/appeals/sentinel-appeal-token');
    expect(out).not.toContain('sentinel-appeal-token');
    expect(out).toContain('/api/v1/public/appeals/[redacted]');
  });

  it('keeps ordinary request URLs and the other request fields intact', () => {
    const out = captureRequestLog('/api/v1/players?q=abc');
    expect(out).toContain('"url":"/api/v1/players?q=abc"');
    expect(out).toContain('"method":"POST"');
    expect(out).toContain('"remoteAddress":"203.0.113.7"');
  });
});

describe('request URL redaction through Fastify (audit #71, #1310)', () => {
  it('Fastify request logs use the redacting serializer', async () => {
    const { default: Fastify } = await import('fastify');
    const chunks: string[] = [];
    const { logger, lateSink } = buildLogger('info');
    lateSink.setInner(
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      }),
    );
    const app = Fastify({ loggerInstance: logger });
    app.post('/api/v1/public/media', async (_req, reply) => reply.code(410).send({}));
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/v1/public/media?token=sentinel-fastify-token' });
    await app.close();
    const out = chunks.join('');
    expect(out).toContain('incoming request');
    expect(out).toContain('token=[redacted]');
    expect(out).not.toContain('sentinel-fastify-token');
  });
});
