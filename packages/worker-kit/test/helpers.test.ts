import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerLog,
  guardAgainstOverlap,
  isMainEntrypoint,
  positiveIntEnv,
} from '../src/index.js';

describe('positiveIntEnv', () => {
  it('returns the fallback when the variable is unset', () => {
    expect(positiveIntEnv('X_MS', 5_000, {})).toBe(5_000);
  });

  it('returns the fallback when the variable is blank', () => {
    expect(positiveIntEnv('X_MS', 5_000, { X_MS: '' })).toBe(5_000);
    expect(positiveIntEnv('X_MS', 5_000, { X_MS: '   ' })).toBe(5_000);
  });

  it('parses a positive integer', () => {
    expect(positiveIntEnv('X_MS', 5_000, { X_MS: '250' })).toBe(250);
  });

  it.each(['1h', '60s', '0', '-5', '1.5', 'NaN', 'Infinity'])(
    'throws naming the variable and the value for %s',
    (raw) => {
      expect(() => positiveIntEnv('X_MS', 5_000, { X_MS: raw })).toThrow(
        `X_MS must be a positive integer, got "${raw}"`,
      );
    },
  );

  it('reads process.env by default', () => {
    vi.stubEnv('KIT_TEST_INTERVAL_MS', '42');
    try {
      expect(positiveIntEnv('KIT_TEST_INTERVAL_MS', 1)).toBe(42);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('guardAgainstOverlap', () => {
  it('skips a call that arrives while the previous one is running', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const guarded = guardAgainstOverlap(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = guarded();
    await guarded();
    release?.();
    await first;

    expect(calls).toBe(1);
  });

  it('reports each skipped call through onSkip', async () => {
    let release: (() => void) | undefined;
    const onSkip = vi.fn();
    const guarded = guardAgainstOverlap(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      onSkip,
    );

    const first = guarded();
    await guarded();
    await guarded();
    release?.();
    await first;

    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it('runs again once the previous call has finished and does not call onSkip', async () => {
    const onSkip = vi.fn();
    const tick = vi.fn().mockResolvedValue(undefined);
    const guarded = guardAgainstOverlap(tick, onSkip);

    await guarded();
    await guarded();

    expect(tick).toHaveBeenCalledTimes(2);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('propagates a rejection and clears the in-flight flag', async () => {
    const tick = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const guarded = guardAgainstOverlap(tick);

    await expect(guarded()).rejects.toThrow('boom');
    await guarded();

    expect(tick).toHaveBeenCalledTimes(2);
  });
});

describe('isMainEntrypoint', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'worker-kit-'));
    dirs.push(dir);
    return dir;
  }

  it('is true when the module is the started script', () => {
    const dir = scratch();
    const script = path.join(dir, 'index.js');
    writeFileSync(script, '');

    expect(isMainEntrypoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it('is true when the script was started through a symlink', () => {
    const dir = scratch();
    const script = path.join(dir, 'index.js');
    const link = path.join(dir, 'link.js');
    writeFileSync(script, '');
    symlinkSync(script, link);

    expect(isMainEntrypoint(pathToFileURL(script).href, link)).toBe(true);
  });

  it('is false when another script was started', () => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'a'));
    const mine = path.join(dir, 'a', 'index.js');
    const other = path.join(dir, 'other.js');
    writeFileSync(mine, '');
    writeFileSync(other, '');

    expect(isMainEntrypoint(pathToFileURL(mine).href, other)).toBe(false);
  });

  it('is false without a started script', () => {
    expect(isMainEntrypoint('file:///anything.js', undefined)).toBe(false);
    expect(isMainEntrypoint('file:///anything.js', '')).toBe(false);
  });

  it('is false when a path cannot be resolved', () => {
    expect(isMainEntrypoint('file:///does/not/exist.js', '/does/not/exist.js')).toBe(false);
  });
});

describe('createWorkerLog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tags every line with the worker service name', () => {
    expect(createWorkerLog('role-expirer').bindings()).toEqual({ service: 'worker-role-expirer' });
  });

  it('defaults to the info level', () => {
    vi.stubEnv('LOG_LEVEL', '');
    delete process.env.LOG_LEVEL;

    expect(createWorkerLog('stats').level).toBe('info');
  });

  it('takes the level from LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');

    expect(createWorkerLog('stats').level).toBe('debug');
  });
});
