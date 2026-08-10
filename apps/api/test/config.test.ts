import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://admin:pass@127.0.0.1:5432/admin',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  PANEL_PUBLIC_URL: 'https://admin.example.com',
};

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  async function freshLoadConfig() {
    vi.resetModules();
    const mod = await import('../src/config.js');
    return mod.loadConfig;
  }

  it('returns parsed config with defaults when all required vars are set', async () => {
    Object.assign(process.env, VALID_ENV);
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig();
    expect(cfg.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(cfg.REDIS_URL).toBe(VALID_ENV.REDIS_URL);
    expect(cfg.API_HOST).toBe('0.0.0.0');
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.BRIDGE_SOCKET).toBe('/run/panel-host-bridge/bridge.sock');
  });

  it('respects overridden optional fields', async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      API_PORT: '4000',
      LOG_LEVEL: 'debug',
      BRIDGE_SOCKET: '/tmp/custom.sock',
    });
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig();
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.LOG_LEVEL).toBe('debug');
    expect(cfg.BRIDGE_SOCKET).toBe('/tmp/custom.sock');
  });

  it('calls process.exit(1) when a required variable is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const envWithoutRequired = { ...VALID_ENV };
    delete envWithoutRequired.DATABASE_URL;

    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, envWithoutRequired);

    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when DATABASE_URL is not a valid URL', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, { ...VALID_ENV, DATABASE_URL: 'not-a-url' });

    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('COOKIE_SECURE defaults to true', async () => {
    Object.assign(process.env, VALID_ENV);
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig();
    expect(cfg.COOKIE_SECURE).toBe(true);
  });

  it('SESSION_TTL_SECONDS defaults to 86400', async () => {
    Object.assign(process.env, VALID_ENV);
    const loadConfig = await freshLoadConfig();
    const cfg = loadConfig();
    expect(cfg.SESSION_TTL_SECONDS).toBe(86400);
  });

  /**
   * Regression for the 2026-07-28 production outage: compose passes
   * `BALANCER_WEBHOOK_SECRET: ${BALANCER_WEBHOOK_SECRET:-}`, which supplies an
   * empty string rather than leaving the variable unset. `.optional()` permits
   * `undefined`, not `''`, so `.min(32)` rejected it and the API refused to boot
   * in a restart loop. An unset optional secret and a blank one must mean the
   * same thing: the feature is off.
   */
  it('treats a blank optional webhook secret as unset rather than refusing to boot', async () => {
    const loadConfig = await freshLoadConfig();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, VALID_ENV, {
      BALANCER_WEBHOOK_SECRET: '',
      VIP_LIFECYCLE_WEBHOOK_SECRET: '',
    });

    const config = loadConfig();

    expect(config.BALANCER_WEBHOOK_SECRET).toBeUndefined();
    expect(config.VIP_LIFECYCLE_WEBHOOK_SECRET).toBeUndefined();
  });

  it('still rejects a non-empty optional webhook secret that is too short', async () => {
    const loadConfig = await freshLoadConfig();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, VALID_ENV, { BALANCER_WEBHOOK_SECRET: 'too-short' });

    expect(() => loadConfig()).toThrow();
  });

  it('accepts a real optional webhook secret', async () => {
    const loadConfig = await freshLoadConfig();
    for (const key of Object.keys(process.env)) delete process.env[key];
    const secret = 'z'.repeat(32);
    Object.assign(process.env, VALID_ENV, { BALANCER_WEBHOOK_SECRET: secret });

    expect(loadConfig().BALANCER_WEBHOOK_SECRET).toBe(secret);
  });
});
