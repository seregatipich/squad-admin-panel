import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const entryPath = path.resolve(import.meta.dirname, '../dist/index.js');

function runWithEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [entryPath], {
    env: { PATH: process.env.PATH, ...overrides },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('media-publisher numeric env validation', () => {
  it.each([
    ['MEDIA_PUBLISHER_INTERVAL_MS', 'abc'],
    ['MEDIA_PUBLISHER_INTERVAL_MS', '0'],
    ['MEDIA_PUBLISHER_INTERVAL_MS', '999'],
    ['MEDIA_PUBLISHER_INTERVAL_MS', '1.5'],
    ['MEDIA_PUBLISHER_BATCH_SIZE', 'NaN'],
    ['MEDIA_PUBLISHER_BATCH_SIZE', '0'],
    ['MEDIA_PUBLISHER_BATCH_SIZE', '51'],
  ])('exits fatally on %s=%s', (name, value) => {
    const result = runWithEnv({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${name} must be an integer between`);
  });
});
