import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSuiteGate,
  describeIfDb,
  describeIfDbAndRedis,
  describeIfRedis,
  type SuiteGateRuntime,
} from './helpers/describe-if.js';

function fakeRuntime(env: NodeJS.ProcessEnv): SuiteGateRuntime & {
  run: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { env, run: vi.fn(), skip: vi.fn(), warn: vi.fn() };
}

const factory = () => undefined;

describe('createSuiteGate', () => {
  it('declares the suite normally when every variable is set', () => {
    const runtime = fakeRuntime({ DATABASE_URL: 'postgres://db' });

    createSuiteGate(['DATABASE_URL'], runtime)('players', factory);

    expect(runtime.run).toHaveBeenCalledExactlyOnceWith('players', factory);
    expect(runtime.skip).not.toHaveBeenCalled();
    expect(runtime.warn).not.toHaveBeenCalled();
  });

  it('still runs the suite under CI when the variables are set', () => {
    const runtime = fakeRuntime({ DATABASE_URL: 'postgres://db', CI: 'true' });

    createSuiteGate(['DATABASE_URL'], runtime)('players', factory);

    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it('skips with a warning that names the suite and the variable outside CI', () => {
    const runtime = fakeRuntime({});

    createSuiteGate(['DATABASE_URL'], runtime)('players', factory);

    expect(runtime.skip).toHaveBeenCalledExactlyOnceWith('players', factory);
    expect(runtime.run).not.toHaveBeenCalled();
    expect(runtime.warn).toHaveBeenCalledOnce();
    expect(runtime.warn.mock.calls[0]?.[0]).toContain('"players"');
    expect(runtime.warn.mock.calls[0]?.[0]).toContain('DATABASE_URL');
  });

  it('treats an empty variable as missing', () => {
    const runtime = fakeRuntime({ DATABASE_URL: '' });

    createSuiteGate(['DATABASE_URL'], runtime)('players', factory);

    expect(runtime.skip).toHaveBeenCalledOnce();
  });

  it('throws at declaration under CI instead of skipping', () => {
    const runtime = fakeRuntime({ CI: 'true' });

    expect(() => createSuiteGate(['DATABASE_URL'], runtime)('players', factory)).toThrow(
      /Suite "players" needs DATABASE_URL.*CI is set/,
    );
    expect(runtime.run).not.toHaveBeenCalled();
    expect(runtime.skip).not.toHaveBeenCalled();
    expect(runtime.warn).not.toHaveBeenCalled();
  });

  it('requires every variable and lists only the missing ones', () => {
    const outsideCi = fakeRuntime({ DATABASE_URL: 'postgres://db' });
    createSuiteGate(['DATABASE_URL', 'REDIS_URL'], outsideCi)('streams', factory);
    expect(outsideCi.skip).toHaveBeenCalledOnce();
    expect(outsideCi.warn.mock.calls[0]?.[0]).toContain('REDIS_URL');
    expect(outsideCi.warn.mock.calls[0]?.[0]).not.toContain('DATABASE_URL');

    const underCi = fakeRuntime({ DATABASE_URL: 'postgres://db', CI: '1' });
    expect(() =>
      createSuiteGate(['DATABASE_URL', 'REDIS_URL'], underCi)('streams', factory),
    ).toThrow(/needs REDIS_URL,/);
  });

  it('reads the environment when the suite is declared, not when the gate is built', () => {
    const env: NodeJS.ProcessEnv = {};
    const runtime = fakeRuntime(env);
    const gate = createSuiteGate(['DATABASE_URL'], runtime);

    env.DATABASE_URL = 'postgres://db';
    gate('players', factory);

    expect(runtime.run).toHaveBeenCalledOnce();
    expect(runtime.skip).not.toHaveBeenCalled();
  });
});

describe('the exported gates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['describeIfDb', describeIfDb, 'DATABASE_URL', { REDIS_URL: 'redis://r' }],
    ['describeIfRedis', describeIfRedis, 'REDIS_URL', { DATABASE_URL: 'postgres://db' }],
    [
      'describeIfDbAndRedis',
      describeIfDbAndRedis,
      'DATABASE_URL',
      { DATABASE_URL: '', REDIS_URL: 'redis://r' },
    ],
  ])('%s refuses to skip under CI when %s is missing', (_name, gate, variable, others) => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('REDIS_URL', '');
    for (const [key, value] of Object.entries(others)) vi.stubEnv(key, value);

    expect(() => gate('some suite', factory)).toThrow(new RegExp(`needs ${variable}`));
  });
});
