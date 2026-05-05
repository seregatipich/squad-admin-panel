import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RconSupervisor, type Target } from '../src/supervisor.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    xadd: vi.fn().mockResolvedValue('0-0'),
  } as never;
}

function makeDb() {
  return {} as never;
}

const target: Target = {
  serverId: 'srv-001',
  host: '127.0.0.1',
  port: 29100,
  queryPort: 27165,
  tickrate: 50,
  password: 'testpass',
};

describe('RconSupervisor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a per-server supervisor on reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    expect(supervisor.size()).toBe(0);
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(1);
    await supervisor.stop();
    expect(supervisor.size()).toBe(0);
  });

  it('removes stopped target on reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(1);
    await supervisor.reconcile([]);
    expect(supervisor.size()).toBe(0);
  });

  it('does not re-add existing target on repeated reconcile', async () => {
    const supervisor = new RconSupervisor({ db: makeDb(), redis: makeRedis(), log: makeLogger() });
    await supervisor.reconcile([target]);
    const sizeBefore = supervisor.size();
    await supervisor.reconcile([target]);
    expect(supervisor.size()).toBe(sizeBefore);
    await supervisor.stop();
  });
});
