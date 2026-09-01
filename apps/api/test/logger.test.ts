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

  it('redacts the BSS client secret when a request body is logged explicitly', () => {
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
    logger.info({ req: { body: { client_secret: 'sentinel-bss-secret' } } }, 'request');

    expect(chunks.join('')).not.toContain('sentinel-bss-secret');
    expect(chunks.join('')).toContain('[redacted]');
  });
});

describe('sensitive auth request logging', () => {
  it('disables automatic logs only for the BSS callback path', () => {
    expect(
      shouldDisableSensitiveAuthRequestLogging({
        url: '/api/v1/auth/bss/callback?code=secret&state=secret',
      }),
    ).toBe(true);
    expect(
      shouldDisableSensitiveAuthRequestLogging({ url: '/api/v1/auth/bss/callback-extra' }),
    ).toBe(false);
    expect(shouldDisableSensitiveAuthRequestLogging({ url: '/api/v1/auth/bss/login' })).toBe(false);
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
