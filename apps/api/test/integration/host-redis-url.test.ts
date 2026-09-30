import { afterEach, describe, expect, it } from 'vitest';
import { hostRedisUrl } from './isolated-db.js';

const originalRedisUrl = process.env.TEST_REDIS_URL;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.TEST_REDIS_URL;
  else process.env.TEST_REDIS_URL = originalRedisUrl;
});

describe('hostRedisUrl', () => {
  it('returns TEST_REDIS_URL when it is set', () => {
    process.env.TEST_REDIS_URL = 'redis://127.0.0.1:56391/9';
    expect(hostRedisUrl()).toBe('redis://127.0.0.1:56391/9');
  });

  it('fails fast instead of falling back to the local stack Redis when TEST_REDIS_URL is unset', () => {
    delete process.env.TEST_REDIS_URL;
    expect(() => hostRedisUrl()).toThrow(/TEST_REDIS_URL/);
  });
});
